/**
 * Freestyle backend for the BB 0.43 machine/environment provider model.
 *
 * Creates a Freestyle VM WITHOUT the bootstrap/daemon install (core installs the
 * daemon over the executor) and WITHOUT the vendor idle timeout (core owns idle
 * suspend/resume — an out-of-band stop reads as an unrecoverable lost host). The
 * executor runs commands over `vm.exec`, feeding stdin via a base64 pipe.
 */
import { Freestyle, FreestyleApiError } from "freestyle";
import { z } from "zod";
import type {
  MachineExecutor,
  PluginMachineValidateDecision,
} from "@get-bb/plugin-sdk";
import type { PluginMachineProviderAvailability } from "@get-bb/plugin-sdk/machine-provider";
import type { SandboxRuntimeConfig } from "../../config.js";
import {
  DEFAULT_SANDBOX_SIZE_TIER,
  isSandboxSizeTier,
  sandboxSizeTierValues,
  sizeTierResources,
  type SandboxSizeTier,
} from "../../size-tiers.js";
import type { SandboxBackend } from "../sandbox-backend.js";
import { toShellCommand } from "./shell-exec.js";

const MIB = 1024 ** 2;

type FreestyleConfig = NonNullable<SandboxRuntimeConfig["freestyle"]>;

const freestyleInputsSchema = z
  .object({
    size: z.enum(sandboxSizeTierValues).optional(),
    image: z.string().min(1).optional(), // snapshot id override
  })
  .strict();
export type FreestyleInputs = z.infer<typeof freestyleInputsSchema>;

const freestyleResourceSchema = z.object({
  provider: z.literal("freestyle"),
  key: z.string(),
  providerSandboxId: z.string(),
  name: z.string(),
  sizeTier: z.enum(sandboxSizeTierValues),
  snapshotId: z.string().nullable(),
});
export type FreestyleResource = z.infer<typeof freestyleResourceSchema>;

