import { imageRecipePreference, imageTools, imageRecipeSchema } from "./image-tools.js";
import { registerRuntimeEnvironment } from "./runtime-environment.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sandboxIntegrations } from "./preferences.js";
import { compatibleBrowserArtifacts } from "./browser-artifact.js";
import { loadSandboxSettings } from "./settings-preferences.js";
import { registerBrowserIntegration } from "./browser-integration.js";
import {registerDesktops} from "./desktop.js";
import { registerSandboxCli } from "./cli.js";
import { runHostCommand } from "./host-command.js";
import { SandboxSsh } from "./ssh.js";
import { SandboxSshDesktop } from "./ssh-desktop.js";
import { provisionTrustedBrowser } from "./trusted-browser.js";
import { registerSandboxBackend } from "./provider/register.js";
import type { SandboxBackend } from "./provider/sandbox-backend.js";
import type { PluginMachineProviderResource } from "@get-bb/plugin-sdk/machine-provider";
import { createDaytonaMachineBackend } from "./provider/backends/daytona.js";
import { createModalMachineBackend } from "./provider/backends/modal.js";
import { createFreestyleMachineBackend } from "./provider/backends/freestyle.js";
import { createBoxMachineBackend } from "./provider/backends/box.js";
import { createE2bMachineBackend } from "./provider/backends/e2b.js";
import { registerNativeProjectEnvironmentSync } from "./provider/project-env.js";
import { registerNativeIdleSuspend } from "./provider/idle-suspend.js";
import { LegacySandboxCleanup } from "./legacy-cleanup.js";
import { resolveNativeThreadStatuses } from "./provider/sidebar-status.js";
import { nativeThreadResources } from "./provider/machine-panel.js";
import { readModelRoute } from "./model-route.js";
import { createNativeAttachments } from "./provider/native-attachments.js";
import {
  loadSandboxRuntimeConfig,
  sandboxImageProviders,
  sandboxImageRegistryConfig,
  sandboxProviderCredentialStatus,
} from "./config.js";
import { sandboxRpcContract } from "./contract.js";
import {
  SandboxManager,
  type SandboxThreadResourcesView,
} from "./manager.js";
import { buildAndPushSandboxImage } from "./build-image.js";
import {
  readRegistryImageLabel,
  registerSandboxImage,
  resolveRegistryImage,
} from "./register-image.js";
import {
  sizeTierPoolViolations,
  smallestSizeTierCovering,
  type SandboxSizeTier,
} from "./size-tiers.js";
import {
  discoverDaytonaCapacity,
  selectedDaytonaPool,
  validateDaytonaResources,
  type DaytonaCapacity,
  type DaytonaPlacement,
} from "./daytona-capacity.js";
import {
  sandboxMigrations,
  SandboxStore,
  type SandboxImageRecord,
} from "./store.js";
import {
  sandboxProviderValues,
  type SandboxProvider,
  type SandboxResourceRequest,
} from "./backend.js";
import {
  imageComponentsFor,
  normalizeExtraPackages,
} from "./image-catalog.js";
import { SandboxImageManager } from "./image-manager.js";
import { SandboxProviderConfigurationStore } from "./provider-configuration.js";
import { prepareGatewayHarnesses, SandboxUpgrader } from "./upgrade.js";
import { gatewaySetupOnHost } from "./gateway-setup.js";
import {
  latestHarnessVersions,
  readImageVersions,
} from "./upgrade-sources.js";

const projectContextSchema = z.object({
  projectId: z.string(),
  credentialId: z.string().uuid().nullable(),
  agentIds: z.array(z.string().uuid()),
  bundleIds: z.array(z.string().uuid()),
}).passthrough();
const projectEnvironmentSnapshotSchema = z.object({
  profiles: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    environmentName: z.string(),
    tokenConfigured: z.boolean(),
    capabilities: z.array(z.string()),
  }).passthrough()),
  capabilities: z.array(z.object({
    id: z.string(),
    name: z.string(),
    command: z.string(),
    description: z.string(),
  }).passthrough()),
}).passthrough();
const catalogSnapshotSchema = z.object({
  skills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    sourceId: z.string().optional(),
    sourceName: z.string().optional(),
    description: z.string(),
    enabled: z.boolean(),
  }).passthrough()),
  bundles: z.array(z.object({
    id: z.string().uuid(),
    skillIds: z.array(z.string()),
  }).passthrough()),
}).passthrough();
const agentProfilesSchema = z.array(z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
}).passthrough());
const taskWorkspaceSnapshotSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    status: z.enum(["triage", "backlog", "todo", "doing", "blocked", "review", "done", "cancelled"]),
    hidden: z.boolean(),
    projectId: z.string().nullable(),
    threadId: z.string().nullable(),
    owner: z.object({ isMe: z.boolean() }).nullable(),
    refs: z.array(z.object({ priority: z.enum(["urgent", "high", "medium", "low"]).nullable() })),
  })),
});
const taskProviderHealthSchema = z.array(z.object({
  provider: z.enum(["akiflow", "linear", "github"]),
  enabled: z.boolean(),
  status: z.enum(["ok", "disabled", "unconfigured", "stale", "error"]),
  lastError: z.string().nullable(),
}));
const urgentTaskStatuses = ["backlog", "todo", "doing", "blocked", "review"] as const;
type UrgentTaskStatus = typeof urgentTaskStatuses[number];

/** The header's answer for a thread that is not on a sandbox host. */
const UNMANAGED_THREAD_RESOURCES: SandboxThreadResourcesView = {
  managed: false,
  sandboxId: null,
  provider: null,
  state: null,
  capability: "unknown",
  capabilityReason: null,
  latest: null,
  provisioned: null,
  target: null,
  assessment: null,
  stale: false,
  sampleError: null,
};

const SANDBOX_MANAGEMENT_AGENT_INSTRUCTIONS =
  'Create current sandboxes by selecting a Sandboxes environment when starting a BB thread; BB core owns those native machines and retires them after their last thread is archived. `bb sandbox list|show|delete` exists only for pre-0.43 legacy records while they are migrated or retired, and deletion requires `--yes` (plus `--force-live-threads` if an unarchived thread still uses the host). Use `bb sandbox capacity` for Daytona quota and `bb sandbox doctor` for configuration and version findings.';

export const SANDBOX_AGENT_INSTRUCTIONS =
  'If `IS_SANDBOX=1`, use the sandbox preview supervisor for every HTTP preview, even if generic preview or server-sharing instructions suggest another command. Inside a sandbox, always launch and share HTTP dev servers with `bb-sandbox-preview start --port <port> --name <name> --cwd "$PWD" -- <command> [args...]`. This is the canonical sandbox preview workflow and supersedes generic server-sharing guidance: it durably registers the launch command, supervises it, restores it when the machine boots, creates the bb Connect share before launch, and supplies its URL to the app as `BB_PREVIEW_URL`. Use `--public-url-env <name>` when the app has its own environment-variable contract for the browser-visible origin. For an app that intentionally accepts only one loopback hostname, add `--canonical-origin http://localhost:<app-port>` and use a different share port; the supervisor proxies HTTP and WebSockets while preserving that canonical origin. Do not start the server separately. Do not use bare `bb connect expose` for HTTP previews; reserve it for one-off non-HTTP ports such as VNC. Use `bb-sandbox-preview list` or `bb-sandbox-preview stop <name>` to inspect or remove registered previews.';

