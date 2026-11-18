import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { watch } from "node:fs/promises";
import { z } from "zod";

export const CURSOR_COMPOSER_URL = "https://cursor-agent.local/v1";
export const CURSOR_COMPOSER_CREDENTIAL = "local:cursor-composer";
export const CURSOR_COMPOSER_LABEL = "cursor-subscription";
export const CURSOR_COMPOSER_MODEL = "composer-2.5";
const exec = promisify(execFile);
let nodeExecutable: Promise<string> | undefined;

function resolveNodeExecutable() {
  nodeExecutable ??= exec("node", ["-p", "process.execPath"], { timeout: 3_000, maxBuffer: 8_000 })
    .then(({ stdout }) => stdout.trim())
    .catch((error) => {
      nodeExecutable = undefined;
      throw error;
    });
  return nodeExecutable;
}

const record = z.record(z.string(), z.unknown());
const requestSchema = z.object({
  model: z.string(),
  instructions: z.string().optional(),
  input: z.union([z.string(), z.array(z.unknown())]),
  tools: z.array(z.object({
    type: z.literal("function"), name: z.string(), description: z.string().optional(), parameters: record.optional(),
  }).passthrough()).optional(),
  stream: z.boolean().optional(),
}).passthrough();

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") return [part.text];
    return [];
  }).join("\n");
}

export function renderCursorPrompt(value: unknown): { prompt: string; tools: Array<Record<string, unknown>>; streaming: boolean } {
  const request = requestSchema.parse(value);
  const turns = typeof request.input === "string" ? [`user: ${request.input}`] : request.input.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const value = item as Record<string, unknown>;
    if (value.type === "message" && typeof value.role === "string")
      return [`${value.role}: ${textFromContent(value.content)}`];
    if (value.type === "function_call")
      return [`assistant tool call ${String(value.name)} (${String(value.call_id)}): ${String(value.arguments)}`];
    if (value.type === "function_call_output")
      return [`tool result (${String(value.call_id)}): ${textFromContent(value.output)}`];
    return [];
  });
  const tools = (request.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.parameters ?? { type: "object", properties: {} },
  }));
  const names = tools.map((tool) => tool.name).join(", ");
  return {
    streaming: request.stream !== false,
    tools,
    prompt: [
      "You are serving an OpenAI Responses-compatible coding harness.",
      "Do not use Cursor built-in tools. Use only the gateway MCP tools when a tool is needed.",
      names ? `Gateway tools: ${names}.` : "No tools are available. Reply with text only.",
      request.instructions ? `Instructions:\n${request.instructions}` : "",
      "Conversation:",
      ...turns,
      "Continue as the assistant.",
    ].filter(Boolean).join("\n\n"),
  };
}

type CursorResult = { text: string; call?: { name: string; arguments: Record<string, unknown> } };

