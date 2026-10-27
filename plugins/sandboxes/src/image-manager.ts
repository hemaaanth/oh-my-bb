import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { verifyRegistryBrowserArtifact, type BrowserArtifact } from "./browser-artifact.js";
import type { SandboxProvider } from "./backend.js";
import type {
  BuildAndPushSandboxImageInput,
  PushedSandboxImage,
} from "./build-image.js";
import {
  isSandboxImageProvider,
  sandboxImageProviders,
  sandboxImageRegistryConfig,
  sandboxProviderCredentialStatus,
  type SandboxImageProvider,
  type SandboxImageRegistryConfig,
  type SandboxSettings,
} from "./config.js";
import {
  normalizeExtraPackages,
  prepareImageBuildContext,
  type SandboxImageBuildContext,
} from "./image-catalog.js";
import type {
  RegistryImageReference,
  SandboxImageRegistrationRequest,
  SandboxImageRegistrationResult,
} from "./register-image.js";
import type { DaytonaCapacityPool, DaytonaPlacement } from "./daytona-capacity.js";
import {
  providerSizesByImage,
  sandboxSizeTierValues,
  sizeTierImageSuffix,
  sizeTierPoolViolations,
  type SandboxSizeTier,
} from "./size-tiers.js";
import type { SandboxImageRecord, SandboxStore } from "./store.js";

export type SandboxImageRegistrationStatus =
  | "registered"
  | "skipped"
  | "error";

export interface SandboxImageRegistration {
  provider: SandboxImageProvider;
  /** Set for providers that register one image per size. */
  sizeTier: SandboxSizeTier | null;
  status: SandboxImageRegistrationStatus;
  name: string | null;
  imageId: string | null;
  message: string | null;
}

export interface SandboxImageBuild {
  version: string;
  reference: string;
  digest: string;
  pinnedReference: string;
  extraPackages: string[];
  registrations: SandboxImageRegistration[];
}

export interface SandboxImageManagerDeps {
  bb: BbPluginApi;
  store: SandboxStore;
  getSettings: () => Promise<SandboxSettings>;
  dockerfilePath: string;
  verifyBrowserImage?: (registry: SandboxImageRegistryConfig, pinnedReference: string) => Promise<BrowserArtifact>;
  bbAppVersion: () => Promise<string>;
  buildAndPush: (
    input: BuildAndPushSandboxImageInput,
  ) => Promise<PushedSandboxImage>;
  register: (
    input: SandboxImageRegistrationRequest,
  ) => Promise<SandboxImageRegistrationResult>;
  resolveRegistryImage: (input: {
    registry: SandboxImageRegistryConfig;
    reference: string | null;
    onLog?: (message: string) => void;
  }) => Promise<RegistryImageReference>;
  /** The bb-app an already-pushed image carries, from its OCI label. */
  readImageBbAppVersion?: (input: {
    registry: SandboxImageRegistryConfig;
    reference: string;
    platform: string;
  }) => Promise<string | null>;
  activateImage: (provider: SandboxProvider, name: string) => Promise<void>;
  /**
   * The Daytona pool a registration lands in, so tiers the pool can never
   * host are skipped instead of failing the whole job. Null when capacity is
   * unknown, in which case every tier is attempted.
   */
  daytonaPool?: (regionId?: string) => Promise<{
    placement: DaytonaPlacement;
    pool: DaytonaCapacityPool | null;
  } | null>;
}

const versionPattern = /^[a-z0-9][a-z0-9-]{0,54}$/u;

/**
 * A `docker buildx --progress plain` run emits tens of thousands of lines, and
 * a watcher only ever needs the tail, so the job log is a bounded window whose
 * offset is tracked separately to keep cursors stable.
 */
const MAX_JOB_LOG_LINES = 2_000;
const MAX_RETAINED_JOBS = 8;

function generatedVersion(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "z")
    .toLowerCase();
}