function isUrgentTaskStatus(status: string): status is UrgentTaskStatus {
  return urgentTaskStatuses.some((candidate) => candidate === status);
}

function taskProviderProblemMessage(entry: z.infer<typeof taskProviderHealthSchema>[number]): string {
  if (entry.status === "unconfigured") return "not configured";
  if (entry.status === "stale") return "credentials expired or invalid";
  if (entry.status === "error") return entry.lastError ?? "last sync failed";
  return "unavailable";
}

export default async function plugin(bb: BbPluginApi) {
  try {
    registerRuntimeEnvironment(bb);
    const settings = await loadSandboxSettings(bb);
    const integrations = sandboxIntegrations(bb);
    const recipe = imageRecipePreference(bb);
    const requireIntegration = async (name: Parameters<typeof integrations.enabled>[0]) => {
      if (!await integrations.enabled(name)) throw new Error(`Enable ${name} under Sandboxes → Oh My BB first`);
    };
    const db = bb.storage.database();
    registerDesktops(bb,()=>idleSuspendHolds??undefined);
    registerBrowserIntegration(bb, () => settings.get(), join(dirname(db.name), "browser-cookies"), () => idleSuspendHolds ?? undefined);
    const ssh = new SandboxSsh(bb, () => settings.get(), new SandboxSshDesktop(
      dirname(db.name), join(os.homedir(), ".ssh", "config"), () => bb.server.loopbackBaseUrl,
    ));
    const prepareSsh = async (hostId: string) => {
      const current = await settings.get();
      if (!current.sshEnabled) throw new Error("Enable sandbox SSH in Settings → Sandboxes first");
      const host = await bb.sdk.hosts.get({ hostId });
      if (!sandboxProviderValues.some((provider) => host.machineProviderId === `sandbox-${provider}`)) throw new Error("SSH setup only applies to Sandboxes machines");
      if (host.lifecycle?.phase === "suspended") await bb.sdk.hosts.experimental_resume({ hostId });
      await ssh.ensure(hostId);
      return (await ssh.list()).find((record) => record.hostId === hostId)!;
    };
    bb.onDispose(() => ssh.dispose());
    bb.events.on("experimental_host.deleted", ({ host }) =>
      ssh.retire(host.id).catch(() => bb.log.warn(`SSH cleanup pending for ${host.id}; run bb sandbox ssh-status`)));
    bb.background.schedule("sandbox-ssh-reconcile", "*/5 * * * *", () => ssh.reconcile());
    if ((await settings.get()).sshEnabled || (await ssh.list()).length > 0) {
      bb.background.service("sandbox-ssh-startup", {
        async start(signal) {
          await ssh.reconcile();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      });
    }
    settings.onChange(() => {
      void ssh.reconcile().catch(() => bb.log.warn("Could not reconcile sandbox SSH; run bb sandbox ssh-status"));
    });
    bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);
    const interruptedImageBuilds = store.failInterruptedImageBuilds();
    if (interruptedImageBuilds > 0) {
      bb.log.warn(
        `Marked ${interruptedImageBuilds} interrupted sandbox image build(s) as failed`,
      );
    }
    const providerConfiguration = new SandboxProviderConfigurationStore(db.name);
    const selectedArtifacts = () => {
      const result: Partial<Record<SandboxProvider, string>> = {};
      for (const provider of sandboxProviderValues) {
        const image = store.getDefaultImage(provider);
        if (image !== null) result[provider] = image.name;
      }
      return result;
    };
    const combinedSettings = async () => {
      const [
        shared, providers, daytonaApiKey, modalTokenId, modalTokenSecret,
        e2bApiKey, boxApiKey, freestyleApiKey,
        imageRegistryUsername, imageRegistryToken,
      ] =
        await Promise.all([
          settings.get(),
          providerConfiguration.getConfiguration(),
          providerConfiguration.getSecret("daytonaApiKey"),
          providerConfiguration.getSecret("modalTokenId"),
          providerConfiguration.getSecret("modalTokenSecret"),
          providerConfiguration.getSecret("e2bApiKey"),
          providerConfiguration.getSecret("boxApiKey"),
          providerConfiguration.getSecret("freestyleApiKey"),
          providerConfiguration.getSecret("imageRegistryUsername"),
          providerConfiguration.getSecret("imageRegistryToken"),
        ]);
      return {
        ...shared,
        daytonaApiKey: shared.daytonaApiKey ?? daytonaApiKey,
        daytonaApiUrl: providers.daytona.apiUrl,
        daytonaTarget: providers.daytona.target,
        daytonaSandboxClass: providers.daytona.sandboxClass,
        daytonaSnapshot: "",
        modalTokenId: shared.modalTokenId ?? modalTokenId,
        modalTokenSecret: shared.modalTokenSecret ?? modalTokenSecret,
        modalApp: providers.modal.appName,
        modalImageName: "",
        modalVmRuntime: providers.modal.vmRuntime,
        e2bApiKey: shared.e2bApiKey ?? e2bApiKey,
        e2bTemplate: "",
        boxApiKey: shared.boxApiKey ?? boxApiKey,
        boxMachineClass: providers.box.machineClass,
        boxEnvironment: providers.box.environment,
        freestyleApiKey: shared.freestyleApiKey ?? freestyleApiKey,
        freestyleCpu: providers.freestyle.cpu,
        freestyleMemory: providers.freestyle.memory,
        freestyleStorage: providers.freestyle.storage,
        freestylePersistence: providers.freestyle.persistence,
        freestyleSnapshotId: providers.freestyle.snapshotId,
        imageRegistry: providers.image.repository,
        imageRegistryUsername: shared.imageRegistryUsername ?? imageRegistryUsername,
        imageRegistryToken: shared.imageRegistryToken ?? imageRegistryToken,
        imagePlatform: providers.image.platform,
      };
    };
    const loadDaytonaCapacity = async (): Promise<DaytonaCapacity> => {
      const current = await combinedSettings();
      if (!current.daytonaApiKey.trim()) {
        throw new Error("Configure the Daytona API key first");
      }
      return discoverDaytonaCapacity({
        apiKey: current.daytonaApiKey,
        ...(current.daytonaApiUrl.trim()
          ? { apiUrl: current.daytonaApiUrl }
          : {}),
      });
    };
    const configuredDaytonaPlacement = async (): Promise<DaytonaPlacement> => {
      const providerConfig = await providerConfiguration.getConfiguration();
      if (!providerConfig.daytona.target) {
        throw new Error("Select a Daytona capacity pool first");
      }
      return {
        regionId: providerConfig.daytona.target,
        sandboxClass:
          providerConfig.daytona.sandboxClass === "linux-vm"
            ? "linux-vm"
            : providerConfig.daytona.sandboxClass === "windows"
              ? "windows"
              : "container",
      };
    };
    const validateDaytonaSizeRequest = async (
      resources: SandboxResourceRequest,
    ) => {
      const [capacity, placement] = await Promise.all([
        loadDaytonaCapacity(),
        configuredDaytonaPlacement(),
      ]);
      const pool = selectedDaytonaPool(capacity, placement);
      if (pool === null) {
        throw new Error(
          `Daytona capacity pool ${placement.regionId}/${placement.sandboxClass} is unavailable`,
        );
      }
      validateDaytonaResources(pool, resources);
    };
    /**
     * A size must be one Daytona can actually host: a custom size against the
     * configured pool's live quota, a tier against the per-sandbox limits of
     * the pool it will land in. Other providers take any size at create.
     */
    const validateSizeRequest = async (
      provider: SandboxProvider,
      resources: SandboxResourceRequest,
      tier: SandboxSizeTier | undefined,
      regionId: string | null,
    ) => {
      if (provider !== "daytona") return;
      if (tier === undefined) {
        await validateDaytonaSizeRequest(resources);
        return;
      }
      const [capacity, configured] = await Promise.all([
        loadDaytonaCapacity(),
        configuredDaytonaPlacement(),
      ]);
      const placement = {
        regionId: regionId ?? configured.regionId,
        sandboxClass: configured.sandboxClass,
      };
      const pool = selectedDaytonaPool(capacity, placement);
      if (pool === null) {
        throw new Error(
          `Daytona capacity pool ${placement.regionId}/${placement.sandboxClass} is unavailable`,
        );
      }
      const violations = sizeTierPoolViolations(pool, tier);
      if (violations.length > 0) {
        throw new Error(
          `${placement.regionId} ${placement.sandboxClass} cannot host size ${tier}: ${violations.join("; ")}`,
        );
      }
    };
    const validateImagePlacement = async (
      image: SandboxImageRecord,
    ) => {
      if (image.provider !== "daytona") return;
      const placement = await configuredDaytonaPlacement();
      if (image.regionId === null || image.sandboxClass === null) {
        throw new Error(
          `Daytona snapshot ${image.name} has no placement metadata; rebuild it for ${placement.regionId}/${placement.sandboxClass}`,
        );
      }
      if (
        image.regionId !== placement.regionId ||
        image.sandboxClass !== placement.sandboxClass
      ) {
        throw new Error(
          `Daytona snapshot ${image.name} belongs to ${image.regionId}/${image.sandboxClass}, not selected pool ${placement.regionId}/${placement.sandboxClass}`,
        );
      }
    };
    const config = loadSandboxRuntimeConfig(
      await combinedSettings(),
      process.env,
      selectedArtifacts(),
    );
    // BB 0.43 native environment/machine provider (experimental, additive).
    // Registered alongside the legacy launcher during the vendor-by-vendor
    // migration; core owns thread creation, enrollment, checkout and progress.
    // Resolve a project's pinned size tier for the native create path: the
    // machine inputs control has no project context, so the per-project default
    // (e.g. XL for Rust builds) is applied server-side from the allocation key
    // (thread id) → project → stored size profile. Explicit picks still win.
    // Allocation key (thread id) → project, or null for a machine with no
    // project environment.
    const resolveProject = async (
      key: string,
    ): Promise<{ id: string; name: string } | null> => {
      const thread = await bb.sdk.threads.get({ threadId: key });
      if (thread.environmentId === null) return null;
      const environment = await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      });
      const project = await bb.sdk.projects.get({ projectId: environment.projectId });
      return { id: environment.projectId, name: project.name };
    };
    const resolveProjectSizeDefaults = async (
      provider: SandboxProvider,
      key: string,
    ): Promise<Record<string, unknown>> => {
      try {
        const thread = await bb.sdk.threads.get({ threadId: key });
        if (thread.environmentId === null) return {};
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        const profile = store.getSizeProfile(environment.projectId, provider);
        if (profile === null) return {};
        const tier =
          profile.tier ??
          smallestSizeTierCovering({
            ...(profile.cpuCores !== null ? { cpuCores: profile.cpuCores } : {}),
            ...(profile.memoryBytes !== null
              ? { memoryBytes: profile.memoryBytes }
              : {}),
            ...(profile.diskBytes !== null
              ? { diskBytes: profile.diskBytes }
              : {}),
          });
        return tier === null ? {} : { size: tier };
      } catch {
        return {};
      }
    };
    const optionsFor = (provider: SandboxProvider) => ({
      now: () => Date.now(),
      requireRuntime: async () => {
        const installed = await bb.sdk.plugins.list();
        if (!installed.plugins.some(plugin => plugin.id === "model-gateway" && plugin.enabled && plugin.status === "running")) {
          throw new Error("Sandboxes managed model access requires Model Gateway running and configured before creating or resuming a machine; no local-login fallback is provided");
        }
      },
      onConnected: async (hostId: string) => {
        // Shared by every provider, including resume. SSH failure must not block agents.
        await ssh.ensure(hostId).catch(() => bb.log.warn(`SSH setup failed for ${hostId}; run bb sandbox ssh-status`));
        // Native bootstrap installs the daemon without replaying the image
        // entrypoint. Start the durable preview supervisor after every connect,
        // including resume, so saved launch specs are reconciled again.
        try {
          const result = await runHostCommand(bb, {
            hostId,
            cwd: null,
            // Older images have `supervise` but predate the `ensure` command.
            // Spawn it detached so closing this temporary terminal cannot stop it.
            command: `bb-sandbox-preview ensure 2>/dev/null || node -e 'const {spawn}=require("node:child_process"); const child=spawn("bb-sandbox-preview",["supervise"],{detached:true,stdio:"ignore"}); child.unref()'`,
            title: "Restore sandbox previews",
            timeoutMs: 30_000,
          });
          if (result.exitCode !== 0) {
            bb.log.warn(`Preview restore on ${hostId}: ${result.output}`);
          }
        } catch (error) {
          bb.log.warn(`Preview restore on ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      resolveDefaultInputs: (key: string) =>
        resolveProjectSizeDefaults(provider, key),
      // Native bootstrap skips the image entrypoint, so the trusted browser's
      // identity is pushed over the executor on every create and resume.
      // Browser owns the global routing and personal-login settings.
      prepareMachine: async ({
        key,
        ...input
      }: { key: string; hostId: string } & Pick<Parameters<typeof provisionTrustedBrowser>[0], "executor" | "report" | "signal">) => {
        try {
          await prepareGatewayHarnesses(bb, input);
        } catch (error) {
          input.signal.throwIfAborted();
          throw new Error(`Managed model setup failed after native connection on ${input.hostId}. Machine and data are retained; reconcile its native lifecycle state before retrying setup/resume. ${error instanceof Error ? error.message : String(error)}`);
        }
        await provisionTrustedBrowser({ ...input, bb, enabled: true });
      },
    });
    const legacyBackends = new Map<
      SandboxProvider,
      Pick<
        SandboxBackend<unknown, PluginMachineProviderResource>,
        "removeLegacy" | "removeLegacyCheckpoint" | "execLegacy" | "stopLegacy"
      >
    >();
    const legacyMachine = (id: string) => {
      const record = store.getLegacySandbox(id);
      const backend = record === null ? undefined : legacyBackends.get(record.provider);
      const providerSandboxId = record?.providerSandboxId ?? null;
      if (providerSandboxId === null || backend?.execLegacy === undefined) {
        throw new Error(`Legacy sandbox ${id} cannot be healed in place`);
      }
      return {
        exec: (script: string, timeoutMs: number) =>
          backend.execLegacy!(providerSandboxId, script, timeoutMs),
        stop: () => backend.stopLegacy?.(providerSandboxId) ?? Promise.resolve(),
      };
    };
    if (config.daytona !== null) {
      const backend = createDaytonaMachineBackend(
        config.daytona,
        () => config.idleSleepMs,
        {
          snapshotFor: (tier, target) => {
            // Only a deployment that never registered images through the
            // plugin falls back to the snapshot named in settings.
            if (store.listDefaultImages("daytona").length === 0) return null;
            const image = store.getDefaultImage("daytona", tier, target);
            if (image === null) {
              throw new Error(
                `No active Daytona snapshot is registered at size ${tier}; run bb sandbox register-image --provider daytona --tier ${tier}`,
              );
            }
            return image.name;
          },
          defaultTier: () => config.defaultSizeTier,
        },
      );
      legacyBackends.set("daytona", backend);
      registerSandboxBackend(bb, backend, optionsFor("daytona"));
    }
    if (config.modal !== null) {
      const backend = createModalMachineBackend(config.modal);
      legacyBackends.set("modal", backend);
      registerSandboxBackend(bb, backend, optionsFor("modal"));
    }
    if (config.freestyle !== null) {
      const backend = createFreestyleMachineBackend(config.freestyle);
      legacyBackends.set("freestyle", backend);
      registerSandboxBackend(bb, backend, optionsFor("freestyle"));
    }
    if (config.box !== null) {
      const backend = createBoxMachineBackend(config.box);
      legacyBackends.set("box", backend);
      registerSandboxBackend(bb, backend, optionsFor("box"));
    }
    if (config.e2b !== null) {
      const backend = createE2bMachineBackend(config.e2b);
      legacyBackends.set("e2b", backend);
      registerSandboxBackend(bb, backend, optionsFor("e2b"));
    }
    let reconfigureChain = Promise.resolve();
    const pendingArtifacts: Partial<Record<SandboxProvider, string>> = {};
    const reconfigure = (activated?: {
      provider: SandboxProvider;
      name: string;
    }): Promise<void> => {
      if (activated !== undefined) {
        pendingArtifacts[activated.provider] = activated.name;
      }
      const run = reconfigureChain.then(async () => {
        const currentSettings = await combinedSettings();
        const artifacts = { ...selectedArtifacts(), ...pendingArtifacts };
        const nextConfig = loadSandboxRuntimeConfig(
          currentSettings,
          process.env,
          artifacts,
        );
        // Native backends captured their provider config object at
        // registration. Update it in place so an activated image or changed
        // setting reaches them without a plugin reload.
        for (const provider of sandboxProviderValues) {
          const current = config[provider] as Record<string, unknown> | null;
          const next = nextConfig[provider] as Record<string, unknown> | null;
          if (current === null || next === null) continue;
          for (const key of Object.keys(current)) {
            if (!(key in next)) delete current[key];
          }
          Object.assign(current, next);
          (nextConfig as unknown as Record<string, unknown>)[provider] = current;
        }
        Object.assign(config, nextConfig);
      });
      reconfigureChain = run.catch((error) => {
        bb.log.error(
          `Could not reload sandbox providers: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return run.catch((error) => {
        if (
          activated !== undefined &&
          pendingArtifacts[activated.provider] === activated.name
        ) {
          delete pendingArtifacts[activated.provider];
        }
        throw error;
      });
    };
    settings.onChange(() => {
      void reconfigure().then(
        () => {
          bb.realtime.publish("sandbox-provider-settings", {
            type: "changed",
          });
        },
        () => undefined,
      );
    });
    const pluginRunning = async (pluginId: string) => {
      const plugins = await bb.sdk.plugins.list();
      return plugins.plugins.some(
        (candidate) =>
          candidate.id === pluginId &&
          candidate.enabled &&
          candidate.status === "running",
      );
    };
    // Restore project-scoped env injection (1Password etc.) for native-path
    // sandboxes. No-ops for non-sandbox hosts; safe to register unconditionally.
    const projectPreparation = registerNativeProjectEnvironmentSync(bb, {
      enabled: () => integrations.enabled("projectEnvironments"),
      isPluginRunning: pluginRunning,
    });
    const legacyCleanup = new LegacySandboxCleanup(bb, store, legacyBackends);
    let idleSuspendHolds: ReturnType<typeof registerNativeIdleSuspend> | null = null;
    if (legacyBackends.size > 0) {
      // Idle-suspend native sandboxes through core's lifecycle (graceful + resumable).
      idleSuspendHolds = registerNativeIdleSuspend(bb, {
        idleMs: () => config.idleSleepMs,
        alwaysOn: (hostId) => store.isAlwaysOn(hostId),
      });
      const cleanupFinishedLegacyThread = (
        { thread }: { thread: { id: string } },
      ) => legacyCleanup.handleFinishedThread(thread.id);
      bb.events.on("thread.archived", cleanupFinishedLegacyThread);
      bb.events.on("thread.deleted", cleanupFinishedLegacyThread);
      bb.background.service("legacy-cleanup", {
        start: (signal) => legacyCleanup.run(signal),
      });
    }
    const manager = new SandboxManager(bb, store, {
      config,
      daytonaCapacity: () => loadDaytonaCapacity(),
      daytonaPlacement: () => configuredDaytonaPlacement(),
      isProviderEnabled: (provider) =>
        store.getProviderSettings(provider).enabled,
      bbAppVersion: async () =>
        (await bb.sdk.system.version()).currentVersion,
    });
    const configuredProviderCount = () =>
      sandboxProviderValues.filter((provider) => config[provider] !== null).length;
    if (configuredProviderCount() === 0) {
      bb.status.needsConfiguration(
        "Configure a provider API key and provider-native image/template, then reload the plugin.",
      );
    }
    const dockerfilePath = fileURLToPath(
      new URL("../docker/Dockerfile", import.meta.url),
    );
    const e2bScriptPath = fileURLToPath(
      new URL("../scripts/register-e2b-template.mjs", import.meta.url),
    );
    const activateImage = async (provider: SandboxProvider, name: string) => {
      await reconfigure({ provider, name });
    };
    const imageManager = new SandboxImageManager({
      bb,
      getImageRecipe: () => recipe.read(),
      store,
      getSettings: combinedSettings,
      dockerfilePath,
      bbAppVersion: async () =>
        (await bb.sdk.system.version()).currentVersion,
      buildAndPush: buildAndPushSandboxImage,
      register: (input) => registerSandboxImage({ ...input, e2bScriptPath }),
      resolveRegistryImage,
      readImageBbAppVersion: (input) =>
        readRegistryImageLabel({ ...input, label: "bb.app.version" }),
      activateImage,
      daytonaPool: async (regionId) => {
        const placement = await configuredDaytonaPlacement();
        const target = {
          regionId: regionId ?? placement.regionId,
          sandboxClass: placement.sandboxClass,
        };
        const capacity = await loadDaytonaCapacity();
        return { placement: target, pool: selectedDaytonaPool(capacity, target) };
      },
    });
    const upgrader = new SandboxUpgrader({
      bb,
      setupOnHost: async (hostId, check) => {
        return gatewaySetupOnHost(bb, hostId, check);
      },
      serverVersion: async () => (await bb.sdk.system.version()).currentVersion,
      latestHarnessVersions,
      activeImage: async () => {
        const image = sandboxImageProviders
          .map((provider) => store.getDefaultImage(provider))
          .find((candidate) => candidate?.imageVersion != null);
        const tag = image?.imageVersion ?? null;
        if (tag === null) return null;
        const registry = sandboxImageRegistryConfig(await combinedSettings());
        if (registry.repository.length === 0) return null;
        const tools = await readRegistryImageLabel({ registry, reference: tag, label: "bb.image.tools", platform: registry.platform });
        const currentRecipe = await recipe.read();
        if (currentRecipe.dockerfile || tools !== currentRecipe.tools.join(",")) return null;
        return { tag, versions: await readImageVersions({ registry, tag }) };
      },
      buildImage: async ({ tag, harness, onLog }) => {
        const result = await imageManager.build({ name: tag, harness, onLog });
        const failed = result.registrations.filter(entry => entry.status === "error");
        if (failed.length) throw new Error(failed.map(entry => entry.message).join("; "));
        onLog(`Built and registered ${result.pinnedReference}`);
      },
      nativeImages: () => [
        {
          // Native Daytona picks the snapshot for the requested size from the
          // store at create time; this is what a default-size thread boots.
          provider: "daytona" as const,
          booting:
            config.daytona === null
              ? null
              : store.getDefaultImage("daytona", config.defaultSizeTier, config.daytona.target)?.name ??
                config.daytona.snapshot,
          active:
            config.daytona === null
              ? null
              : store.getDefaultImage("daytona", config.defaultSizeTier)?.name ?? null,
        },
        {
          provider: "modal" as const,
          booting: config.modal?.imageName ?? null,
          active: config.modal === null ? null : store.getDefaultImage("modal")?.name ?? null,
        },
        {
          provider: "e2b" as const,
          booting: config.e2b?.template ?? null,
          active: config.e2b === null ? null : store.getDefaultImage("e2b")?.name ?? null,
        },
      ],
      holds: idleSuspendHolds,
      legacy: {
        list: () =>
          store
            .listLegacySandboxes()
            .filter(
              (record) =>
                record.status === "ready" &&
                record.providerSandboxId !== null &&
                legacyBackends.get(record.provider)?.execLegacy !== undefined,
            )
            .map((record) => ({
              id: record.id,
              name: `${record.projectName} (legacy ${record.provider})`,
              hostId: record.hostId,
            })),
        run: async (id, script, timeoutMs) => {
          const result = await legacyMachine(id).exec(script, timeoutMs);
          return { output: result.output, started: result.started };
        },
        stop: (id) => legacyMachine(id).stop(),
        recordBbApp: (id, version) => store.setLegacyBbAppVersion(id, version),
      },
    });
    const providerSettingsView = async (provider: SandboxProvider) => {
      const currentSettings = await combinedSettings();
      const credentials = sandboxProviderCredentialStatus(currentSettings);
      const providerConfig = await providerConfiguration.getConfiguration();
      const providerSettings = store.getProviderSettings(provider);
      const defaultImage = store.getDefaultImage(provider);
      return {
        provider,
        enabled: providerSettings.enabled,
        configured: config[provider] !== null,
        credentialsConfigured: credentials[provider],
        apiUrl:
          provider === "daytona" ? providerConfig.daytona.apiUrl : "",
        target: provider === "daytona" ? providerConfig.daytona.target : "",
        sandboxClass:
          provider === "daytona" ? providerConfig.daytona.sandboxClass : "",
        appName: provider === "modal" ? providerConfig.modal.appName : "",
        vmRuntime: provider === "modal" && providerConfig.modal.vmRuntime,
        machineClass: provider === "box" ? providerConfig.box.machineClass : "",
        environment: provider === "box" ? providerConfig.box.environment : "",
        cpu:
          provider === "freestyle" ? providerConfig.freestyle.cpu : "",
        memory:
          provider === "freestyle" ? providerConfig.freestyle.memory : "",
        storage:
          provider === "freestyle" ? providerConfig.freestyle.storage : "",
        persistence:
          provider === "freestyle" ? providerConfig.freestyle.persistence : "",
        snapshotId:
          provider === "freestyle" ? providerConfig.freestyle.snapshotId : "",
        supportsImages: sandboxImageProviders.some(
          (candidate) => candidate === provider,
        ),
        artifactName: defaultImage?.name ?? null,
      };
    };
    const imageSettingsView = async () => {
      const currentSettings = await combinedSettings();
      const credentials = sandboxProviderCredentialStatus(currentSettings);
      const registry = sandboxImageRegistryConfig(currentSettings);
      const providerConfig = await providerConfiguration.getConfiguration();
      const compatible = compatibleBrowserArtifacts();
      return {
        repository: providerConfig.image.repository,
        platform: providerConfig.image.platform,
        registryUsernameConfigured: registry.username !== null,
        registryTokenConfigured: registry.token !== null,
        extraPackages: normalizeExtraPackages(
          sandboxImageProviders.flatMap(
            (provider) => store.getProviderSettings(provider).extraPackages,
          ),
        ),
        recipe: await recipe.read(),
        providers: sandboxImageProviders.map((provider) => ({
          provider,
          credentialsConfigured: credentials[provider],
          activeName: store.getDefaultImage(provider)?.name ?? null,
          images: store.listImages(provider).map(image => ({ ...image, browserProvenance: store.imageProvenanceState(image.id, compatible) })),
        })),
      };
    };

    const projectEnvironmentSnapshot = async () => {
      await requireIntegration("projectEnvironments");
      return bb.sdk.plugins.callRpc({
        pluginId: "project-environments", method: "snapshot", input: null,
        outputSchema: projectEnvironmentSnapshotSchema,
      });
    };
    const projectContext = async (projectId: string) => {
      await requireIntegration("projects");
      return bb.sdk.plugins.callRpc({
        pluginId: "projects", method: "projectContext", input: { projectId },
        outputSchema: projectContextSchema,
      });
    };
    const launchProjects = async () => {
      const [projectRows, environment] = await Promise.all([
        bb.sdk.projects.list({ includePersonal: true }),
        projectEnvironmentSnapshot(),
      ]);
      const contexts = await Promise.all(projectRows.map((project) => projectContext(project.id)));
      const credentialByProject = new Map(contexts.map((context) => [context.projectId, context.credentialId]));
      return projectRows
        .filter((project) => project.kind === "personal" || (project.kind === "standard" && project.gitRemoteUrl !== null))
        .map((project) => ({
          id: project.id,
          name: project.kind === "personal" ? "No project" : project.name,
          kind: project.kind,
          detail: null,
          defaultCredentialProfileId: credentialByProject.get(project.id) ?? null,
          setup: null,
        }));
    };
    const credentialProfiles = async () => (await projectEnvironmentSnapshot()).profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      environmentName: profile.environmentName,
      tokenConfigured: profile.tokenConfigured,
    }));
    const launchPreview = async (input: {
      projectId: string;
      credentialProfileId: string | null;
      auth?: {
        copyGitHubCliAuth: boolean;
      };
    }) => {
      await Promise.all([
        requireIntegration("catalog"), requireIntegration("agents"),
        requireIntegration("projects"), requireIntegration("projectEnvironments"),
      ]);
      const [environment, context, catalog, agents, currentSettings] = await Promise.all([
        projectEnvironmentSnapshot(),
        projectContext(input.projectId),
        bb.sdk.plugins.callRpc({
          pluginId: "catalog",
          method: "snapshot",
          input: null,
          outputSchema: catalogSnapshotSchema,
        }),
        bb.sdk.plugins.callRpc({
          pluginId: "agent-profiles",
          method: "listProfiles",
          input: null,
          outputSchema: agentProfilesSchema,
        }),
        combinedSettings(),
      ]);
      const profile = input.credentialProfileId === null
        ? null
        : environment.profiles.find((candidate) => candidate.id === input.credentialProfileId) ?? null;
      const capabilityIds = new Set(profile?.capabilities ?? []);
      const tools = environment.capabilities
        .filter((capability) => capabilityIds.has(capability.id))
        .map(({ id, name, command, description }) => ({ id, name, command, description }));
      const skillIds = new Set(catalog.bundles
        .filter((bundle) => context.bundleIds.includes(bundle.id))
        .flatMap((bundle) => bundle.skillIds));
      const skills = catalog.skills
        .filter((skill) => skill.enabled && skillIds.has(skill.id))
        .map(({ id, name, description, sourceId, sourceName }) => ({ id, name, description, sourceId, sourceName }));
      return {
        credentialProfile: profile === null ? null : {
          id: profile.id,
          name: profile.name,
          environmentName: profile.environmentName,
          tokenConfigured: profile.tokenConfigured,
        },
        auth: {
          copyGitHubCliAuth:
            input.auth?.copyGitHubCliAuth ?? currentSettings.copyGitHubCliAuth,
        },
        baseAuthentication: [
          ...(input.auth?.copyGitHubCliAuth ?? currentSettings.copyGitHubCliAuth ? ["GitHub CLI"] : []),
        ],
        tools,
        skills,
        availableTools: environment.capabilities,
        availableSkills: catalog.skills.filter((skill) => skill.enabled),
        availableAgents: agents.map((agent) => ({ id: agent.id, name: agent.name, detail: agent.description || null })),
        agents: agents.filter((agent) => context.agentIds.includes(agent.id)).map((agent) => ({ id: agent.id, name: agent.name, detail: agent.description || null })),
        imageComponents: imageComponentsFor((await recipe.read()).tools).map((component) => ({
          category: component.category,
          items: [...component.items],
        })),
      };
    };
    // Native-path machine-panel config: resolves via the SDK when there is no
    // legacy store record, reusing the same launch-preview/credential helpers.
    const nativeAttachments = createNativeAttachments(bb, {
      launchPreview,
      credentialProfiles,
    });
    const sandboxHostForThread = async (threadId: string) => {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId === null) throw new Error("Thread has no sandbox machine.");
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
      if (!host.machineProviderId?.startsWith("sandbox-") || host.machineProviderId === "sandbox-modal") {
        throw new Error("Always on is unavailable for this machine.");
      }
      return host.id;
    };
    bb.rpc.register(sandboxRpcContract, {
      preferences: () => settings.view(),
      updatePreferences: (input, context) => {
        if (context.experimental_caller.kind !== "client") throw new Error("Owner client required");
        return settings.update(input);
      },
      integrations: () => integrations.read(),
      importIntegrations: (input, context) => {
        if (context.experimental_caller.kind !== "client") throw new Error("Owner client required");
        return integrations.import(input);
      },
      projectPreparationStatus: ({ threadId }) => projectPreparation.status(threadId),
      reconcileProjectPreparation: ({ threadId }, context) => {
        if (context.experimental_caller.kind !== "client") throw new Error("Owner client required");
        return projectPreparation.reconcile(threadId);
      },
      retryProjectPreparation: ({ threadId }, context) => {
        if (context.experimental_caller.kind !== "client") throw new Error("Owner client required");
        return projectPreparation.retry(threadId);
      },
      updateIntegrations: (input, context) => {
        if (context.experimental_caller.kind !== "client") throw new Error("Owner client required");
        return integrations.update(input);
      },
      prepareSsh: async ({ hostId }) => {
        const target = await prepareSsh(hostId);
        if (target.nodeId === null || target.authority === null) throw new Error("Sandbox SSH is not configured");
        return { nodeId: target.nodeId, authority: target.authority, error: target.error };
      },
      sandboxAlwaysOn: async ({ threadId }) => {
        const hostId = await sandboxHostForThread(threadId);
        return { enabled: store.isAlwaysOn(hostId) };
      },
      setSandboxAlwaysOn: async ({ threadId, enabled }) => {
        const hostId = await sandboxHostForThread(threadId);
        const host = enabled ? await bb.sdk.hosts.get({ hostId }) : null;
        const previous = store.isAlwaysOn(hostId);
        store.setAlwaysOn(hostId, enabled);
        if (host?.lifecycle.phase === "suspended") {
          try {
            await bb.sdk.hosts.experimental_resume({ hostId });
          } catch (error) {
            store.setAlwaysOn(hostId, previous);
            throw error;
          }
        }
        bb.realtime.publish("sandboxes", { type: "always-on-changed" });
        return { enabled };
      },
      threadAttachments: async ({ threadId }) => {
        await Promise.all([
          requireIntegration("catalog"), requireIntegration("agents"),
          requireIntegration("projects"), requireIntegration("projectEnvironments"),
        ]);
        const view = await nativeAttachments.view(threadId);
        if (view === null) {
          throw new Error("Attachments are unavailable for this thread.");
        }
        return view;
      },
      updateThreadAttachments: () => {
        throw new Error("Legacy sandbox selections are read-only during migration. Existing scope is retained; use the source plugin's project settings for new runs.");
      },
      projects: launchProjects,
      credentialProfiles,
      launchPreview,
      providers: () => manager.providers(),
      providerSettings: async () => ({
        providers: await Promise.all(
          sandboxProviderValues.map(providerSettingsView),
        ),
      }),
      daytonaCapacity: () => loadDaytonaCapacity(),
      imageSettings: () => imageSettingsView(),
      updateImageConfiguration: async (input, context) => {
        if (context.experimental_caller?.kind !== "client") throw new Error("Owner client required");
        const extraPackages = normalizeExtraPackages(input.packages);
        if (input.recipe) await recipe.save(imageRecipeSchema.parse(input.recipe));
        await providerConfiguration.updateImageConfiguration({
          repository: input.repository,
          platform: input.platform,
        });
        await providerConfiguration.setSecrets({
          ...(input.registryUsername === undefined
            ? {}
            : { imageRegistryUsername: input.registryUsername }),
          ...(input.registryToken === undefined
            ? {}
            : { imageRegistryToken: input.registryToken }),
        });
        for (const provider of sandboxImageProviders) {
          store.updateProviderSettings(provider, { extraPackages });
        }
        bb.realtime.publish("sandbox-provider-settings", { type: "changed" });
        return imageSettingsView();
      },
      setProviderEnabled: async ({ provider, enabled }) => {
        store.updateProviderSettings(provider, { enabled });
        bb.realtime.publish("sandbox-provider-settings", {
          provider,
          type: "changed",
        });
        return providerSettingsView(provider);
      },
      updateProviderConfiguration: async (input) => {
        if (input.provider === "daytona") {
          const currentProviderConfig =
            await providerConfiguration.getConfiguration();
          const apiKey =
            input.apiKey ?? (await providerConfiguration.getSecret("daytonaApiKey"));
          if (input.target) {
            if (!apiKey) throw new Error("Configure the Daytona API key first");
            const capacity = await discoverDaytonaCapacity({
              apiKey,
              ...(input.apiUrl.trim() ? { apiUrl: input.apiUrl } : {}),
            });
            if (
              selectedDaytonaPool(capacity, {
                regionId: input.target,
                sandboxClass: input.sandboxClass,
              }) === null
            ) {
              throw new Error(
                `Daytona capacity pool ${input.target}/${input.sandboxClass} is unavailable`,
              );
            }
          }
          await providerConfiguration.updateConfiguration("daytona", {
            apiUrl: input.apiUrl,
            target: input.target,
            sandboxClass: input.sandboxClass,
          });
          await providerConfiguration.setSecrets({
            ...(input.apiKey === undefined ? {} : { daytonaApiKey: input.apiKey }),
          });
          if (
            currentProviderConfig.daytona.target !== input.target ||
            currentProviderConfig.daytona.sandboxClass !== input.sandboxClass
          ) {
            store.clearDefaultImage("daytona");
          }
        } else if (input.provider === "modal") {
          await providerConfiguration.updateConfiguration("modal", {
            appName: input.appName,
            vmRuntime: input.vmRuntime,
          });
          await providerConfiguration.setSecrets({
            ...(input.tokenId === undefined ? {} : { modalTokenId: input.tokenId }),
            ...(input.tokenSecret === undefined ? {} : { modalTokenSecret: input.tokenSecret }),
          });
        } else if (input.provider === "e2b") {
          await providerConfiguration.setSecrets({
            ...(input.apiKey === undefined ? {} : { e2bApiKey: input.apiKey }),
          });
        } else if (input.provider === "box") {
          await providerConfiguration.updateConfiguration("box", {
            machineClass: input.machineClass,
            environment: input.environment,
          });
          await providerConfiguration.setSecrets({
            ...(input.apiKey === undefined ? {} : { boxApiKey: input.apiKey }),
          });
        } else if (input.provider === "freestyle") {
          await providerConfiguration.updateConfiguration("freestyle", {
            cpu: input.cpu,
            memory: input.memory,
            storage: input.storage,
            persistence: input.persistence,
            snapshotId: input.snapshotId,
          });
          await providerConfiguration.setSecrets({
            ...(input.apiKey === undefined ? {} : { freestyleApiKey: input.apiKey }),
          });
        }
        await reconfigure();
        bb.realtime.publish("sandbox-provider-settings", {
          provider: input.provider,
          type: "changed",
        });
        return providerSettingsView(input.provider);
      },
      startImageBuild: async (_input, context) => {
        if (context.experimental_caller?.kind !== "client") throw new Error("Owner client required");
        const job = await imageManager.startBuild({});
        return { id: job.id };
      },
      imageBuildStatus: ({ id, cursor }, context) => {
        if (context.experimental_caller?.kind !== "client") throw new Error("Owner client required");
        const job = imageManager.job(id, cursor);
        return { state: job.state, progress: job.progress, cursor: job.cursor, error: job.error, pinnedReference: job.pinnedReference, registrationErrors: job.build?.registrations.filter(entry => entry.status === "error").map(entry => entry.message ?? "Provider registration failed") ?? [] };
      },
      buildImage: (request, context) => {
        if (context.experimental_caller?.kind !== "client") throw new Error("Owner client required");
        return imageManager.build(request);
      },
      branches: async ({ projectId }) => {
        const project = await bb.sdk.projects.get({ projectId });
        const source =
          project.sources.find((candidate) => candidate.isDefault) ??
          project.sources[0];
        if (source === undefined) {
          return { branches: [], defaultBranch: null };
        }
        const result = await bb.sdk.projects.branches({
          projectId,
          hostId: source.hostId,
          limit: "250",
        });
        const branches = result.remoteBranches.filter(
          (branch) => branch !== "origin/HEAD",
        );
        const preferred =
          result.defaultWorktreeBaseBranch ?? result.originDefaultBranch;
        return {
          branches,
          defaultBranch:
            preferred !== null && branches.includes(preferred)
              ? preferred
              : (branches[0] ?? null),
        };
      },
      updateAuthDefaults: async (input) => {
        await bb.sdk.plugins.updateSettings({
          pluginId: "sandboxes",
          values: input,
        });
        await reconfigure();
        bb.realtime.publish("sandbox-provider-settings", { type: "changed" });
        return input;
      },

      threadStatuses: async ({ threads }) => {
        const statuses = await resolveNativeThreadStatuses(
          bb,
          threads,
          new Set<string>(),
        );
        return { statuses };
      },
      threadResources: async ({ refresh, ...ref }) => {
        const native = await nativeThreadResources(bb, ref, refresh ?? true);
        // Every thread header asks, so a thread off a sandbox host is an
        // ordinary answer, not an error.
        return native ?? UNMANAGED_THREAD_RESOURCES;
      },
      threadModelRoute: ({ threadId }) => readModelRoute(bb, threadId),
      sizeProfiles: ({ projectId }) => ({
        profiles: manager.sizeProfiles(projectId),
      }),
      setSizeProfile: async ({
        projectId,
        provider,
        cpuCores,
        memoryBytes,
        diskBytes,
        tier,
        regionId,
      }) => {
        const resources = {
          ...(cpuCores === undefined ? {} : { cpuCores }),
          ...(memoryBytes === undefined ? {} : { memoryBytes }),
          ...(diskBytes === undefined ? {} : { diskBytes }),
        };
        await validateSizeRequest(provider, resources, tier, regionId ?? null);
        return manager.setSizeProfile({
          projectId,
          provider,
          cpuCores: cpuCores ?? null,
          memoryBytes: memoryBytes ?? null,
          diskBytes: diskBytes ?? null,
          tier: tier ?? null,
          regionId: regionId ?? null,
          source: "manual",
        });
      },
      sizeTiers: async () => ({ tiers: await manager.sizeTierCatalog() }),
      clearSizeProfile: ({ projectId, provider }) => ({
        removed: manager.clearSizeProfile(projectId, provider),
      }),
      versionAudit: () => manager.versionAudit({ previousServerVersion, probe: false }),
      startSandboxUpgrade: ({ check }) => ({
        id: upgrader.start(check === true ? { check } : {}),
      }),
      sandboxUpgradeJob: ({ id, cursor }) => {
        const jobId = id ?? upgrader.latestId();
        if (jobId === null) return null;
        try {
          return upgrader.job(jobId, cursor);
        } catch {
          // A plugin reload drops upgrade jobs.
          return null;
        }
      },
      resizeSandbox: ({ sandboxId, cpuCores, memoryBytes, diskBytes }) =>
        manager.resizeSandbox(sandboxId, {
          ...(cpuCores === undefined ? {} : { cpuCores }),
          ...(memoryBytes === undefined ? {} : { memoryBytes }),
          ...(diskBytes === undefined ? {} : { diskBytes }),
        }),
    });
    const capacityDoctor = async () => {
      const findings: Array<{
        severity: "error" | "warning";
        code: string;
        message: string;
        sandboxId?: string;
      }> = [];
      try {
        const [capacity, placement] = await Promise.all([
          loadDaytonaCapacity(),
          configuredDaytonaPlacement(),
        ]);
        const pool = selectedDaytonaPool(capacity, placement);
        if (pool === null) {
          findings.push({
            severity: "error",
            code: "placement-unavailable",
            message: `${placement.regionId}/${placement.sandboxClass} is not present in the live quota pools`,
          });
        } else {
          const image = store.getDefaultImage("daytona");
          if (image === null) {
            findings.push({
              severity: "error",
              code: "image-missing",
              message: "No active snapshot exists for the selected placement",
            });
          } else if (image.regionId === null || image.sandboxClass === null) {
            findings.push({
              severity: "warning",
              code: "image-placement-unknown",
              message: `Active snapshot ${image.name} predates placement metadata; rebuild it before relying on this pool`,
            });
          } else if (
            image.regionId !== placement.regionId ||
            image.sandboxClass !== placement.sandboxClass
          ) {
            findings.push({
              severity: "error",
              code: "image-placement-mismatch",
              message: `Active snapshot ${image.name} belongs to ${image.regionId}/${image.sandboxClass}, not ${placement.regionId}/${placement.sandboxClass}`,
            });
          }
          for (const profile of store
            .listSizeProfiles()
            .filter((candidate) => candidate.provider === "daytona")) {
            if (profile.tier !== null) {
              const target =
                profile.regionId === null
                  ? pool
                  : selectedDaytonaPool(capacity, {
                      regionId: profile.regionId,
                      sandboxClass: placement.sandboxClass,
                    });
              if (target === null) {
                findings.push({
                  severity: "error",
                  code: "profile-region-unavailable",
                  message: `${profile.projectId}: pinned region ${profile.regionId} has no ${placement.sandboxClass} pool`,
                });
                continue;
              }
              const violations = sizeTierPoolViolations(target, profile.tier);
              if (violations.length > 0) {
                findings.push({
                  severity: "error",
                  code: "profile-exceeds-capacity",
                  message: `${profile.projectId}: size ${profile.tier} does not fit ${target.regionId}/${target.sandboxClass}: ${violations.join("; ")}`,
                });
              }
              continue;
            }
            try {
              validateDaytonaResources(pool, {
                ...(profile.cpuCores === null
                  ? {}
                  : { cpuCores: profile.cpuCores }),
                ...(profile.memoryBytes === null
                  ? {}
                  : { memoryBytes: profile.memoryBytes }),
                ...(profile.diskBytes === null
                  ? {}
                  : { diskBytes: profile.diskBytes }),
              });
            } catch (error) {
              findings.push({
                severity: "error",
                code: "profile-exceeds-capacity",
                message: `${profile.projectId}: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
        }
      } catch (error) {
        findings.push({
          severity: "error",
          code: "capacity-unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return findings;
    };

    // A bb upgrade lands on this machine first. Remember which server the
    // fleet last ran under so the audit can say what changed, and say so in
    // the log right away rather than when the first sandbox fails to connect.
    const serverVersionMemorySchema = z.object({
      version: z.string(),
      previousVersion: z.string().nullable().default(null),
      seenAt: z.number(),
    });
    const rememberedServer = serverVersionMemorySchema.safeParse(
      await bb.storage.kv.get("server-version"),
    );
    let currentServerVersion: string | null = null;
    try {
      currentServerVersion = (await bb.sdk.system.version()).currentVersion;
    } catch (error) {
      bb.log.warn(
        `Could not read the bb server version; sandbox version audits are unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const previousServerVersion: string | null = rememberedServer.success
      ? rememberedServer.data.version === currentServerVersion
        ? rememberedServer.data.previousVersion
        : rememberedServer.data.version
      : null;
    if (
      currentServerVersion !== null &&
      (!rememberedServer.success ||
        rememberedServer.data.version !== currentServerVersion)
    ) {
      await bb.storage.kv.set("server-version", {
        version: currentServerVersion,
        previousVersion: previousServerVersion,
        seenAt: Date.now(),
      });
    }
    const versionAudit = () =>
      manager.versionAudit({ previousServerVersion, probe: true });
    if (
      currentServerVersion !== null &&
      rememberedServer.success &&
      rememberedServer.data.version !== currentServerVersion
    ) {
      bb.log.warn(
        `bb moved from ${rememberedServer.data.version} to ${currentServerVersion}; auditing sandbox images, pins, and machines`,
      );
      void versionAudit()
        .then((audit) => {
          for (const finding of audit.findings) {
            const line = `[bb ${audit.serverVersion}] ${finding.message}${finding.fix === null ? "" : ` (fix: ${finding.fix})`}`;
            if (finding.severity === "error") bb.log.error(line);
            else bb.log.warn(line);
          }
          if (audit.findings.length === 0) {
            bb.log.info(
              `Every sandbox image, pin, and machine already matches bb ${audit.serverVersion}`,
            );
          }
          bb.realtime.publish("sandbox-version-audit", { type: "changed" });
        })
        .catch((error: unknown) => {
          bb.log.warn(
            `Could not audit sandbox versions after the bb upgrade: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    registerSandboxCli(bb, manager, {
      sshStatus: () => ssh.list(),
      setupSsh: prepareSsh,
      listLegacySandboxes: () => legacyCleanup.list(),
      getLegacySandbox: (idOrHostId) => legacyCleanup.get(idOrHostId),
      deleteLegacySandbox: (idOrHostId, options) =>
        legacyCleanup.destroy(idOrHostId, options),
      versionDoctor: versionAudit,
      daytonaCapacity: () => loadDaytonaCapacity(),
      capacityDoctor,
      setProviderEnabled: (provider, enabled) => {
        store.updateProviderSettings(provider, { enabled });
        bb.realtime.publish("sandbox-provider-settings", {
          provider,
          type: "changed",
        });
      },
      listImages: (provider) => store.listImages(provider),
      buildImage: (request) => imageManager.startBuild(request),
      registerImage: (request) => imageManager.startRegistration(request),
      imageJob: (id, cursor) => imageManager.job(id, cursor),
      validateSizeRequest: (provider, resources, tier, regionId) =>
        validateSizeRequest(provider, resources, tier, regionId ?? null),
      startUpgrade: (options) => upgrader.start(options),
      upgradeJob: (id, cursor) => upgrader.job(id, cursor),
    });

    bb.agents.contributeInstructions(() =>
      `${configuredProviderCount() === 0
        ? SANDBOX_AGENT_INSTRUCTIONS
        : `${SANDBOX_MANAGEMENT_AGENT_INSTRUCTIONS} ${SANDBOX_AGENT_INSTRUCTIONS}`}`,
    );
  } catch (error) {
    bb.log.error(
      `Sandboxes plugin failed to initialize: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    throw error;
  }
}