async function runCursor(prompt: string, tools: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<CursorResult> {
  const directory = await mkdtemp(join(tmpdir(), "model-gateway-cursor-"));
  const toolsPath = join(directory, "tools.json");
  const callPath = join(directory, "call.json");
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const helper = resolve(moduleDirectory, basename(moduleDirectory) === "dist"
    ? "../scripts/cursor-tool-proxy.mjs" : "../../scripts/cursor-tool-proxy.mjs");
  const node = await resolveNodeExecutable();
  await writeFile(toolsPath, JSON.stringify(tools), { mode: 0o600 });
  const child = spawn("cursor-agent", ["--model", CURSOR_COMPOSER_MODEL, "acp"], {
    stdio: ["pipe", "pipe", "ignore"], signal,
  });
  const watcher = new AbortController();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  const toolNames = new Set(tools.map((tool) => String(tool.name)));
  let nextId = 0;
  let text = "";
  let timer: NodeJS.Timeout | undefined;
  const send = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const respond = (id: number, result: unknown) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  lines.on("line", (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const request = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error !== undefined) request.reject(message.error);
      else request.resolve(message.result);
      return;
    }
    const params = typeof message.params === "object" && message.params !== null ? message.params as Record<string, unknown> : {};
    if (message.method === "session/update") {
      const update = typeof params.update === "object" && params.update !== null ? params.update as Record<string, unknown> : {};
      const content = typeof update.content === "object" && update.content !== null ? update.content as Record<string, unknown> : {};
      if (update.sessionUpdate === "agent_message_chunk" && typeof content.text === "string") text += content.text;
    } else if (message.method === "session/request_permission" && typeof message.id === "number") {
      const description = JSON.stringify(params.toolCall ?? {});
      const allow = [...toolNames].some((name) => description.includes(name));
      respond(message.id, { outcome: { outcome: "selected", optionId: allow ? "allow-once" : "reject-once" } });
    } else if (message.method === "cursor/ask_question" && typeof message.id === "number") {
      respond(message.id, { answers: {} });
    }
  });
  const exited = new Promise<never>((_, reject) => child.once("exit", (code) =>
    reject(new Error(`Cursor exited before replying${code === null ? "" : ` (${code})`}.`))));
  const failed = new Promise<never>((_, reject) => child.once("error", reject));
  const called = tools.length === 0 ? new Promise<never>(() => {}) : (async () => {
    for await (const event of watch(directory, { signal: watcher.signal })) {
      if (event.filename !== "call.json") continue;
      const call = z.object({ name: z.string(), arguments: record }).parse(JSON.parse(await readFile(callPath, "utf8")));
      return { text, call };
    }
    throw new Error("Cursor tool bridge stopped before a tool call.");
  })();
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cursor Composer timed out.")), 120_000);
    });
    const completed = (async () => {
      await send("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "model-gateway", version: "1" },
      });
      await send("authenticate", { methodId: "cursor_login" });
      const session = z.object({ sessionId: z.string() }).parse(await send("session/new", {
        cwd: directory,
        mcpServers: tools.length === 0 ? [] : [{
          name: "gateway", command: node, args: [helper, toolsPath, callPath], env: [],
        }],
      }));
      if (tools.length === 0)
        await send("session/set_mode", { sessionId: session.sessionId, modeId: "ask" }).catch(() => undefined);
      await send("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] });
      return { text };
    })();
    return await Promise.race([completed, called, timeout, exited, failed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    watcher.abort();
    lines.close();
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
}

function responseObject(model: string, result: CursorResult) {
  const id = `resp_${randomUUID().replaceAll("-", "")}`;
  const output: Array<Record<string, unknown>> = [];
  if (result.text) output.push({
    id: `msg_${randomUUID().replaceAll("-", "")}`, type: "message", status: "completed", role: "assistant",
    content: [{ type: "output_text", text: result.text, annotations: [] }],
  });
  if (result.call) output.push({
    id: `fc_${randomUUID().replaceAll("-", "")}`, type: "function_call", status: "completed",
    call_id: `call_${randomUUID().replaceAll("-", "")}`, name: result.call.name, arguments: JSON.stringify(result.call.arguments),
  });
  return { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model, output };
}

function streamResponse(response: ReturnType<typeof responseObject>) {
  const events: Array<Record<string, unknown>> = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }];
  response.output.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item: { ...item, status: "in_progress",
      ...(item.type === "function_call" ? { arguments: "" } : item.type === "message" ? { content: [] } : {}) } });
    if (item.type === "message") {
      const text = ((item.content as Array<Record<string, unknown>>)[0]?.text ?? "") as string;
      events.push({ type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: text });
      events.push({ type: "response.output_text.done", item_id: item.id, output_index, content_index: 0, text });
    } else if (item.type === "function_call") {
      events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments });
      events.push({ type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({ type: "response.completed", response });
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

export async function cursorComposerResponse(body: Uint8Array, signal?: AbortSignal) {
  const request = requestSchema.parse(JSON.parse(new TextDecoder().decode(body)));
  if (request.model !== CURSOR_COMPOSER_MODEL) throw new Error("Cursor Composer only accepts composer-2.5.");
  const prepared = renderCursorPrompt(request);
  const response = responseObject(request.model, await runCursor(prepared.prompt, prepared.tools, signal));
  return prepared.streaming ? streamResponse(response) : Response.json(response);
}

export async function assertCursorComposer() {
  const status = await exec("cursor-agent", ["status"], { timeout: 15_000, maxBuffer: 64_000 })
    .catch(() => { throw new Error("Cursor Agent needs to be installed and signed in locally."); });
  if (!/Logged in as/u.test(status.stdout)) throw new Error("Cursor Agent needs a local sign-in.");
  const models = await exec("cursor-agent", ["models"], { timeout: 15_000, maxBuffer: 512_000 });
  if (!/^composer-2\.5\s+-/mu.test(models.stdout)) throw new Error("The signed-in Cursor account does not offer Composer 2.5.");
}
