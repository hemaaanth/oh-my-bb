import type { PluginSettingsValues } from "@get-bb/plugin-sdk";
import type { SandboxProvider } from "./backend.js";
import type { DaytonaSandboxClass } from "./daytona-capacity.js";
import {
  DEFAULT_SANDBOX_SIZE_TIER,
  isSandboxSizeTier,
  sandboxSizeTierValues,
  type SandboxSizeTier,
} from "./size-tiers.js";

export const sandboxIdleSleepOptions = [
  "5 minutes",
  "15 minutes",
  "30 minutes",
  "1 hour",
  "Never",
] as const;

export function sandboxIdleSleepMs(value: string): number | null {
  if (value === "5 minutes") return 5 * 60 * 1_000;
  if (value === "30 minutes") return 30 * 60 * 1_000;
  if (value === "1 hour") return 60 * 60 * 1_000;
  if (value === "Never") return null;
  return 15 * 60 * 1_000;
}

export const sandboxCredentialDescriptors = {
  daytonaApiKey: { type: "string", label: "Daytona API key", secret: true },
  modalTokenId: { type: "string", label: "Modal token ID", secret: true },
  modalTokenSecret: { type: "string", label: "Modal token secret", secret: true },
  e2bApiKey: { type: "string", label: "E2B API key", secret: true },
  boxApiKey: { type: "string", label: "Boat API key", secret: true },
  freestyleApiKey: { type: "string", label: "Freestyle API key", secret: true },
  imageRegistryUsername: { type: "string", label: "Image registry username", secret: true },
  imageRegistryToken: { type: "string", label: "Image registry token", secret: true },
} as const;

export const sandboxSettingDescriptors = {
  sshEnabled: {
    type: "boolean",
    label: "Open sandbox files in local editors",
    description:
      "Enable private Tailscale SSH on sandbox machines and register SSH targets on this BB server machine. Use when this server also runs your editor. Your tailnet must allow SSH to the sandbox tag.",
    default: false,
  },
  sshAuthKey: {
    type: "string",
    label: "Tailscale enrollment key",
    description:
      "Enroll sandbox machines in your tailnet.",
    secret: true,
    default: "",
  },
  sshApiKey: {
    type: "string",
    label: "Tailscale cleanup API key",
    description:
      "Remove retired sandbox devices from Tailscale.",
    secret: true,
    default: "",
  },
  idleSleepAfter: {
    type: "select",
    label: "Auto-sleep after",
    description:
      "Pause providers that support durable sleep after this much thread inactivity. Modal keeps its fixed 24-hour lifetime.",
    options: sandboxIdleSleepOptions.slice(),
    default: "15 minutes",
  },
  defaultSizeTier: {
    type: "select",
    label: "Default sandbox size",
    description:
      "Size new sandboxes start at unless a project sets its own: S is 2 cores, 4 GiB, 10 GiB disk; M is 4/12/20; L is 8/16/40; XL is 16/32/100. Daytona serves a size only from a snapshot registered at that size.",
    options: sandboxSizeTierValues.slice(),
    default: DEFAULT_SANDBOX_SIZE_TIER,
  },
  copyGitHubCliAuth: {
    type: "boolean",
    label: "Copy GitHub CLI login",
    description:
      "Sign the GitHub CLI in to each sandbox with this machine's `gh` login, and use it for git over HTTPS. The token carries every scope granted to `gh auth login`.",
    default: true,
  },
  gitUsername: {
    type: "string",
    label: "Git HTTPS username",
    default: "",
  },
  gitToken: {
    type: "string",
    label: "Git HTTPS token",
    secret: true,
    default: "",
  },
  gitSshPrivateKey: {
    type: "string",
    label: "Git SSH private key",
    secret: true,
    default: "",
  },
  gitKnownHosts: {
    type: "string",
    label: "Git SSH known_hosts",
    secret: true,
    default: "",
  },
  browserUserAgent: {
    type: "string",
    label: "Trusted browser user agent",
    description:
      "Exact User-Agent that `bb-browser` (Brave through agent-browser) sends from every sandbox. Empty keeps Brave's own.",
    default: "",
  },
  browserExitNode: {
    type: "string",
    label: "Trusted browser exit node",
    description:
      "Tailscale exit node (name or 100.x IP) at home that `bb-browser` traffic leaves through. Without one, `bb-browser` refuses to start in a sandbox unless egress is set to direct there.",
    default: "",
  },
  browserHomeEgressIp: {
    type: "string",
    label: "Trusted browser home IP",
    description:
      "Optional public IP (or comma-separated IPs) home egress must come from; `bb-browser` fails when it does not.",
    default: "",
  },
  browserTailscaleAuthKey: {
    type: "string",
    label: "Browser enrollment key",
    description:
      "Optional browser enrollment override.",
    secret: true,
    default: "",
  },
  browserTailscaleAuthKeyFile: {
    type: "string",
    label: "Trusted browser Tailscale auth key file",
    description:
      "Optional mode-0600 dotenv file containing TAILSCALE_AUTH_KEY. The direct secret setting takes precedence.",
    default: "",
  },
  browserStateFile: {
    type: "string",
    label: "Trusted browser auth state file",
    description:
      "Optional manual cookies/localStorage export. A browser paired under Browser cookie sync supplies its state automatically and takes precedence over this file.",
    default: "",
  },

} as const;

