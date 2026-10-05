// Adapted from opencodex src/claude/outbound.ts and src/lib/sse-decoder.ts (MIT, (c) 2026 opencodex contributors). See THIRD_PARTY.md.
//
// ChatGPT Responses output -> Anthropic Messages output, streaming and JSON.
// Stream framing Claude Code expects: message_start, then per block
// content_block_start -> deltas -> content_block_stop, then message_delta (stop_reason
// and cumulative usage) and message_stop. `ping` may appear anywhere. Errors after the
// HTTP 200 are an `error` event; Claude Code retries the turn itself.
import { randomUUID } from "node:crypto";
import { CHATGPT_REPLAY, encodeReasoningEnvelope } from "./reasoning-envelope.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Responses usage counts cached tokens inside input_tokens; Anthropic counts them apart. */
function anthropicUsage(usage: unknown, webSearchRequests = 0): Rec {
  const u = isRec(usage) ? usage : {};
  const details = isRec(u.input_tokens_details) ? u.input_tokens_details : {};
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  return {
    input_tokens: Math.max(0, input - cached),
    output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    ...(webSearchRequests > 0 ? { server_tool_use: { web_search_requests: webSearchRequests } } : {}),
  };
}

/** Map a failed Responses turn to the Anthropic error type Claude Code reacts to. */
function anthropicError(error: Rec): Rec {
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" && error.message ? error.message : "upstream request failed";
  if (code === "context_length_exceeded") {
    // Claude Code compacts on this message text.
    return { type: "error", error: { type: "invalid_request_error", message: `prompt is too long: ${message}` } };
  }
  const type = /rate_limit|usage_limit|quota/.test(code) ? "rate_limit_error" : "overloaded_error";
  return { type: "error", error: { type, message } };
}

function webSearchBlocks(item: Rec): { id: string; input: Rec; result: unknown; completed: boolean } {
  const action = isRec(item.action) ? item.action : {};
  const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === "string" && q.length > 0) : [];
  const query = typeof action.query === "string" ? action.query : (queries[0] ?? "");
  const completed = item.status !== "failed";
  const sources = Array.isArray(action.sources) ? action.sources : Array.isArray(item.sources) ? item.sources : [];
  const result = completed
    ? sources.filter((s): s is Rec => isRec(s) && typeof s.url === "string")
      .map(s => ({ type: "web_search_result", title: typeof s.title === "string" ? s.title : "", url: s.url }))
    : { type: "web_search_tool_result_error", error_code: "unavailable" };
  const id = `srvtoolu_${typeof item.id === "string" ? item.id.replace(/[^a-zA-Z0-9_-]/g, "") : randomUUID().replace(/-/g, "")}`;
  return { id, input: queries.length > 1 ? { queries } : { query }, result, completed };
}

function sseFrame(data: Rec): Uint8Array {
  return encoder.encode(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
}
const encoder = new TextEncoder();

/** ChatGPT envelopes carry no `up`, so envelopes minted before P5 stay ChatGPT's. */
function envelope(id: string, enc: string | undefined, upstream: string): string {
  return encodeReasoningEnvelope({ id, ...(enc ? { enc } : {}), ...(upstream === CHATGPT_REPLAY ? {} : { up: upstream }) });
}

/** Decode text/event-stream bytes into JSON payloads. The `data.type` field names the event. */
export async function* decodeSse(sse: AsyncIterable<Uint8Array>): AsyncGenerator<Rec> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (frame: string): Rec | null => {
    let data = "";
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data")) continue;
      const rest = line.slice(4);
      if (rest.length > 0 && !rest.startsWith(":")) continue;
      // The space after the colon is optional in text/event-stream.
      data += rest.startsWith(": ") ? rest.slice(2) : rest.slice(1);
    }
    if (!data || data === "[DONE]") return null;
    try {
      const parsed: unknown = JSON.parse(data);
      return isRec(parsed) && typeof parsed.type === "string" ? parsed : null;
    } catch {
      return null;
    }
  };
  for await (const chunk of sse) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = parse(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      if (frame) yield frame;
    }
  }
  const last = parse(buffer + decoder.decode());
  if (last) yield last;
}

