// Adapted from opencodex src/claude/inbound.ts, inbound-content-options.ts, inbound-model-options.ts (MIT, (c) 2026 opencodex contributors). See THIRD_PARTY.md.
//
// Anthropic Messages request (as Claude Code sends it) -> ChatGPT Responses request.
// The target is the ChatGPT Codex backend: store false, always streamed, and no
// sampling or output-limit fields (it rejects max_output_tokens, temperature, top_p,
// stop and user).
import { createHash } from "node:crypto";
import { CHATGPT_REPLAY, decodeReasoningEnvelope } from "./reasoning-envelope.js";

type Rec = Record<string, unknown>;

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: Rec[];
  tools?: Rec[];
  tool_choice?: string | Rec;
  parallel_tool_calls?: boolean;
  reasoning: { effort: string; summary?: "auto" };
  text?: { format: Rec };
  include?: string[];
  prompt_cache_key?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  store: false;
  stream: true;
}

/** A request the gateway cannot translate without losing meaning. The hub answers `status` with `body`. */
export class TranslateError extends Error {
  readonly status = 400;
  readonly body: { type: "error"; error: { type: "invalid_request_error"; message: string } };
  constructor(message: string) {
    super(`Gateway: ${message}`);
    this.body = { type: "error", error: { type: "invalid_request_error", message: this.message } };
  }
}

const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

// Claude Code prepends a per-call billing line whose hash changes every request. It means
// nothing to ChatGPT and would break the upstream prompt-cache prefix.
const BILLING_HEADER = "x-anthropic-billing-header:";

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((b): b is Rec => isRec(b) && b.type === "text" && typeof b.text === "string")
    .map(b => b.text as string)
    .filter(text => !text.startsWith(BILLING_HEADER))
    .join("\n\n");
}

function imagePart(block: Rec): Rec {
  const source = isRec(block.source) ? block.source : {};
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "input_image", image_url: `data:${media};base64,${source.data}` };
  }
  if (source.type === "url" && typeof source.url === "string") return { type: "input_image", image_url: source.url };
  throw new TranslateError(`image source "${String(source.type)}" is not supported on the ChatGPT fallback`);
}

function documentParts(block: Rec): Rec[] {
  const source = isRec(block.source) ? block.source : {};
  const title = typeof block.title === "string" && block.title.length > 0 ? block.title : undefined;
  if (source.type === "base64" && typeof source.data === "string") {
    const media = typeof source.media_type === "string" ? source.media_type : "application/octet-stream";
    return [{ type: "input_file", file_data: `data:${media};base64,${source.data}`, filename: title ?? "document" }];
  }
  if (source.type === "url" && typeof source.url === "string") return [{ type: "input_file", file_url: source.url }];
  if (source.type === "text" && typeof source.data === "string") return [{ type: "input_text", text: source.data }];
  if (source.type === "content" && Array.isArray(source.content)) return source.content.filter(isRec).map(contentPart);
  throw new TranslateError(`document source "${String(source.type)}" is not supported on the ChatGPT fallback`);
}

/** One user-side content block (also used inside tool_result content). */
function contentPart(block: Rec): Rec {
  if (block.type === "text") return { type: "input_text", text: typeof block.text === "string" ? block.text : "" };
  if (block.type === "image") return imagePart(block);
  throw new TranslateError(`content block "${String(block.type)}" is not supported on the ChatGPT fallback`);
}

function toolResultOutput(block: Rec, loadedTools: Set<string>): string | Rec[] {
  const prefix = block.is_error === true ? "[tool error] " : "";
  const content = block.content;
  if (typeof content === "string") return prefix + content;
  if (!Array.isArray(content)) return prefix.trim();
  const parts: Rec[] = [];
  for (const item of content.filter(isRec)) {
    if (item.type === "document") parts.push(...documentParts(item));
    else if (item.type === "tool_reference") {
      if (typeof item.tool_name !== "string" || item.tool_name.length === 0)
        throw new TranslateError("tool_reference requires tool_name");
      loadedTools.add(item.tool_name);
      parts.push({ type: "input_text", text: `Tool loaded: ${item.tool_name}` });
    }
    else parts.push(contentPart(item));
  }
  if (prefix) parts.unshift({ type: "input_text", text: prefix.trim() });
  return parts;
}