export function createFreestyleMachineBackend(
  config: FreestyleConfig,
): SandboxBackend<FreestyleInputs, FreestyleResource> {
  let clientKey = config.apiKey;
  let client = new Freestyle({ apiKey: clientKey });
  const currentClient = () => {
    // Save mutates the captured config; SDK clients and VM handles retain auth.
    if (clientKey !== config.apiKey) {
      client = new Freestyle({ apiKey: config.apiKey });
      clientKey = config.apiKey;
    }
    return client;
  };

  const resolveTier = (inputs: FreestyleInputs): SandboxSizeTier =>
    inputs.size !== undefined && isSandboxSizeTier(inputs.size)
      ? inputs.size
      : DEFAULT_SANDBOX_SIZE_TIER;

  const sizeFor = (tier: SandboxSizeTier) => {
    const resources = sizeTierResources(tier);
    return {
      cpu: Math.max(1, Math.ceil(resources.cpuCores)),
      memory: Math.max(1, Math.ceil(resources.memoryBytes / MIB)),
      storage: Math.max(1, Math.ceil(resources.diskBytes / MIB)),
    };
  };

  const executorFor = (vmId: string): MachineExecutor => ({
    async exec(request) {
      request.signal.throwIfAborted();
      const result = await currentClient().vms.ref(vmId).exec({
        linuxUser: "root",
        command: toShellCommand(request.command, request.stdin),
        timeoutMs: request.timeoutMs,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (output.length > 0) request.onOutput(output);
      return { exitCode: result.statusCode ?? 1 };
    },
  });

  const isNotFound = (error: unknown): boolean =>
    error instanceof FreestyleApiError && error.status === 404;

  return {
    definition: {
      id: "sandbox-freestyle",
      displayName: "Freestyle Sandbox",
      description: "Create a cloud sandbox on Freestyle.",
      environmentDescription: "Run this thread in a Freestyle cloud VM.",
      runtimeName: "Freestyle",
      icon: "./freestyle-logo.svg",
      ephemeral: true,
      inputs: freestyleInputsSchema,
    },
    parseInputs(value) {
      return freestyleInputsSchema.parse(value ?? {});
    },
    parseResource(value) {
      return freestyleResourceSchema.parse(value);
    },
    allocationKey(resource) {
      return resource.key;
    },
    async availability(): Promise<PluginMachineProviderAvailability> {
      return config.apiKey.length === 0
        ? { status: "setup-required", message: "Add a Freestyle API key." }
        : { status: "available" };
    },
    async validate(inputs): Promise<PluginMachineValidateDecision> {
      if (inputs.size !== undefined && !isSandboxSizeTier(inputs.size)) {
        return { action: "refuse", message: `Unknown size ${inputs.size}` };
      }
      return { action: "accept" };
    },
    async create(context) {
      const tier = resolveTier(context.inputs);
      const snapshotId = context.inputs.image ?? config.snapshotId;
      const name = `bb-${context.key}`;
      context.report.step(`Creating the Freestyle VM (${tier})`);
      const client = currentClient();
      const persistent = config.persistence === "persistent";
      const { vm, vmId, data } = await client.vms.create({
        ...(snapshotId === null ? {} : { snapshotId }),
        displayName: name,
        firewall: {
          rules: [{ action: "allow", source: {}, destination: { public: true } }],
        },
        // BB owns idle pause. Only persistent mode requires uncapped retention.
        idleTimeoutSeconds: -1,
        ...(persistent ? { autoDeleteSeconds: -1, ttlSeconds: -1 } : {}),
      }).catch((error: unknown) => {
        if (snapshotId !== null && error instanceof FreestyleApiError &&
          (error.status === 400 || error.status === 404) &&
          /snapshot.*(?:does not exist|not found)/iu.test(error.message)) {
          throw new Error(`Freestyle snapshot "${snapshotId}" is unavailable. In Sandboxes settings → Freestyle, clear Base snapshot to use Ubuntu, or choose an existing snapshot.`, { cause: error });
        }
        throw error;
      });
      try {
        if (data.autoDeleteSeconds === 0) {
          throw new Error("Freestyle returned an ephemeral VM; durable suspend/resume requires retained storage.");
        }
        if (persistent && (
          (data.autoDeleteSeconds != null && data.autoDeleteSeconds >= 0) ||
          (data.ttlSeconds != null && data.ttlSeconds >= 0)
        )) {
          throw new Error("Freestyle persistent storage requires a plan without an auto-delete cap or deletion deadline.");
        }
        const requested = sizeFor(tier);
        // The API only grows; a base image or snapshot can already be larger.
        const size = {
          cpu: Math.max(requested.cpu, data.resources.cpu),
          memory: Math.max(requested.memory, data.resources.memory),
          storage: Math.max(requested.storage, data.resources.storage),
        };
        if (
          size.cpu > data.resources.cpu ||
          size.memory > data.resources.memory ||
          size.storage > data.resources.storage
        ) {
          await vm.resize(size);
        }
      } catch (error) {
        await client.vms.delete(vmId).catch(() => undefined);
        if (error instanceof FreestyleApiError && error.status === 429 && /this plan allows/iu.test(error.message)) {
          throw new Error(`Freestyle cannot run size ${tier} on this plan. Choose a smaller size in the thread's environment options, or upgrade your Freestyle plan. ${error.message}`, { cause: error });
        }
        throw error;
      }
      const resource: FreestyleResource = {
        provider: "freestyle",
        key: context.key,
        providerSandboxId: vmId,
        name,
        sizeTier: tier,
        snapshotId,
      };
      await context.checkpoint(resource);
      return { resource, executor: executorFor(vmId) };
    },
    async reconcileCleanup(context) {
      try {
        const client = currentClient();
        const matches: string[] = [];
        let offset = 0;
        for (;;) {
          const listed = await client.vms.list({ limit: 100, offset });
          for (const vm of listed.vms) {
            if (vm.displayName === `bb-${context.key}`) matches.push(vm.id);
          }
          offset += listed.vms.length;
          if (listed.vms.length === 0 || offset >= listed.totalCount) break;
        }
        // Delete after paging, so removals cannot shift the next page's offset.
        for (const vmId of matches) {
          await client.vms.delete(vmId).catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async suspend(context) {
      try {
        const vm = currentClient().vms.ref(context.resource.providerSandboxId);
        context.report.step("Pausing the Freestyle VM");
        await vm.pause();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return context.resource;
    },
    async resume(context) {
      const vmId = context.resource.providerSandboxId;
      context.report.step("Restoring the Freestyle VM");
      await currentClient().vms.ref(vmId).start();
      return { resource: context.resource, executor: executorFor(vmId) };
    },
    async remove(context) {
      await currentClient().vms
        .delete(context.resource.providerSandboxId)
        .catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
    },
    async removeLegacy(providerSandboxId) {
      await currentClient().vms.delete(providerSandboxId).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    },
  };
}
