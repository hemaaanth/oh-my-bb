/**
 * Boat REST backend. Persisted Box provider/resource IDs remain unchanged.
 * Core installs the daemon over the executor; command status uses an exit marker.
 * Allocation-key lookup is not implemented, so uncertain cleanup stays retained.
 */
import { randomUUID } from "node:crypto";
import { BOAT_RUNTIME_CONTAINER, BOAT_RUNTIME_ROOT, BoatImageClient } from "../../boat-image.js";
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
import { shQuote, toShellCommand } from "./shell-exec.js";

const BASE_URL = "https://boat.dev/api/v1";
// Boat TTL is wall-clock, not idle time. BB handles idle suspension separately.
const AUTO_STOP_SECONDS = 2 * 60 * 60;
const RC_MARKER = "__BBRC__";

// Boat restores files and recreates processes. Never let a saved PID identify
// an unrelated process (or a zombie) when core runs machine setup again.
const clearStaleDaemonPids = `const fs = require("node:fs"), path = require("node:path");
function clean(dir) {
    const file = path.join(dir, "install-daemon.pid");
    if (fs.existsSync(file)) {
      const pid = fs.readFileSync(file, "utf8").trim();
      let command = "";
      if (/^[1-9][0-9]*$/.test(pid)) {
        try { command = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replaceAll("\\0", " "); }
        catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
      }
      if (!/\\b(?:bb-host-daemon(?:\\.js)?|daemon-bundle\\.mjs|host-daemon)\\b/.test(command)) fs.unlinkSync(file);
    }
}
clean("/root/.bb");
if (fs.existsSync("/root/.bb-machines")) for (const entry of fs.readdirSync("/root/.bb-machines", {withFileTypes:true})) {
  if (entry.isDirectory()) clean(path.join("/root/.bb-machines", entry.name));
}`;

type BoxConfig = NonNullable<SandboxRuntimeConfig["box"]>;
type BoxMachineClass = BoxConfig["machineClass"];

