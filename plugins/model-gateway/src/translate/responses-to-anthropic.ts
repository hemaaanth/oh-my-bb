// Adapted from opencodex src/adapters/anthropic.ts (request build, stream parse),
// src/responses/parser.ts (input items), src/bridge/sse.ts and src/bridge/internal.ts
// (Responses SSE framing, usage) (MIT, (c) 2026 opencodex contributors). See THIRD_PARTY.md.
//
// A Responses client (Codex, omp, FX, nanocodex, Pi) behind an Anthropic-compatible API
// key. Request: Responses -> Messages. Output: Messages SSE or JSON -> Responses SSE or JSON.
// Foreign reasoning (ChatGPT encrypted items, other models' thinking) is dropped before
// sending. Anthropic thinking comes back as a `reasoning` item carrying a gateway
// envelope, which is replayed to the same model and dropped for everything else.
import { randomUUID } from "node:crypto";
import { ANTHROPIC_REPLAY, decodeThinkingEnvelope, encodeThinkingEnvelope, type ThinkingEnvelope } from "./reasoning-envelope.js";
import { TranslateError } from "./messages-to-responses.js";
import { decodeSse } from "./responses-to-messages.js";
import { createToolCallIdAllocator } from "./tool-call-id.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What the output translator needs to give tool calls back their client shape. */
export interface ToolNames {
  /** Freeform (`custom`) tools: Anthropic sees `{ input: string }`. */
  custom: Set<string>;
  /** Wire name -> namespaced tool (Codex `namespace` tool groups). */
  namespaced: Map<string, { namespace: string; name: string }>;
}

export interface MessagesRequestTranslation {
  body: Rec;
  tools: ToolNames;
  /** What had no Messages form and was left out, e.g. `tool:web_search`, `item:compaction`. */
  dropped: string[];
}

/** Codex's reserved namespace for ordinary tools: its children keep bare names. */
const FUNCTIONS_NAMESPACE = "functions";
const DEFAULT_MAX_TOKENS = 32_000;
const OUTPUT_HEADROOM = 8_192;
const OUTPUT_FLOOR = 4_096;
const MIN_THINKING_BUDGET = 1_024;

function reasoningBudget(effort: string): number {
  switch (effort) {
    case "minimal": return 1_024;
    case "low": return 4_096;
    case "high": return 16_384;
    case "xhigh": return 24_576;
    case "max": return 32_000;
    default: return 8_192;
  }
}

/** Claude families that take `thinking: adaptive` + `output_config.effort` and 400 on budgets. */
function usesAdaptiveThinking(model: string): boolean {
  const match = /(?:^|\/)claude-([a-z]+)-(\d+)(?:[.-](\d{1,2}))?(?!\d)/iu.exec(model);
  if (!match) return false;
  const [family = "", major = 0, minor = 0] = [match[1]?.toLowerCase(), Number(match[2]), Number(match[3] ?? 0)];
  if (family === "fable") return true;
  if (family === "sonnet") return major >= 5;
  if (family === "opus") return major > 4 || (major === 4 && minor >= 7);
  return false;
}

/** Anthropic wants a root `type: object` with `properties` and no root oneOf/anyOf/allOf. */
function inputSchema(schema: unknown): Rec {
  const obj = isRec(schema) ? schema : {};
  const properties: Rec = isRec(obj.properties) ? { ...obj.properties } : {};
  const required = new Set(Array.isArray(obj.required) ? obj.required.filter((r): r is string => typeof r === "string") : []);
  const out: Rec = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") {
      for (const variant of Array.isArray(value) ? value.filter(isRec) : []) {
        if (isRec(variant.properties)) Object.assign(properties, variant.properties);
        if (key === "allOf" && Array.isArray(variant.required))
          for (const r of variant.required) if (typeof r === "string") required.add(r);
      }
    } else if (key !== "type" && key !== "properties" && key !== "required") out[key] = value;
  }
  return { ...out, type: "object", properties, ...(required.size > 0 ? { required: [...required] } : {}) };
}

