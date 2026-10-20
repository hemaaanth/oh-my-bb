// Reads GPT-Live data channel events into a small set of cases the call
// controller handles (SPEC §5.3, CONTRACTS §9), and builds the events it sends
// back. Parsing is tolerant: an unknown or malformed event becomes null, and a
// field the spec does not pin down is read from its likely names.

export type LiveEvent =
  | { kind: "started" }
  | { kind: "transcript"; speaker: "you" | "agent"; final: boolean; text: string; startMs: number | null; endMs: number | null }
  | { kind: "response"; active: boolean }
  | { kind: "function-call"; callId: string; name: string; args: string }
  | { kind: "usage"; seconds: number }
  | { kind: "closed"; reason: string; seconds: number | null }
  | { kind: "error"; message: string; transient: boolean };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Error codes that only mean "nothing to do", not a failed call. */
const TRANSIENT_CODES = new Set(["response_cancel_not_active", "conversation_already_has_active_response"]);

function transcript(type: string, event: Json): LiveEvent | null {
  if (!/transcript/.test(type)) return null;
  const final = /\.(done|completed)$/.test(type);
  if (!final && !type.endsWith(".delta")) return null;
  const speaker = /input/.test(type) ? "you" : "agent";
  const text = str(final ? (event.transcript ?? event.text) : (event.delta ?? event.text)) ?? "";
  return { kind: "transcript", speaker, final, text, startMs: num(event.start_ms), endMs: num(event.end_ms) };
}

function functionCall(event: Json): LiveEvent | null {
  const item = event.item;
  if (!isObject(item) || item.type !== "function_call") return null;
  const name = str(item.name);
  const callId = str(item.call_id) ?? str(item.id);
  if (!name || !callId) return null;
  const args = item.arguments;
  return { kind: "function-call", callId, name, args: typeof args === "string" ? args : JSON.stringify(args ?? {}) };
}

function responseEvent(type: string, event: Json): LiveEvent | null {
  if (type === "response.output_item.done") return functionCall(event);
  if (type === "response.created") return { kind: "response", active: true };
  if (type === "response.done" || type === "response.completed" || type === "response.cancelled") return { kind: "response", active: false };
  return null;
}

export function parseLiveEvent(raw: unknown): LiveEvent | null {
  let event: unknown = raw;
  if (typeof raw === "string") {
    try {
      event = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObject(event)) return null;
  const type = str(event.type);
  if (!type) return null;

  if (type === "session.started") return { kind: "started" };
  if (type === "response.event") {
    // The delegated response's own events arrive wrapped.
    const inner = event.event;
    return isObject(inner) && typeof inner.type === "string" ? responseEvent(inner.type, inner) : null;
  }
  const fromResponse = responseEvent(type, event);
  if (fromResponse) return fromResponse;
  if (type === "session.usage.updated") {
    const usage = isObject(event.usage) ? event.usage : event;
    const seconds = num(usage.seconds) ?? num(usage.total_seconds) ?? num(usage.audio_seconds);
    return seconds === null ? null : { kind: "usage", seconds };
  }
  if (type === "session.closed") {
    const usage = isObject(event.usage) ? event.usage : event;
    return { kind: "closed", reason: str(event.reason) ?? "closed", seconds: num(usage.seconds) };
  }
  if (type === "error") {
    const error = isObject(event.error) ? event.error : event;
    const code = str(error.code);
    return {
      kind: "error",
      message: str(error.message) ?? code ?? "The voice session reported an error.",
      transient: error.transient === true || (code !== null && TRANSIENT_CODES.has(code)),
    };
  }
  return transcript(type, event);
}

/** The output of one function call. */
export const functionOutputEvent = (callId: string, output: string) => ({
  type: "response.item.create",
  item: { type: "function_call_output", call_id: callId, output },
});

/** Ask the model to go on, once per batch of function calls. */
export const continueEvent = () => ({ type: "response.create" });

/** Out-of-band text the model reads as a system notice (SPEC §15). */
export const noticeEvent = (text: string) => ({
  type: "response.item.create",
  item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
});
