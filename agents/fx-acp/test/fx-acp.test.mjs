// @ts-check
// Drives fx-acp over stdio against test/fake-fx.mjs. No real fx, no vendor traffic.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";

const BIN = new URL("../fx-acp.mjs", import.meta.url).pathname;
const FAKE = new URL("./fake-fx.mjs", import.meta.url).pathname;

/** @param {Record<string, string>} [env] */
function start(env = {}) {
  const log = join(mkdtempSync(join(tmpdir(), "fx-acp-")), "fx.log");
  const child = spawn(process.execPath, [BIN, "--model", "gpt-6-astra"], {
    env: { ...process.env, FX_BIN: FAKE, FAKE_FX_LOG: log, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  /** @type {any[]} */
  const received = [];
  /** @type {string[]} */
  const raw = [];
  /** @type {Array<() => void>} */
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    raw.push(line);
    received.push(JSON.parse(line));
    for (const wake of waiters.splice(0)) wake();
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  /** @param {object} frame */
  const send = (frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  /** @param {(frame: any) => boolean} match */
  const next = async (match) => {
    for (;;) {
      const found = received.find(match);
      if (found !== undefined) return found;
      await new Promise((resolve) => waiters.push(() => resolve(undefined)));
    }
  };
  /** @returns {any[]} */
  const agentSaw = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return { child, send, next, received, raw, agentSaw, log, exited, stderr: () => stderr };
}

test("pins a new session to codex and hides the Provider option", async () => {
  const fx = start();
  fx.send({ id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
  const reply = await fx.next((frame) => frame.id === 1);
  expect(reply.result.sessionId).toBe("s1");
  expect(reply.result.configOptions.map((/** @type {any} */ option) => option.id)).toEqual(["model"]);
  const set = fx.agentSaw().find((frame) => frame.method === "session/set_config_option");
  expect(set.params).toEqual({ sessionId: "s1", configId: "provider", value: "codex" });
  // The switch's own reply never reaches the client; its option update does, without Provider.
  const update = await fx.next((frame) => frame.method === "session/update");
  expect(update.params.update.configOptions.map((/** @type {any} */ option) => option.id)).toEqual(["model"]);
  expect(fx.received.some((frame) => typeof frame.id === "string" && frame.id.startsWith("fx-acp:"))).toBe(false);
  fx.child.stdin.end();
  await fx.exited;
});

test("pins a loaded session with the request's session id", async () => {
  const fx = start();
  fx.send({ id: "load", method: "session/load", params: { sessionId: "old", cwd: "/tmp", mcpServers: [] } });
  const reply = await fx.next((frame) => frame.id === "load");
  expect(JSON.stringify(reply)).not.toContain("Grok");
  expect(fx.agentSaw().find((frame) => frame.method === "session/set_config_option").params.sessionId).toBe("old");
  fx.child.stdin.end();
  await fx.exited;
});

test("does not switch a session that is already on codex", async () => {
  const fx = start({ FAKE_FX_PROVIDER: "codex" });
  fx.send({ id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
  const reply = await fx.next((frame) => frame.id === 1);
  expect(reply.result.configOptions.map((/** @type {any} */ option) => option.id)).toEqual(["model"]);
  expect(fx.agentSaw().some((frame) => frame.method === "session/set_config_option")).toBe(false);
  fx.child.stdin.end();
  await fx.exited;
});

test("fails session/new when fx refuses the codex provider", async () => {
  const fx = start({ FAKE_FX_REFUSE: "1" });
  fx.send({ id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
  const reply = await fx.next((frame) => frame.id === 1);
  expect(reply.result).toBeUndefined();
  expect(reply.error.message).toContain("could not select the codex provider: not signed in");
  fx.child.stdin.end();
  await fx.exited;
});

test("rejects a client switch to another provider without asking fx", async () => {
  const fx = start();
  fx.send({ id: 7, method: "session/set_config_option", params: { sessionId: "s1", configId: "provider", value: "grok" } });
  const reply = await fx.next((frame) => frame.id === 7);
  expect(reply.error.message).toBe("fx-acp only allows provider codex.");
  fx.send({ id: 8, method: "session/prompt", params: { sessionId: "s1", prompt: [] } });
  await fx.next((frame) => frame.id === 8);
  expect(fx.agentSaw().map((frame) => frame.method)).toEqual(["session/prompt"]);
  fx.child.stdin.end();
  await fx.exited;
});

test("passes other frames through byte for byte", async () => {
  const fx = start();
  const line = '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":1,"extra":"  spaced  "}}';
  fx.child.stdin.write(`${line}\n`);
  await fx.next((frame) => frame.id === 3);
  expect(readFileSync(fx.log, "utf8")).toBe(`${line}\n`);
  expect(fx.raw).toEqual([
    '{"jsonrpc":"2.0","id":3,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}',
  ]);
  fx.child.stdin.end();
  await fx.exited;
});

test("forwards stderr and fx's exit code", async () => {
  const fx = start();
  fx.send({ method: "exit", params: { code: 3 } });
  expect(await fx.exited).toEqual({ code: 3, signal: null });
  expect(fx.stderr()).toContain("fake fx started with acp --model gpt-6-astra");
  expect(fx.raw).toEqual([]);
});

test("forwards a signal to fx and dies by it", async () => {
  const fx = start();
  fx.send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await fx.next((frame) => frame.id === 1);
  fx.child.kill("SIGTERM");
  expect(await fx.exited).toEqual({ code: null, signal: "SIGTERM" });
});
