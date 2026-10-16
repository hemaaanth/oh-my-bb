#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

export const MODELS = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"];

/** @param {string[]} args */
export function launchArgs(args) {
  const out = [];
  let model = MODELS[0];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider" || arg.startsWith("--provider=") || arg === "--api-key" || arg.startsWith("--api-key=") ||
        arg === "--daemon-socket" || arg.startsWith("--daemon-socket="))
      throw new Error("Provider, API key, and daemon socket are owned by prime-agent-acp.");
    if (arg === "--model" || arg.startsWith("--model=")) {
      const selected = arg === "--model" ? args[++i] : arg.slice(8);
      if (!selected) throw new Error("--model requires a model id.");
      const slash = selected.indexOf("/");
      const provider = slash < 0 ? "model-gateway" : selected.slice(0, slash);
      if (provider !== "model-gateway") throw new Error("Prime ACP only accepts model-gateway models.");
      model = slash < 0 ? selected : selected.slice(slash + 1);
      if (!model) throw new Error("--model requires a model id.");
    } else out.push(arg);
  }
  return { model, args: ["--offline", "--provider", "model-gateway", "--model", model, ...out] };
}

/** @param {string} baseUrl @param {string[]} models */
export function primeConfig(baseUrl, models) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("MODEL_GATEWAY_BASE_URL must be HTTP(S) without credentials, query, or fragment.");
  return { providers: { "model-gateway": {
    api: "openai-responses", baseUrl: baseUrl.replace(/\/+$/u, ""),
    apiKey: "MODEL_GATEWAY_TOKEN", authHeader: true,
    models: [...new Set(models)].map((id) => ({
      id, name: `${id} (Model Gateway)`, reasoning: true, input: ["text", "image"],
      contextWindow: id === "gpt-6.1-sol" ? 500000 : 272000, maxTokens: 128000,
    })),
  } } };
}

/** @param {import('node:child_process').ChildProcess} child */
async function exited(child) {
  const [code, signal] = await once(child, "close");
  return { code: /** @type {number|null} */ (code), signal: /** @type {NodeJS.Signals|null} */ (signal) };
}

/** Stop only this launch's daemon. Prime's public shutdown command scans all daemons.
 * @param {string} socketPath
 */
export async function shutdownDaemon(socketPath) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const lines = createInterface({ input: socket });
    let sent = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Timed out stopping the private Prime daemon.")), 10000);
    /** @param {Error | undefined} [error] */
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      socket.destroy();
      if (error) reject(error); else resolve(undefined);
    }
    socket.on("error", (error) => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      finish(code === "ENOENT" || code === "ECONNREFUSED" ? undefined : error);
    });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch { finish(new Error("Invalid private Prime daemon message.")); return; }
      if (message.type === "daemon_hello" && !sent) {
        if (message.protocol?.name !== "prime-agent.daemon" || typeof message.protocol?.version !== "number") {
          finish(new Error("Invalid private Prime daemon protocol.")); return;
        }
        sent = true;
        socket.write(`${JSON.stringify({
          type: "command", id: "prime-acp-shutdown", protocol: message.protocol,
          clientId: `prime-agent-acp:${process.pid}`,
          command: { type: "shutdown", id: "prime-acp-shutdown", force: true },
        })}\n`);
      } else if (message.type === "response" && message.id === "prime-acp-shutdown" && message.success === false) {
        finish(new Error("Private Prime daemon refused shutdown."));
      }
    });
    socket.on("close", () => finish(sent ? undefined : new Error("Private Prime daemon closed before its handshake.")));
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args[0] === "--version") { console.log("prime-agent-acp 0.1.0"); return 0; }
  // BB discovers models outside a thread. No credential or host setup is needed.
  if (args[0] === "model-list" || args[0] === "--list-models") {
    for (const model of MODELS) console.log(`model-gateway/${model} - ${model} (model-gateway)`);
    return 0;
  }
  if (!env.MODEL_GATEWAY_BASE_URL || !env.MODEL_GATEWAY_TOKEN)
    throw new Error("MODEL_GATEWAY_BASE_URL and MODEL_GATEWAY_TOKEN are required; no local Prime login fallback.");
  const launch = launchArgs(args.length ? args : ["--mode", "acp"]);
  const config = primeConfig(env.MODEL_GATEWAY_BASE_URL, [...MODELS, launch.model]);
  // Short, unique socket paths also prevent a daemon from retaining another thread's env.
  const root = await mkdtemp(path.join(tmpdir(), "pa-acp-"));
  const agentDir = path.join(root, "agent");
  const childEnv = { ...env, PRIME_AGENT_CODING_AGENT_DIR: agentDir,
    PRIME_AGENT_DAEMON_SOCKET: path.join(root, "d.sock"), PI_OFFLINE: "1" };
  const binary = env.PRIME_AGENT_BIN || "prime-agent";
  /** @type {import('node:child_process').ChildProcess|undefined} */
  let child;
  /** @type {NodeJS.Signals|null} */
  let receivedSignal = null;
  /** @param {NodeJS.Signals} signal */
  const forward = (signal) => { receivedSignal = signal; child?.kill(signal); };
  try {
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(path.join(agentDir, "models.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
    // Let Prime create its daemon so its installed worker startup stays authoritative.
    child = spawn(binary, launch.args, { env: childEnv, stdio: "inherit" });
    for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.on(signal, forward);
    const result = await exited(child);
    return receivedSignal !== null || result.signal !== null ? 1 : result.code ?? 1;
  } finally {
    for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.off(signal, forward);
    // Address only our socket; `prime-agent shutdown` ignores it and discovers other daemons.
    await shutdownDaemon(childEnv.PRIME_AGENT_DAEMON_SOCKET);
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) {
    console.error(`prime-agent-acp: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
