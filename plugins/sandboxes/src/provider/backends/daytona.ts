/**
 * Daytona backend for the BB 0.43 machine/environment provider model.
 *
 * Vertical slice: allocates a Daytona sandbox from a snapshot WITHOUT baking bb
 * enrollment env and WITHOUT launching the daemon — BB core installs and starts
 * the daemon over the returned {@link MachineExecutor} during
 * `bb.experimental_machines.bootstrap(...)`. Suspend/resume map to Daytona
 * stop/start; core re-bootstraps on resume.
 */
import { createRequire } from "node:module";
import { z } from "zod";
import type {
  MachineExecutor,
  PluginMachineValidateDecision,
} from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderAvailability,
} from "@get-bb/plugin-sdk/machine-provider";
import type { SandboxRuntimeConfig } from "../../config.js";
import {
  DEFAULT_SANDBOX_SIZE_TIER,
  isSandboxSizeTier,
  sandboxSizeTierValues,
  type SandboxSizeTier,
} from "../../size-tiers.js";
import type { SandboxBackend } from "../sandbox-backend.js";

const CREATE_TIMEOUT_SECONDS = 10 * 60;
const MACHINE_KEY_LABEL = "bb.machine-key";

type DaytonaConfig = NonNullable<SandboxRuntimeConfig["daytona"]>;

/** Non-secret inputs surfaced in the native New Thread composer. */
const daytonaInputsSchema = z
  .object({
    size: z.enum(sandboxSizeTierValues).optional(),
    /** Named snapshot to boot from; defaults to the configured snapshot. */
    image: z.string().min(1).optional(),
  })
  .strict();
export type DaytonaInputs = z.infer<typeof daytonaInputsSchema>;

/** Durable, secret-free resource persisted by core. */
const daytonaResourceSchema = z.object({
  provider: z.literal("daytona"),
  key: z.string(),
  providerSandboxId: z.string(),
  name: z.string(),
  snapshotName: z.string(),
  sizeTier: z.enum(sandboxSizeTierValues),
  regionId: z.string().nullable(),
  sandboxClass: z.string(),
});
export type DaytonaResource = z.infer<typeof daytonaResourceSchema>;

type DaytonaSdkModule = typeof import("@daytona/sdk");
interface DaytonaClient {
  daytona: InstanceType<DaytonaSdkModule["Daytona"]>;
  DaytonaNotFoundError: DaytonaSdkModule["DaytonaNotFoundError"];
}

