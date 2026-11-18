#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

/** Reported by `--version`; the manifest is the one place the version lives. */
const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

export const MODELS = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"];

/** @typedef {{ id: string, name: string, input: string[], contextWindow: number, maxTokens: number }} GatewayModel */

/** @param {string} home */
function configuredModels(home) {
  try {
    const catalog = JSON.parse(readFileSync(path.join(home, ".config/bb/model-gateway-models.json"), "utf8"));
    if (catalog.managedBy !== "bb gateway setup host" || !Array.isArray(catalog.models))
      throw new Error("Invalid managed Prime model catalog. Run bb gateway setup host.");
    return /** @type {GatewayModel[]} */ (catalog.models);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
}

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

/** @param {string} baseUrl @param {string[]} models @param {GatewayModel[]} configured */
export function primeConfig(baseUrl, models, configured = []) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("MODEL_GATEWAY_BASE_URL must be HTTP(S) without credentials, query, or fragment.");
  return { providers: { "model-gateway": {
    api: "openai-responses", baseUrl: baseUrl.replace(/\/+$/u, ""),
    apiKey: "MODEL_GATEWAY_TOKEN", authHeader: true,
    models: [...new Set(models)].map((id) => ({
      id, name: `${id} (Model Gateway)`, reasoning: true, input: ["text", "image"],
      contextWindow: id === "gpt-6.1-sol" ? 500000 : 272000, maxTokens: 128000,
      ...configured.find((model) => model.id === id),
    })),
  } } };
}

/** @param {string} baseUrl @param {string} token */
async function gatewayRelay(baseUrl, token) {
  const route = `/${randomUUID()}`;
  const target = `${baseUrl.replace(/\/+$/u, "")}/responses`;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== `${route}/responses` || req.headers.origin)
      return void res.writeHead(404).end();
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const upstream = await fetch(target, {
        method: "POST", redirect: "error", signal: abort.signal,
        headers: { "x-bb-model-gateway-token": token, "content-type": "application/json", accept: "text/event-stream" },
        body: Readable.toWeb(req), duplex: "half",
      });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (upstream.body) Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(undefined)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot bind Prime Gateway relay.");
  return { baseUrl: `http://127.0.0.1:${address.port}${route}`, token: route.slice(1),
    close: () => { server.closeAllConnections(); server.close(); } };
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
  if (args[0] === "--version") { console.log(`prime-agent-acp ${VERSION}`); return 0; }
  const configured = configuredModels(env.HOME || homedir());
  const models = [...new Set([...MODELS, ...configured.map((model) => model.id)])];
  // BB discovers models outside a thread, before a per-thread token exists.
  if (args[0] === "model-list" || args[0] === "--list-models") {
    for (const model of models) {
      const name = configured.find(({ id }) => id === model)?.name ?? model;
      console.log(`model-gateway/${model} - ${name} (model-gateway)`);
    }
    return 0;
  }
  if (!env.MODEL_GATEWAY_BASE_URL || !env.MODEL_GATEWAY_TOKEN)
    throw new Error("MODEL_GATEWAY_BASE_URL and MODEL_GATEWAY_TOKEN are required; no local Prime login fallback.");
  const launch = launchArgs(args.length ? args : ["--mode", "acp"]);
  // Validate the host URL before creating the launcher resources.
  const config = primeConfig(env.MODEL_GATEWAY_BASE_URL, [...models, launch.model], configured);
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
  /** @type {Awaited<ReturnType<typeof gatewayRelay>> | undefined} */
  let relay;
  try {
    relay = await gatewayRelay(config.providers["model-gateway"].baseUrl, env.MODEL_GATEWAY_TOKEN);
    config.providers["model-gateway"].baseUrl = relay.baseUrl;
    const workerEnv = { ...childEnv, MODEL_GATEWAY_BASE_URL: relay.baseUrl, MODEL_GATEWAY_TOKEN: relay.token };
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(path.join(agentDir, "models.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
    // Let Prime create its daemon so its installed worker startup stays authoritative.
    child = spawn(binary, launch.args, { env: workerEnv, stdio: "inherit" });
    for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.on(signal, forward);
    const result = await exited(child);
    return receivedSignal !== null || result.signal !== null ? 1 : result.code ?? 1;
  } finally {
    for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.off(signal, forward);
    relay?.close();
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
