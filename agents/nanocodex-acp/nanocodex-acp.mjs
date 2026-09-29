#!/usr/bin/env node
// @ts-check
// nanocodex as a stdio ACP agent for BB's provider-acp bridge.
// Transport is the Model Gateway only: NANOCODEX_API_BASE_URL + MODEL_GATEWAY_TOKEN.
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import { Agent, Transport } from "nanocodex/node";
import { createNodeProcessTools } from "nanocodex-tools/node";

// nanocodex 0.6.5 rejects any other model id client-side. The gateway maps them to real upstreams.
const MODELS = ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "@cf/zai-org/glm-5.3", "kimi-k3", "mimo-v2.6-pro"];
const THINKING = ["none", "low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES = ["accept-edits", "full"];

// stdout carries ACP frames only.
console.log = console.error;

const { values: flags } = parseArgs({
  options: {
    "list-models": { type: "boolean" },
    model: { type: "string" },
    thinking: { type: "string" },
    "permission-mode": { type: "string", default: "accept-edits" },
  },
});
if (flags["list-models"]) {
  for (const model of MODELS) process.stdout.write(`${model} - ${model}\n`);
  process.exit(0);
}
for (const [flag, allowed] of /** @type {const} */ ([["model", MODELS], ["thinking", THINKING], ["permission-mode", PERMISSION_MODES]])) {
  const value = flags[flag];
  if (value !== undefined && !allowed.includes(value)) {
    process.stderr.write(`nanocodex-acp: --${flag} must be one of ${allowed.join(", ")}; got "${value}"\n`);
    process.exit(2);
  }
}
const model = /** @type {import("nanocodex/node").Agent.create.Options["model"]} */ (flags.model);
const thinking = /** @type {import("nanocodex").Thinking | undefined} */ (flags.thinking);
const askPermission = flags["permission-mode"] !== "full";

/**
 * Fail closed. nanocodex silently falls back to wss://api.openai.com when websocketUrl is unset,
 * so the WebSocket URL is always derived here and always passed.
 * @param {NodeJS.ProcessEnv} env
 */
function gatewayEndpoints(env) {
  const base = env.NANOCODEX_API_BASE_URL;
  if (!base) {
    throw new acp.RequestError(-32603, "NANOCODEX_API_BASE_URL is not set. nanocodex-acp only talks to the Model Gateway; it will not start a session without it.");
  }
  if (!env.MODEL_GATEWAY_TOKEN) {
    throw new acp.RequestError(-32603, "MODEL_GATEWAY_TOKEN is not set. nanocodex-acp needs the Model Gateway token to start a session.");
  }
  const url = URL.canParse(base) ? new URL(base) : undefined;
  if (url?.protocol !== "http:" && url?.protocol !== "https:") {
    throw new acp.RequestError(-32603, `NANOCODEX_API_BASE_URL must be an http(s) URL; got "${base}".`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const websocket = new URL(url);
  websocket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  websocket.pathname += "/responses";
  return { apiKey: env.MODEL_GATEWAY_TOKEN, apiBaseUrl: url.href, websocketUrl: websocket.href };
}

/** @param {string} tool @param {any} args */
const toolTitle = (tool, args) => (tool === "exec_command" && typeof args?.cmd === "string" ? args.cmd : tool);
/** @param {string} tool @returns {acp.ToolKind} */
const toolKind = (tool) => (tool === "exec_command" || tool === "write_stdin" ? "execute" : "other");

/**
 * @typedef {{
 *   id: string,
 *   agent: import("nanocodex").DefaultAgent,
 *   closeTools: () => Promise<void>,
 *   turn?: import("nanocodex").Turn,
 *   allowed: Set<string>,
 *   streamed: Set<string>,
 * }} Session
 */
/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * nanocodex has no permission hook, so each host tool handler asks BB first.
 * Subagents (spawn_agent) reach the OS only through these same handlers.
 * @param {import("nanocodex").NamedTool} tool @param {Session} session
 * @returns {import("nanocodex").NamedTool}
 */
function gate(tool, session) {
  return {
    ...tool,
    async handler(input, context) {
      const poll = tool.name === "write_stdin" && !(/** @type {any} */ (input)?.chars);
      if (askPermission && !poll && !session.allowed.has(tool.name)) {
        /** @type {acp.RequestPermissionResponse} */
        const { outcome } = await connection.client.request("session/request_permission", {
          sessionId: session.id,
          toolCall: {
            toolCallId: context.callId,
            title: toolTitle(tool.name, input),
            kind: toolKind(tool.name),
            status: "pending",
            rawInput: input,
          },
          options: [
            { optionId: "allow_once", name: "Allow", kind: "allow_once" },
            { optionId: "allow_always", name: `Always allow ${tool.name} in this session`, kind: "allow_always" },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        });
        const choice = outcome.outcome === "selected" ? outcome.optionId : "cancelled";
        if (choice === "allow_always") session.allowed.add(tool.name);
        else if (choice !== "allow_once") throw new Error(`The user did not allow ${tool.name}.`);
      }
      return tool.handler(input, context);
    },
  };
}

/**
 * Maps one nanocodex event to an ACP session update. Lifecycle events (run.*) end the turn
 * through turn.result() instead.
 * @param {Session} session @param {import("nanocodex").AgentEvent} event
 * @returns {acp.SessionUpdate | undefined}
 */
function toUpdate(session, { type, payload }) {
  const p = /** @type {any} */ (payload);
  switch (type) {
    case "assistant.delta":
      session.streamed.add(p.item_id);
      return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: p.text } };
    case "assistant.message":
      // Deltas already carried the text; only send it when none arrived.
      return session.streamed.has(p.item_id)
        ? undefined
        : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: p.text } };
    case "reasoning.summary.delta":
      return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: p.text ?? p.delta } };
    case "tool.call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: p.call_id,
        title: toolTitle(p.tool, p.arguments),
        kind: toolKind(p.tool),
        status: "pending",
        rawInput: p.arguments,
      };
    case "tool.result":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: p.call_id,
        status: p.status === "completed" ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: String(p.result ?? "") } }],
        rawOutput: p.structured_result ?? p.result,
      };
  }
}

