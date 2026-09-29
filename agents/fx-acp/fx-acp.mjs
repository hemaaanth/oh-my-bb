#!/usr/bin/env node
// @ts-check
// `fx acp` behind a stdio relay that pins FX's provider to the Codex subscription
// and hides the Provider option (Vercel AI Gateway, Grok) from the ACP client.
// Every other frame passes through unchanged.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const PROVIDER_OPTION = "provider";
export const PINNED_PROVIDER = "codex";
/** Results of these client requests carry `configOptions` for a session. */
const SESSION_OPENERS = new Set(["session/new", "session/load", "session/resume", "session/fork"]);

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

function main() {
  const child = spawn(process.env.FX_BIN || "fx", ["acp", ...process.argv.slice(2)], {
    stdio: ["pipe", "pipe", "inherit"],
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
    process.stderr.write(`fx-acp: cannot start ${process.env.FX_BIN || "fx"}: ${error.message}\n`);
    process.exit(127);
  });
  // `close` waits for fx's stdout to drain, so no frame is lost before we exit.
  child.on("close", (code, signal) => {
    if (signal !== null) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