export type SandboxSettings = PluginSettingsValues<
  typeof sandboxSettingDescriptors
> & {
  daytonaApiKey: string;
  daytonaApiUrl: string;
  daytonaTarget: string;
  daytonaSandboxClass: string;
  daytonaSnapshot: string;
  modalTokenId: string;
  modalTokenSecret: string;
  modalApp: string;
  modalImageName: string;
  modalVmRuntime: boolean;
  e2bApiKey: string;
  e2bTemplate: string;
  boxApiKey: string;
  boxMachineClass: string;
  boxEnvironment: string;
  freestyleApiKey: string;
  freestyleCpu: string;
  freestyleMemory: string;
  freestyleStorage: string;
  freestylePersistence: string;
  freestyleSnapshotId: string;
  imageRegistry: string;
  imageRegistryUsername: string;
  imageRegistryToken: string;
  imagePlatform: string;
};

/**
 * Every provider that can consume the shared sandbox image by registry
 * reference. Boat and Freestyle bootstrap their toolchain at launch instead.
 */
export const sandboxImageProviders = [
  "daytona",
  "modal",
  "e2b",
] as const satisfies readonly SandboxProvider[];

export type SandboxImageProvider = (typeof sandboxImageProviders)[number];

export function isSandboxImageProvider(
  provider: SandboxProvider,
): provider is SandboxImageProvider {
  return sandboxImageProviders.some((candidate) => candidate === provider);
}

export interface SandboxImageRegistryConfig {
  repository: string;
  username: string | null;
  token: string | null;
  platform: string;
}