function addTools(list: unknown, tools: Rec[], names: ToolNames, dropped: Set<string>): void {
  if (!Array.isArray(list)) return;
  const seen = new Set(tools.map(t => t.name));
  const add = (tool: Rec, wire: string) => {
    if (seen.has(wire)) return;
    seen.add(wire);
    if (tool.type === "custom") {
      names.custom.add(wire);
      const format = isRec(tool.format) && typeof tool.format.definition === "string"
        ? `\n\nThe input must follow this ${str(tool.format.syntax) || "grammar"}:\n${tool.format.definition}`
        : "";
      tools.push({
        name: wire,
        description: str(tool.description) + format,
        input_schema: { type: "object", properties: { input: { type: "string", description: "The raw tool input." } }, required: ["input"] },
      });
    } else {
      tools.push({
        name: wire,
        description: str(tool.description),
        input_schema: inputSchema(tool.parameters),
        ...(tool.strict === true ? { strict: true } : {}),
      });
    }
  };
  for (const tool of list.filter(isRec)) {
    if ((tool.type === "function" || tool.type === "custom") && typeof tool.name === "string") add(tool, tool.name);
    else if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      for (const child of tool.tools.filter(isRec)) {
        if ((child.type !== "function" && child.type !== "custom") || typeof child.name !== "string") continue;
        const wire = tool.name === FUNCTIONS_NAMESPACE ? child.name : `${tool.name}__${child.name}`;
        if (tool.name !== FUNCTIONS_NAMESPACE) names.namespaced.set(wire, { namespace: tool.name, name: child.name });
        add(child, wire);
      }
    }
    // Hosted tools (web_search, image_generation, local_shell, ...) have no Messages form here.
    else dropped.add(`tool:${str(tool.type) || "unknown"}`);
  }
}

function wireToolName(name: string, namespace: unknown): string {
  return typeof namespace === "string" && namespace !== FUNCTIONS_NAMESPACE ? `${namespace}__${name}` : name;
}

function imageBlock(url: string): Rec {
  const data = /^data:([^;,]+);base64,(.*)$/su.exec(url);
  return data
    ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
    : { type: "image", source: { type: "url", url } };
}

/** One Responses content part -> Anthropic content blocks. */
function contentBlocks(part: unknown): Rec[] {
  if (typeof part === "string") return part ? [{ type: "text", text: part }] : [];
  if (!isRec(part)) return [];
  switch (part.type) {
    case "input_text":
    case "output_text":
    case "text":
      return str(part.text) ? [{ type: "text", text: part.text }] : [];
    case "refusal":
      return str(part.refusal) ? [{ type: "text", text: part.refusal }] : [];
    case "input_image": {
      const url = str(part.image_url);
      return url ? [imageBlock(url)] : [{ type: "text", text: "[image]" }];
    }
    case "input_file": {
      const data = /^data:application\/pdf;base64,(.*)$/su.exec(str(part.file_data));
      if (data) return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: data[1] } }];
      return [{ type: "text", text: `[file: ${str(part.filename) || "attachment"}]` }];
    }
    default:
      return [];
  }
}

function contentOf(content: unknown): Rec[] {
  if (typeof content === "string") return contentBlocks(content);
  return Array.isArray(content) ? content.flatMap(contentBlocks) : [];
}

function toolResultContent(output: unknown): string | Rec[] {
  if (typeof output === "string") return output || "(empty tool output)";
  const blocks = contentOf(output).filter(b => b.type === "text" || b.type === "image");
  return blocks.length > 0 ? blocks : "(empty tool output)";
}

