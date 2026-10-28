import { z } from "zod";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import {
  sandboxProviderValues,
  SandboxResizeUnsupportedError,
  type SandboxBackend,
  type SandboxBackendLifecycleInput,
  type SandboxBackendStatus,
  type SandboxProvider,
  type SandboxProvisionedResources,
  type SandboxResourceRequest,
  type SandboxResourceSample,
  type SandboxResizeCapability,
} from "./backend.js";
import { sandboxImageProviders, type SandboxRuntimeConfig } from "./config.js";
import type {
  DaytonaCapacity,
  DaytonaCapacityPool,
  DaytonaPlacement,
} from "./daytona-capacity.js";
import {
  formatSizeTier,
  providerSizesByImage,
  sandboxSizeTierValues,
  sandboxSizeTiers,
  sizeTierPoolViolations,
  sizeTierResources,
  smallestSizeTierCovering,
  type SandboxSizeTier,
} from "./size-tiers.js";
import { runHostCommand } from "./host-command.js";
import {
  SandboxStore,
  type SandboxCleanupRecord,
  type SandboxCleanupStep,
  type SandboxRecord,
  type SandboxRuntimeRecord,
  type SandboxSizeProfileInput,
  type SandboxSizeProfileRecord,
  type SandboxImageRecord,
} from "./store.js";
import { assessSandboxResources, type SandboxResourceAssessment } from "./resource-sizing.js";
import {
  auditVersions,
  type VersionAudit,
  type VersionAuditSandboxInput,
} from "./version-audit.js";

const VERSION_PROBE_TIMEOUT_MS = 20_000;

const BRANCH_CHECKOUT_TIMEOUT_MS = 2 * 60 * 1_000;
const REMOTE_URL_LOOKUP_TIMEOUT_MS = 30_000;

/**
 * How long a launch keeps waiting on a machine that dropped mid-step. A
 * Connect tunnel reconnect takes seconds and every host session dies with it,
 * so a step that lost its machine is retried rather than failing the launch
 * and destroying a sandbox that is about to answer again.
 */
const HOST_RECOVERY_BUDGET_MS = 3 * 60 * 1_000;
const HOST_RECOVERY_DELAY_MS = 2_000;

const terminalEscapeSequence = new RegExp(
  "\\u001B(?:\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-_])",
  "gu",
);

function compactFailure(error: unknown): string {
  const cleaned = (error instanceof Error ? error.message : String(error))
    .replace(terminalEscapeSequence, "")
    .replaceAll("\r", "");
  const embeddedNpmError = cleaned.search(/\bnpm (?:ERR!|error) code\b/iu);
  const focused =
    embeddedNpmError > 0 &&
    /\bwarning\b/iu.test(cleaned.slice(0, embeddedNpmError))
      ? cleaned.slice(embeddedNpmError)
      : cleaned;
  const lines = focused.split("\n").filter((line) => line.trim().length > 0);
  const firstError = lines.findIndex((line) =>
    /^(?:npm (?:ERR!|error)|(?:error|fatal)(?:\b|:)|[A-Z][A-Z0-9_]{2,}:)/iu.test(
      line.trim(),
    ),
  );
  const leadingLinesAreWarnings =
    firstError > 0 &&
    lines
      .slice(0, firstError)
      .every((line) => /\bwarning\b|^(?:\[?OK\]?\s*)+$/iu.test(line.trim()));
  const message = (
    leadingLinesAreWarnings ? lines.slice(firstError) : lines
  ).join("\n");
  return message.length <= 1_000 ? message : `${message.slice(0, 997)}...`;
}

/**
 * The machine answered bb a moment ago and is gone right now: bb refuses the
 * call outright, or a terminal session it was serving died under it.
 */
function isHostAwayError(error: unknown): boolean {
  return /host (?:is )?(?:not connected|unavailable)|host_unavailable|disconnected from (?:its host|terminal session)|host disconnected/iu.test(
    compactFailure(error),
  );
}