function providerImageName(
  provider: SandboxImageProvider,
  version: string,
  pinnedReference: string,
  sizeTier: SandboxSizeTier | null = null,
  regionId?: string,
): string {
  if (provider === "modal") return `bb-sandbox:${version}`;
  // Nirvana takes the registry reference itself as its image setting.
  if (provider === "nirvana") return pinnedReference;
  // Providers sized by their image carry the tier in the name, so the
  // snapshot list reads as one build at several sizes. Snapshot names are
  // unique per organization, so a copy registered into a second region
  // carries that region too.
  const region = regionId === undefined ? "" : `-${regionId}`;
  return sizeTier === null
    ? `bb-sandbox-${version}${region}`
    : `bb-sandbox-${version}-${sizeTierImageSuffix(sizeTier)}${region}`;
}

/** One provider image to register: a provider, and for tiered providers a size. */
interface RegistrationTarget {
  provider: SandboxImageProvider;
  sizeTier: SandboxSizeTier | null;
  regionId?: string;
}

function targetKey(target: RegistrationTarget): string {
  return `${target.provider}:${target.sizeTier ?? ""}`;
}

export interface SandboxImageBuildRequest {
  provider?: SandboxProvider;
  name?: string;
  /** Register only this size on tiered providers; all sizes when absent. */
  sizeTier?: SandboxSizeTier;
  /** Register into this region on providers with regions. */
  regionId?: string;
}

export interface SandboxImageRegistrationTaskRequest {
  provider?: SandboxProvider;
  /** A tag, a `repository:tag`, or absent for the newest tag in the registry. */
  reference?: string;
  sizeTier?: SandboxSizeTier;
  regionId?: string;
}

export const sandboxImageJobKinds = ["build", "register"] as const;
export type SandboxImageJobKind = (typeof sandboxImageJobKinds)[number];

export type SandboxImageJobState = "running" | "ready" | "error";

export interface SandboxImageJobHandle {
  id: string;
  kind: SandboxImageJobKind;
  version: string;
  reference: string;
  pinnedReference: string | null;
  imageIds: string[];
}

export interface SandboxImageJobStatus extends SandboxImageJobHandle {
  state: SandboxImageJobState;
  error: string | null;
  /** Log lines produced after the cursor the caller passed in. */
  progress: string[];
  /** Cursor to pass to the next poll. */
  cursor: number;
  images: SandboxImageRecord[];
  build: SandboxImageBuild | null;
}

interface SandboxImageJob {
  id: string;
  kind: SandboxImageJobKind;
  version: string;
  reference: string;
  pinnedReference: string | null;
  imageIds: string[];
  log: string[];
  /** Index of `log[0]` in the job's whole output. */
  logStart: number;
  state: SandboxImageJobState;
  error: string | null;
  build: SandboxImageBuild | null;
}

interface PreparedImageJob {
  kind: SandboxImageJobKind;
  version: string;
  reference: string;
  digest: string | null;
  pinnedReference: string | null;
  settings: SandboxSettings;
  registry: SandboxImageRegistryConfig;
  requested: SandboxImageProvider | undefined;
  targets: RegistrationTarget[];
  registrable: SandboxImageProvider[];
  extraPackages: string[];
  /** Target key to the image row opened for it, absent when it was skipped. */
  rows: Map<string, string>;
}

export class SandboxImageManager {
  private readonly inFlight = new Map<string, Promise<SandboxImageBuild>>();
  private readonly jobs = new Map<string, SandboxImageJob>();

  constructor(private readonly deps: SandboxImageManagerDeps) {}

