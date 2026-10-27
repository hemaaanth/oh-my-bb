/**
 * E2B backend for the BB 0.43 machine/environment provider model.
 *
 * The E2B SDK is loaded in a subprocess (`scripts/e2b-runtime.mjs`) to avoid an
 * ESM-in-process issue under the plugin's source loader. This backend drives the
 * native runtime actions (create-native / exec / resume-native / sleep / destroy):
 * it allocates WITHOUT enrollment env or a daemon launch, and the executor runs
 * commands over the `exec` action, feeding stdin through E2B's process stream.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  type SandboxSizeTier,
} from "../../size-tiers.js";
import type { SandboxBackend } from "../sandbox-backend.js";
import { toShellCommand } from "./shell-exec.js";

const FALLBACK_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_OUTPUT_LENGTH = 8 * 1024 * 1024;

type E2bConfig = NonNullable<SandboxRuntimeConfig["e2b"]>;

const runtimeResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-native"), sandboxId: z.string().min(1) }),
  z.object({ action: z.literal("resume-native"), sandboxId: z.string().min(1) }),
  z.object({
    action: z.literal("exec"),
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.object({ action: z.literal("destroy") }),
  z.object({ action: z.literal("sleep") }),
]);
type RuntimeResult = z.infer<typeof runtimeResultSchema>;

/**
 * The E2B SDK can write status lines to stdout before our helper result. Keep
 * the helper protocol line-oriented and accept only a final line that matches
 * the exact result schema. Never include provider output in the error because
 * an exec result can contain provisioning secrets.
 */
export function parseE2bRuntimeOutput(stdout: string): RuntimeResult {
  let shape = "no JSON object";
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null) {
        const candidate = value as Record<string, unknown>;
        shape = [
          `action=${typeof candidate.action === "string" ? candidate.action : typeof candidate.action}`,
          `exitCode=${typeof candidate.exitCode}`,
          `stdout=${typeof candidate.stdout}`,
          `stderr=${typeof candidate.stderr}`,
        ].join(", ");
      } else {
        shape = `JSON ${typeof value}`;
      }
      const parsed = runtimeResultSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    } catch {
      // Ignore SDK status lines and keep looking for the helper's JSON result.
    }
  }
  throw new Error(
    `E2B runtime returned invalid output (${shape}; bytes=${Buffer.byteLength(stdout, "utf8")})`,
  );
}