const boxEnvelopeSchema = z.object({
  sandbox: z.object({ id: z.string(), state: z.string(), archiveAfter: z.string().nullable().optional() }),
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
  runtimeContainer: z.boolean().optional(),
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
        `Boat API ${response.status}: ${
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

  const executorFor = (boxId: string, managed = false): MachineExecutor => ({
    async exec(request_) {
      request_.signal.throwIfAborted();
      const inputPath = `/tmp/bb-stdin-${randomUUID()}`;
      if (managed && request_.stdin.length > 0) {
        await request(`/sandboxes/${encodeURIComponent(boxId)}/files`, { method: "PUT", signal: request_.signal,
          body: JSON.stringify({ path: inputPath, content: Buffer.from(request_.stdin).toString("base64"), encoding: "base64" }) });
      }
      const argv = managed ? ["sudo", "docker", "exec", "-i", "-e", "IS_SANDBOX=1", BOAT_RUNTIME_CONTAINER, "chroot", BOAT_RUNTIME_ROOT, ...request_.command] : request_.command;
      const shell = toShellCommand(argv, managed ? "" : request_.stdin);
      const invocation = managed && request_.stdin.length > 0
        ? `chmod 600 ${inputPath}; ${shell} <${inputPath}; rc=$?; rm -f ${inputPath}; (exit $rc)` : shell;
      const command = `${invocation}; printf '${RC_MARKER}%s' "$?"`;
      const result = commandSchema.parse(
        await request(`/sandboxes/${encodeURIComponent(boxId)}/commands`, {
          method: "POST", signal: request_.signal,
          body: JSON.stringify({
            command,
            timeoutSeconds: Math.min(600, Math.max(1, Math.ceil(request_.timeoutMs / 1000))),
            detached: false,
          }),
        }).catch(async error => {
          if (managed && request_.stdin.length > 0) {
            await request(`/sandboxes/${encodeURIComponent(boxId)}/commands`, { method: "POST", signal: AbortSignal.timeout(15_000),
              body: JSON.stringify({ command: `rm -f ${inputPath}`, timeoutSeconds: 10, detached: false }) }).catch(() => {});
          }
          throw error;
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
      const body = await request(`/sandboxes/${encodeURIComponent(boxId)}`);
      if (body === null) throw new Error(`Boat ${boxId} disappeared while starting`);
      const state = boxEnvelopeSchema.parse(body).sandbox.state;
      if (state === "ready" || state === "idle" || state === "running") return;
      if (state === "error") throw new Error(`Boat ${boxId} failed while starting`);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Boat ${boxId} did not become ready within 2 minutes`);
  };

  return {
    definition: {
      id: "sandbox-box",
      displayName: "Boat Sandbox",
      description: "Create a cloud sandbox on Boat.",
      environmentDescription: "Run this thread in a Boat cloud sandbox.",
      runtimeName: "Boat",
      icon: "./boat-logo.svg",
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
      if (config.apiKey.length === 0) return { status: "setup-required", message: "Add a Boat API key." };
      if (!config.snapshotId) return { status: "setup-required", message: "Build a runtime image in Settings → Sandboxes before starting a new machine." };
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
      const machineClass = machineClassForTier(tier);
      context.report.step(`Creating the Boat sandbox (${tier})`);
      const created = boxEnvelopeSchema.parse(
        await request("/sandboxes", {
          method: "POST",
          body: JSON.stringify({
            ...(config.snapshotId ? { from: config.snapshotId } : {}),
            type: machineClass,
            name: `bb-${context.key}`,
            ttlSeconds: AUTO_STOP_SECONDS,
            environment: config.environment,
          }),
        }),
      );
      const resource: BoxResource = {
        provider: "box",
        key: context.key,
        providerSandboxId: created.sandbox.id,
        name: `bb-${context.key}`,
        machineClass,
        environment: config.environment,
        sizeTier: tier,
        ...(config.runtimeContainer ? { runtimeContainer: true } : {}),
      };
      await context.checkpoint(resource);
      if (resource.runtimeContainer) {
        await waitUntilRunning(created.sandbox.id);
        await new BoatImageClient(config.apiKey, AbortSignal.any([context.signal, AbortSignal.timeout(330_000)])).command(created.sandbox.id,
          `sudo systemctl start docker; for attempt in $(seq 1 150); do sudo docker start ${BOAT_RUNTIME_CONTAINER} >/dev/null 2>&1 && sudo docker exec ${BOAT_RUNTIME_CONTAINER} test -r ${BOAT_RUNTIME_ROOT}/proc/self/stat && exit 0; sleep 2; done; exit 1`);
      }
      return { resource, executor: executorFor(created.sandbox.id, resource.runtimeContainer) };
    },
    async reconcileCleanup() {
      const listed = z.object({
        sandboxes: z.array(z.unknown()), pageInfo: z.object({ hasMore: z.boolean() }),
      }).parse(await request("/sandboxes?limit=1"));
      // Older creates had no allocation name. Only a completely empty account proves absence.
      if (listed.sandboxes.length === 0 && !listed.pageInfo.hasMore) return;
      throw new Error("Boat cannot confirm cleanup by allocation key; retain the native resource for manual reconciliation");
    },
    async renewLease(context) {
      const path = `/sandboxes/${encodeURIComponent(context.resource.providerSandboxId)}`;
      const body = await request(path, { signal: context.signal });
      if (body === null) return;
      const { sandbox } = boxEnvelopeSchema.parse(body);
      if (!["ready", "idle", "running"].includes(sandbox.state)) return;
      const deadline = Date.parse(sandbox.archiveAfter ?? "");
      if (!Number.isFinite(deadline)) throw new Error("Boat did not report a valid auto-stop deadline");
      if (deadline - Date.now() > 30 * 60_000) return;
      await request(path, {
        method: "PATCH", signal: context.signal,
        body: JSON.stringify({ ttlSeconds: AUTO_STOP_SECONDS }),
      });
    },
    async suspend(context) {
      context.report.step("Stopping the Boat sandbox");
      await request(
        `/sandboxes/${encodeURIComponent(context.resource.providerSandboxId)}/stop`,
        { method: "POST" },
      );
      return context.resource;
    },
    async resume(context) {
      context.report.step("Restoring the Boat sandbox");
      await request(
        `/sandboxes/${encodeURIComponent(context.resource.providerSandboxId)}/resume`,
        { method: "POST", body: JSON.stringify({ ttlSeconds: AUTO_STOP_SECONDS }) },
      );
      await waitUntilRunning(context.resource.providerSandboxId);
      if (context.resource.runtimeContainer) {
        await new BoatImageClient(config.apiKey, AbortSignal.any([context.signal, AbortSignal.timeout(330_000)])).command(context.resource.providerSandboxId,
          `sudo systemctl start docker; for attempt in $(seq 1 150); do sudo docker start ${BOAT_RUNTIME_CONTAINER} >/dev/null 2>&1 && sudo docker exec ${BOAT_RUNTIME_CONTAINER} test -r ${BOAT_RUNTIME_ROOT}/proc/self/stat && exit 0; sleep 2; done; exit 1`);
        await new BoatImageClient(config.apiKey, AbortSignal.any([context.signal, AbortSignal.timeout(30_000)])).command(context.resource.providerSandboxId,
          `sudo docker exec ${BOAT_RUNTIME_CONTAINER} chroot ${BOAT_RUNTIME_ROOT} node -e ${shQuote(clearStaleDaemonPids)}`);
      }
      return {
        resource: context.resource,
        executor: executorFor(context.resource.providerSandboxId, context.resource.runtimeContainer),
      };
    },
    async remove(context) {
      await request(
        `/sandboxes/${encodeURIComponent(context.resource.providerSandboxId)}`,
        {
          method: "DELETE",
          headers: {
            "X-Ascii-Confirm-Delete": context.resource.providerSandboxId,
          },
        },
      );
    },
    async removeLegacy(providerSandboxId) {
      await request(`/sandboxes/${encodeURIComponent(providerSandboxId)}`, {
        method: "DELETE",
        headers: { "X-Ascii-Confirm-Delete": providerSandboxId },
      });
    },
  };
}
