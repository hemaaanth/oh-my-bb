// @ts-check
// Drives nanocodex-acp over stdio against a loopback mock of the gateway's WS /v1/responses route.
// `npm test` runs this inside an empty network namespace, so nothing can reach api.openai.com.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { after, before, test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { WebSocketServer } from "ws";

const BIN = new URL("../nanocodex-acp.mjs", import.meta.url).pathname;
const CMD = "echo hello-from-mock | tee ran.txt";

// Mock Responses WebSocket: first call asks for one exec_command, the next call answers.
/** @type {{ url?: string, auth?: string, tools?: string[] }[]} */
const seen = [];
const server = createServer();
new WebSocketServer({ server }).on("connection", (ws, req) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  ws.on("message", (data) => {
    const body = JSON.parse(data.toString());
    const declared = body.input?.find((/** @type {any} */ i) => i.type === "additional_tools")?.tools;
    seen.push({ tools: declared?.map((/** @type {any} */ t) => t.name) });
    const input = JSON.stringify(body.input ?? "");
    const send = (/** @type {any[]} */ ...events) => events.forEach((e) => ws.send(JSON.stringify(e)));
    const id = `resp_${seen.length}`;
    send({ type: "response.created", response: { id, status: "in_progress" } });
    if (input.includes("PLEASE-HANG")) return;
    if (!input.includes("function_call_output")) {
      const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: CMD }) };
      return send(
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
        { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
        { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      );
    }
    const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done: hello-from-mock" }] };
    const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Thinking it over" }] };
    send(
      { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Thinking it over" },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "Done: hello-from-mock" },
      { type: "response.output_item.done", output_index: 1, item: message },
      { type: "response.completed", response: { id, status: "completed", output: [reasoning, message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    );
  });
});
let baseUrl = "";
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/gw/prefix/v1/`;
});
/** @type {Set<() => void>} */
const running = new Set();
after(() => { running.forEach((stop) => stop()); server.close(); server.closeAllConnections(); });

/** The ~30-line ACP test client. `answer` picks the permission option id. */
async function startAgent({ args = ["--permission-mode", "accept-edits"], base = baseUrl, answer = "allow_once", model = "gpt-6-sol", home = mkdtempSync(join(tmpdir(), "nca-home-")) } = {}) {
  const env = { PATH: process.env.PATH, HOME: home, MODEL_GATEWAY_TOKEN: "test-token", ...(base ? { NANOCODEX_API_BASE_URL: base } : {}) };
  const child = spawn(process.execPath, [BIN, "--model", model, ...args], { env, stdio: ["pipe", "pipe", "inherit"] });
  /** @type {string[]} */
  const log = [];
  /** @type {acp.SessionUpdate[]} */
  const updates = [];
  const conn = acp
    .client({ name: "test" })
    .onRequest("session/request_permission", ({ params }) => {
      log.push(`permission:${params.toolCall.toolCallId}`);
      return { outcome: { outcome: "selected", optionId: answer } };
    })
    .onNotification("session/update", ({ params }) => {
      log.push(`update:${params.update.sessionUpdate}`);
      updates.push(params.update);
    })
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), /** @type {any} */ (Readable.toWeb(child.stdout))));
  const initialized = await conn.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const cwd = mkdtempSync(join(tmpdir(), "nca-cwd-"));
  const stop = () => { conn.close(); child.kill(); };
  running.add(stop);
  return { conn, initialized, log, updates, cwd, stop, newSession: () => conn.agent.request("session/new", { cwd, mcpServers: [] }) };
}

/** @param {Awaited<ReturnType<typeof startAgent>>} agent @param {string} text */
async function prompt(agent, text) {
  const { sessionId } = await agent.newSession();
  return { sessionId, result: agent.conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }) };
}

test("accept-edits: asks permission, runs one real command in cwd, streams the answer", async () => {
  seen.length = 0;
  const agent = await startAgent();
  const { result } = await prompt(agent, "run it");
  assert.equal((await result).stopReason, "end_turn");
  agent.stop();

  assert.deepEqual(seen[0], { url: "/gw/prefix/v1/responses", auth: "Bearer test-token" });
  assert.ok(seen[1].tools?.includes("exec_command") && !seen[1].tools.includes("exec"), `Code Mode exec must be off: ${seen[1].tools}`);
  assert.ok(agent.log.indexOf("update:tool_call") < agent.log.indexOf("permission:call_1"), agent.log.join(" "));
  const call = agent.updates.find((u) => u.sessionUpdate === "tool_call");
  assert.equal(call?.sessionUpdate === "tool_call" && call.title, CMD);
  const done = agent.updates.find((u) => u.sessionUpdate === "tool_call_update");
  assert.equal(done?.sessionUpdate === "tool_call_update" && done.status, "completed");
  assert.match(JSON.stringify(done), /hello-from-mock/);
  assert.ok(existsSync(join(agent.cwd, "ran.txt")), "command ran in the session cwd");
  const text = agent.updates.flatMap((u) => (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? [u.content.text] : []));
  assert.equal(text.join(""), "Done: hello-from-mock");
  const thought = agent.updates.find((u) => u.sessionUpdate === "agent_thought_chunk");
  assert.equal(thought?.sessionUpdate === "agent_thought_chunk" && thought.content.type === "text" && thought.content.text, "Thinking it over");
});

test("accept-edits: a rejected command does not run", async () => {
  const agent = await startAgent({ answer: "reject_once" });
  const { result } = await prompt(agent, "run it");
  await result;
  agent.stop();
  assert.ok(agent.log.includes("permission:call_1"));
  assert.ok(!existsSync(join(agent.cwd, "ran.txt")), "rejected command must not run");
  const done = agent.updates.find((u) => u.sessionUpdate === "tool_call_update");
  assert.equal(done?.sessionUpdate === "tool_call_update" && done.status, "failed");
});

test("full: runs without a permission request", async () => {
  const agent = await startAgent({ args: ["--permission-mode", "full"] });
  const { result } = await prompt(agent, "run it");
  assert.equal((await result).stopReason, "end_turn");
  agent.stop();
  assert.ok(!agent.log.some((entry) => entry.startsWith("permission")), agent.log.join(" "));
  assert.ok(existsSync(join(agent.cwd, "ran.txt")));
});

test("session/cancel ends the turn with stopReason cancelled", async () => {
  seen.length = 0;
  const agent = await startAgent();
  const { sessionId, result } = await prompt(agent, "PLEASE-HANG");
  while (seen.length < 2) await new Promise((resolve) => setTimeout(resolve, 20)); // the turn reached the mock
  await agent.conn.agent.notify("session/cancel", { sessionId });
  assert.equal((await result).stopReason, "cancelled");
  agent.stop();
});

test("fails closed without NANOCODEX_API_BASE_URL", async () => {
  seen.length = 0;
  const agent = await startAgent({ base: "" });
  await assert.rejects(agent.newSession(), /NANOCODEX_API_BASE_URL is not set/);
  agent.stop();
  assert.equal(seen.length, 0);
});

test("--list-models includes the current Codex and Claude model ids", () => {
  const out = execFileSync(process.execPath, [BIN, "--list-models"], {
    encoding: "utf8", env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "nca-home-")) },
  });
  assert.deepEqual(out.trim().split("\n").map((line) => line.split(" - ")[0]), ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "@cf/zai-org/glm-5.3", "kimi-k3", "mimo-v2.6-pro", "claude-opus-5-5", "claude-sonnet-5-5"]);
});

for (const model of ["claude-sonnet-5-5", "DeepSeek-V4.1-Flash-1017"]) {
  test(`${model} sends a Messages request to the gateway and streams the reply`, async () => {
    const home = mkdtempSync(join(tmpdir(), "nca-home-"));
    if (model.startsWith("DeepSeek")) {
      const dir = join(home, ".config/nanocodex-acp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "model-gateway.json"), JSON.stringify({
        managedBy: "bb gateway setup host",
        models: [{ id: model, name: "DeepSeek Flash", contextWindow: 1048576, maxTokens: 64000 }],
      }));
      const listing = execFileSync(process.execPath, [BIN, "--list-models"], {
        encoding: "utf8", env: { ...process.env, HOME: home },
      });
      assert.ok(listing.split("\n").includes(`${model} - DeepSeek Flash`));
    }
    /** @type {{url?: string, auth?: string, model: string}[]} */
    const requests = [];
    /** @type {import("node:http").RequestListener} */
    const handler = async (req, res) => {
      let input = "";
      for await (const chunk of req) input += chunk;
      const body = JSON.parse(input);
      requests.push({ url: req.url, auth: req.headers.authorization, model: body.model });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const runTool = model.startsWith("DeepSeek") && requests.length === 1;
      for (const event of [
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        runTool
          ? { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "run_command", input: {} } }
          : { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        runTool
          ? { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ cmd: CMD }) } }
          : { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Model reply" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: runTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    };
    server.on("request", handler);
    const agent = await startAgent({ model, home });
    try {
      const { result } = await prompt(agent, "say hello");
      assert.equal((await result).stopReason, "end_turn");
      const request = { url: "/gw/prefix/v1/messages", auth: "Bearer test-token", model };
      assert.deepEqual(requests, model.startsWith("DeepSeek") ? [request, request] : [request]);
      if (model.startsWith("DeepSeek")) {
        assert.ok(agent.log.some((entry) => entry.startsWith("permission:")));
        assert.ok(existsSync(join(agent.cwd, "ran.txt")));
      }
      assert.ok(agent.updates.some((update) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "Model reply"));
    } finally {
      agent.stop();
      server.off("request", handler);
    }
  });
}

test("initialize reports the manifest version", async () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const agent = await startAgent();
  agent.stop();
  assert.deepEqual(agent.initialized.agentInfo, { name: "nanocodex-acp", version });
});
