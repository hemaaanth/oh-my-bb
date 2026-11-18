#!/usr/bin/env node
// @ts-check
// `fx acp` behind a stdio relay that pins FX's provider to the Codex subscription
// and hides the Provider option (Vercel AI Gateway, Grok) from the ACP client.
// Every other frame passes through unchanged.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

export const PROVIDER_OPTION = "provider";
export const PINNED_PROVIDER = "codex";
/** Results of these client requests carry `configOptions` for a session. */
const SESSION_OPENERS = new Set(["session/new", "session/load", "session/resume", "session/fork"]);
const DEFAULT_MODELS = [
  "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra",
  "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

function listModels() {
  const models = new Map(DEFAULT_MODELS.map((id) => [id, id]));
  try {
    const catalog = JSON.parse(readFileSync(join(homedir(), ".config/bb/model-gateway-models.json"), "utf8"));
    if (catalog.managedBy !== "bb gateway setup host" || !Array.isArray(catalog.models))
      throw new Error("Invalid managed FX model catalog. Run bb gateway setup host.");
    for (const { id, name } of catalog.models) models.set(id, name);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  for (const [id, name] of models) console.log(`${id} - ${name}`);
}

/** @typedef {{ jsonrpc?: string, id?: string | number | null, method?: string, params?: any, result?: any, error?: any }} Frame */

/** @param {unknown} options */
function withoutProvider(options) {
  return Array.isArray(options) ? options.filter((option) => option?.id !== PROVIDER_OPTION) : options;
}

/** @param {unknown} options */
function providerValue(options) {
  if (!Array.isArray(options)) return null;
  const option = options.find((item) => item?.id === PROVIDER_OPTION);
  return option === undefined ? null : String(option.currentValue);
}

/**
 * The relay, apart from process wiring so tests can drive it.
 * @param {{ toClient: (line: string) => void, toAgent: (line: string) => void }} io
 */
export function createRelay(io) {
  /** Client request id (JSON) -> { method, params } for requests whose results we rewrite. */
  const pending = new Map();
  /** Our own request id -> resolve. */
  const own = new Map();
  let ownId = 0;

  /** @param {Frame} frame */
  const sendClient = (frame) => io.toClient(JSON.stringify(frame));

  /**
   * @param {string} method
   * @param {unknown} params
   * @returns {Promise<Frame>}
   */
  function request(method, params) {
    const id = `fx-acp:${++ownId}`;
    io.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => own.set(id, resolve));
  }

  /**
   * A session opened on another provider: switch it to Codex before the client
   * sees the session. Fails the client request when FX refuses.
   * @param {Frame} frame
   * @param {string} sessionId
   */
  async function pin(frame, sessionId) {
    const reply = await request("session/set_config_option", {
      sessionId,
      configId: PROVIDER_OPTION,
      value: PINNED_PROVIDER,
    });
    if (reply.error !== undefined) {
      sendClient({
        jsonrpc: "2.0",
        id: frame.id,
        error: {
          code: -32603,
          message: `fx-acp could not select the ${PINNED_PROVIDER} provider: ${reply.error?.message ?? "unknown error"}`,
        },
      });
      return;
    }
    const configOptions = reply.result?.configOptions ?? frame.result.configOptions;
    sendClient({ ...frame, result: { ...frame.result, configOptions: withoutProvider(configOptions) } });
  }

  return {
    /** @param {string} line */
    fromClient(line) {
      /** @type {Frame} */
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        io.toAgent(line);
        return;
      }
      if (frame.method === "session/set_config_option" && frame.params?.configId === PROVIDER_OPTION) {
        if (frame.params.value !== PINNED_PROVIDER) {
          if (frame.id !== undefined)
            sendClient({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: -32602, message: `fx-acp only allows provider ${PINNED_PROVIDER}.` },
            });
          return;
        }
      }
      if (
        frame.id !== undefined &&
        frame.method !== undefined &&
        (SESSION_OPENERS.has(frame.method) || frame.method === "session/set_config_option")
      )
        pending.set(JSON.stringify(frame.id), { method: frame.method, params: frame.params });
      io.toAgent(line);
    },

    /** @param {string} line */
    fromAgent(line) {
      /** @type {Frame} */
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        io.toClient(line);
        return;
      }
      const isResponse = frame.method === undefined && frame.id !== undefined;
      if (isResponse && typeof frame.id === "string" && own.has(frame.id)) {
        own.get(frame.id)(frame);
        own.delete(frame.id);
        return;
      }
      if (isResponse && pending.has(JSON.stringify(frame.id))) {
        const { method, params } = pending.get(JSON.stringify(frame.id));
        pending.delete(JSON.stringify(frame.id));
        const options = frame.result?.configOptions;
        if (!Array.isArray(options)) return io.toClient(line);
        const current = providerValue(options);
        const sessionId = frame.result?.sessionId ?? params?.sessionId;
        if (SESSION_OPENERS.has(method) && current !== null && current !== PINNED_PROVIDER && typeof sessionId === "string") {
          void pin(frame, sessionId);
          return;
        }
        if (current === null) return io.toClient(line);
        return sendClient({ ...frame, result: { ...frame.result, configOptions: withoutProvider(options) } });
      }
      const update = frame.method === "session/update" ? frame.params?.update : undefined;
      if (update?.sessionUpdate === "config_option_update" && providerValue(update.configOptions) !== null)
        return sendClient({
          ...frame,
          params: { ...frame.params, update: { ...update, configOptions: withoutProvider(update.configOptions) } },
        });
      io.toClient(line);
    },
  };
}