  /**
   * Blocking build, used by the settings UI over RPC where the caller holds a
   * live socket. The CLI cannot wait this long and uses `startBuild` instead.
   */
  build(request: SandboxImageBuildRequest = {}): Promise<SandboxImageBuild> {
    const key = `build:${request.provider ?? "fleet"}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const build = this.buildOnce(request).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, build);
    return build;
  }

  /** Start a local Docker build and return once its image rows exist. */
  startBuild(
    request: SandboxImageBuildRequest = {},
  ): Promise<SandboxImageJobHandle> {
    return this.start("build", request);
  }

  /** Register an image CI already pushed, resolving the reference first. */
  startRegistration(
    request: SandboxImageRegistrationTaskRequest = {},
  ): Promise<SandboxImageJobHandle> {
    return this.start("register", request);
  }

  job(id: string, cursor = 0): SandboxImageJobStatus {
    const job = this.jobs.get(id);
    if (job === undefined) {
      throw new Error(
        `Sandbox image job ${id} is unknown; a plugin reload drops running jobs, so check bb sandbox images`,
      );
    }
    const from = Math.max(cursor - job.logStart, 0);
    return {
      id: job.id,
      kind: job.kind,
      version: job.version,
      reference: job.reference,
      pinnedReference: job.pinnedReference,
      imageIds: [...job.imageIds],
      state: job.state,
      error: job.error,
      progress: job.log.slice(from),
      cursor: job.logStart + job.log.length,
      images: job.imageIds.map((imageId) =>
        this.deps.store.requireImage(imageId),
      ),
      build: job.build,
    };
  }

  private async start(
    kind: SandboxImageJobKind,
    request: SandboxImageBuildRequest & SandboxImageRegistrationTaskRequest,
  ): Promise<SandboxImageJobHandle> {
    const key = `${kind}:${request.provider ?? "fleet"}`;
    if (this.inFlight.has(key)) {
      throw new Error(
        `A sandbox image ${kind === "build" ? "build" : "registration"} is already running for ${request.provider ?? "the fleet"}`,
      );
    }
    const job: SandboxImageJob = {
      id: `job_${randomUUID().replaceAll("-", "")}`,
      kind,
      version: "",
      reference: "",
      pinnedReference: null,
      imageIds: [],
      log: [],
      logStart: 0,
      state: "running",
      error: null,
      build: null,
    };
    const log = (message: string) => {
      this.appendJobLog(job, message);
      this.deps.bb.log.info(`[sandbox image] ${message.trimEnd()}`);
      this.publishProgress(null, null, "building", message);
    };
    // Validation, reference resolution, and the image rows happen before the
    // caller gets its handle so a bad request still fails the command.
    const prepared = await this.prepare(kind, request, log);
    job.version = prepared.version;
    job.reference = prepared.reference;
    job.pinnedReference = prepared.pinnedReference;
    job.imageIds = [...prepared.rows.values()];
    this.retain(job);
    const run = this.finish(prepared, log);
    this.inFlight.set(key, run);
    void run
      .then((build) => {
        job.build = build;
        job.state = build.registrations.some(
          (registration) => registration.status === "error",
        )
          ? "error"
          : "ready";
      })
      .catch((error: unknown) => {
        job.state = "error";
        job.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    return {
      id: job.id,
      kind: job.kind,
      version: job.version,
      reference: job.reference,
      pinnedReference: job.pinnedReference,
      imageIds: [...job.imageIds],
    };
  }

  private retain(job: SandboxImageJob): void {
    this.jobs.set(job.id, job);
    for (const [id, candidate] of this.jobs) {
      if (this.jobs.size <= MAX_RETAINED_JOBS) break;
      if (candidate.state === "running") continue;
      this.jobs.delete(id);
    }
  }

  private appendJobLog(job: SandboxImageJob, message: string): void {
    for (const line of message.split("\n")) {
      const text = line.trimEnd();
      if (text.length > 0) job.log.push(text);
    }
    const overflow = job.log.length - MAX_JOB_LOG_LINES;
    if (overflow > 0) {
      job.log.splice(0, overflow);
      job.logStart += overflow;
    }
  }

  private publishProgress(
    provider: SandboxImageProvider | null,
    imageId: string | null,
    phase: "building" | "ready" | "error",
    message: string,
  ): void {
    this.deps.bb.realtime.publish("sandbox-image-builds", {
      provider,
      imageId,
      phase,
      message: message.slice(-2_000),
    });
  }

  private async buildOnce(
    request: SandboxImageBuildRequest,
  ): Promise<SandboxImageBuild> {
    const log = (message: string) => {
      this.deps.bb.log.info(`[sandbox image] ${message.trimEnd()}`);
      this.publishProgress(null, null, "building", message);
    };
    const prepared = await this.prepare("build", request, log);
    return this.finish(prepared, log);
  }

  private async prepare(
    kind: SandboxImageJobKind,
    request: SandboxImageBuildRequest & SandboxImageRegistrationTaskRequest,
    log: (message: string) => void,
  ): Promise<PreparedImageJob> {
    let requested: SandboxImageProvider | undefined;
    if (request.provider !== undefined) {
      if (!isSandboxImageProvider(request.provider)) {
        throw new Error(
          `${request.provider} bootstraps its toolchain at launch instead of pulling the shared sandbox image`,
        );
      }
      requested = request.provider;
    }
    const settings = await this.deps.getSettings();
    const registry = sandboxImageRegistryConfig(settings);
    if (registry.repository.length === 0) {
      throw new Error(
        "Set the sandbox image repository (for example ghcr.io/acme/bb-sandbox) first; the image is built once and every provider references it",
      );
    }
    const providers =
      requested === undefined ? sandboxImageProviders.slice() : [requested];
    const credentials = sandboxProviderCredentialStatus(settings);
    const registrable = providers.filter((provider) => credentials[provider]);
    const targets = await this.registrationTargets(
      providers,
      registrable,
      request,
      log,
    );
    if (registrable.length === 0) {
      throw new Error(
        requested === undefined
          ? "Configure credentials for at least one image-backed provider (Daytona, Modal, E2B, or Nirvana) first"
          : `Configure the ${requested} credentials first`,
      );
    }
    let version: string;
    let reference: string;
    let digest: string | null = null;
    let pinnedReference: string | null = null;
    let extraPackages: string[];
    let bbAppVersion: string | null;
    if (kind === "build") {
      bbAppVersion = await this.deps.bbAppVersion();
      version = request.name?.trim() || generatedVersion();
      if (!versionPattern.test(version)) {
        throw new Error(
          "Image versions must be lowercase letters, numbers, and dashes",
        );
      }
      reference = `${registry.repository}:${version}`;
      // One image serves every provider, so it carries the extra packages that
      // any of the targeted providers asked for.
      extraPackages = normalizeExtraPackages(
        registrable.flatMap(
          (provider) =>
            this.deps.store.getProviderSettings(provider).extraPackages,
        ),
      );
    } else {
      const resolved = await this.deps.resolveRegistryImage({
        registry,
        reference: request.reference?.trim() || null,
        onLog: log,
      });
      version = resolved.tag;
      reference = resolved.reference;
      digest = resolved.digest;
      pinnedReference = resolved.pinnedReference;
      // CI builds `docker/` verbatim, so an already-pushed image never carries
      // the operator's extra Debian packages; recording them would lie.
      extraPackages = [];
      bbAppVersion =
        (await this.deps.readImageBbAppVersion?.({
          registry,
          reference: resolved.tag,
          platform: registry.platform,
        })) ?? null;
      log(
        bbAppVersion === null
          ? `${reference} carries no bb.app.version label; the doctor will treat its bb version as unknown`
          : `${reference} carries bb-app ${bbAppVersion}`,
      );
    }
    const rows = new Map<string, string>();
    for (const target of targets) {
      if (!registrable.includes(target.provider)) continue;
      const record = this.deps.store.beginImageBuild({
        id: `img_${randomUUID().replaceAll("-", "")}`,
        provider: target.provider,
        name: providerImageName(
          target.provider,
          version,
          pinnedReference ?? reference,
          target.sizeTier,
          target.regionId,
        ),
        extraPackages,
        bbAppVersion,
        sizeTier: target.sizeTier,
        imageVersion: version,
      });
      rows.set(targetKey(target), record.id);
    }
    return {
      kind,
      version,
      reference,
      digest,
      pinnedReference,
      settings,
      registry,
      requested,
      targets,
      registrable,
      extraPackages,
      rows,
    };
  }

  /**
   * Providers sized by their image get one target per tier, minus the tiers
   * the destination pool can never host; the rest get a single target.
   */
  private async registrationTargets(
    providers: SandboxImageProvider[],
    registrable: SandboxImageProvider[],
    request: SandboxImageBuildRequest & SandboxImageRegistrationTaskRequest,
    log: (message: string) => void,
  ): Promise<RegistrationTarget[]> {
    const targets: RegistrationTarget[] = [];
    for (const provider of providers) {
      // A provider without credentials is reported once as skipped, not once
      // per size it would have been registered at.
      if (!providerSizesByImage(provider) || !registrable.includes(provider)) {
        targets.push({ provider, sizeTier: null });
        continue;
      }
      const tiers =
        request.sizeTier === undefined
          ? sandboxSizeTierValues.slice()
          : [request.sizeTier];
      const located = await this.deps.daytonaPool?.(request.regionId).catch((error: unknown) => {
        log(
          `Could not read ${provider} capacity; registering every size: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
      for (const tier of tiers) {
        const violations =
          located?.pool === undefined || located.pool === null
            ? []
            : sizeTierPoolViolations(located.pool, tier);
        if (violations.length > 0) {
          log(
            `Skipping size ${tier} on ${provider}: ${located?.placement.regionId}/${located?.placement.sandboxClass} allows at most ${violations.join("; ")}`,
          );
          continue;
        }
        targets.push({
          provider,
          sizeTier: tier,
          ...(request.regionId === undefined ? {} : { regionId: request.regionId }),
        });
      }
      if (!tiers.some((tier) => targets.some((target) => target.provider === provider && target.sizeTier === tier))) {
        throw new Error(
          `${provider} cannot host any of the requested sizes in ${located?.placement.regionId ?? "the selected pool"}; pick a region with larger per-sandbox limits`,
        );
      }
    }
    return targets;
  }

  private async finish(
    prepared: PreparedImageJob,
    log: (message: string) => void,
  ): Promise<SandboxImageBuild> {
    const pushed =
      prepared.kind === "build"
        ? await this.push(prepared, log)
        : {
            reference: prepared.reference,
            digest: prepared.digest ?? "",
            pinnedReference: prepared.pinnedReference ?? prepared.reference,
          };
    const registrations = await this.registerWithProviders(
      prepared,
      pushed,
      log,
    );
    const failure = registrations.find(
      (registration) => registration.status === "error",
    );
    if (failure !== undefined && prepared.requested !== undefined) {
      throw new Error(
        failure.message ?? `Could not register ${failure.provider}`,
      );
    }
    return {
      version: prepared.version,
      reference: pushed.reference,
      digest: pushed.digest,
      pinnedReference: pushed.pinnedReference,
      extraPackages: prepared.extraPackages,
      registrations,
    };
  }

  private async push(
    prepared: PreparedImageJob,
    log: (message: string) => void,
  ): Promise<PushedSandboxImage> {
    log("Preparing build context");
    let context: SandboxImageBuildContext | null = null;
    try {
      context = await prepareImageBuildContext({
        dockerfilePath: this.deps.dockerfilePath,
        extraPackages: prepared.extraPackages,
      });
      return await this.deps.buildAndPush({
        contextDir: context.contextDir,
        dockerfilePath: context.dockerfilePath,
        reference: prepared.reference,
        platform: prepared.registry.platform,
        bbAppVersion: await this.deps.bbAppVersion(),
        registryUsername: prepared.registry.username,
        registryToken: prepared.registry.token,
        onLog: log,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const target of prepared.targets) {
        const imageId = prepared.rows.get(targetKey(target));
        if (imageId === undefined) continue;
        this.deps.store.failImageBuild(imageId, message);
        this.publishProgress(target.provider, imageId, "error", message);
      }
      this.publishProgress(null, null, "error", message);
      throw new Error(message);
    } finally {
      await context?.cleanup();
    }
  }

  private async registerWithProviders(
    prepared: PreparedImageJob,
    pushed: PushedSandboxImage,
    log: (message: string) => void,
  ): Promise<SandboxImageRegistration[]> {
    const registrations: SandboxImageRegistration[] = [];
    // One at a time, sizes included: Daytona serializes snapshot creation per
    // image and rejects a second pull of the same reference with "an operation
    // is already in progress", so parallel sizes would fail rather than save
    // time. Later sizes reuse the layers the first pull fetched.
    for (const target of prepared.targets) {
      registrations.push(await this.registerTarget(prepared, pushed, target, log));
    }
    return registrations;
  }

  private async registerTarget(
    prepared: PreparedImageJob,
    pushed: PushedSandboxImage,
    target: RegistrationTarget,
    log: (message: string) => void,
  ): Promise<SandboxImageRegistration> {
    const { provider, sizeTier } = target;
    const imageId = prepared.rows.get(targetKey(target));
    if (imageId === undefined) {
      return {
        provider,
        sizeTier,
        status: "skipped",
        name: null,
        imageId: null,
        message: `${provider} has no credentials configured`,
      };
    }
    const name = providerImageName(
      provider,
      prepared.version,
      pushed.pinnedReference,
      sizeTier,
      target.regionId,
    );
    // Nirvana's name is the pinned reference, which a local build only knows
    // after the push, so the row opened up front is corrected here.
    if (this.deps.store.requireImage(imageId).name !== name) {
      this.deps.store.renameImage(imageId, name);
    }
    const label = sizeTier === null ? provider : `${provider} (size ${sizeTier})`;
    this.publishProgress(
      provider,
      imageId,
      "building",
      `Registering ${pushed.pinnedReference} with ${label}`,
    );
    log(`Registering ${pushed.pinnedReference} with ${label}`);
    try {
      const artifact = await (this.deps.verifyBrowserImage ?? verifyRegistryBrowserArtifact)(prepared.registry, pushed.pinnedReference);
      const registered = await this.deps.register({
        provider,
        name,
        pinnedReference: pushed.pinnedReference,
        reference: pushed.reference,
        settings: prepared.settings,
        registry: prepared.registry,
        ...(sizeTier === null ? {} : { sizeTier }),
        ...(target.regionId === undefined ? {} : { regionId: target.regionId }),
        onLog: (message) => {
          this.deps.bb.log.info(`[${label} image] ${message.trimEnd()}`);
          this.publishProgress(provider, imageId, "building", message);
          log(message);
        },
      });
      this.deps.store.recordImageProvenance(imageId, pushed.pinnedReference, artifact);
      await this.deps.activateImage(provider, registered.name);
      if (registered.name !== name) {
        this.deps.store.renameImage(imageId, registered.name);
      }
      this.deps.store.finishImageBuild(
        imageId,
        registered.placement ?? undefined,
      );
      this.publishProgress(
        provider,
        imageId,
        "ready",
        `Registered ${registered.name}`,
      );
      log(`Registered ${registered.name} with ${label}`);
      return {
        provider,
        sizeTier,
        status: "registered",
        name: registered.name,
        imageId,
        message: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.failImageBuild(imageId, message);
      this.publishProgress(provider, imageId, "error", message);
      log(`${label} failed: ${message}`);
      return {
        provider,
        sizeTier,
        status: "error",
        name: null,
        imageId,
        message,
      };
    }
  }
}