function userItems(content: unknown, input: Rec[], loadedTools: Set<string>): void {
  if (typeof content === "string") {
    if (content.length > 0) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: content }] });
    return;
  }
  if (!Array.isArray(content)) return;
  // Keep block order: each tool_result becomes its own function_call_output item;
  // contiguous text/image/document runs become one user message.
  let pending: Rec[] = [];
  const flush = () => {
    if (pending.length > 0) input.push({ type: "message", role: "user", content: pending });
    pending = [];
  };
  for (const block of content.filter(isRec)) {
    if (block.type === "tool_result") {
      flush();
      if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
        throw new TranslateError("tool_result requires tool_use_id");
      }
      input.push({ type: "function_call_output", call_id: block.tool_use_id, output: toolResultOutput(block, loadedTools) });
    } else if (block.type === "document") {
      pending.push(...documentParts(block));
    } else if (block.type === "text") {
      if (typeof block.text === "string" && block.text.length > 0) pending.push(contentPart(block));
    } else {
      pending.push(contentPart(block));
    }
  }
  flush();
}

function assistantItems(content: unknown, input: Rec[], upstream: string): void {
  if (typeof content === "string") {
    if (content.length > 0) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] });
    return;
  }
  if (!Array.isArray(content)) return;
  let pending: Rec[] = [];
  const flush = () => {
    if (pending.length > 0) input.push({ type: "message", role: "assistant", content: pending });
    pending = [];
  };
  for (const block of content.filter(isRec)) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.length > 0) pending.push({ type: "output_text", text: block.text });
        break;
      case "tool_use":
        flush();
        if (typeof block.id !== "string" || block.id.length === 0 || typeof block.name !== "string" || block.name.length === 0) {
          throw new TranslateError("tool_use requires id and name");
        }
        // Tool ids pass through unchanged in both directions: toolu_* ids are valid Responses
        // call_ids and ChatGPT call_* ids are valid Anthropic tool_use ids.
        input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
        break;
      case "thinking": {
        // Our own envelope replays as a reasoning item, but only to the upstream that
        // minted it. Anything else (Anthropic's or a key's thinking, another Responses
        // upstream's reasoning) is foreign and dropped (plan decision "drop foreign thinking").
        const env = typeof block.signature === "string" ? decodeReasoningEnvelope(block.signature) : null;
        if (!env?.enc || (env.up ?? CHATGPT_REPLAY) !== upstream) break;
        flush();
        const text = typeof block.thinking === "string" ? block.thinking : "";
        input.push({
          type: "reasoning",
          id: env.id,
          summary: text.length > 0 ? [{ type: "summary_text", text }] : [],
          encrypted_content: env.enc,
        });
        break;
      }
      case "redacted_thinking":
        break; // Always Anthropic's; dropped.
      default:
        throw new TranslateError(`assistant block "${String(block.type)}" is not supported on the ChatGPT fallback`);
    }
  }
  flush();
}

function toolsToResponses(tools: unknown, loadedTools: Set<string>): Rec[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Rec[] = [];
  for (const tool of tools.filter(isRec)) {
    const type = typeof tool.type === "string" ? tool.type : "";
    // Claude Code's WebSearch tool makes its own sub-request with this server tool.
    if (type.startsWith("web_search_")) {
      out.push({ type: "web_search" });
      continue;
    }
    if (type !== "" && type !== "custom") {
      throw new TranslateError(`server tool "${type}" is not supported on the ChatGPT fallback`);
    }
    if (typeof tool.name !== "string" || !isRec(tool.input_schema)) continue;
    // Deferred tools become callable after a tool_result references them.
    if (tool.defer_loading === true && !loadedTools.has(tool.name)) continue;
    out.push({
      type: "function",
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: tool.input_schema,
      // Responses treats a missing `strict` as strict, which makes optional parameters required.
      strict: tool.strict === true,
    });
  }
  return out.length > 0 ? out : undefined;
}

