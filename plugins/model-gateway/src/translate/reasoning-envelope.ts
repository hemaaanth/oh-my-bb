// Adapted from opencodex src/responses/reasoning-envelope.ts (MIT, (c) 2026 opencodex contributors). See THIRD_PARTY.md.
//
// ChatGPT reasoning rides back to Claude Code as a `thinking` block. Its signature is
// this envelope: the reasoning item id plus its `encrypted_content`. When Claude Code
// replays the block, the request translator turns it back into a Responses reasoning
// item, so the model keeps its reasoning across a tool loop. Genuine Anthropic
// signatures never carry this prefix; those blocks are foreign and are dropped.
//
// Replay rule: a thinking or reasoning block goes back only to the upstream that
// minted it (`replayIdentity` in chain.ts). Every envelope records that upstream.

/** Raw (unwrapped) Messages thinking is Anthropic's; raw Responses reasoning is ChatGPT's. */
export const ANTHROPIC_REPLAY = "anthropic";
export const CHATGPT_REPLAY = "chatgpt";

export const GATEWAY_REASONING_PREFIX = "mgw1:";

export interface ReasoningEnvelope {
  id: string;
  enc?: string;
  /** Replay identity of the Responses upstream that minted it; absent means ChatGPT. */
  up?: string;
}

