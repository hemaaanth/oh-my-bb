/**
 * Modal backend for the BB 0.43 machine/environment provider model.
 *
 * Allocates a Modal sandbox from a configured image WITHOUT baking bb enrollment
 * env and WITHOUT launching the daemon (it boots `sleep infinity` and stays idle
 * while BB core installs the daemon over the executor). Modal has no stop/start
 * lifecycle — only a fixed 24h timeout — so this backend omits suspend/resume and
 * is registered as non-suspendable; idle suspend skips it.
 */
import { createRequire } from "node:module";
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

const SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MACHINE_KEY_TAG = "bb.machine-key";

type ModalConfig = NonNullable<SandboxRuntimeConfig["modal"]>;
type ModalSdkModule = typeof import("modal");
type ModalSandbox = InstanceType<ModalSdkModule["Sandbox"]>;
interface ModalClient {
  modal: InstanceType<ModalSdkModule["ModalClient"]>;
  NotFoundError: ModalSdkModule["NotFoundError"];
}

const modalInputsSchema = z
  .object({
    size: z.enum(sandboxSizeTierValues).optional(),
    image: z.string().min(1).optional(),
  })
  .strict();
export type ModalInputs = z.infer<typeof modalInputsSchema>;

const modalResourceSchema = z.object({
  provider: z.literal("modal"),
  key: z.string(),
  providerSandboxId: z.string(),
  name: z.string(),
  appName: z.string(),
  imageName: z.string(),
  sizeTier: z.enum(sandboxSizeTierValues),
});
export type ModalResource = z.infer<typeof modalResourceSchema>;

export function createModalMachineBackend(
  config: ModalConfig,
): SandboxBackend<ModalInputs, ModalResource> {
  let client: Promise<ModalClient> | undefined;
  const getClient = (): Promise<ModalClient> =>
    (client ??= (async () => {
      // Load Modal's CommonJS entry via require so its protobuf runtime is not
      // reinterpreted by the TypeScript source loader across hot reloads.
      const { ModalClient, NotFoundError } = createRequire(import.meta.url)(
        "modal",
      ) as ModalSdkModule;
      return {
        modal: new ModalClient({
          tokenId: config.tokenId,
          tokenSecret: config.tokenSecret,
        }),
        NotFoundError,
      } satisfies ModalClient;
    })());

  const resolveTier = (inputs: ModalInputs): SandboxSizeTier =>
    inputs.size !== undefined && isSandboxSizeTier(inputs.size)
      ? inputs.size
      : DEFAULT_SANDBOX_SIZE_TIER;

  const executorFor = (sandbox: ModalSandbox): MachineExecutor => ({
    async exec(request) {
      request.signal.throwIfAborted();
      const process = await sandbox.exec([...request.command], {
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: request.timeoutMs,
      });
      if (request.stdin.length > 0) {
        await process.stdin.writeText(request.stdin);
      }
      await process.closeStdin();
      const [stdout, stderr, exitCode] = await Promise.all([
        process.stdout.readText(),
        process.stderr.readText(),
        process.wait(),
      ]);
      const combined = `${stdout}${stderr}`;
      if (combined.length > 0) request.onOutput(combined);
      return { exitCode };
    },
  });

  return {
    definition: {
      id: "sandbox-modal",
      displayName: "Modal Sandbox",
      description: "Create a cloud sandbox in your Modal account.",
      environmentDescription: "Run this thread in a Modal cloud sandbox.",
      runtimeName: "Modal",
      icon: "./modal-logo.svg",
      ephemeral: true,
      inputs: modalInputsSchema,
    },
    parseInputs(value) {
      return modalInputsSchema.parse(value ?? {});
    },
    parseResource(value) {
      return modalResourceSchema.parse(value);
    },
    allocationKey(resource) {
      return resource.key;
    },
    async availability(): Promise<PluginMachineProviderAvailability> {
      if (config.tokenId.length === 0 || config.tokenSecret.length === 0) {
        return { status: "setup-required", message: "Add a Modal token." };
      }
      if (config.imageName.length === 0) {
        return { status: "setup-required", message: "Set a Modal image name." };
      }
      return { status: "available" };
    },
    async validate(inputs): Promise<PluginMachineValidateDecision> {
      if (inputs.size !== undefined && !isSandboxSizeTier(inputs.size)) {
        return { action: "refuse", message: `Unknown size ${inputs.size}` };
      }
      return { action: "accept" };
    },
    async create(context) {
      const tier = resolveTier(context.inputs);
      const resources = sizeTierResources(tier);
      const imageName = context.inputs.image ?? config.imageName;
      const name = `bb-${context.key}`;
      const { modal } = await getClient();
      context.report.step(`Creating the Modal sandbox (${tier})`);
      const app = await modal.apps.fromName(config.appName, {
        createIfMissing: true,
      });
      const image = await modal.images.fromName(imageName);
      const sandbox = await modal.sandboxes.create(app, image, {
        command: ["sleep", "infinity"],
        cpu: Math.max(1, Math.ceil(resources.cpuCores)),
        memoryMiB: Math.max(512, Math.ceil(resources.memoryBytes / 1024 ** 2)),
        // The gVisor default cannot host a Docker daemon; VM runtime can.
        ...(config.vmRuntime
          ? { experimentalOptions: { vm_runtime: true } }
          : {}),
        name,
        tags: { "bb.sandbox-id": context.key, [MACHINE_KEY_TAG]: context.key },
        timeoutMs: SANDBOX_TIMEOUT_MS,
      });
      const resource: ModalResource = {
        provider: "modal",
        key: context.key,
        providerSandboxId: sandbox.sandboxId,
        name,
        appName: config.appName,
        imageName,
        sizeTier: tier,
      };
      await context.checkpoint(resource);
      return { resource, executor: executorFor(sandbox) };
    },
    async reconcileCleanup(context) {
      const { modal, NotFoundError } = await getClient();
      try {
        const sandbox = await modal.sandboxes.fromName(
          config.appName,
          `bb-${context.key}`,
        );
        await sandbox.terminate();
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
    async remove(context) {
      const { modal, NotFoundError } = await getClient();
      try {
        const sandbox = await modal.sandboxes.fromId(
          context.resource.providerSandboxId,
        );
        await sandbox.terminate();
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
    async removeLegacy(providerSandboxId) {
      const { modal, NotFoundError } = await getClient();
      try {
        const sandbox = await modal.sandboxes.fromId(providerSandboxId);
        await sandbox.terminate();
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
    async removeLegacyCheckpoint(checkpointId) {
      const { modal, NotFoundError } = await getClient();
      try {
        await modal.images.delete(checkpointId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
    displayName(context) {
      return context.resource.name;
    },
  };
}