const PING = Symbol("ping");

/**
 * Translate a ChatGPT Responses SSE body into an Anthropic Messages SSE body.
 * `requestModel` is the Claude model id the client asked for; it is echoed back.
 * `upstream` is the replay identity stamped into reasoning envelopes.
 */
export async function* responsesStreamToMessages(
  sse: AsyncIterable<Uint8Array>,
  { requestModel, upstream = CHATGPT_REPLAY, pingIntervalMs = 15_000 }: { requestModel: string; upstream?: string; pingIntervalMs?: number },
): AsyncGenerator<Uint8Array> {
  let started = false;
  let terminated = false;
  let blockIndex = 0;
  let sawToolUse = false;
  let webSearchRequests = 0;
  let sawContent = false;
  const completedItems = new Set<string>();
  // At most one open block: Responses streams output items one after another.
  type Block = { kind: "text" | "thinking" | "tool_use" | "server"; index: number; itemId?: string; part?: unknown; argsSent?: boolean };
  let open: Block | null = null;
  const out: Uint8Array[] = [];
  const emit = (data: Rec) => out.push(sseFrame(data));

  const start = () => {
    if (started) return;
    started = true;
    emit({
      type: "message_start",
      message: {
        id: `msg_${randomUUID().replace(/-/g, "")}`, type: "message", role: "assistant", content: [],
        model: requestModel, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const close = () => {
    if (!open) return;
    emit({ type: "content_block_stop", index: open.index });
    open = null;
  };
  const openBlock = (kind: Block["kind"], contentBlock: Rec, itemId?: string): Block => {
    start();
    close();
    sawContent = true;
    const block: Block = { kind, index: blockIndex++, itemId };
    open = block;
    emit({ type: "content_block_start", index: block.index, content_block: contentBlock });
    return block;
  };
  const current = (): Block | null => open;
  const finish = (stopReason: string, usage: unknown) => {
    start();
    close();
    emit({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: anthropicUsage(usage, webSearchRequests) });
    emit({ type: "message_stop" });
    terminated = true;
  };
  const fail = (error: Rec) => {
    close();
    emit(anthropicError(error));
    terminated = true;
  };

  const itemKey = (item: Rec): string | null => {
    if (typeof item.id === "string" && item.id.length > 0) return item.id;
    if (typeof item.call_id === "string" && item.call_id.length > 0)
      return `${String(item.type)}:${item.call_id}`;
    return null;
  };

  const completeItem = (item: Rec) => {
    const key = itemKey(item);
    if (key !== null && completedItems.has(key)) return;
    const block = current();
    if (item.type === "message") {
      if (block?.kind === "text" && (block.itemId === key || block.itemId === undefined)) {
        close();
      } else {
        for (const part of (Array.isArray(item.content) ? item.content : []).filter(isRec)) {
          if (part.type !== "output_text" || typeof part.text !== "string" || part.text.length === 0) continue;
          const text = openBlock("text", { type: "text", text: "" }, key ?? undefined);
          emit({ type: "content_block_delta", index: text.index, delta: { type: "text_delta", text: part.text } });
          close();
        }
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      sawToolUse = true;
      const callId = typeof item.call_id === "string" ? item.call_id : `toolu_${randomUUID().replace(/-/g, "")}`;
      const use = block?.kind === "tool_use" && block.itemId === key
        ? block
        : openBlock("tool_use", {
            type: "tool_use",
            id: callId,
            name: typeof item.name === "string" ? item.name : "",
            input: {},
          }, key ?? undefined);
      if (!use.argsSent) {
        const args = item.type === "custom_tool_call"
          ? JSON.stringify({ input: typeof item.input === "string" ? item.input : "" })
          : typeof item.arguments === "string" ? item.arguments : "";
        if (args.length > 0) {
          emit({ type: "content_block_delta", index: use.index, delta: { type: "input_json_delta", partial_json: args } });
          use.argsSent = true;
        }
      }
      close();
    } else if (item.type === "reasoning") {
      const enc = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0 ? item.encrypted_content : undefined;
      const id = typeof item.id === "string" ? item.id : "";
      const summary = (Array.isArray(item.summary) ? item.summary : [])
        .filter(isRec)
        .map(part => typeof part.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n\n");
      const isOpen = block?.kind === "thinking" && block.itemId === id;
      if (isOpen || summary || enc) {
        const thinking = isOpen ? block : openBlock("thinking", { type: "thinking", thinking: "", signature: "" }, id);
        if (!isOpen && summary) emit({ type: "content_block_delta", index: thinking.index, delta: { type: "thinking_delta", thinking: summary } });
        emit({ type: "content_block_delta", index: thinking.index, delta: { type: "signature_delta", signature: envelope(id, enc, upstream) } });
        close();
      }
    } else if (item.type === "web_search_call") {
      const pair = webSearchBlocks(item);
      const use = openBlock("server", { type: "server_tool_use", id: pair.id, name: "web_search", input: {} });
      emit({ type: "content_block_delta", index: use.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(pair.input) } });
      openBlock("server", { type: "web_search_tool_result", tool_use_id: pair.id, content: pair.result });
      close();
      if (pair.completed) webSearchRequests++;
    }
    if (key !== null) completedItems.add(key);
  };

  const handle = (event: Rec) => {
    switch (event.type) {
      case "response.created":
        start(); // Early first byte; the hub already checked the HTTP status.
        break;
      case "response.output_text.delta": {
        if (typeof event.delta !== "string" || event.delta.length === 0) break;
        const prev = current();
        const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
        const block = prev?.kind === "text" ? prev : openBlock("text", { type: "text", text: "" }, itemId);
        emit({ type: "content_block_delta", index: block.index, delta: { type: "text_delta", text: event.delta } });
        break;
      }
      case "response.reasoning_summary_text.delta": {
        if (typeof event.delta !== "string" || event.delta.length === 0) break;
        const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
        const prev = current();
        const same = prev?.kind === "thinking" && prev.itemId === itemId;
        const block = same ? prev : openBlock("thinking", { type: "thinking", thinking: "", signature: "" }, itemId);
        // A new summary part of the same reasoning item starts a new paragraph.
        const text = same && event.summary_index !== block.part ? `\n\n${event.delta}` : event.delta;
        block.part = event.summary_index;
        emit({ type: "content_block_delta", index: block.index, delta: { type: "thinking_delta", thinking: text } });
        break;
      }
      case "response.output_item.added": {
        const item = isRec(event.item) ? event.item : {};
        if (item.type !== "function_call" && item.type !== "custom_tool_call") break;
        sawToolUse = true;
        openBlock("tool_use", {
          type: "tool_use",
          id: typeof item.call_id === "string" ? item.call_id : `toolu_${randomUUID().replace(/-/g, "")}`,
          name: typeof item.name === "string" ? item.name : "",
          input: {},
        }, itemKey(item) ?? undefined);
        break;
      }
      case "response.function_call_arguments.delta": {
        const block = current();
        if (block?.kind !== "tool_use" || typeof event.delta !== "string" || event.delta.length === 0) break;
        emit({ type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: event.delta } });
        block.argsSent = true;
        break;
      }
      case "response.output_item.done": {
        const item = isRec(event.item) ? event.item : {};
        completeItem(item);
        break;
      }
      case "response.completed": {
        const response = isRec(event.response) ? event.response : {};
        for (const item of (Array.isArray(response.output) ? response.output : []).filter(isRec)) completeItem(item);
        if (!sawContent) {
          fail({ message: "upstream completed without assistant content" });
          break;
        }
        finish(sawToolUse ? "tool_use" : "end_turn", response.usage);
        break;
      }
      case "response.incomplete": {
        const response = isRec(event.response) ? event.response : {};
        const reason = isRec(response.incomplete_details) ? response.incomplete_details.reason : undefined;
        if (reason === "max_output_tokens") finish("max_tokens", response.usage);
        else if (reason === "content_filter") finish("refusal", response.usage);
        else fail({ message: `upstream response was incomplete (${String(reason)})` });
        break;
      }
      case "response.failed": {
        const response = isRec(event.response) ? event.response : {};
        fail(isRec(response.error) ? response.error : {});
        break;
      }
      case "error":
        fail(isRec(event.error) ? event.error : event);
        break;
      default:
        break;
    }
  };

  const events = decodeSse(sse)[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Read the next upstream event only while not terminated, so a finished turn never
    // waits on an upstream that keeps the connection open.
    let next: Promise<IteratorResult<Rec>> | undefined;
    while (!terminated) {
      next ??= events.next();
      const result = pingIntervalMs > 0
        ? await Promise.race([next, new Promise<typeof PING>(resolve => { timer = setTimeout(resolve, pingIntervalMs, PING); })])
        : await next;
      clearTimeout(timer);
      if (result === PING) {
        // Keepalive during long silent reasoning, so idle proxies and tunnels keep the stream.
        yield sseFrame({ type: "ping" });
        continue;
      }
      next = undefined;
      if (result.done) break;
      handle(result.value);
      yield* out.splice(0);
    }
    // EOF without a terminal event is a truncation, not success: make Claude Code retry.
    if (!terminated) fail({ message: "upstream stream ended before a terminal event" });
    yield* out.splice(0);
  } finally {
    clearTimeout(timer);
    await events.return?.(undefined);
  }
}

/** Translate a finished Responses response object (e.g. `response.completed`'s `response`) into an Anthropic message. */
export function responsesJsonToMessages(
  json: unknown,
  { requestModel, upstream = CHATGPT_REPLAY }: { requestModel: string; upstream?: string },
): Rec {
  const body = isRec(json) ? json : {};
  if (body.status === "failed") return anthropicError(isRec(body.error) ? body.error : {});
  const reason = isRec(body.incomplete_details) ? body.incomplete_details.reason : undefined;
  if (body.status === "incomplete" && reason !== "max_output_tokens" && reason !== "content_filter") {
    return anthropicError({ message: `upstream response was incomplete (${String(reason)})` });
  }
  const content: Rec[] = [];
  let sawToolUse = false;
  let webSearchRequests = 0;
  for (const item of (Array.isArray(body.output) ? body.output : []).filter(isRec)) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(isRec)) {
        if (part.type === "output_text" && typeof part.text === "string" && part.text.length > 0) content.push({ type: "text", text: part.text });
      }
    } else if (item.type === "reasoning") {
      const text = (Array.isArray(item.summary) ? item.summary : [])
        .filter((s): s is Rec => isRec(s) && typeof s.text === "string").map(s => s.text).join("\n\n");
      const enc = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0 ? item.encrypted_content : undefined;
      if (text || enc) {
        const id = typeof item.id === "string" ? item.id : "";
        content.push({ type: "thinking", thinking: text, signature: envelope(id, enc, upstream) });
      }
    } else if (item.type === "function_call") {
      sawToolUse = true;
      let input: unknown = {};
      try { input = typeof item.arguments === "string" && item.arguments ? JSON.parse(item.arguments) : {}; } catch { input = {}; }
      content.push({
        type: "tool_use",
        id: typeof item.call_id === "string" ? item.call_id : `toolu_${randomUUID().replace(/-/g, "")}`,
        name: typeof item.name === "string" ? item.name : "",
        input,
      });
    } else if (item.type === "web_search_call") {
      const pair = webSearchBlocks(item);
      content.push({ type: "server_tool_use", id: pair.id, name: "web_search", input: pair.input });
      content.push({ type: "web_search_tool_result", tool_use_id: pair.id, content: pair.result });
      if (pair.completed) webSearchRequests++;
    }
  }
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" ? "refusal" : sawToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: anthropicUsage(body.usage, webSearchRequests),
  };
}