/** @param {NodeJS.ProcessEnv} env */
export async function gatewayEnvironment(env) {
  const responses = env.FX_E2E_OPENAI_CODEX_RESPONSES_URL;
  const models = env.FX_E2E_OPENAI_CODEX_MODELS_URL;
  if (!responses && !models) {
    if (env.MODEL_GATEWAY_REQUIRED === "1" || env.BB_THREAD_ID)
      throw new Error("Model Gateway is required for BB-managed FX. Check bb gateway status.");
    return { env, close: () => {} };
  }
  if (!responses || !models) throw new Error("Both FX gateway URLs are required.");
  for (const value of [responses, models]) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("FX gateway URLs must be HTTP(S) without embedded credentials.");
  }
  // FX's native override URLs accept only loopback HTTP, even on remote hosts.
  const prefix = `/${randomUUID()}`;
  const server = createServer(async (req, res) => {
    const target = req.method === "GET" && req.url?.split("?", 1)[0] === `${prefix}/models` ? models
      : req.method === "POST" && req.url === `${prefix}/responses` ? responses : null;
    if (target === null) { res.writeHead(404).end(); return; }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const upstream = await fetch(target, {
        method: req.method, signal: abort.signal, redirect: "error",
        headers: { "content-type": "application/json", accept: req.method === "GET" ? "application/json" : "text/event-stream" },
        ...(req.method === "POST" ? { body: Readable.toWeb(req), duplex: "half" } : {}),
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
  if (!address || typeof address === "string") throw new Error("Cannot bind FX gateway relay.");
  const base = `http://127.0.0.1:${address.port}${prefix}`;
  return {
    env: { ...env, FX_AUTH_MODE: "host-managed", FX_PROVIDER: PINNED_PROVIDER, FX_PROVIDER_STRICT: "1",
      FX_E2E_OPENAI_CODEX_RESPONSES_URL: `${base}/responses`,
      FX_E2E_OPENAI_CODEX_MODELS_URL: `${base}/models`,
      FX_TEST_OPENAI_CODEX_RESPONSES_URL: `${base}/responses`,
      FX_TEST_OPENAI_CODEX_MODELS_URL: `${base}/models` },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

async function main() {
  if (process.argv[2] === "model-list") return listModels();
  const gateway = await gatewayEnvironment(process.env);
  const child = spawn(process.env.FX_BIN || "fx", ["acp", ...process.argv.slice(2)], {
    env: gateway.env, stdio: ["pipe", "pipe", "inherit"],
  });
  const relay = createRelay({
    toClient: (line) => process.stdout.write(`${line}\n`),
    toAgent: (line) => child.stdin.write(`${line}\n`),
  });
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => relay.fromClient(line)).on("close", () => child.stdin.end());
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => relay.fromAgent(line));
  child.stdin.on("error", () => {});
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    gateway.close();
    process.stderr.write(`fx-acp: cannot start ${process.env.FX_BIN || "fx"}: ${error.message}\n`);
    process.exit(127);
  });
  // `close` waits for fx's stdout to drain, so no frame is lost before we exit.
  child.on("close", (code, signal) => {
    gateway.close();
    if (signal !== null) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // The messages come from gatewayEnvironment and never include the URLs, which carry the hub token.
    console.error(`fx-acp: ${error instanceof Error ? error.message : "cannot configure gateway relay."}`);
    process.exitCode = 1;
  });