/** POSIX single-quote quoting for building a shell command from argv. */
function shQuote(arg: string): string {
  return `'${arg.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Render argv as a shell command, feeding `stdin` in over a base64 pipe because
 * Daytona's executeCommand has no stdin channel. `base64` ships in the image's
 * coreutils. The decoded bytes become the command's stdin (the installer reads
 * `BB_ENROLLMENT` from there).
 */
function toDaytonaShellCommand(argv: readonly string[], stdin: string): string {
  const quoted = argv.map(shQuote).join(" ");
  if (stdin.length === 0) return quoted;
  const b64 = Buffer.from(stdin, "utf8").toString("base64");
  return `printf %s ${shQuote(b64)} | base64 -d | ${quoted}`;
}

export interface DaytonaSnapshotSelection {
  /**
   * The active snapshot registered at a size. Daytona takes a sandbox's size
   * from its snapshot, so each size boots its own; null falls back to the
   * configured snapshot.
   */
  snapshotFor(tier: SandboxSizeTier, target: string | undefined): string | null;
  /** The size to use when the request names none. */
  defaultTier(): SandboxSizeTier;
}

export function createDaytonaMachineBackend(
  config: DaytonaConfig,
  getIdleSleepMs: () => number | null,
  snapshots?: DaytonaSnapshotSelection,
): SandboxBackend<DaytonaInputs, DaytonaResource> {
  const clients = new Map<string, Promise<DaytonaClient>>();
  const getClient = (
    target: string | undefined = config.target,
  ): Promise<DaytonaClient> => {
    const cacheKey = target ?? "";
    let pending = clients.get(cacheKey);
    if (pending === undefined) {
      pending = (async () => {
        // Load the SDK's CommonJS entry via require: the ESM interop breaks
        // agent-base/debug, and require preserves one instance across reloads.
        const { Daytona, DaytonaNotFoundError } = createRequire(import.meta.url)(
          "@daytona/sdk",
        ) as DaytonaSdkModule;
        return {
          daytona: new Daytona({
            apiKey: config.apiKey,
            ...(config.apiUrl === undefined ? {} : { apiUrl: config.apiUrl }),
            ...(target === undefined ? {} : { target }),
          }),
          DaytonaNotFoundError,
        } satisfies DaytonaClient;
      })();
      clients.set(cacheKey, pending);
    }
    return pending;
  };

  const resolveTier = (inputs: DaytonaInputs): SandboxSizeTier =>
    inputs.size !== undefined && isSandboxSizeTier(inputs.size)
      ? inputs.size
      : (snapshots?.defaultTier() ?? DEFAULT_SANDBOX_SIZE_TIER);

  const executorFor = (providerSandboxId: string): MachineExecutor => ({
    async exec(request) {
      request.signal.throwIfAborted();
      const { daytona } = await getClient();
      const sandbox = await daytona.get(providerSandboxId);
      const command = toDaytonaShellCommand(request.command, request.stdin);
      const result = await sandbox.process.executeCommand(
        command,
        undefined,
        undefined,
        Math.max(1, Math.ceil(request.timeoutMs / 1000)),
      );
      if (typeof result.result === "string" && result.result.length > 0) {
        request.onOutput(result.result);
      }
      return { exitCode: result.exitCode };
    },
  });

  return {
    definition: {
      id: "sandbox-daytona",
      displayName: "Daytona Sandbox",
      description: "Create a cloud sandbox in your Daytona account.",
      environmentDescription: "Run this thread in a Daytona cloud sandbox.",
      runtimeName: "Daytona",
      icon: "./daytona-logo.svg",
      ephemeral: true,
      inputs: daytonaInputsSchema,
    },
    parseInputs(value) {
      return daytonaInputsSchema.parse(value ?? {});
    },
    parseResource(value) {
      return daytonaResourceSchema.parse(value);
    },
    allocationKey(resource) {
      return resource.key;
    },
    async availability(): Promise<PluginMachineProviderAvailability> {
      if (config.apiKey.length === 0) {
        return { status: "setup-required", message: "Add a Daytona API key." };
      }
      try {
        const { daytona } = await getClient();
        await daytona.snapshot.get(config.snapshot);
        return { status: "available" };
      } catch (error) {
        return {
          status: "setup-required",
          message: `Daytona snapshot ${config.snapshot} is not ready: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    async validate(inputs): Promise<PluginMachineValidateDecision> {
      if (inputs.size !== undefined && !isSandboxSizeTier(inputs.size)) {
        return { action: "refuse", message: `Unknown size ${inputs.size}` };
      }
      return { action: "accept" };
    },
    async create(context) {
      const tier = resolveTier(context.inputs);
      const snapshotName =
        context.inputs.image ??
        snapshots?.snapshotFor(tier, config.target) ??
        config.snapshot;
      const name = `bb-${context.key}`;
      const { daytona } = await getClient();
      context.report.step(`Creating the Daytona sandbox (${tier})`);
      const sandbox = await daytona.create(
        {
          snapshot: snapshotName,
          labels: {
            "bb.sandbox-id": context.key,
            [MACHINE_KEY_LABEL]: context.key,
          },
          name,
          public: false,
          // Never let Daytona stop the VM out-of-band: BB core owns idle
          // suspend/resume, and an out-of-band stop reads as an unrecoverable
          // "connection to host lost". 0 disables Daytona's auto-stop.
          autoStopInterval: 0,
          autoDeleteInterval: -1,
        },
        { timeout: CREATE_TIMEOUT_SECONDS },
      );
      try {
        await sandbox.setTtl(0);
      } catch {
        // TTL is best-effort; a sandbox without it is still usable.
      }
      const resource: DaytonaResource = {
        provider: "daytona",
        key: context.key,
        providerSandboxId: sandbox.id,
        name,
        snapshotName,
        sizeTier: tier,
        regionId: config.target ?? null,
        sandboxClass: config.sandboxClass,
      };
      await context.checkpoint(resource);
      return { resource, executor: executorFor(sandbox.id) };
    },
    async reconcileCleanup(context) {
      const { daytona, DaytonaNotFoundError } = await getClient();
      try {
        for await (const sandbox of daytona.list({
          labels: { [MACHINE_KEY_LABEL]: context.key },
        })) {
          await sandbox.delete(60, true).catch((error: unknown) => {
            if (!(error instanceof DaytonaNotFoundError)) throw error;
          });
        }
      } catch (error) {
        if (!(error instanceof DaytonaNotFoundError)) throw error;
      }
    },
    async suspend(context) {
      const { daytona, DaytonaNotFoundError } = await getClient();
      try {
        const sandbox = await daytona.get(context.resource.providerSandboxId);
        if (String(sandbox.state) === "started") {
          context.report.step("Stopping the Daytona sandbox");
          await sandbox.stop(60, false);
        }
      } catch (error) {
        if (!(error instanceof DaytonaNotFoundError)) throw error;
      }
      return context.resource;
    },
    async resume(context) {
      const { daytona } = await getClient();
      const sandbox = await daytona.get(context.resource.providerSandboxId);
      if (String(sandbox.state) !== "started") {
        context.report.step("Restoring the Daytona sandbox");
        await sandbox.start(120);
      }
      await Promise.all([
        // Keep Daytona's own auto-stop disabled; core drives suspend/resume.
        sandbox.setAutostopInterval(0),
        sandbox.setAutoDeleteInterval(-1),
        sandbox.setTtl(0),
      ]);
      const resource: DaytonaResource = {
        ...context.resource,
        providerSandboxId: sandbox.id,
      };
      return { resource, executor: executorFor(sandbox.id) };
    },
    async remove(context) {
      const { daytona, DaytonaNotFoundError } = await getClient();
      try {
        const sandbox = await daytona.get(context.resource.providerSandboxId);
        await sandbox.delete(60, true);
      } catch (error) {
        if (!(error instanceof DaytonaNotFoundError)) throw error;
      }
    },
    async removeLegacy(providerSandboxId) {
      const { daytona, DaytonaNotFoundError } = await getClient();
      try {
        const sandbox = await daytona.get(providerSandboxId);
        await sandbox.delete(60, true);
      } catch (error) {
        if (!(error instanceof DaytonaNotFoundError)) throw error;
      }
    },
    async execLegacy(providerSandboxId, script, timeoutMs) {
      const { daytona } = await getClient();
      const sandbox = await daytona.get(providerSandboxId);
      const started = String(sandbox.state) !== "started";
      if (started) await sandbox.start(120);
      const encoded = Buffer.from(script, "utf8").toString("base64");
      const result = await sandbox.process.executeCommand(
        `bash -c 'echo ${encoded} | base64 -d > /tmp/bb-upgrade.sh && bash /tmp/bb-upgrade.sh 2>&1'`,
        undefined,
        undefined,
        Math.max(1, Math.ceil(timeoutMs / 1000)),
      );
      return { exitCode: result.exitCode, output: result.result, started };
    },
    async stopLegacy(providerSandboxId) {
      const { daytona } = await getClient();
      const sandbox = await daytona.get(providerSandboxId);
      if (String(sandbox.state) === "started") await sandbox.stop(60, false);
    },
  };
}
