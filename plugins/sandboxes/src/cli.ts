import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import {
  sandboxProviderValues,
  type SandboxProvider,
  type SandboxProvisionedResources,
  type SandboxResourceRequest,
} from "./backend.js";
import {
  isSandboxImageProvider,
  sandboxImageProviders,
} from "./config.js";
import type { DaytonaCapacity } from "./daytona-capacity.js";
import type {
  SandboxImageBuildRequest,
  SandboxImageJobHandle,
  SandboxImageJobStatus,
  SandboxImageRegistrationTaskRequest,
} from "./image-manager.js";
import type { SandboxManager } from "./manager.js";
import {
  formatSizeTier,
  parseSandboxSizeTier,
  sandboxSizeTierValues,
  type SandboxSizeTier,
} from "./size-tiers.js";
import type { SandboxImageRecord, SandboxRecord } from "./store.js";
import type { VersionAudit } from "./version-audit.js";
import { harnessNames } from "./upgrade.js";
import type { SandboxSshRecord } from "./ssh.js";
import type {
  SandboxUpgradeJobStatus,
  SandboxUpgradeOptions,
  SandboxUpgradeReport,
} from "./upgrade.js";

const providerUsage = sandboxProviderValues.join("|");
const imageProviderUsage = sandboxImageProviders.join("|");