async function callRuntime(
  apiKey: string,
  action: "create-native" | "resume-native" | "exec" | "destroy" | "sleep",
  input: object,
): Promise<RuntimeResult> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = [
    resolve(moduleDir, "../../../scripts/e2b-runtime.mjs"),
    resolve(moduleDir, "../scripts/e2b-runtime.mjs"),
  ].find(existsSync);
  if (scriptPath === undefined) throw new Error("E2B runtime helper is missing");
  const pluginRoot = resolve(dirname(scriptPath), "..");
  const child = spawn(process.execPath, [scriptPath, action], {
    cwd: pluginRoot,
    env: {
      // The packaged BB executable is Electron; run the helper as Node instead
      // of trying to open the desktop app on this headless server process.
      ELECTRON_RUN_AS_NODE: "1",
      E2B_API_KEY: apiKey,
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
      ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
      ...(process.env.NODE_EXTRA_CA_CERTS
        ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_LENGTH);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_LENGTH);
  });
  child.stdin.end(JSON.stringify(input));
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    // `exit` can fire before stdout and stderr are fully drained. `close`
    // waits until the stdio pipes close, so the JSON result is complete.
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`E2B ${action} exited ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  return parseE2bRuntimeOutput(stdout);
}

const e2bInputsSchema = z
  .object({
    size: z.enum(sandboxSizeTierValues).optional(),
    image: z.string().min(1).optional(), // template override
  })
  .strict();
export type E2bInputs = z.infer<typeof e2bInputsSchema>;

const e2bResourceSchema = z.object({
  provider: z.literal("e2b"),
  key: z.string(),
  providerSandboxId: z.string(),
  name: z.string(),
  template: z.string(),
  sizeTier: z.enum(sandboxSizeTierValues),
});
export type E2bResource = z.infer<typeof e2bResourceSchema>;

export function createE2bMachineBackend(
  config: E2bConfig,
): SandboxBackend<E2bInputs, E2bResource> {
  const resolveTier = (inputs: E2bInputs): SandboxSizeTier =>
    inputs.size !== undefined && isSandboxSizeTier(inputs.size)
      ? inputs.size
      : DEFAULT_SANDBOX_SIZE_TIER;

  const executorFor = (providerSandboxId: string): MachineExecutor => ({
    async exec(request) {
      request.signal.throwIfAborted();
      const result = await callRuntime(config.apiKey, "exec", {
        providerSandboxId,
        command: toShellCommand(request.command, ""),
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
      });
      if (result.action !== "exec") throw new Error("E2B exec failed");
      const output = `${result.stdout}${result.stderr}`;
      if (output.length > 0) request.onOutput(output);
      return { exitCode: result.exitCode };
    },
  });

  return {
    definition: {
      id: "sandbox-e2b",
      displayName: "E2B Sandbox",
      description: "Create a cloud sandbox on E2B.",
      environmentDescription: "Run this thread in an E2B cloud sandbox.",
      runtimeName: "E2B",
      icon: "./e2b-logo.svg",
      ephemeral: true,
      inputs: e2bInputsSchema,
    },
    parseInputs(value) {
      return e2bInputsSchema.parse(value ?? {});
    },
    parseResource(value) {
      return e2bResourceSchema.parse(value);
    },
    allocationKey(resource) {
      return resource.key;
    },
    async availability(): Promise<PluginMachineProviderAvailability> {
      if (config.apiKey.length === 0) {
        return { status: "setup-required", message: "Add an E2B API key." };
      }
      if (config.template.length === 0) {
        return { status: "setup-required", message: "Set an E2B template." };
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
      const template = context.inputs.image ?? config.template;
      const name = `bb-${context.key}`;
      context.report.step("Creating the E2B sandbox");
      const result = await callRuntime(config.apiKey, "create-native", {
        template,
        metadata: { "bb.sandbox-id": context.key, name },
        timeoutMs: FALLBACK_TIMEOUT_MS,
        lifecycle: { onTimeout: { action: "pause", keepMemory: true }, autoResume: true },
      });
      if (result.action !== "create-native") throw new Error("E2B create failed");
      const resource: E2bResource = {
        provider: "e2b",
        key: context.key,
        providerSandboxId: result.sandboxId,
        name,
        template,
        sizeTier: tier,
      };
      await context.checkpoint(resource);
      return { resource, executor: executorFor(result.sandboxId) };
    },
    async reconcileCleanup() {
      throw new Error("E2B cannot confirm cleanup by allocation key; retain the native resource until removal is verified");
    },
    async suspend(context) {
      context.report.step("Pausing the E2B sandbox");
      await callRuntime(config.apiKey, "sleep", {
        providerSandboxId: context.resource.providerSandboxId,
      });
      return context.resource;
    },
    async resume(context) {
      context.report.step("Resuming the E2B sandbox");
      const result = await callRuntime(config.apiKey, "resume-native", {
        providerSandboxId: context.resource.providerSandboxId,
      });
      if (result.action !== "resume-native") throw new Error("E2B resume failed");
      const resource: E2bResource = {
        ...context.resource,
        providerSandboxId: result.sandboxId,
      };
      return { resource, executor: executorFor(result.sandboxId) };
    },
    async remove(context) {
      await callRuntime(config.apiKey, "destroy", {
        providerSandboxId: context.resource.providerSandboxId,
      });
    },
    async removeLegacy(providerSandboxId) {
      await callRuntime(config.apiKey, "destroy", { providerSandboxId });
    },
    displayName(context) {
      return context.resource.name;
    },
  };
}
