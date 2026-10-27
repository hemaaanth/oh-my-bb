/**
 * Nirvana backend for the BB 0.43 machine/environment provider model.
 *
 * Nirvana's own API has no command-exec endpoint, but it runs on OpenSandbox,
 * whose `execd` daemon (port 44772) exposes a Command Execution API — reachable
 * through Nirvana's gateway exactly like the legacy metrics probe
 * (`GET /sandboxes/{id}/endpoints/44772` → gateway + returned headers). The
 * executor runs `POST /command` (foreground SSE), streams stdout/stderr to
 * `onOutput`, and reads the real exit code from `GET /command/status/{id}`.
 * execd is injected independently of the container entrypoint, so we boot an idle
 * entrypoint and let BB core install the daemon over the executor.
 *
 * Runtime-verify: (1) whether the endpoint headers alone authorize execd or an
 * `X-EXECD-ACCESS-TOKEN` is also required, and (2) that the `init` SSE event
 * carries the command id in its `text` field.
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

const GIB = 1024 ** 3;
const EXECD_PORT = 44772;

type NirvanaConfig = NonNullable<SandboxRuntimeConfig["nirvana"]>;

const sandboxSchema = z.object({
  id: z.string(),
  status: z.object({ state: z.string() }),
});
const endpointSchema = z.object({
  endpoint: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});
const statusSchema = z.object({
  running: z.boolean().optional(),
  exit_code: z.number().nullable().optional(),
});

const nirvanaInputsSchema = z
  .object({
    size: z.enum(sandboxSizeTierValues).optional(),
    image: z.string().min(1).optional(), // image uri override
  })
  .strict();
export type NirvanaInputs = z.infer<typeof nirvanaInputsSchema>;

const nirvanaResourceSchema = z.object({
  provider: z.literal("nirvana"),
  key: z.string(),
  providerSandboxId: z.string(),
  name: z.string(),
  imageUri: z.string(),
  sizeTier: z.enum(sandboxSizeTierValues),
});
export type NirvanaResource = z.infer<typeof nirvanaResourceSchema>;

export function createNirvanaMachineBackend(
  config: NirvanaConfig,
): SandboxBackend<NirvanaInputs, NirvanaResource> {
  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> => {
    const response = await fetch(`${config.apiEndpoint}${path}`, {
      ...init,
      headers: {
        "OPEN-SANDBOX-API-KEY": config.apiKey,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    if (response.status === 404) return null;
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z
        .object({ detail: z.string().optional(), message: z.string().optional() })
        .safeParse(body);
      const detail = parsed.success ? parsed.data.detail ?? parsed.data.message : null;
      throw new Error(`Nirvana API ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return body;
  };

  // Resolve the gateway headers that route to a sandbox's execd (port 44772).
  const execdHeaders = async (
    providerSandboxId: string,
  ): Promise<Record<string, string>> => {
    const endpoint = endpointSchema.parse(
      await request(
        `/sandboxes/${encodeURIComponent(providerSandboxId)}/endpoints/${EXECD_PORT}`,
      ),
    );
    return endpoint.headers;
  };

  const resolveTier = (inputs: NirvanaInputs): SandboxSizeTier =>
    inputs.size !== undefined && isSandboxSizeTier(inputs.size)
      ? inputs.size
      : DEFAULT_SANDBOX_SIZE_TIER;

  const limitsFor = (tier: SandboxSizeTier) => {
    const resources = sizeTierResources(tier);
    return {
      cpu: String(Math.max(1, Math.ceil(resources.cpuCores))),
      memory: `${Math.max(1, Math.ceil(resources.memoryBytes / GIB))}Gi`,
      storage: `${Math.max(1, Math.ceil(resources.diskBytes / GIB))}Gi`,
    };
  };

  const executorFor = (providerSandboxId: string): MachineExecutor => ({
    async exec(request_) {
      request_.signal.throwIfAborted();
      const headers = await execdHeaders(providerSandboxId);
      const response = await fetch(`${config.gatewayEndpoint}/command`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          command: toShellCommand(request_.command, request_.stdin),
          background: false,
          timeout: request_.timeoutMs,
        }),
      });
      if (!response.ok || response.body === null) {
        throw new Error(`execd /command failed (HTTP ${response.status})`);
      }
      // Consume the SSE stream: capture the command id from `init`, stream
      // stdout/stderr to onOutput, and note any error event.
      let commandId: string | null = null;
      let sawError = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleEvent = (raw: string): void => {
        const dataLine = raw
          .split("\n")
          .find((line) => line.startsWith("data:"));
        if (dataLine === undefined) return;
        let event: { type?: string; text?: string };
        try {
          event = JSON.parse(dataLine.slice("data:".length).trim());
        } catch {
          return;
        }
        if (event.type === "init" && typeof event.text === "string") {
          commandId = event.text.trim() || commandId;
        } else if (event.type === "stdout" || event.type === "stderr") {
          if (event.text) request_.onOutput(event.text);
        } else if (event.type === "error") {
          sawError = true;
          if (event.text) request_.onOutput(event.text);
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          handleEvent(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
        }
      }
      if (buffer.trim().length > 0) handleEvent(buffer);

      // Exit code lives only on the status endpoint; fall back to error events.
      let exitCode = sawError ? 1 : 0;
      if (commandId !== null) {
        try {
          const statusResponse = await fetch(
            `${config.gatewayEndpoint}/command/status/${encodeURIComponent(commandId)}`,
            { headers },
          );
          if (statusResponse.ok) {
            const status = statusSchema.parse(await statusResponse.json());
            if (typeof status.exit_code === "number") exitCode = status.exit_code;
          }
        } catch {
          // Keep the error-event fallback.
        }
      }
      return { exitCode };
    },
  });

  return {
    definition: {
      id: "sandbox-nirvana",
      displayName: "Nirvana Sandbox",
      description: "Create a cloud sandbox on Nirvana.",
      environmentDescription: "Run this thread in a Nirvana cloud sandbox.",
      runtimeName: "Nirvana",
      icon: "./nirvana-logo.svg",
      ephemeral: true,
      inputs: nirvanaInputsSchema,
    },
    parseInputs(value) {
      return nirvanaInputsSchema.parse(value ?? {});
    },
    parseResource(value) {
      return nirvanaResourceSchema.parse(value);
    },
    allocationKey(resource) {
      return resource.key;
    },
    async availability(): Promise<PluginMachineProviderAvailability> {
      if (
        config.apiKey.length === 0 ||
        config.apiEndpoint.length === 0 ||
        config.gatewayEndpoint.length === 0
      ) {
        return { status: "setup-required", message: "Configure Nirvana API access." };
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
      const limits = limitsFor(tier);
      const imageUri = context.inputs.image ?? config.imageUri;
      const name = `bb-${context.key}`;
      context.report.step(`Creating the Nirvana sandbox (${tier})`);
      const sandbox = sandboxSchema.parse(
        await request("/sandboxes", {
          method: "POST",
          body: JSON.stringify({
            image: { uri: imageUri },
            // Idle entrypoint: execd is injected separately, and core installs
            // the bb daemon over the executor.
            entrypoint: ["/bin/bash", "-c", "sleep infinity"],
            metadata: { "bb.sandbox-id": context.key, name },
            resourceLimits: { cpu: limits.cpu, memory: limits.memory },
            extensions: {
              persistence: "true",
              storageClass: "local-path",
              storageSize: limits.storage,
            },
          }),
        }),
      );
      const resource: NirvanaResource = {
        provider: "nirvana",
        key: context.key,
        providerSandboxId: sandbox.id,
        name,
        imageUri,
        sizeTier: tier,
      };
      await context.checkpoint(resource);
      return { resource, executor: executorFor(sandbox.id) };
    },
    async reconcileCleanup() {
      throw new Error("Nirvana cannot confirm cleanup by allocation key; retain the native resource for manual reconciliation");
    },
    async suspend(context) {
      context.report.step("Pausing the Nirvana sandbox");
      await request(
        `/sandboxes/${encodeURIComponent(context.resource.providerSandboxId)}/pause`,
        { method: "POST" },
      );
      return context.resource;
    },
    async resume(context) {
      context.report.step("Resuming the Nirvana sandbox");
      await request(
        `/sandboxes/${encodeURIComponent(context.resource.providerSandboxId)}/resume`,
        { method: "POST" },
      );
      return {
        resource: context.resource,
        executor: executorFor(context.resource.providerSandboxId),
      };
    },
    async remove(context) {
      await request(
        `/sandboxes/${encodeURIComponent(context.resource.providerSandboxId)}`,
        { method: "DELETE" },
      );
    },
    async removeLegacy(providerSandboxId) {
      await request(`/sandboxes/${encodeURIComponent(providerSandboxId)}`, {
        method: "DELETE",
      });
    },
    displayName(context) {
      return context.resource.name;
    },
  };
}