/** Keeps nanocodex's message; the SDK would otherwise reply with a bare "Internal error". @param {unknown} error */
const nanocodexError = (error) => new acp.RequestError(-32603, `nanocodex: ${error instanceof Error ? error.message : String(error)}`);

const connection = acp
  .agent({ name: "nanocodex-acp" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: false } },
    agentInfo: { name: "nanocodex-acp", version: "0.1.0" },
    authMethods: [],
  }))
  .onRequest("session/new", async ({ params }) => {
    const transport = Transport.openAi(gatewayEndpoints(process.env));
    const { tools, close } = await createNodeProcessTools({ workspace: params.cwd });
    /** @type {Session} */
    const session = { id: "", agent: /** @type {any} */ (undefined), closeTools: close, allowed: new Set(), streamed: new Set() };
    try {
      session.agent = await Agent.create({
        transport,
        model,
        thinking,
        workspace: params.cwd,
        // Direct mode drops the `exec` Code Mode tool, whose JavaScript can require("fs") past the gate.
        toolMode: "direct",
        rawApiEvents: false,
        tools: tools.map((tool) => gate(tool, session)),
      });
    } catch (error) {
      await close();
      throw nanocodexError(error);
    }
    const sessionId = (session.id = session.agent.sessionId);
    session.agent.events.watch().onEvent((event) => {
      const update = toUpdate(session, event);
      if (update) void connection.client.notify("session/update", { sessionId, update });
    });
    sessions.set(sessionId, session);
    return { sessionId };
  })
  .onRequest("session/prompt", async ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw acp.RequestError.invalidParams(undefined, `unknown session ${params.sessionId}`);
    /** @type {import("nanocodex").PromptItem[]} */
    const input = params.prompt.map((block) =>
      block.type === "text" ? { type: "text", text: block.text }
      : block.type === "resource_link" ? { type: "text", text: `[file: ${block.uri}]` }
      : { type: "text", text: `[unsupported ${block.type} attachment]` },
    );
    session.turn = session.agent.turn.prompt({ input });
    try {
      (await session.turn.result()).dispose();
      return { stopReason: "end_turn" };
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "cancelled") return { stopReason: "cancelled" };
      throw nanocodexError(error);
    } finally {
      session.turn = undefined;
    }
  })
  .onNotification("session/cancel", async ({ params }) => {
    await sessions.get(params.sessionId)?.turn?.cancel();
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

await connection.closed.catch(() => {});
for (const session of sessions.values()) {
  session.agent.dispose();
  await session.closeTools().catch(() => {});
}
process.exit(0);
