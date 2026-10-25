import { isRecord } from "./chain.js";

export const MAX_PRELUDE_BYTES = 64 * 1024;
export const PRELUDE_TIMEOUT_MS = 10_000;

type Decision = "prelude" | "commit" | "success" | "capacity";

/** Only explicit terminal capacity signals authorize replay. Unknown events commit. */
function decide(frame: string): Decision {
  const lines = frame.split(/\r\n|\r|\n/u);
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data) return lines.every((line) => !line || line.startsWith(":")) ? "prelude" : "commit";
  let event: unknown;
  try { event = JSON.parse(data); } catch { return "commit"; }
  if (!isRecord(event)) return "commit";
  const type = event.type ?? lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const response = isRecord(event.response) ? event.response : null;
  // Even lifecycle/terminal frames can contain output. Never replay that output.
  if (response && Array.isArray(response.output) && response.output.length > 0) return "success";
  if (type === "response.failed" || type === "error" || type === "response.error") {
    const error = response?.error ?? event.error ?? event;
    if (!isRecord(error)) return "commit";
    const codes = [error.code, error.type, error.providerCode].filter((code): code is string => typeof code === "string")
      .map((code) => code.replace(/[^a-z0-9]/giu, "").toLowerCase());
    // Auth, quota and credit errors must never open a model-wide circuit.
    if (codes.some((code) => /auth|permission|quota|credit|billing|ratelimit/u.test(code))) return "commit";
    if (codes.some((code) => ["serveroverloaded", "modelatcapacity", "overloaded", "overloadederror"].includes(code))) return "capacity";
    if (typeof error.message === "string" && /^(?:selected |the selected |the )?model is (?:currently )?at capacity[.!]?$/iu.test(error.message.trim())) return "capacity";
    return "commit";
  }
  if (type === "response.created" || type === "response.in_progress") return "prelude";
  return typeof type === "string" && (type === "response.completed" || /^response\.(?:output|reasoning|content_part|function_call|custom_tool_call)/u.test(type)) ? "success" : "commit";
}

export type PreludeResult =
  | { kind: "committed"; response: Response; success: boolean }
  | { kind: "capacity" | "unavailable" };

/** Pull only until the first meaningful frame. The deadline is a bound, never a delay. */
export async function gateResponsesPrelude(response: Response, signal: AbortSignal): Promise<PreludeResult> {
  if (!response.ok || response.body === null || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
    return { kind: "committed", response, success: response.ok };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = () => {};
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Responses prelude timed out")), PRELUDE_TIMEOUT_MS);
    aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
  let committed = false;
  const commit = (success: boolean): PreludeResult => {
    committed = true;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < chunks.length) { controller.enqueue(chunks[index++]!); return; }
        chunks.length = 0;
        index = 0;
        try {
          const part = await reader.read();
          if (part.done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(part.value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { void reader.cancel(reason).catch(() => undefined); },
    });
    return { kind: "committed", response: new Response(body, response), success };
  };
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) return commit(false);
      if (part.value.byteLength === 0) continue;
      chunks.push(part.value);
      const remaining = MAX_PRELUDE_BYTES - bytes;
      pending += decoder.decode(part.value.subarray(0, remaining), { stream: true });
      bytes += part.value.byteLength;
      // Preserve raw bytes; the text copy is only for bounded classification.
      let match: RegExpExecArray | null;
      while ((match = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/u.exec(pending)) !== null) {
        const decision = decide(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
        if (decision === "capacity") return { kind: "capacity" };
        if (decision !== "prelude") return commit(decision === "success");
      }
      // Fail open at the byte bound: from here on this stream can never replay.
      if (bytes >= MAX_PRELUDE_BYTES) return commit(false);
    }
  } catch {
    signal.throwIfAborted();
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
    if (!committed) void reader.cancel().catch(() => undefined);
  }
}