function toolChoice(choice: unknown): { tool_choice: string | Rec; parallel_tool_calls: boolean } {
  const c = isRec(choice) ? choice : {};
  const parallel_tool_calls = c.disable_parallel_tool_use !== true;
  switch (c.type) {
    case "none": return { tool_choice: "none", parallel_tool_calls };
    case "any": return { tool_choice: "required", parallel_tool_calls };
    case "tool":
      if (typeof c.name !== "string" || c.name.length === 0) throw new TranslateError("tool_choice.tool requires a name");
      return {
        tool_choice: c.name === "web_search" ? { type: "web_search" } : { type: "function", name: c.name },
        parallel_tool_calls,
      };
    default: return { tool_choice: "auto", parallel_tool_calls };
  }
}

// Claude Code effort levels -> the effort levels ChatGPT accepts.
const EFFORT: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

function effortForBudget(budget: number): string {
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

/**
 * Translate a Claude Code `/v1/messages` body into a ChatGPT `/responses` body.
 * `model` is the upstream model id, already resolved by the caller's model map.
 * `keepSampling` is for real Responses APIs (API keys): they take the output limit and
 * sampling fields the ChatGPT Codex backend rejects. `upstream` is the target's replay
 * identity: only reasoning it minted is replayed.
 * Throws TranslateError for input the fallback cannot represent.
 */
export function messagesToResponses(
  raw: unknown,
  { model, keepSampling = false, upstream = CHATGPT_REPLAY }: { model: string; keepSampling?: boolean; upstream?: string },
): ResponsesRequest {
  if (!isRec(raw)) throw new TranslateError("request body must be a JSON object");
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) throw new TranslateError("messages must be a non-empty array");
  if (raw.mcp_servers !== undefined) throw new TranslateError("mcp_servers is not supported on the ChatGPT fallback");
  if (Array.isArray(raw.stop_sequences) && raw.stop_sequences.length > 0) {
    throw new TranslateError("stop_sequences is not supported on the ChatGPT fallback");
  }

  const input: Rec[] = [];
  const loadedTools = new Set<string>();
  for (const msg of raw.messages) {
    if (!isRec(msg)) throw new TranslateError("each message must be an object");
    if (msg.role === "user") userItems(msg.content, input, loadedTools);
    else if (msg.role === "assistant") assistantItems(msg.content, input, upstream);
    else if (msg.role === "system") {
      // Claude Code's mid-conversation system turns. ChatGPT rejects role "system" in
      // input but accepts "developer", which keeps the turn in place in the timeline.
      const text = systemText(msg.content);
      if (text.length > 0) input.push({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
    } else throw new TranslateError(`unsupported message role: ${String(msg.role)}`);
  }

  const body: ResponsesRequest = {
    model,
    instructions: systemText(raw.system),
    input,
    reasoning: { effort: "low" },
    store: false,
    stream: true,
  };
  const tools = toolsToResponses(raw.tools, loadedTools);
  if (tools) Object.assign(body, { tools }, toolChoice(raw.tool_choice));

  // Thinking on: request summaries and encrypted reasoning so it can ride back as a
  // thinking block. Thinking off (e.g. the session-title call): lowest effort, and no
  // reasoning comes back.
  const thinking = isRec(raw.thinking) ? raw.thinking : undefined;
  if (thinking && thinking.type !== "disabled") {
    const configured = isRec(raw.output_config) && typeof raw.output_config.effort === "string"
      ? EFFORT[raw.output_config.effort]
      : undefined;
    const effort = configured
      ?? (typeof thinking.budget_tokens === "number" ? effortForBudget(thinking.budget_tokens) : "medium");
    body.reasoning = { effort, summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }

  // Structured output (the session-title call asks for {"title": ...}).
  const format = isRec(raw.output_config) ? raw.output_config.format : undefined;
  if (isRec(format) && format.type === "json_schema" && isRec(format.schema)) {
    body.text = { format: { type: "json_schema", name: "response", schema: format.schema } };
  }

  if (keepSampling) {
    if (typeof raw.max_tokens === "number") body.max_output_tokens = raw.max_tokens;
    if (typeof raw.temperature === "number") body.temperature = raw.temperature;
    if (typeof raw.top_p === "number") body.top_p = raw.top_p;
  }

  // metadata.user_id embeds the Claude Code session id: a stable per-session cache key.
  if (isRec(raw.metadata) && typeof raw.metadata.user_id === "string") {
    body.prompt_cache_key = createHash("sha256").update(raw.metadata.user_id).digest("hex").slice(0, 32);
  }
  return body;
}