function parseArguments(raw: unknown): Rec {
  if (isRec(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRec(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Anthropic pairing rules: tool_use blocks end their assistant message, and the next
 * message is a user message that starts with one tool_result per tool_use. Missing
 * results get a synthetic error result; results with no call become text.
 */
function pairToolResults(messages: Rec[]): Rec[] {
  const out: Rec[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Rec & { content: Rec[] };
    if (msg.role === "user") {
      // Not consumed below, so it answers no tool_use: its tool_results become text.
      out.push({ role: "user", content: msg.content.map(orphanToText) });
      continue;
    }
    const uses = msg.content.filter(b => b.type === "tool_use");
    const ordered = [...msg.content.filter(b => b.type !== "tool_use"), ...uses];
    out.push({ role: "assistant", content: ordered });
    if (uses.length === 0) continue;
    const ids = new Set(uses.map(b => b.id));
    const next = messages[i + 1] as (Rec & { content: Rec[] }) | undefined;
    const following = next?.role === "user" ? next.content : [];
    if (next?.role === "user") i++;
    const results = new Map<unknown, Rec>();
    const rest: Rec[] = [];
    for (const block of following) {
      if (block.type === "tool_result" && ids.has(block.tool_use_id) && !results.has(block.tool_use_id))
        results.set(block.tool_use_id, block);
      else rest.push(orphanToText(block));
    }
    out.push({
      role: "user",
      content: [
        ...uses.map(use => results.get(use.id) ?? {
          type: "tool_result",
          tool_use_id: use.id,
          content: "[missing tool_result for this tool_use in history]",
          is_error: true,
        }),
        ...rest,
      ],
    });
  }
  return out;
}

function orphanToText(block: Rec): Rec {
  if (block.type !== "tool_result") return block;
  const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
  return { type: "text", text: `[tool_result without adjacent tool_use: ${str(block.tool_use_id)}]\n${content}` };
}

/**
 * Translate a Responses request body into an Anthropic Messages body. `model` is the
 * upstream model id, already resolved by the model map. Sampling and output-limit
 * fields are kept: the upstream is a real API, not the ChatGPT Codex backend.
 */
export function responsesToMessages(
  raw: unknown,
  { model, stream, upstream = ANTHROPIC_REPLAY }: { model: string; stream: boolean; upstream?: string },
): MessagesRequestTranslation {
  if (!isRec(raw)) throw new TranslateError("request body must be a JSON object");
  const names: ToolNames = { custom: new Set(), namespaced: new Map() };
  const tools: Rec[] = [];
  const dropped = new Set<string>();
  addTools(raw.tools, tools, names, dropped);
  const system: string[] = str(raw.instructions) ? [str(raw.instructions)] : [];
  const items: unknown[] = typeof raw.input === "string"
    ? [{ type: "message", role: "user", content: raw.input }]
    : Array.isArray(raw.input) ? raw.input : [];

  const ids = createToolCallIdAllocator();
  for (const item of items) if (isRec(item)) ids.reserve(str(item.call_id));

  const messages: Rec[] = [];
  const push = (role: "user" | "assistant", blocks: Rec[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) (last.content as Rec[]).push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  for (const item of items.filter(isRec)) {
    const type = item.type ?? (typeof item.role === "string" ? "message" : undefined);
    switch (type) {
      case "message": {
        if (item.role === "system") {
          const text = contentOf(item.content).filter(b => b.type === "text").map(b => str(b.text)).join("\n");
          if (text) system.push(text);
        } else push(item.role === "assistant" ? "assistant" : "user", contentOf(item.content));
        break;
      }
      case "reasoning": {
        // Only thinking this upstream and model minted can be replayed; ChatGPT encrypted
        // reasoning and other upstreams' or models' thinking are foreign and dropped.
        const envelope = decodeThinkingEnvelope(str(item.encrypted_content));
        if (envelope?.model !== model || (envelope.up ?? ANTHROPIC_REPLAY) !== upstream) break;
        if (envelope.redacted !== undefined) push("assistant", [{ type: "redacted_thinking", data: envelope.redacted }]);
        else if (envelope.signature !== undefined)
          push("assistant", [{ type: "thinking", thinking: envelope.thinking ?? "", signature: envelope.signature }]);
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const id = ids.allocate(str(item.call_id));
        const name = wireToolName(str(item.name), item.namespace);
        if (id === undefined || !name) break;
        push("assistant", [{
          type: "tool_use",
          id,
          name,
          input: type === "custom_tool_call" ? { input: str(item.input) } : parseArguments(item.arguments),
        }]);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const id = ids.lookup(str(item.call_id));
        push("user", [{ type: "tool_result", tool_use_id: id ?? str(item.call_id), content: toolResultContent(item.output) }]);
        break;
      }
      case "additional_tools":
        // nanocodex declares its tools inside `input`.
        addTools(item.tools, tools, names, dropped);
        break;
      default:
        // web_search_call, compaction, item_reference, ...: no Messages form; dropped.
        dropped.add(`item:${str(type) || "unknown"}`);
        break;
    }
  }

  const paired = pairToolResults(messages);
  // Anthropic answers an assistant-final conversation as prefill, which newer models reject.
  if (paired.length === 0 || paired.at(-1)?.role === "assistant") paired.push({ role: "user", content: [{ type: "text", text: "(continue)" }] });

  const maxOut = typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : DEFAULT_MAX_TOKENS;
  const body: Rec = { model, max_tokens: maxOut, messages: paired, stream };
  if (system.length > 0) body.system = system.join("\n\n");
  if (tools.length > 0) body.tools = tools;
  if (typeof raw.temperature === "number") body.temperature = raw.temperature;
  if (typeof raw.top_p === "number") body.top_p = raw.top_p;

  const choice = raw.tool_choice;
  let toolChoice: Rec | undefined;
  if (choice === "none") toolChoice = { type: "none" };
  else if (choice === "required") toolChoice = { type: "any" };
  else if (isRec(choice) && typeof choice.name === "string") toolChoice = { type: "tool", name: wireToolName(choice.name, choice.namespace) };
  if (tools.length > 0 && raw.parallel_tool_calls === false && toolChoice?.type !== "none")
    toolChoice = { ...(toolChoice ?? { type: "auto" }), disable_parallel_tool_use: true };
  if (toolChoice && (tools.length > 0 || toolChoice.type === "none")) body.tool_choice = toolChoice;

  const effort = isRec(raw.reasoning) ? str(raw.reasoning.effort) : "";
  if (effort && effort !== "none") {
    if (usesAdaptiveThinking(model)) {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort: effort === "minimal" ? "low" : effort };
      body.max_tokens = Math.max(maxOut, reasoningBudget(effort) + OUTPUT_HEADROOM);
    } else {
      const want = reasoningBudget(effort);
      const maxTokens = Math.max(maxOut, want + OUTPUT_HEADROOM);
      body.max_tokens = maxTokens;
      body.thinking = { type: "enabled", budget_tokens: Math.max(MIN_THINKING_BUDGET, Math.min(want, maxTokens - OUTPUT_FLOOR)) };
    }
    // Extended thinking rejects temperature and top_p.
    delete body.temperature;
    delete body.top_p;
  }

  const format = isRec(raw.text) && isRec(raw.text.format) ? raw.text.format : undefined;
  if (format?.type === "json_schema" && isRec(format.schema) && /^claude-/iu.test(model)) {
    body.output_config = { ...(isRec(body.output_config) ? body.output_config : {}), format: { type: "json_schema", schema: format.schema } };
  }
  return { body, tools: names, dropped: [...dropped] };
}

// ---------------------------------------------------------------------------
// Output: Anthropic Messages -> Responses
// ---------------------------------------------------------------------------

export interface OutputOptions {
  /** The model the client asked for; echoed back. */
  requestModel: string;
  /** The upstream model; stamped into thinking envelopes. */
  upstreamModel: string;
  /** The upstream's replay identity; stamped into thinking envelopes unless Anthropic. */
  upstream?: string;
  tools: ToolNames;
}

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "")}`;

/** Anthropic counts cache reads and writes apart from input_tokens; Responses includes them. */
function responsesUsage(usage: Rec): Rec {
  const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const cached = n("cache_read_input_tokens");
  const input = n("input_tokens") + cached + n("cache_creation_input_tokens");
  const output = n("output_tokens");
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

function toolItem(id: string, wire: string, args: string, tools: ToolNames): Rec {
  if (tools.custom.has(wire)) {
    const parsed = parseArguments(args);
    return { type: "custom_tool_call", id: newId("ctc"), call_id: id, name: wire, input: typeof parsed.input === "string" ? parsed.input : args, status: "completed" };
  }
  const alias = tools.namespaced.get(wire);
  return {
    type: "function_call",
    id: newId("fc"),
    call_id: id,
    name: alias?.name ?? wire,
    ...(alias ? { namespace: alias.namespace } : {}),
    arguments: args.trim() || "{}",
    status: "completed",
  };
}

/** Anthropic envelopes carry no `up`, so envelopes minted before P5 stay Anthropic's. */
function thinkingEnvelope(options: OutputOptions, fields: Omit<ThinkingEnvelope, "model" | "up">): string {
  const up = options.upstream ?? ANTHROPIC_REPLAY;
  return encodeThinkingEnvelope({ model: options.upstreamModel, ...(up === ANTHROPIC_REPLAY ? {} : { up }), ...fields });
}

function reasoningItem(thinking: string, envelope: string): Rec {
  return {
    type: "reasoning",
    id: newId("rs"),
    summary: thinking ? [{ type: "summary_text", text: thinking }] : [],
    encrypted_content: envelope,
  };
}

function messageItem(text: string): Rec {
  return {
    type: "message",
    id: newId("msg"),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

/** Terminal status for a stop reason. */
function outcome(stopReason: string | null): { status: string; incomplete?: Rec } {
  if (stopReason === "max_tokens") return { status: "incomplete", incomplete: { reason: "max_output_tokens" } };
  if (stopReason === "refusal") return { status: "incomplete", incomplete: { reason: "content_filter" } };
  return { status: "completed" };
}

function responsesError(error: unknown): Rec {
  const e = isRec(error) ? error : {};
  const type = str(e.type);
  const message = str(e.message) || "upstream request failed";
  const code = /prompt is too long|context/iu.test(message)
    ? "context_length_exceeded"
    : type === "rate_limit_error" ? "rate_limit_exceeded"
      : type === "overloaded_error" ? "server_is_overloaded"
        : type === "invalid_request_error" ? "invalid_request_error" : "server_error";
  return { code, message };
}

/** Translate an Anthropic Messages (non-streaming) response body into a Responses body. */
export function messagesJsonToResponses(json: unknown, options: OutputOptions): Rec {
  const message = isRec(json) ? json : {};
  const output: Rec[] = [];
  for (const block of Array.isArray(message.content) ? message.content.filter(isRec) : []) {
    if (block.type === "text" && str(block.text)) output.push(messageItem(str(block.text)));
    else if (block.type === "thinking")
      output.push(reasoningItem(str(block.thinking), thinkingEnvelope(options, { thinking: str(block.thinking), signature: str(block.signature) })));
    else if (block.type === "redacted_thinking")
      output.push(reasoningItem("", thinkingEnvelope(options, { redacted: str(block.data) })));
    else if (block.type === "tool_use")
      output.push(toolItem(str(block.id) || newId("toolu"), str(block.name), JSON.stringify(block.input ?? {}), options.tools));
  }
  const { status, incomplete } = outcome(typeof message.stop_reason === "string" ? message.stop_reason : null);
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status,
    model: options.requestModel,
    output,
    usage: responsesUsage(isRec(message.usage) ? message.usage : {}),
    ...(incomplete ? { incomplete_details: incomplete } : {}),
  };
}

const encoder = new TextEncoder();

/**
 * Translate an Anthropic Messages SSE body into a Responses SSE body: response.created,
 * then per block output_item.added -> deltas -> output_item.done, then one terminal
 * response.completed / response.incomplete / response.failed carrying all output items
 * (the Codex WebSocket route replays those for previous_response_id).
 */
export async function* messagesStreamToResponses(
  sse: AsyncIterable<Uint8Array>,
  options: OutputOptions,
): AsyncGenerator<Uint8Array> {
  const id = newId("resp");
  const createdAt = Math.floor(Date.now() / 1_000);
  let sequence = 0;
  const frame = (type: string, data: Rec) =>
    encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  const snapshot = (status: string, output: Rec[]) => ({ id, object: "response", created_at: createdAt, status, model: options.requestModel, output });

  yield frame("response.created", { response: { ...snapshot("in_progress", []), usage: null } });
  yield frame("response.in_progress", { response: { ...snapshot("in_progress", []), usage: null } });

  const output: Rec[] = [];
  let usage: Rec = {};
  let stopReason: string | null = null;
  type Open =
    | { kind: "text"; item: Rec; text: string }
    | { kind: "thinking"; item: Rec; text: string; signature: string }
    | { kind: "tool"; toolId: string; wire: string; item: Rec; args: string }
    | { kind: "other" };
  let open: Open | null = null;
  const index = () => output.length;

  const close = function* (): Generator<Uint8Array> {
    if (open === null) return;
    const block = open;
    open = null;
    if (block.kind === "text") {
      const item: Rec = { ...block.item, status: "completed", content: [{ type: "output_text", text: block.text, annotations: [] }] };
      const ids = { item_id: item.id, output_index: index(), content_index: 0 };
      yield frame("response.output_text.done", { ...ids, text: block.text });
      yield frame("response.content_part.done", { ...ids, part: { type: "output_text", text: block.text, annotations: [] } });
      yield frame("response.output_item.done", { output_index: index(), item });
      output.push(item);
    } else if (block.kind === "thinking") {
      const item = reasoningItem(block.text, thinkingEnvelope(options, { thinking: block.text, signature: block.signature }));
      item.id = block.item.id;
      const ids = { item_id: item.id, output_index: index(), summary_index: 0 };
      yield frame("response.reasoning_summary_text.done", { ...ids, text: block.text });
      yield frame("response.reasoning_summary_part.done", { ...ids, part: { type: "summary_text", text: block.text } });
      yield frame("response.output_item.done", { output_index: index(), item });
      output.push(item);
    } else if (block.kind === "tool") {
      const item: Rec = { ...toolItem(block.toolId, block.wire, block.args, options.tools), id: block.item.id };
      if (item.type === "function_call")
        yield frame("response.function_call_arguments.done", { item_id: item.id, output_index: index(), arguments: item.arguments });
      yield frame("response.output_item.done", { output_index: index(), item });
      output.push(item);
    }
  };

  const terminal = function* (): Generator<Uint8Array> {
    yield* close();
    const { status, incomplete } = outcome(stopReason);
    const response = { ...snapshot(status, output), usage: responsesUsage(usage), ...(incomplete ? { incomplete_details: incomplete } : {}) };
    yield frame(status === "completed" ? "response.completed" : "response.incomplete", { response });
  };
  const failed = function* (error: Rec): Generator<Uint8Array> {
    yield* close();
    yield frame("response.failed", { response: { ...snapshot("failed", output), usage: responsesUsage(usage), error } });
  };

  for await (const event of decodeSse(sse)) {
    switch (event.type) {
      case "message_start":
        if (isRec(event.message) && isRec(event.message.usage)) usage = { ...event.message.usage };
        break;
      case "content_block_start": {
        yield* close();
        const block = isRec(event.content_block) ? event.content_block : {};
        if (block.type === "text") {
          const item = { type: "message", id: newId("msg"), role: "assistant", status: "in_progress", content: [] };
          open = { kind: "text", item, text: "" };
          yield frame("response.output_item.added", { output_index: index(), item });
          yield frame("response.content_part.added", { item_id: item.id, output_index: index(), content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          if (str(block.text)) {
            open.text += str(block.text);
            yield frame("response.output_text.delta", { item_id: item.id, output_index: index(), content_index: 0, delta: block.text });
          }
        } else if (block.type === "thinking") {
          const item = { type: "reasoning", id: newId("rs"), summary: [] };
          open = { kind: "thinking", item, text: str(block.thinking), signature: str(block.signature) };
          yield frame("response.output_item.added", { output_index: index(), item });
          yield frame("response.reasoning_summary_part.added", { item_id: item.id, output_index: index(), summary_index: 0, part: { type: "summary_text", text: "" } });
        } else if (block.type === "redacted_thinking") {
          const item = reasoningItem("", thinkingEnvelope(options, { redacted: str(block.data) }));
          yield frame("response.output_item.added", { output_index: index(), item });
          yield frame("response.output_item.done", { output_index: index(), item });
          output.push(item);
          open = { kind: "other" };
        } else if (block.type === "tool_use") {
          const toolId = str(block.id) || newId("toolu");
          const wire = str(block.name);
          const shape = toolItem(toolId, wire, "", options.tools);
          const item = shape.type === "function_call"
            ? { ...shape, arguments: "", status: "in_progress" }
            : { ...shape, input: "", status: "in_progress" };
          open = { kind: "tool", toolId, wire, item, args: "" };
          yield frame("response.output_item.added", { output_index: index(), item });
        } else open = { kind: "other" };
        break;
      }
      case "content_block_delta": {
        const delta = isRec(event.delta) ? event.delta : {};
        const block: Open | null = open;
        if (block?.kind === "text" && delta.type === "text_delta") {
          block.text += str(delta.text);
          yield frame("response.output_text.delta", { item_id: block.item.id, output_index: index(), content_index: 0, delta: str(delta.text) });
        } else if (block?.kind === "thinking" && delta.type === "thinking_delta") {
          block.text += str(delta.thinking);
          yield frame("response.reasoning_summary_text.delta", { item_id: block.item.id, output_index: index(), summary_index: 0, delta: str(delta.thinking) });
        } else if (block?.kind === "thinking" && delta.type === "signature_delta") {
          block.signature = str(delta.signature);
        } else if (block?.kind === "tool" && delta.type === "input_json_delta") {
          block.args += str(delta.partial_json);
          if (block.item.type === "function_call")
            yield frame("response.function_call_arguments.delta", { item_id: block.item.id, output_index: index(), delta: str(delta.partial_json) });
        }
        break;
      }
      case "content_block_stop":
        yield* close();
        break;
      case "message_delta":
        if (isRec(event.usage)) usage = { ...usage, ...event.usage };
        if (isRec(event.delta) && typeof event.delta.stop_reason === "string") stopReason = event.delta.stop_reason;
        break;
      case "message_stop":
        yield* terminal();
        return;
      case "error":
        yield* failed(responsesError(event.error));
        return;
      default:
        break;
    }
  }
  // Compatible vendors may close after message_delta without message_stop.
  if (stopReason !== null) yield* terminal();
  else yield* failed({ code: "server_error", message: "Gateway: the upstream stream ended before the message finished." });
}