export interface SandboxCliDeps {
  sshStatus?: () => Promise<SandboxSshRecord[]>;
  setupSsh?: (hostId: string) => Promise<SandboxSshRecord>;
  listLegacySandboxes?: () => SandboxRecord[];
  getLegacySandbox?: (idOrHostId: string) => SandboxRecord | null;
  deleteLegacySandbox?: (
    idOrHostId: string,
    options: { allowLiveThreads: boolean },
  ) => Promise<SandboxRecord>;
  setProviderEnabled?: (provider: SandboxProvider, enabled: boolean) => void;
  listImages?: (provider?: SandboxProvider) => SandboxImageRecord[];
  buildImage?: (
    request: SandboxImageBuildRequest,
  ) => Promise<SandboxImageJobHandle>;
  registerImage?: (
    request: SandboxImageRegistrationTaskRequest,
  ) => Promise<SandboxImageJobHandle>;
  imageJob?: (id: string, cursor: number) => SandboxImageJobStatus;
  activateImage?: (imageId: string) => Promise<SandboxImageRecord>;
  daytonaCapacity?: () => Promise<DaytonaCapacity>;
  validateSizeRequest?: (
    provider: SandboxProvider,
    resources: SandboxResourceRequest,
    tier?: SandboxSizeTier,
    regionId?: string | null,
  ) => Promise<void>;
  capacityDoctor?: () => Promise<
    Array<{
      severity: "error" | "warning";
      code: string;
      message: string;
      sandboxId?: string;
    }>
  >;
  /** Images, pins, and machines compared with the bb server's version. */
  versionDoctor?: () => Promise<VersionAudit>;
  startUpgrade?: (options: SandboxUpgradeOptions) => string;
  upgradeJob?: (id: string, cursor: number) => SandboxUpgradeJobStatus;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (index >= 0 && (!value || value.startsWith("--"))) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function isProvider(value: string): value is SandboxProvider {
  return sandboxProviderValues.some((provider) => provider === value);
}

function json(value: unknown): PluginCliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` };
}

const GIB = 1024 ** 3;

function positiveOption(argv: string[], name: string): number | undefined {
  const value = option(argv, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

/** CPU in cores, memory and disk in GiB, matching the provider settings UI. */
function sizeRequest(argv: string[]): SandboxResourceRequest {
  const cpuCores = positiveOption(argv, "--cpu");
  const memoryGib = positiveOption(argv, "--memory");
  const diskGib = positiveOption(argv, "--disk");
  return {
    ...(cpuCores === undefined ? {} : { cpuCores }),
    ...(memoryGib === undefined
      ? {}
      : { memoryBytes: Math.round(memoryGib * GIB) }),
    ...(diskGib === undefined ? {} : { diskBytes: Math.round(diskGib * GIB) }),
  };
}

/** `--tier L`, `--tier large`, or absent. */
function tierOption(argv: string[]): SandboxSizeTier | undefined {
  const value = option(argv, "--tier");
  if (value === undefined) return undefined;
  const tier = parseSandboxSizeTier(value);
  if (tier === null) {
    throw new Error(`--tier must be one of ${sandboxSizeTierValues.join(", ")}`);
  }
  return tier;
}

function formatSize(size: SandboxProvisionedResources): string {
  const parts = [
    size.cpuCores === null ? null : `${size.cpuCores} cores`,
    size.memoryBytes === null
      ? null
      : `${(size.memoryBytes / GIB).toFixed(0)} GiB memory`,
    size.diskBytes === null
      ? null
      : `${(size.diskBytes / GIB).toFixed(0)} GiB disk`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "provider default" : parts.join(" · ");
}

/**
 * The bb CLI's HTTP call into the plugin is killed at five minutes with a bare
 * `fetch failed`, and the SDK exposes no timeout knob, so a watch window has
 * to end short of that and hand back a command to resume with. Work continues
 * server-side either way.
 */
const DEFAULT_WATCH_SECONDS = 240;
const MAX_WATCH_SECONDS = 270;
const POLL_INTERVAL_MS = 2_000;
/** A plain buildx log would blow the plugin CLI output cap on its own. */
const MAX_PROGRESS_LINES = 200;

function watchSeconds(argv: string[]): number {
  if (argv.includes("--no-wait")) return 0;
  const value = option(argv, "--wait");
  if (value === undefined) return DEFAULT_WATCH_SECONDS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--wait must be a number of seconds");
  }
  return Math.min(parsed, MAX_WATCH_SECONDS);
}

function imageProviderOption(argv: string[]): SandboxProvider | undefined {
  const value = option(argv, "--provider");
  if (value === undefined) return undefined;
  if (!isProvider(value) || !isSandboxImageProvider(value)) {
    throw new Error(
      `--provider must be one of ${sandboxImageProviders.join(", ")}`,
    );
  }
  return value;
}

async function watchImageJob(
  imageJob: (id: string, cursor: number) => SandboxImageJobStatus,
  jobId: string,
  seconds: number,
  signal: AbortSignal | undefined,
): Promise<{ status: SandboxImageJobStatus; progress: string[] }> {
  const deadline = Date.now() + seconds * 1_000;
  const progress: string[] = [];
  let cursor = 0;
  for (;;) {
    const status = imageJob(jobId, cursor);
    cursor = status.cursor;
    progress.push(...status.progress);
    if (progress.length > MAX_PROGRESS_LINES) {
      progress.splice(0, progress.length - MAX_PROGRESS_LINES);
    }
    if (status.state !== "running") return { status, progress };
    if (Date.now() >= deadline || signal?.aborted === true) {
      return { status, progress };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function renderImageJob(
  status: SandboxImageJobStatus,
  progress: string[],
  seconds: number,
): PluginCliResult {
  const verb = status.kind === "build" ? "Building" : "Registering";
  const log = progress.length === 0 ? "" : `${progress.join("\n")}\n`;
  if (status.state === "running") {
    return {
      exitCode: 0,
      stdout:
        `${verb} ${status.reference} as ${status.id}.\n` +
        log +
        `Still running after ${seconds}s; it continues on the server. Keep watching:\n` +
        `  bb sandbox image-status ${status.id}\n`,
    };
  }
  const rows =
    status.build === null
      ? status.images.map(
          (image) =>
            `${image.provider}\t${image.status}\t${image.error ?? image.name}`,
        )
      : status.build.registrations.map(
          (registration) =>
            `${registration.provider}\t${registration.status}\t${registration.name ?? registration.message ?? ""}`,
        );
  return {
    exitCode: status.state === "error" ? 1 : 0,
    stdout:
      `${status.kind === "build" ? "Pushed" : "Registered"} ${status.pinnedReference ?? status.reference}.\n` +
      log +
      (rows.length === 0 ? "" : `${rows.join("\n")}\n`),
    ...(status.error === null ? {} : { stderr: `${status.error}\n` }),
  };
}

async function watchUpgrade(
  upgradeJob: (id: string, cursor: number) => SandboxUpgradeJobStatus,
  jobId: string,
  seconds: number,
  signal: AbortSignal | undefined,
): Promise<{ status: SandboxUpgradeJobStatus; progress: string[] }> {
  const deadline = Date.now() + seconds * 1_000;
  const progress: string[] = [];
  let cursor = 0;
  for (;;) {
    const status = upgradeJob(jobId, cursor);
    cursor = status.cursor;
    progress.push(...status.progress);
    if (progress.length > MAX_PROGRESS_LINES) {
      progress.splice(0, progress.length - MAX_PROGRESS_LINES);
    }
    if (status.state !== "running") return { status, progress };
    if (Date.now() >= deadline || signal?.aborted === true) {
      return { status, progress };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function renderUpgradeReport(report: SandboxUpgradeReport): string {
  const image = report.image;
  const imageLine =
    image.action === "built"
      ? `image\tbuilt\t${image.tag ?? "?"}`
      : image.action === "would-build"
        ? `image\twould build\treplaces ${image.reference ?? "?"}`
        : `image\t${image.action}\t${image.reference ?? "-"}`;
  const machineLines = report.machines.map((machine) => {
    const versions =
      machine.versions === null
        ? ""
        : `\t${harnessNames.map(name => `${name} ${machine.versions!.harness[name] ?? "?"}`).join(", ")}; setup ${machine.versions.setupRevision ?? "unknown"}`;
    return `${machine.action}\t${machine.name} (${machine.hostId})${versions}${machine.message === null ? "" : `\t${machine.message}`}`;
  });
  return `${[imageLine, ...machineLines].join("\n")}\n`;
}

function renderUpgrade(
  status: SandboxUpgradeJobStatus,
  progress: string[],
  seconds: number,
): PluginCliResult {
  const log = progress.length === 0 ? "" : `${progress.join("\n")}\n`;
  if (status.state === "running") {
    return {
      exitCode: 0,
      stdout:
        `Upgrade ${status.id}\n` +
        log +
        `Still running after ${seconds}s; it continues on the server. Keep watching:\n` +
        `  bb sandbox upgrade-status ${status.id}\n`,
    };
  }
  return {
    exitCode: status.state === "error" ? 1 : 0,
    stdout: log + (status.report === null ? "" : renderUpgradeReport(status.report)),
    ...(status.error === null ? {} : { stderr: `${status.error}\n` }),
  };
}

export function registerSandboxCli(
  bb: BbPluginApi,
  manager: SandboxManager,
  deps: SandboxCliDeps = {},
): void {
  bb.cli.register({
    name: "sandbox",
    summary: "Manage temporary sandbox machines",
    commands: [
      {
        name: "ssh-status",
        summary: "Show local editor SSH targets and pending Tailscale cleanup",
        usage: "bb sandbox ssh-status [--json]",
      },
      {
        name: "ssh-setup",
        summary: "Configure local editor access to an existing sandbox, resuming it if needed",
        usage: "bb sandbox ssh-setup <host-id> [--json]",
      },
      {
        name: "list",
        summary: "List pre-0.43 legacy sandboxes still tracked by this plugin",
        usage: "bb sandbox list [--json]",
      },
      {
        name: "show",
        summary: "Show one legacy sandbox by sandbox or host id",
        usage: "bb sandbox show <sandbox-id|host-id> [--json]",
      },
      {
        name: "delete",
        summary: "Permanently delete one legacy provider sandbox",
        usage:
          "bb sandbox delete <sandbox-id|host-id> --yes [--force-live-threads] [--json]",
      },
      {
        name: "providers",
        summary: "List provider configuration",
        usage: "bb sandbox providers [--json]",
      },
      {
        name: "provider",
        summary: "Enable or disable a provider for new sandboxes",
        usage:
          `bb sandbox provider <${providerUsage}> <enable|disable> [--json]`,
      },
      {
        name: "capacity",
        summary: "Show live Daytona quota by region and sandbox class",
        usage: "bb sandbox capacity [--json]",
      },
      {
        name: "tiers",
        summary:
          "Show the S/M/L/XL sandbox sizes, which images serve each, and which Daytona pools can host them",
        usage: "bb sandbox tiers [--json]",
      },
      {
        name: "images",
        summary: "List managed provider images",
        usage: `bb sandbox images [--provider <${imageProviderUsage}>] [--json]`,
      },
      {
        name: "register-image",
        summary:
          "Register an image CI already pushed with every configured provider",
        usage: `bb sandbox register-image [--reference <tag>] [--provider <${imageProviderUsage}>] [--tier <${sandboxSizeTierValues.join("|")}>] [--region <id>] [--wait <seconds>|--no-wait] [--json]`,
      },
      {
        name: "image-status",
        summary: "Watch a running sandbox image build or registration",
        usage:
          "bb sandbox image-status <job-id> [--wait <seconds>|--no-wait] [--json]",
      },
      {
        name: "build-image",
        summary:
          "No-CI fallback: build the image with Docker on the bb server, then register it",
        usage: `bb sandbox build-image --local [--provider <${imageProviderUsage}>] [--name <version>] [--wait <seconds>|--no-wait] [--json]`,
      },
      {
        name: "set-image-version",
        summary:
          "Record the bb-app version an image carries, for images built before the version label existed",
        usage: "bb sandbox set-image-version <image-id> <bb-app-version> [--json]",
      },
      {
        name: "activate-image",
        summary: "Use an existing managed image for new sandboxes",
        usage: "bb sandbox activate-image <image-id> [--json]",
      },
      {
        name: "project-images",
        summary: "Show provider images pinned to individual projects",
        usage: "bb sandbox project-images [--project <project-id>] [--json]",
      },
      {
        name: "set-project-image",
        summary: "Pin a managed provider image to one project",
        usage: `bb sandbox set-project-image <image-id> --provider <${providerUsage}> [--project <project-id>] [--json]`,
      },
      {
        name: "clear-project-image",
        summary: "Return one project to the shared provider image",
        usage: `bb sandbox clear-project-image --provider <${providerUsage}> [--project <project-id>] [--json]`,
      },
      {
        name: "size",
        summary: "Show the per-project size profiles new sandboxes start from",
        usage: "bb sandbox size [--project <project-id>] [--json]",
      },
      {
        name: "set-size",
        summary:
          "Set the size new sandboxes for a project get: a tier, or custom dimensions where the provider allows them; --region pins a Daytona region",
        usage:
          `bb sandbox set-size --provider <${providerUsage}> [--project <project-id>] (--tier <${sandboxSizeTierValues.join("|")}> | [--cpu <cores>] [--memory <gib>] [--disk <gib>]) [--region <id>] [--json]`,
      },
      {
        name: "clear-size",
        summary: "Drop a project size profile so the provider default applies",
        usage:
          `bb sandbox clear-size --provider <${providerUsage}> [--project <project-id>] [--json]`,
      },
      {
        name: "resize",
        summary: "Resize one existing sandbox",
        usage:
          "bb sandbox resize <sandbox-id> [--cpu <cores>] [--memory <gib>] [--disk <gib>] [--json]",
      },
      {
        name: "upgrade",
        summary:
          "Rebuild the image with the latest Claude Code, Codex, OMP, FX, and this bb, then heal every live sandbox machine",
        usage:
          "bb sandbox upgrade [--check] [--skip-image|--force-image] [--skip-machines] [--wait <seconds>|--no-wait] [--json]",
      },
      {
        name: "upgrade-status",
        summary: "Watch a running sandbox upgrade",
        usage:
          "bb sandbox upgrade-status <job-id> [--wait <seconds>|--no-wait] [--json]",
      },
      {
        name: "doctor",
        summary:
          "Audit sandboxes: bb versions behind the server, stale image pins, and doomed automation targets",
        usage: "bb sandbox doctor [--json]",
      },
    ],
    async run(argv, context) {
      const [command, ...args] = argv;
      const wantsJson = args.includes("--json");
      if (command === "ssh-status") {
        if (!deps.sshStatus) throw new Error("Sandbox SSH is unavailable");
        const targets = await deps.sshStatus();
        return wantsJson ? json({ targets }) : {
          exitCode: 0,
          stdout: targets.length === 0 ? "No sandbox SSH targets configured.\n" : targets.map((target) => {
            const state = target.retiring ? "cleanup pending" : target.error ? "error" : "configured";
            return `${target.hostId}\t${state}\t${target.authority ?? "-"}${target.error ? `\t${target.error}` : ""}`;
          }).join("\n") + "\n",
        };
      }
      if (command === "ssh-setup") {
        const hostId = args.find((arg) => !arg.startsWith("--"));
        if (!hostId || args.some((arg) => arg !== hostId && arg !== "--json")) throw new Error("Usage: bb sandbox ssh-setup <host-id> [--json]");
        if (!deps.setupSsh) throw new Error("Sandbox SSH is unavailable");
        const target = await deps.setupSsh(hostId);
        return wantsJson ? json(target) : { exitCode: 0, stdout: `${target.hostId}: ${target.authority} registered for local editors.\n` };
      }
      if (command === "list") {
        if (deps.listLegacySandboxes === undefined) {
          throw new Error("Legacy sandbox inventory is unavailable");
        }
        const sandboxes = deps.listLegacySandboxes();
        return wantsJson
          ? json({ sandboxes })
          : {
              exitCode: 0,
              stdout:
                sandboxes.length === 0
                  ? "No legacy sandboxes. Current native sandboxes are managed as BB machines.\n"
                  : `${sandboxes
                      .map(
                        (sandbox) =>
                          `${sandbox.id}\t${sandbox.provider}\t${sandbox.status}\t${sandbox.hostId}\t${sandbox.threadId ?? "unattached"}`,
                      )
                      .join("\n")}\n`,
            };
      }
      if (command === "show") {
        if (deps.getLegacySandbox === undefined) {
          throw new Error("Legacy sandbox inventory is unavailable");
        }
        const id = args.find((arg) => !arg.startsWith("--"));
        if (id === undefined) {
          throw new Error("Usage: bb sandbox show <sandbox-id|host-id>");
        }
        const sandbox = deps.getLegacySandbox(id);
        if (sandbox === null) {
          return { exitCode: 1, stderr: `Legacy sandbox ${id} was not found.\n` };
        }
        return wantsJson
          ? json({ sandbox })
          : {
              exitCode: 0,
              stdout:
                `${sandbox.id}\n` +
                `provider\t${sandbox.provider}\nstatus\t${sandbox.status}\n` +
                `host\t${sandbox.hostId}\nthread\t${sandbox.threadId ?? "unattached"}\n` +
                `provider id\t${sandbox.providerSandboxId ?? "unknown"}\n` +
                (sandbox.error === null ? "" : `error\t${sandbox.error}\n`),
            };
      }
      if (command === "delete") {
        if (deps.deleteLegacySandbox === undefined) {
          throw new Error("Legacy sandbox cleanup is unavailable");
        }
        const id = args.find((arg) => !arg.startsWith("--"));
        if (id === undefined || !args.includes("--yes")) {
          throw new Error(
            "Usage: bb sandbox delete <sandbox-id|host-id> --yes [--force-live-threads]",
          );
        }
        const sandbox = await deps.deleteLegacySandbox(id, {
          allowLiveThreads: args.includes("--force-live-threads"),
        });
        return wantsJson
          ? json({ sandbox })
          : {
              exitCode: sandbox.status === "destroyed" ? 0 : 1,
              stdout:
                sandbox.status === "destroyed"
                  ? `Deleted legacy sandbox ${sandbox.id}.\n`
                  : `Cleanup for ${sandbox.id} is pending: ${sandbox.error ?? sandbox.status}.\n`,
            };
      }
      if (command === "providers") {
        const providers = manager.providers();
        return wantsJson
          ? json({ providers })
          : {
              exitCode: 0,
              stdout: `${providers
                .map(
                  ({ provider, configured, enabled }) =>
                    `${provider}\t${enabled ? "enabled" : "disabled"}\t${configured ? "configured" : "not configured"}`,
                )
                .join("\n")}\n`,
            };
      }
      if (command === "provider") {
        const providerValue = args.find((arg) => isProvider(arg));
        const action = args.find(
          (arg) => arg === "enable" || arg === "disable",
        );
        if (providerValue === undefined || action === undefined) {
          throw new Error(
            `Usage: bb sandbox provider <${providerUsage}> <enable|disable>`,
          );
        }
        if (deps.setProviderEnabled === undefined) {
          throw new Error("Provider settings are unavailable");
        }
        deps.setProviderEnabled(providerValue, action === "enable");
        const provider = manager
          .providers()
          .find((candidate) => candidate.provider === providerValue);
        if (provider === undefined) {
          throw new Error(`Provider ${providerValue} is unavailable`);
        }
        return wantsJson
          ? json({ provider })
          : {
              exitCode: 0,
              stdout: `${action === "enable" ? "Enabled" : "Disabled"} ${providerValue}.\n`,
            };
      }
      if (command === "capacity") {
        if (deps.daytonaCapacity === undefined) {
          throw new Error("Daytona capacity discovery is unavailable");
        }
        const capacity = await deps.daytonaCapacity();
        if (wantsJson) return json({ capacity });
        const rows = capacity.pools.map(
          (pool) =>
            `${pool.regionId}\t${pool.sandboxClass}\t` +
            `${pool.usedCpu}/${pool.totalCpu} CPU\t` +
            `${pool.usedMemoryGiB}/${pool.totalMemoryGiB} GiB RAM\t` +
            `${pool.usedDiskGiB}/${pool.totalDiskGiB} GiB disk\t` +
            `max ${pool.maxCpuPerSandbox ?? "—"} CPU/${pool.maxMemoryGiBPerSandbox ?? "—"} GiB/${pool.maxDiskGiBPerSandbox ?? "—"} GiB`,
        );
        return {
          exitCode: 0,
          stdout:
            rows.length === 0
              ? "No Daytona capacity pools are available.\n"
              : `${rows.join("\n")}\n`,
        };
      }
      if (command === "images") {
        if (deps.listImages === undefined) {
          throw new Error("Image management is unavailable");
        }
        const providerValue = option(args, "--provider");
        if (providerValue !== undefined && !isProvider(providerValue)) {
          throw new Error(`--provider must be one of ${sandboxProviderValues.join(", ")}`);
        }
        const images = deps.listImages(providerValue);
        return wantsJson
          ? json({ images })
          : {
              exitCode: 0,
              stdout:
                images.length === 0
                  ? "No managed images.\n"
                  : `${images
                      .map(
                        (image) =>
                          `${image.provider}\t${image.status}\t${image.isDefault ? "active" : "history"}\t${image.sizeTier ?? "-"}\t${image.name}`,
                      )
                      .join("\n")}\n`,
            };
      }
      if (
        command === "build-image" ||
        command === "register-image" ||
        command === "image-status"
      ) {
        if (deps.imageJob === undefined) {
          throw new Error("Image management is unavailable");
        }
        let jobId: string;
        if (command === "image-status") {
          const requested = args.find((arg) => !arg.startsWith("--"));
          if (requested === undefined) {
            throw new Error("Usage: bb sandbox image-status <job-id>");
          }
          jobId = requested;
        } else if (command === "register-image") {
          if (deps.registerImage === undefined) {
            throw new Error("Image registration is unavailable");
          }
          const provider = imageProviderOption(args);
          const reference = option(args, "--reference");
          const sizeTier = tierOption(args);
          const regionId = option(args, "--region");
          const handle = await deps.registerImage({
            ...(provider === undefined ? {} : { provider }),
            ...(reference === undefined ? {} : { reference }),
            ...(sizeTier === undefined ? {} : { sizeTier }),
            ...(regionId === undefined ? {} : { regionId }),
          });
          jobId = handle.id;
        } else {
          if (deps.buildImage === undefined) {
            throw new Error("Image building is unavailable");
          }
          if (!args.includes("--local")) {
            throw new Error(
              "GitHub Actions builds and pushes the sandbox image; register it with `bb sandbox register-image`. Pass --local to build it with Docker on this server instead.",
            );
          }
          const provider = imageProviderOption(args);
          const name = option(args, "--name");
          const sizeTier = tierOption(args);
          const regionId = option(args, "--region");
          const handle = await deps.buildImage({
            ...(provider === undefined ? {} : { provider }),
            ...(name === undefined ? {} : { name }),
            ...(sizeTier === undefined ? {} : { sizeTier }),
            ...(regionId === undefined ? {} : { regionId }),
          });
          jobId = handle.id;
        }
        const seconds = watchSeconds(args);
        const { status, progress } = await watchImageJob(
          deps.imageJob,
          jobId,
          seconds,
          context.signal,
        );
        return wantsJson
          ? json({ job: status, progress })
          : renderImageJob(status, progress, seconds);
      }
      if (command === "activate-image") {
        if (deps.activateImage === undefined) {
          throw new Error("Image activation is unavailable");
        }
        const imageId = args.find((arg) => !arg.startsWith("--"));
        if (imageId === undefined) {
          throw new Error("Usage: bb sandbox activate-image <image-id>");
        }
        const image = await deps.activateImage(imageId);
        return wantsJson
          ? json({ image })
          : { exitCode: 0, stdout: `Activated ${image.name}.\n` };
      }
      if (command === "set-image-version") {
        const [imageId, version] = args.filter((arg) => !arg.startsWith("--"));
        if (!imageId || !version) {
          throw new Error(
            "Usage: bb sandbox set-image-version <image-id> <bb-app-version>",
          );
        }
        if (!/^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/u.test(version)) {
          throw new Error(`${version} is not a bb-app version such as 0.42.0`);
        }
        const image = manager.setImageBbAppVersion(imageId, version);
        return wantsJson
          ? json({ image })
          : {
              exitCode: 0,
              stdout: `${image.name} (${image.provider}) carries bb-app ${image.bbAppVersion}.\n`,
            };
      }
      if (command === "project-images") {
        const projectId = option(args, "--project") ?? context.projectId;
        const profiles = manager.projectImages(projectId ?? undefined);
        return wantsJson
          ? json({ profiles })
          : {
              exitCode: 0,
              stdout: profiles.length === 0
                ? "No project-specific images; projects use provider defaults.\n"
                : `${profiles.map((profile) =>
                    `${profile.projectId}\t${profile.provider}\t${profile.imageName}`
                  ).join("\n")}\n`,
            };
      }
      if (command === "set-project-image" || command === "clear-project-image") {
        const projectId = option(args, "--project") ?? context.projectId;
        const providerValue = option(args, "--provider");
        if (!projectId) throw new Error("--project is required outside a project thread");
        if (!providerValue || !isProvider(providerValue)) {
          throw new Error(`--provider must be one of ${sandboxProviderValues.join(", ")}`);
        }
        if (command === "clear-project-image") {
          const removed = manager.clearProjectImage(projectId, providerValue);
          return wantsJson ? json({ removed }) : {
            exitCode: 0,
            stdout: removed
              ? `Cleared the ${providerValue} image pin for ${projectId}.\n`
              : `No ${providerValue} image pin for ${projectId}.\n`,
          };
        }
        const imageId = args.find((arg) => !arg.startsWith("--") && arg !== providerValue && arg !== projectId);
        if (!imageId) throw new Error("Usage: bb sandbox set-project-image <image-id> --provider <provider>");
        const profile = manager.setProjectImage(projectId, providerValue, imageId);
        return wantsJson ? json({ profile }) : {
          exitCode: 0,
          stdout: `${projectId} will use ${profile.imageName} on ${providerValue}.\n`,
        };
      }
      if (command === "size") {
        const projectId = option(args, "--project") ?? context.projectId;
        const profiles = manager.sizeProfiles(projectId ?? undefined);
        if (wantsJson) return json({ profiles });
        return {
          exitCode: 0,
          stdout:
            profiles.length === 0
              ? "No size profiles; new sandboxes use the provider default.\n"
              : `${profiles
                  .map(
                    (profile) =>
                      `${profile.projectId}\t${profile.provider}\t${profile.source}\t${profile.tier === null ? "custom" : profile.tier}\t${formatSize(profile)}${profile.regionId === null ? "" : `\tregion ${profile.regionId}`}`,
                  )
                  .join("\n")}\n`,
        };
      }
      if (command === "set-size" || command === "clear-size") {
        const projectId = option(args, "--project") ?? context.projectId;
        const providerValue = option(args, "--provider");
        if (!projectId) {
          throw new Error("--project is required outside a project thread");
        }
        if (!providerValue || !isProvider(providerValue)) {
          throw new Error(`--provider must be one of ${sandboxProviderValues.join(", ")}`);
        }
        if (command === "clear-size") {
          const removed = manager.clearSizeProfile(projectId, providerValue);
          return wantsJson
            ? json({ removed })
            : {
                exitCode: 0,
                stdout: removed
                  ? `Cleared the ${providerValue} size profile for ${projectId}.\n`
                  : `No ${providerValue} size profile for ${projectId}.\n`,
              };
        }
        const requested = sizeRequest(args);
        const tier = tierOption(args);
        const regionId = option(args, "--region") ?? null;
        if (tier !== undefined && Object.keys(requested).length > 0) {
          throw new Error("Pass either --tier or --cpu/--memory/--disk, not both");
        }
        if (tier === undefined && Object.keys(requested).length === 0) {
          throw new Error(
            `bb sandbox set-size needs --tier <${sandboxSizeTierValues.join("|")}> or --cpu/--memory/--disk`,
          );
        }
        await deps.validateSizeRequest?.(providerValue, requested, tier, regionId);
        const profile = manager.setSizeProfile({
          projectId,
          provider: providerValue,
          cpuCores: requested.cpuCores ?? null,
          memoryBytes: requested.memoryBytes ?? null,
          diskBytes: requested.diskBytes ?? null,
          tier: tier ?? null,
          regionId,
          source: "manual",
        });
        return wantsJson
          ? json({ profile })
          : {
              exitCode: 0,
              stdout:
                `New ${providerValue} sandboxes for ${projectId}: ${profile.tier === null ? formatSize(profile) : formatSizeTier(profile.tier)}${profile.regionId === null ? "" : ` in ${profile.regionId}`}.\n`,
            };
      }
      if (command === "tiers") {
        const tiers = await manager.sizeTierCatalog();
        if (wantsJson) return json({ tiers });
        const lines = tiers.flatMap((tier) => {
          const head = `${tier.tier}${tier.isDefault ? " (default)" : ""}\t${formatSizeTier(tier.tier).replace(/^\w+ · /u, "")}`;
          const images = tier.images.map(
            ({ provider, image }) =>
              `\t${provider} image: ${image === null ? "none registered" : `${image.name} (bb-app ${image.bbAppVersion ?? "?"})`}`,
          );
          const pools = tier.pools.map(
            (pool) =>
              `\t${pool.regionId}/${pool.sandboxClass}: ${pool.fits ? "fits" : `no (${pool.reasons.join("; ")})`}${pool.imageName === null ? "" : ` · ${pool.imageName}`}`,
          );
          return [head, ...images, ...pools];
        });
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }
      if (command === "resize") {
        const id = args.find((arg) => !arg.startsWith("--"));
        if (!id) throw new Error("Usage: bb sandbox resize <sandbox-id>");
        const requested = sizeRequest(args);
        if (Object.keys(requested).length === 0) {
          throw new Error("bb sandbox resize needs --cpu, --memory, or --disk");
        }
        const result = await manager.resizeSandbox(id, requested);
        if (wantsJson) {
          return { ...json({ resize: result }), exitCode: result.supported ? 0 : 1 };
        }
        return {
          exitCode: result.supported ? 0 : 1,
          ...(result.supported
            ? { stdout: `${id} target size: ${formatSize(result.target)}.\n` }
            : {
                stderr:
                  `${(result.reason ?? "This sandbox cannot be resized").replace(/[.!?]+$/u, "")}\.\n`,
              }),
        };
      }
      if (command === "upgrade" || command === "upgrade-status") {
        if (deps.startUpgrade === undefined || deps.upgradeJob === undefined) {
          throw new Error("Sandbox upgrades are unavailable");
        }
        let jobId: string;
        if (command === "upgrade-status") {
          const requested = args.find((arg) => !arg.startsWith("--"));
          if (requested === undefined) {
            throw new Error("Usage: bb sandbox upgrade-status <job-id>");
          }
          jobId = requested;
        } else {
          if (args.includes("--skip-image") && args.includes("--force-image")) {
            throw new Error("--skip-image and --force-image contradict each other");
          }
          jobId = deps.startUpgrade({
            // --dry-run is the old spelling of --check.
            check: args.includes("--check") || args.includes("--dry-run"),
            skipImage: args.includes("--skip-image"),
            skipMachines: args.includes("--skip-machines"),
            forceImage: args.includes("--force-image"),
          });
        }
        const seconds = watchSeconds(args);
        const { status, progress } = await watchUpgrade(
          deps.upgradeJob,
          jobId,
          seconds,
          context.signal,
        );
        if (wantsJson) {
          return { ...json(status), exitCode: status.state === "error" ? 1 : 0 };
        }
        return renderUpgrade(status, progress, seconds);
      }
      if (command === "doctor") {
        const [capacityFindings, versions] = await Promise.all([
          deps.capacityDoctor?.() ?? Promise.resolve([]),
          deps.versionDoctor?.() ?? Promise.resolve(null),
        ]);
        const versionFindings = versions?.findings ?? [];
        const hasErrors =
          capacityFindings.some((finding) => finding.severity === "error") ||
          versionFindings.some((finding) => finding.severity === "error");
        if (wantsJson) {
          return {
            ...json({ capacityFindings, versions }),
            exitCode: hasErrors ? 1 : 0,
          };
        }
        const capacityLines = capacityFindings.map(
          (finding) =>
            `${finding.severity.toUpperCase()}\tDaytona ${finding.code}${finding.sandboxId === undefined ? "" : ` ${finding.sandboxId}`}: ${finding.message}`,
        );
        const versionLines = versionFindings.map(
          (finding) =>
            `${finding.severity.toUpperCase()}\tbb ${finding.code}: ${finding.message}` +
            (finding.fix === null ? "" : `\n\tfix: ${finding.fix}`),
        );
        const lines = [...capacityLines, ...versionLines];
        const header =
          versions === null
            ? ""
            : `bb ${versions.serverVersion}${
                versions.previousServerVersion === null
                  ? ""
                  : ` (upgraded from ${versions.previousServerVersion})`
              }: ${versions.pins.length} project pin(s)\n`;
        return {
          exitCode: hasErrors ? 1 : 0,
          stdout:
            header +
            (lines.length === 0
              ? "No issues found.\n"
              : `${lines.join("\n")}\n`),
        };
      }
      return {
        exitCode: 2,
        stderr:
          "Usage: bb sandbox <list|show|delete|providers|provider|capacity|tiers|images|register-image|image-status|build-image|activate-image|project-images|set-project-image|clear-project-image|size|set-size|clear-size|resize|upgrade|doctor|ssh-status|ssh-setup> [options]\n",
      };
    },
  });
}