export function encodeReasoningEnvelope(envelope: ReasoningEnvelope): string {
  return GATEWAY_REASONING_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Returns null for anything that is not a well-formed gateway envelope. */
export function decodeReasoningEnvelope(signature: string): ReasoningEnvelope | null {
  if (!signature.startsWith(GATEWAY_REASONING_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(signature.slice(GATEWAY_REASONING_PREFIX.length), "base64").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const { id, enc, up } = parsed as { id?: unknown; enc?: unknown; up?: unknown };
    if (typeof id !== "string") return null;
    return {
      id,
      ...(typeof enc === "string" && enc.length > 0 ? { enc } : {}),
      ...(typeof up === "string" ? { up } : {}),
    };
  } catch {
    return null;
  }
}

// The reverse direction (P4): Anthropic thinking rides back to a Responses client as a
// `reasoning` item whose `encrypted_content` is this envelope. The request translator
// replays it as a thinking block only to the same upstream model; every other upstream
// gets it dropped (Anthropic signatures are only valid where they were minted).
export const GATEWAY_THINKING_PREFIX = "mgwa1:";

export interface ThinkingEnvelope {
  /** Upstream model that produced the block. */
  model: string;
  thinking?: string;
  signature?: string;
  /** `redacted_thinking` data, replayed verbatim. */
  redacted?: string;
  /** Replay identity of the Messages upstream that minted it; absent means Anthropic. */
  up?: string;
}

export function encodeThinkingEnvelope(envelope: ThinkingEnvelope): string {
  return GATEWAY_THINKING_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Returns null for anything that is not a well-formed gateway thinking envelope. */
export function decodeThinkingEnvelope(value: string): ThinkingEnvelope | null {
  if (!value.startsWith(GATEWAY_THINKING_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice(GATEWAY_THINKING_PREFIX.length), "base64").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const { model, thinking, signature, redacted, up } = parsed as Record<string, unknown>;
    if (typeof model !== "string") return null;
    return {
      model,
      ...(typeof up === "string" ? { up } : {}),
      ...(typeof thinking === "string" ? { thinking } : {}),
      ...(typeof signature === "string" ? { signature } : {}),
      ...(typeof redacted === "string" ? { redacted } : {}),
    };
  } catch {
    return null;
  }
}

// Same-protocol key upstreams (Kimi behind Claude Code, OpenRouter behind Codex) pass
// their thinking and reasoning straight through. On the way to the client the hub wraps
// each thinking `signature`, `redacted_thinking` `data` and reasoning `encrypted_content`
// in this envelope, so only that key ever sees them again (plan 9, P4 risks a and b).
export const GATEWAY_KEY_PREFIX = "mgwk1:";

export interface KeyEnvelope {
  up: string;
  /** The vendor's own value; null when the item carried none. */
  value: string | null;
}

export function encodeKeyEnvelope(envelope: KeyEnvelope): string {
  return GATEWAY_KEY_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export function decodeKeyEnvelope(value: string): KeyEnvelope | null {
  if (!value.startsWith(GATEWAY_KEY_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice(GATEWAY_KEY_PREFIX.length), "base64").toString("utf8"),
    );
    if (!isRec(parsed) || typeof parsed.up !== "string") return null;
    return { up: parsed.up, value: typeof parsed.value === "string" ? parsed.value : null };
  } catch {
    return null;
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** The replayable field of a thinking, redacted-thinking, signature-delta or reasoning block. */
function replayField(block: Rec): string | null {
  switch (block.type) {
    case "thinking":
    case "signature_delta":
      return "signature";
    case "redacted_thinking":
      return "data";
    case "reasoning":
      return "encrypted_content";
    default:
      return null;
  }
}

/** The value to send `target`, or null to drop the block. Unwrapped values belong to `native`. */
function replayed(value: unknown, native: string, target: string): { value: unknown } | null {
  if (typeof value === "string") {
    // Cross-vendor envelopes: only the translators replay these.
    if (value.startsWith(GATEWAY_REASONING_PREFIX) || value.startsWith(GATEWAY_THINKING_PREFIX)) return null;
    if (value.startsWith(GATEWAY_KEY_PREFIX)) {
      const envelope = decodeKeyEnvelope(value);
      return envelope?.up === target ? { value: envelope.value } : null;
    }
  }
  return native === target ? { value } : null;
}

/**
 * A same-protocol body fitted for the upstream `target` (a replay identity): thinking or
 * reasoning that `target` minted is kept (unwrapped); everything else is dropped. Messages
 * bodies lose empty assistant turns. Returns the input object when nothing changed.
 */
export function fitReplay<T>(body: T, target: string): T {
  if (!isRec(body)) return body;
  let changed = false;
  const fit = (block: unknown, native: string): unknown[] => {
    const field = isRec(block) ? replayField(block) : null;
    if (field === null || !isRec(block)) return [block];
    const kept = replayed(block[field], native, target);
    if (kept === null) {
      changed = true;
      return [];
    }
    if (kept.value === block[field]) return [block];
    changed = true;
    return [{ ...block, [field]: kept.value }];
  };
  if (Array.isArray(body.messages)) {
    const messages = body.messages.flatMap((msg) => {
      if (!isRec(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) return [msg];
      const content = msg.content.flatMap((block) => fit(block, ANTHROPIC_REPLAY));
      return content.length === 0 ? [] : [{ ...msg, content }];
    });
    return changed ? ({ ...body, messages } as T) : body;
  }
  if (Array.isArray(body.input)) {
    const input = body.input.flatMap((item) => fit(item, CHATGPT_REPLAY));
    return changed ? ({ ...body, input } as T) : body;
  }
  return body;
}

/**
 * Wraps, in place, what the key upstream `up` minted in one Messages or Responses SSE
 * event or JSON body. True when something was wrapped.
 */
export function wrapKeyOutput(json: unknown, up: string): boolean {
  if (!isRec(json)) return false;
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  let changed = false;
  for (const block of [
    json.content_block,
    json.delta,
    json.item,
    ...list(json.content),
    ...list(json.output),
    ...(isRec(json.response) ? list(json.response.output) : []),
  ]) {
    const field = isRec(block) ? replayField(block) : null;
    if (field === null || !isRec(block)) continue;
    const value = block[field];
    block[field] = encodeKeyEnvelope({ up, value: typeof value === "string" ? value : null });
    changed = true;
  }
  return changed;
}

const WRAPPABLE = /"(?:thinking|redacted_thinking|signature_delta|reasoning)"/u;

/** `wrapKeyOutput` over an SSE body. Frames with nothing to wrap pass through unchanged. */
export async function* wrapKeySse(sse: AsyncIterable<Uint8Array>, up: string): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const frame = (text: string): Uint8Array => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.startsWith("data:"));
    const line = lines[at];
    if (line !== undefined && WRAPPABLE.test(line)) {
      try {
        const json: unknown = JSON.parse(line.slice(5));
        if (wrapKeyOutput(json, up)) lines[at] = `data: ${JSON.stringify(json)}`;
      } catch {
        // Not a JSON data frame: pass it through.
      }
    }
    return encoder.encode(`${lines.join("\n")}\n\n`);
  };
  for await (const chunk of sse) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/gu, "\n");
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      yield frame(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) yield frame(buffer);
}