/**
 * Repeat a launch step whose machine went away, once it answers again.
 *
 * Only steps that can be replayed safely belong here: creating a directory,
 * checking a branch out, projecting skills. Each one either rewrites what the
 * lost attempt left behind or is a no-op the second time. Cloning and thread
 * creation are deliberately left out, since a repeat there is not free.
 */
export async function withHostRecovery<T>(
  step: () => Promise<T>,
  options?: { budgetMs?: number; delayMs?: number },
): Promise<T> {
  const deadline = Date.now() + (options?.budgetMs ?? HOST_RECOVERY_BUDGET_MS);
  for (;;) {
    try {
      return await step();
    } catch (error) {
      if (!isHostAwayError(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, options?.delayMs ?? HOST_RECOVERY_DELAY_MS),
      );
    }
  }
}


function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function waitForProviderStopped(
  backend: SandboxBackend,
  providerSandboxId: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let status: SandboxBackendStatus = "unknown";
  while (Date.now() < deadline) {
    status = await backend.status(providerSandboxId);
    if (status === "stopped" || status === "missing") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`provider still reports ${status}`);
}

interface ProjectSourceRef {
  hostId: string;
  isDefault: boolean;
  path: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function checkoutRemoteBranch(
  bb: BbPluginApi,
  hostId: string,
  workspacePath: string,
  remoteBranch: string,
): Promise<void> {
  if (!remoteBranch.startsWith("origin/") || remoteBranch === "origin/HEAD") {
    throw new Error("Sandbox branches must be remote origin/* branches");
  }
  const localBranch = remoteBranch.slice("origin/".length);
  if (localBranch.length === 0) {
    throw new Error("Sandbox branch is empty");
  }
  const result = await runHostCommand(bb, {
    hostId,
    cwd: workspacePath,
    command:
      `git fetch --prune origin && ` +
      `git checkout --force -B ${shellQuote(localBranch)} --track ${shellQuote(remoteBranch)}`,
    title: `Checkout ${localBranch}`,
    timeoutMs: BRANCH_CHECKOUT_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return;
  const detail = compactFailure(new Error(result.output));
  throw new Error(
    `Could not check out ${remoteBranch}${detail ? `: ${detail}` : ""}`,
  );
}

/**
 * Resolve the Git remote a sandbox should clone.
 *
 * bb records `project.gitRemoteUrl` once, when the project is created, and only
 * ever backfills it while it is null. A checkout whose origin later moves to a
 * different repository leaves that anchor stale, and the sandbox then clones a
 * repository that does not hold the branches the composer offered. The branch
 * list comes from the default source, so take the remote from there too and
 * fall back to the recorded anchor when the source host cannot answer.
 */
export async function resolveProjectRemoteUrl(
  bb: BbPluginApi,
  project: { gitRemoteUrl: string | null; sources: ProjectSourceRef[] },
): Promise<string> {
  const anchor = project.gitRemoteUrl;
  const source =
    project.sources.find((candidate) => candidate.isDefault) ??
    project.sources[0];
  if (source === undefined) {
    if (anchor === null) throw new Error("Project has no Git remote to clone");
    return anchor;
  }
  try {
    const result = await runHostCommand(bb, {
      hostId: source.hostId,
      cwd: source.path,
      command: "git remote get-url origin",
      title: "Read project remote",
      timeoutMs: REMOTE_URL_LOOKUP_TIMEOUT_MS,
    });
    const resolved = result.output.trim().split("\n").at(-1)?.trim() ?? "";
    if (result.exitCode !== 0 || resolved.length === 0) {
      throw new Error(result.output || "git remote get-url origin failed");
    }
    if (anchor !== null && resolved !== anchor) {
      bb.log.info(
        `Cloning ${resolved} for the sandbox; the project's recorded remote ${anchor} is stale.`,
      );
    }
    return resolved;
  } catch (error) {
    if (anchor === null) throw error;
    bb.log.warn(
      `Could not read the project remote from ${source.path}; falling back to ${anchor}: ${compactFailure(error)}`,
    );
    return anchor;
  }
}

const additionalProjectsSchema = z.array(z.object({ projectId: z.string(), sourceId: z.string(), name: z.string(), path: z.string() }));

export interface SandboxManagerDeps {
  config: SandboxRuntimeConfig;
  isProviderEnabled?: (provider: SandboxProvider) => boolean;
  bbAppVersion?: () => Promise<string>;
  /** Live Daytona quota pools, for placing a size where it can actually run. */
  daytonaCapacity?: () => Promise<DaytonaCapacity>;
  /** The Daytona pool selected in the provider settings. */
  daytonaPlacement?: () => Promise<DaytonaPlacement>;
}

/** One size, with where and how each provider can serve it. */
export interface SandboxSizeTierView {
  tier: SandboxSizeTier;
  label: string;
  cpuCores: number;
  memoryBytes: number;
  diskBytes: number;
  /** True for the plugin-wide default when a project sets nothing. */
  isDefault: boolean;
  /** Providers sized by their image, with the image that serves this size. */
  images: Array<{
    provider: SandboxProvider;
    image: SandboxImageRecord | null;
  }>;
  /** Daytona pools, and whether their per-sandbox limits admit this size. */
  pools: Array<{
    regionId: string;
    sandboxClass: string;
    fits: boolean;
    reasons: string[];
    /** The active image registered into this pool at this size, if any. */
    imageName: string | null;
  }>;
}

export interface SandboxThreadRuntimeView {
  managed: boolean;
  sandboxId: string | null;
  provider: SandboxProvider | null;
  recordStatus: SandboxRecord["status"] | null;
  state: SandboxRuntimeRecord["state"] | null;
  /**
   * Provider compute is running but bb's machine agent has not checked in past
   * its grace window: a Connect reset, a killed guest agent, or a network
   * partition. The provider reports the sandbox as healthy in this case, so
   * this is the only signal that a live-looking sandbox cannot serve a turn.
   */
  hostUnreachable: boolean;
  expiresAt: number | null;
  canRetry: boolean;
  error: string | null;
}

export const sandboxThreadStatusValues = [
  "live",
  "idle",
  "stopped",
  "unreachable",
  "unrecoverable",
] as const;
export type SandboxThreadStatus = (typeof sandboxThreadStatusValues)[number];

export interface SandboxThreadStatusView {
  threadId: string;
  sandboxId: string;
  provider: SandboxProvider;
  status: SandboxThreadStatus;
  label: string;
}

/**
 * A thread the caller wants resolved to a sandbox. `hostId` is the machine the
 * thread runs on when the caller already knows it (the sidebar does), which
 * skips the lookup this class would otherwise do through the SDK.
 */
export interface SandboxThreadRef {
  threadId: string;
  hostId?: string | null;
  environmentId?: string | null;
}

function providerDisplayName(provider: SandboxProvider): string {
  const names: Record<SandboxProvider, string> = {
    daytona: "Daytona",
    modal: "Modal",
    e2b: "E2B",
    box: "Boat",
    freestyle: "Freestyle",

  };
  return names[provider];
}

export interface SandboxResizeResult {
  sandboxId: string;
  /** False when the provider cannot change the size of an existing sandbox. */
  supported: boolean;
  reason: string | null;
  /** The size the sandbox is now meant to have, whatever the provider applied. */
  target: SandboxProvisionedResources;
  /** The size the provider reported after accepting the operation. */
  provisioned: SandboxProvisionedResources | null;
  /** True when the existing provider machine stopped and reconnected. */
  restarted: boolean;
}

export interface SandboxThreadResourcesView {
  managed: boolean;
  sandboxId: string | null;
  provider: SandboxProvider | null;
  state: SandboxRuntimeRecord["state"] | null;
  capability: SandboxResizeCapability;
  capabilityReason: string | null;
  latest: SandboxResourceSample | null;
  provisioned: SandboxProvisionedResources | null;
  target: SandboxProvisionedResources | null;
  assessment: SandboxResourceAssessment | null;
  stale: boolean;
  sampleError: string | null;
}

/**
 * A stored profile only constrains the dimensions it actually sets, so unset
 * ones keep falling through to the provider default. A profile with nothing
 * set is the same as no profile at all.
 */
function sizeProfileRequest(
  profile: SandboxSizeProfileRecord | null,
): SandboxResourceRequest | undefined {
  if (profile === null) return undefined;
  const request: SandboxResourceRequest = {
    ...(profile.cpuCores === null ? {} : { cpuCores: profile.cpuCores }),
    ...(profile.memoryBytes === null ? {} : { memoryBytes: profile.memoryBytes }),
    ...(profile.diskBytes === null ? {} : { diskBytes: profile.diskBytes }),
  };
  return Object.keys(request).length === 0 ? undefined : request;
}

export class SandboxManager {
  private readonly resizeInFlight = new Map<
    string,
    Promise<SandboxResizeResult>
  >();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: SandboxStore,
    private readonly deps: SandboxManagerDeps,
  ) {}

  providers(): Array<{
    provider: SandboxProvider;
    configured: boolean;
    enabled: boolean;
  }> {
    return sandboxProviderValues.map((provider) => ({
      provider,
      configured: this.deps.config[provider] !== null,
      enabled: this.deps.isProviderEnabled?.(provider) ?? true,
    }));
  }

  sizeProfiles(projectId?: string): SandboxSizeProfileRecord[] {
    return this.store.listSizeProfiles(projectId);
  }

  /**
   * A tier fills every dimension so readers that predate tiers still see the
   * numbers; a custom profile keeps only what the caller set.
   */
  setSizeProfile(input: SandboxSizeProfileInput): SandboxSizeProfileRecord {
    const tier = input.tier ?? null;
    const filled = tier === null ? null : sizeTierResources(tier);
    return this.store.upsertSizeProfile({
      ...input,
      tier,
      cpuCores: filled?.cpuCores ?? input.cpuCores,
      memoryBytes: filled?.memoryBytes ?? input.memoryBytes,
      diskBytes: filled?.diskBytes ?? input.diskBytes,
    });
  }

  /**
   * The size a new sandbox gets: an explicit request, else the project's
   * profile, else the plugin-wide default tier. A tier is remembered next to
   * its numbers so image-sized providers can pick the matching snapshot.
   */
  private resolveSize(
    projectId: string,
    provider: SandboxProvider,
    input: { resources?: SandboxResourceRequest; sizeTier?: SandboxSizeTier },
  ): {
    tier: SandboxSizeTier | null;
    resources: SandboxResourceRequest | undefined;
    regionId: string | null;
  } {
    const profile = this.store.getSizeProfile(projectId, provider);
    const regionId = profile?.regionId ?? null;
    if (input.resources !== undefined) {
      return { tier: null, resources: input.resources, regionId };
    }
    if (input.sizeTier !== undefined) {
      return { tier: input.sizeTier, resources: sizeTierResources(input.sizeTier), regionId };
    }
    if (profile?.tier) {
      return { tier: profile.tier, resources: sizeTierResources(profile.tier), regionId };
    }
    const custom = sizeProfileRequest(profile);
    if (custom !== undefined) return { tier: null, resources: custom, regionId };
    const tier = this.deps.config.defaultSizeTier;
    return { tier, resources: sizeTierResources(tier), regionId };
  }

  /**
   * For a provider whose machines take their size from the image: the active
   * image registered at the wanted size, in a pool that admits it. A pinned
   * region is honoured or refused; otherwise the configured pool is tried
   * first and any other pool of the same class after it, so a size the
   * default region cannot host still lands somewhere that can.
   */
  private async resolveTieredImage(
    provider: SandboxProvider,
    size: {
      tier: SandboxSizeTier | null;
      resources: SandboxResourceRequest | undefined;
      regionId: string | null;
    },
    projectId: string,
  ): Promise<{ image: SandboxImageRecord; placement: DaytonaPlacement } | null> {
    // A deployment that never registered an image through the plugin runs on
    // the snapshot named in its settings; it predates tiers and keeps working
    // as before, with the size applied by resize where the provider allows.
    if (this.store.listDefaultImages(provider).length === 0) return null;
    const tier =
      size.tier ??
      (size.resources === undefined
        ? this.deps.config.defaultSizeTier
        : smallestSizeTierCovering(size.resources));
    if (tier === null) {
      throw new Error(
        `The requested size for ${projectId} exceeds the largest sandbox size (${formatSizeTier("XL")}); choose a tier with bb sandbox set-size --tier`,
      );
    }
    const placement = await this.deps.daytonaPlacement?.().catch(() => null) ?? null;
    const capacity = await this.deps.daytonaCapacity?.().catch(() => null) ?? null;
    const pinnedRegion = size.regionId;
    const candidates: Array<{ placement: DaytonaPlacement; pool: DaytonaCapacityPool | null }> = [];
    const sandboxClass = placement?.sandboxClass ?? "container";
    if (pinnedRegion !== null) {
      candidates.push({
        placement: { regionId: pinnedRegion, sandboxClass },
        pool: capacity?.pools.find((pool) => pool.regionId === pinnedRegion && pool.sandboxClass === sandboxClass) ?? null,
      });
    } else {
      if (placement !== null) {
        candidates.push({
          placement,
          pool: capacity?.pools.find((pool) => pool.regionId === placement.regionId && pool.sandboxClass === placement.sandboxClass) ?? null,
        });
      }
      for (const pool of capacity?.pools ?? []) {
        if (pool.sandboxClass !== sandboxClass) continue;
        if (candidates.some((candidate) => candidate.placement.regionId === pool.regionId)) continue;
        candidates.push({ placement: { regionId: pool.regionId, sandboxClass }, pool });
      }
    }
    const refusals: string[] = [];
    for (const candidate of candidates) {
      const violations = candidate.pool === null ? [] : sizeTierPoolViolations(candidate.pool, tier);
      if (violations.length > 0) {
        refusals.push(`${candidate.placement.regionId}: ${violations.join("; ")}`);
        continue;
      }
      const image = this.store.getDefaultImage(provider, tier, candidate.placement.regionId);
      if (image === null) {
        refusals.push(`${candidate.placement.regionId}: no active ${provider} image registered at size ${tier}`);
        continue;
      }
      return { image, placement: candidate.placement };
    }
    if (candidates.length === 0) {
      // No capacity and no configured placement, as in a minimal setup: the
      // active image for the size is still the right answer.
      const image = this.store.getDefaultImage(provider, tier);
      if (image !== null) {
        return {
          image,
          placement: placement ?? {
            regionId: image.regionId ?? "",
            sandboxClass:
              image.sandboxClass === "linux-vm" || image.sandboxClass === "windows"
                ? image.sandboxClass
                : "container",
          },
        };
      }
    }
    throw new Error(
      `No ${providerDisplayName(provider)} placement can serve size ${tier} (${formatSizeTier(tier)}) for ${projectId}` +
        (refusals.length === 0 ? "" : `: ${refusals.join("; ")}`) +
        `. Register the size with \`bb sandbox register-image --provider ${provider} --tier ${tier}\`` +
        (pinnedRegion === null ? "" : `, or clear the region pin with \`bb sandbox set-size --project ${projectId} --provider ${provider} --tier ${tier}\``) +
        ".",
    );
  }

  /** Every size, with the images and pools that can serve it. */
  async sizeTierCatalog(): Promise<SandboxSizeTierView[]> {
    const capacity = await this.deps.daytonaCapacity?.().catch(() => null) ?? null;
    const placement = await this.deps.daytonaPlacement?.().catch(() => null) ?? null;
    const imageProviders = sandboxProviderValues.filter(providerSizesByImage);
    return sandboxSizeTierValues.map((tier) => {
      const spec = sandboxSizeTiers[tier];
      const pools = (capacity?.pools ?? [])
        .filter((pool) => placement === null || pool.sandboxClass === placement.sandboxClass)
        .map((pool) => {
          const reasons = sizeTierPoolViolations(pool, tier);
          return {
            regionId: pool.regionId,
            sandboxClass: pool.sandboxClass,
            fits: reasons.length === 0,
            reasons,
            imageName: this.store.getDefaultImage("daytona", tier, pool.regionId)?.name ?? null,
          };
        });
      return {
        tier,
        label: spec.label,
        cpuCores: spec.cpuCores,
        memoryBytes: spec.memoryBytes,
        diskBytes: spec.diskBytes,
        isDefault: tier === this.deps.config.defaultSizeTier,
        images: imageProviders.map((provider) => ({
          provider,
          image: this.store.getDefaultImage(provider, tier),
        })),
        pools,
      };
    });
  }

  clearSizeProfile(projectId: string, provider: SandboxProvider): boolean {
    return this.store.deleteSizeProfile(projectId, provider);
  }

  /**
   * Apply a new size to one existing sandbox. The backend decides how much of
   * the request its API will accept right now, so the stored target records the
   * intent and the samples keep reporting what the guest actually got.
   */
  async resizeSandbox(
    sandboxId: string,
    resources: SandboxResourceRequest,
  ): Promise<SandboxResizeResult> {
    // Live sandboxes are managed by BB core machine/environment providers now;
    // resizing an existing machine in place is not offered here.
    return {
      sandboxId,
      supported: false,
      reason: "Resizing an existing sandbox is not supported.",
      target: {
        cpuCores: resources.cpuCores ?? null,
        memoryBytes: resources.memoryBytes ?? null,
        diskBytes: resources.diskBytes ?? null,
      },
      provisioned: null,
      restarted: false,
    };
  }


  private async serverVersion(): Promise<string> {
    const version = await this.deps.bbAppVersion?.();
    if (version === undefined) {
      throw new Error("The bb server version is unavailable to the sandboxes plugin");
    }
    return version;
  }

  /**
   * Compare every default image, project pin, and live sandbox with the bb
   * server. With `probe`, machines whose version was never recorded are asked
   * directly, so the first audit after this feature landed fills the gaps.
   */
  async versionAudit(options: {
    previousServerVersion?: string | null;
    probe?: boolean;
  } = {}): Promise<VersionAudit> {
    const serverVersion = await this.serverVersion();
    const seenImages = new Set<string>();
    const defaultImages: SandboxImageRecord[] = [];
    for (const provider of sandboxProviderValues) {
      const images = providerSizesByImage(provider)
        ? this.store.listDefaultImages(provider)
        : [this.store.getDefaultImage(provider)];
      for (const image of images) {
        if (image === null || seenImages.has(image.id)) continue;
        seenImages.add(image.id);
        defaultImages.push(image);
      }
    }
    // Sizes somebody depends on: the plugin default plus every project tier.
    const requiredTiers = new Set<SandboxSizeTier>([this.deps.config.defaultSizeTier]);
    for (const profile of this.store.listSizeProfiles()) {
      if (profile.tier !== null) requiredTiers.add(profile.tier);
    }
    // A provider with no managed images runs on a snapshot named in settings;
    // sizes are not its concern until an image is registered through bb.
    const sizeTiers = sandboxProviderValues
      .filter(providerSizesByImage)
      .filter((provider) => this.store.listDefaultImages(provider).length > 0)
      .flatMap((provider) =>
        sandboxSizeTierValues.map((tier) => ({
          provider,
          tier,
          required: requiredTiers.has(tier),
          image: this.store.getDefaultImage(provider, tier),
        })),
      );
    // Live sandboxes are managed by BB core now, so the audit covers only the
    // image, pin, and size-tier state the plugin still owns.
    const sandboxes: VersionAuditSandboxInput[] = [];
    return auditVersions({
      serverVersion,
      previousServerVersion: options.previousServerVersion ?? null,
      defaultImages,
      pins: [],
      sandboxes,
      sizeTiers,
    });
  }
}
