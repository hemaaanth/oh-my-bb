/**
 * Box backend for the BB 0.43 machine/environment provider model.
 *
 * Allocates a Box via its REST API WITHOUT the legacy `setupScript` (daemon
 * install) or enrollment env — core installs the daemon over the executor. Box's
 * command API returns only a boolean `success`, so the executor appends an
 * exit-code marker and parses it. Box exposes no name/metadata to look a box up
 * by allocation key, so `reconcileCleanup` is a best-effort no-op.
 */
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

const BASE_URL = "https://ascii.dev/api/box/v1";
const RC_MARKER = "__BBRC__";

type BoxConfig = NonNullable<SandboxRuntimeConfig["box"]>;
type BoxMachineClass = BoxConfig["machineClass"];

const boxEnvelopeSchema = z.object({
  box: z.object({ id: z.string(), state: z.string() }),
});
const commandSchema = z.object({
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

const boxInputsSchema = z
  .object({ size: z.enum(sandboxSizeTierValues).optional() })
  .strict();
export type BoxInputs = z.infer<typeof boxInputsSchema>;

const boxResourceSchema = z.object({
  provider: z.literal("box"),
  key: z.string(),
  providerSandboxId: z.string(),
  name: z.string(),
  machineClass: z.enum(["small", "default", "large"]),
  environment: z.string(),
  sizeTier: z.enum(sandboxSizeTierValues),
});
export type BoxResource = z.infer<typeof boxResourceSchema>;

function machineClassForTier(tier: SandboxSizeTier): BoxMachineClass {
  const { cpuCores } = sizeTierResources(tier);
  if (cpuCores <= 2) return "small";
  if (cpuCores <= 4) return "default";
  return "large";
}

export function createBoxMachineBackend(
  config: BoxConfig,
): SandboxBackend<BoxInputs, BoxResource> {
  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> => {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    if (response.status === 404) return null;
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = z.object({ message: z.string().optional() }).safeParse(body);
      throw new Error(
        `Box API ${response.status}: ${
          detail.success ? detail.data.message ?? response.statusText : response.statusText
        }`,
      );
    }
    return body;
  };

  const resolveTier = (inputs: BoxInputs): SandboxSizeTier =>
    inputs.size !== undefined && isSandboxSizeTier(inputs.size)
      ? inputs.size
      : DEFAULT_SANDBOX_SIZE_TIER;

  const executorFor = (boxId: string): MachineExecutor => ({
    async exec(request_) {
      request_.signal.throwIfAborted();
      const command = `${toShellCommand(request_.command, request_.stdin)}; printf '${RC_MARKER}%s' "$?"`;
      const result = commandSchema.parse(
        await request(`/boxes/${encodeURIComponent(boxId)}/commands`, {
          method: "POST",
          body: JSON.stringify({
            command,
            timeoutSeconds: Math.max(1, Math.ceil(request_.timeoutMs / 1000)),
            detached: false,
          }),
        }),
      );
      let stdout = result.stdout;
      let exitCode = result.success ? 0 : 1;
      const markerAt = stdout.lastIndexOf(RC_MARKER);
      if (markerAt >= 0) {
        const parsed = Number.parseInt(
          stdout.slice(markerAt + RC_MARKER.length),
          10,
        );
        if (Number.isFinite(parsed)) exitCode = parsed;
        stdout = stdout.slice(0, markerAt);
      }
      const output = `${stdout}${result.stderr}`;
      if (output.length > 0) request_.onOutput(output);
      return { exitCode };
    },
  });

  const waitUntilRunning = async (boxId: string): Promise<void> => {
    const deadline = Date.now() + 2 * 60_000;
    while (Date.now() < deadline) {
      const body = await request(`/boxes/${encodeURIComponent(boxId)}`);
      if (body === null) throw new Error(`Box ${boxId} disappeared while starting`);
      const state = boxEnvelopeSchema.parse(body).box.state;
      if (state === "ready" || state === "idle" || state === "running") return;
      if (state === "error") throw new Error(`Box ${boxId} failed while starting`);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Box ${boxId} did not become ready within 2 minutes`);
  };

  return {
    definition: {
      id: "sandbox-box",
      displayName: "Box Sandbox",
      description: "Create a cloud sandbox on Box.",
      environmentDescription: "Run this thread in a Box cloud sandbox.",
      runtimeName: "Box",
      icon: "./box-logo.svg",
      ephemeral: true,
      inputs: boxInputsSchema,
    },
    parseInputs(value) {
      return boxInputsSchema.parse(value ?? {});
    },
    parseResource(value) {
      return boxResourceSchema.parse(value);
    },
    allocationKey(resource) {
      return resource.key;
    },
    async availability(): Promise<PluginMachineProviderAvailability> {
      return config.apiKey.length === 0
        ? { status: "setup-required", message: "Add a Box API key." }
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
      const machineClass = machineClassForTier(tier);
      context.report.step(`Creating the Box sandbox (${tier})`);
      const created = boxEnvelopeSchema.parse(
        await request("/boxes", {
          method: "POST",
          body: JSON.stringify({
            type: machineClass,
            ttlSeconds: null,
            environment: config.environment,
          }),
        }),
      );
      const resource: BoxResource = {
        provider: "box",
        key: context.key,
        providerSandboxId: created.box.id,
        name: `bb-${context.key}`,
        machineClass,
        environment: config.environment,
        sizeTier: tier,
      };
      await context.checkpoint(resource);
      return { resource, executor: executorFor(created.box.id) };
    },
    async reconcileCleanup() {
      // Box exposes no name/metadata lookup by allocation key, so an orphan from
      // a crash mid-create cannot be found here; accept it (rare) rather than
      // deleting an unrelated box.
    },
    async suspend(context) {
      context.report.step("Stopping the Box sandbox");
      await request(
        `/boxes/${encodeURIComponent(context.resource.providerSandboxId)}/stop`,
        { method: "POST" },
      );
      return context.resource;
    },
    async resume(context) {
      context.report.step("Restoring the Box sandbox");
      await request(
        `/boxes/${encodeURIComponent(context.resource.providerSandboxId)}/resume`,
        { method: "POST" },
      );
      await waitUntilRunning(context.resource.providerSandboxId);
      return {
        resource: context.resource,
        executor: executorFor(context.resource.providerSandboxId),
      };
    },
    async remove(context) {
      await request(
        `/boxes/${encodeURIComponent(context.resource.providerSandboxId)}`,
        {
          method: "DELETE",
          headers: {
            "X-Ascii-Confirm-Delete": context.resource.providerSandboxId,
          },
        },
      );
    },
    async removeLegacy(providerSandboxId) {
      await request(`/boxes/${encodeURIComponent(providerSandboxId)}`, {
        method: "DELETE",
        headers: { "X-Ascii-Confirm-Delete": providerSandboxId },
      });
    },
    displayName(context) {
      return context.resource.name;
    },
  };
}