export interface SandboxRuntimeConfig {
  daytona: {
    apiKey: string;
    apiUrl?: string;
    snapshot: string;
    target?: string;
    sandboxClass: DaytonaSandboxClass;
  } | null;
  modal: {
    tokenId: string;
    tokenSecret: string;
    appName: string;
    imageName: string;
    vmRuntime: boolean;
  } | null;
  e2b: { apiKey: string; template: string } | null;
  box: {
    apiKey: string;
    machineClass: "small" | "default" | "large";
    environment: string;
  } | null;
  freestyle: {
    apiKey: string;
    cpu: number;
    memoryGb: number;
    storageGb: number;
    persistence: "sticky" | "persistent";
    snapshotId: string | null;
  } | null;
  idleSleepMs: number | null;
  /** Size for projects without a size profile of their own. */
  defaultSizeTier: SandboxSizeTier;
  copyGitHubCliAuth: boolean;
  sandboxEnv: Record<string, string>;
  image: SandboxImageRegistryConfig;
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value) => value);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadSandboxRuntimeConfig(
  settings: SandboxSettings,
  env: NodeJS.ProcessEnv = process.env,
  artifacts: Partial<Record<SandboxProvider, string>> = {},
): SandboxRuntimeConfig {
  const daytonaApiKey = first(settings.daytonaApiKey, env.DAYTONA_API_KEY);
  const daytonaSnapshot = first(
    artifacts.daytona,
    settings.daytonaSnapshot,
    env.BB_SANDBOX_DAYTONA_SNAPSHOT,
  );
  const configuredDaytonaClass = first(
    settings.daytonaSandboxClass,
    env.BB_SANDBOX_DAYTONA_CLASS,
  );
  const modalTokenId = first(settings.modalTokenId, env.MODAL_TOKEN_ID);
  const modalTokenSecret = first(
    settings.modalTokenSecret,
    env.MODAL_TOKEN_SECRET,
  );
  const modalImageName = first(
    artifacts.modal,
    settings.modalImageName,
    env.BB_SANDBOX_MODAL_IMAGE_NAME,
  );
  const e2bApiKey = first(settings.e2bApiKey, env.E2B_API_KEY);
  const e2bTemplate = first(
    artifacts.e2b,
    settings.e2bTemplate,
    env.BB_SANDBOX_E2B_TEMPLATE,
  );
  const boxApiKey = first(settings.boxApiKey, env.BOAT_API_KEY, env.BOX_API_KEY);
  const freestyleApiKey = first(settings.freestyleApiKey, env.FREESTYLE_API_KEY);
  const modalVmRuntimeOverride =
    env.BB_SANDBOX_MODAL_VM_RUNTIME?.trim().toLowerCase();
  const sandboxEnv: Record<string, string> = {};
  const mapped = {
    BB_SANDBOX_GIT_USERNAME: first(
      settings.gitUsername,
      env.BB_SANDBOX_GIT_USERNAME,
    ),
    BB_SANDBOX_GIT_TOKEN: first(settings.gitToken, env.BB_SANDBOX_GIT_TOKEN),
    BB_SANDBOX_GIT_SSH_PRIVATE_KEY: first(
      settings.gitSshPrivateKey,
      env.BB_SANDBOX_GIT_SSH_PRIVATE_KEY,
    ),
    BB_SANDBOX_GIT_KNOWN_HOSTS: first(
      settings.gitKnownHosts,
      env.BB_SANDBOX_GIT_KNOWN_HOSTS,
    ),
  };
  for (const [key, value] of Object.entries(mapped)) {
    if (value !== undefined) sandboxEnv[key] = value;
  }
  return {
    daytona:
      daytonaApiKey === undefined || daytonaSnapshot === undefined
        ? null
        : {
            apiKey: daytonaApiKey,
            snapshot: daytonaSnapshot,
            ...(first(settings.daytonaApiUrl, env.DAYTONA_API_URL) === undefined
              ? {}
              : {
                  apiUrl: first(settings.daytonaApiUrl, env.DAYTONA_API_URL),
                }),
            ...(first(settings.daytonaTarget, env.DAYTONA_TARGET) === undefined
              ? {}
              : {
                  target: first(settings.daytonaTarget, env.DAYTONA_TARGET),
                }),
            sandboxClass:
              configuredDaytonaClass === "linux-vm"
                ? "linux-vm"
                : configuredDaytonaClass === "windows"
                  ? "windows"
                  : "container",
          },
    modal:
      modalTokenId === undefined ||
      modalTokenSecret === undefined ||
      modalImageName === undefined
        ? null
        : {
            tokenId: modalTokenId,
            tokenSecret: modalTokenSecret,
            imageName: modalImageName,
            appName:
              first(settings.modalApp, env.BB_SANDBOX_MODAL_APP) ??
              "bb-sandboxes",
            vmRuntime:
              modalVmRuntimeOverride === undefined ||
              modalVmRuntimeOverride.length === 0
                ? settings.modalVmRuntime
                : modalVmRuntimeOverride === "1" ||
                  modalVmRuntimeOverride === "true",
          },
    e2b:
      e2bApiKey === undefined || e2bTemplate === undefined
        ? null
        : { apiKey: e2bApiKey, template: e2bTemplate },
    box:
      boxApiKey === undefined
        ? null
        : {
            apiKey: boxApiKey,
            machineClass:
              settings.boxMachineClass === "small" || settings.boxMachineClass === "large"
                ? settings.boxMachineClass
                : "default",
            environment: first(settings.boxEnvironment) ?? "base",
          },
    freestyle:
      freestyleApiKey === undefined
        ? null
        : {
            apiKey: freestyleApiKey,
            cpu: positiveNumber(first(settings.freestyleCpu), 4),
            memoryGb: positiveNumber(first(settings.freestyleMemory), 8),
            storageGb: positiveNumber(first(settings.freestyleStorage), 20),
            persistence:
              settings.freestylePersistence === "persistent"
                ? "persistent"
                : "sticky",
            snapshotId: first(settings.freestyleSnapshotId) ?? null,
          },
    idleSleepMs: sandboxIdleSleepMs(settings.idleSleepAfter),
    defaultSizeTier: isSandboxSizeTier(settings.defaultSizeTier)
      ? settings.defaultSizeTier
      : DEFAULT_SANDBOX_SIZE_TIER,
    copyGitHubCliAuth: settings.copyGitHubCliAuth,
    sandboxEnv,
    image: sandboxImageRegistryConfig(settings, env),
  };
}

export function sandboxImageRegistryConfig(
  settings: SandboxSettings,
  env: NodeJS.ProcessEnv = process.env,
): SandboxImageRegistryConfig {
  return {
    repository:
      first(settings.imageRegistry, env.BB_SANDBOX_IMAGE_REGISTRY) ?? "",
    username:
      first(
        settings.imageRegistryUsername,
        env.BB_SANDBOX_IMAGE_REGISTRY_USERNAME,
      ) ?? null,
    token:
      first(
        settings.imageRegistryToken,
        env.BB_SANDBOX_IMAGE_REGISTRY_TOKEN,
      ) ?? null,
    platform:
      first(settings.imagePlatform, env.BB_SANDBOX_IMAGE_PLATFORM) ??
      "linux/amd64",
  };
}

export function sandboxProviderCredentialStatus(
  settings: SandboxSettings,
  env: NodeJS.ProcessEnv = process.env,
): Record<SandboxProvider, boolean> {
  return {
    daytona: first(settings.daytonaApiKey, env.DAYTONA_API_KEY) !== undefined,
    modal:
      first(settings.modalTokenId, env.MODAL_TOKEN_ID) !== undefined &&
      first(settings.modalTokenSecret, env.MODAL_TOKEN_SECRET) !== undefined,
    e2b: first(settings.e2bApiKey, env.E2B_API_KEY) !== undefined,
    box: first(settings.boxApiKey, env.BOAT_API_KEY, env.BOX_API_KEY) !== undefined,
    freestyle: first(settings.freestyleApiKey, env.FREESTYLE_API_KEY) !== undefined,
  };
}
