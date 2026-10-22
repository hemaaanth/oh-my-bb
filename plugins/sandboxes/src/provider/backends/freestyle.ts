/**
 * Freestyle backend for the BB 0.43 machine/environment provider model.
 *
 * Creates a Freestyle VM WITHOUT the bootstrap/daemon install (core installs the
 * daemon over the executor) and WITHOUT the vendor idle timeout (core owns idle
 * suspend/resume — an out-of-band stop reads as an unrecoverable lost host). The
 * executor runs commands over `vm.exec`, feeding stdin via a base64 pipe.
 */
import { Freestyle } from "freestyle";
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

const GIB = 1024 ** 3;
const FREESTYLE_BASE_SIZE = { cpu: 4, memoryGb: 8, storageGb: 20 };

type FreestyleConfig = NonNullable<SandboxRuntimeConfig["freestyle"]>;
type FreestyleClient = InstanceType<typeof Freestyle>;
type FreestyleVm = Awaited<
  ReturnType<FreestyleClient["vms"]["create"]>
>["vm"];

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
  const client = new Freestyle({ apiKey: config.apiKey });

  const resolveTier = (inputs: FreestyleInputs): SandboxSizeTier =>
    inputs.size !== undefined && isSandboxSizeTier(inputs.size)
      ? inputs.size
      : DEFAULT_SANDBOX_SIZE_TIER;

  const sizeFor = (tier: SandboxSizeTier) => {
    const resources = sizeTierResources(tier);
    return {
      cpu: Math.max(1, Math.ceil(resources.cpuCores)),
      memoryGb: Math.max(1, Math.ceil(resources.memoryBytes / GIB)),
      storageGb: Math.max(1, Math.ceil(resources.diskBytes / GIB)),
    };
  };

  const executorFor = (vm: FreestyleVm): MachineExecutor => ({
    async exec(request) {
      request.signal.throwIfAborted();
      const result = await vm.exec({
        command: toShellCommand(request.command, request.stdin),
        timeoutMs: request.timeoutMs,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (output.length > 0) request.onOutput(output);
      return { exitCode: result.statusCode ?? 1 };
    },
  });

  const isNotFound = (error: unknown): boolean =>
    error instanceof Error && /not found|404/iu.test(error.message);

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
      const { vm, vmId } = await client.vms.create({
        ...(snapshotId === null ? {} : { snapshotId }),
        name,
        // No vendor idle timeout: BB core owns suspend/resume.
        idleTimeoutSeconds: null,
        persistence:
          config.persistence === "persistent"
            ? { type: "persistent" }
            : { type: "sticky", priority: 5 },
      });
      try {
        const size = sizeFor(tier);
        if (
          size.cpu !== FREESTYLE_BASE_SIZE.cpu ||
          size.memoryGb !== FREESTYLE_BASE_SIZE.memoryGb ||
          size.storageGb !== FREESTYLE_BASE_SIZE.storageGb
        ) {
          await vm.resize({
            cpu: size.cpu,
            memory: size.memoryGb,
            storage: size.storageGb,
          });
        }
      } catch (error) {
        await client.vms.delete({ vmId }).catch(() => undefined);
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
      return { resource, executor: executorFor(vm) };
    },
    async reconcileCleanup(context) {
      try {
        const listed = await client.vms.list();
        for (const vm of listed.vms) {
          if ((vm as { name?: string }).name === `bb-${context.key}`) {
            await client.vms.delete({ vmId: vm.id }).catch(() => undefined);
          }
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async suspend(context) {
      try {
        const { vm } = await client.vms.get({
          vmId: context.resource.providerSandboxId,
        });
        context.report.step("Stopping the Freestyle VM");
        await vm.stop();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return context.resource;
    },
    async resume(context) {
      const { vm } = await client.vms.get({
        vmId: context.resource.providerSandboxId,
      });
      context.report.step("Restoring the Freestyle VM");
      await vm.start({});
      return { resource: context.resource, executor: executorFor(vm) };
    },
    async remove(context) {
      await client.vms
        .delete({ vmId: context.resource.providerSandboxId })
        .catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
    },
    async removeLegacy(providerSandboxId) {
      await client.vms.delete({ vmId: providerSandboxId }).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    },
    displayName(context) {
      return context.resource.name;
    },
  };
}
