import { afterEach, describe, expect, it, vi } from "vitest";
import { gateResponsesPrelude, MAX_PRELUDE_BYTES, PRELUDE_TIMEOUT_MS } from "./responses-prelude.js";
import { CapacityCircuits } from "./capacity.js";

const encoder = new TextEncoder();
const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
const created = frame({ type: "response.created", response: { output: [] } });
const failed = frame({ type: "response.failed", response: { error: { code: "serverOverloaded", message: "Selected model is at capacity" } } });
const sse = (body: string | ReadableStream<Uint8Array>) => new Response(body, { headers: { "content-type": "text/event-stream" } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Responses prelude", () => {
  it("commits healthy fragmented UTF-8/CRLF frames without advancing a timer and preserves raw order", async () => {
    vi.useFakeTimers();
    const raw = encoder.encode((created + frame({ type: "response.in_progress" }) + frame({ type: "response.output_text.delta", delta: "héllo" }) + failed).replace(/\n/gu, "\r\n"));
    let finished = false;
    const response = sse(new ReadableStream({
      start(controller) {
        for (const byte of raw) controller.enqueue(new Uint8Array([byte]));
        // Remain open: the gate must return before EOF or a timeout.
        finished = false;
      },
      cancel() { finished = true; },
    }));
    const result = await gateResponsesPrelude(response, new AbortController().signal);
    expect(result.kind).toBe("committed");
    expect(finished).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    if (result.kind !== "committed") throw new Error("Not committed");
    const reader = result.response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (bytes < raw.byteLength) { const part = await reader.read(); chunks.push(part.value!); bytes += part.value!.length; }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(raw));
    await reader.cancel();
    expect(finished).toBe(true);
  });

  it.each(["serverOverloaded", "server_overloaded", "model_at_capacity", "overloaded_error"])("rejects early terminal capacity %s", async (code) => {
    const response = sse(created + frame({ type: "error", error: { code } }));
    expect(await gateResponsesPrelude(response, new AbortController().signal)).toEqual({ kind: "capacity" });
  });

  it.each([
    { type: "response.output_text.delta", delta: "hello" },
    { type: "response.reasoning_text.delta", delta: "thinking" },
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.output_item.added", item: { type: "reasoning" } },
    { type: "response.output_item.added", item: { type: "message" } },
    { type: "response.output_item.added", item: { type: "function_call" } },
    { type: "response.output_item.added", item: { type: "custom_tool_call" } },
    { type: "response.function_call_arguments.delta", delta: "{" },
    { type: "response.custom_tool_call_input.delta", delta: "patch" },
    { type: "response.content_part.added", part: { type: "output_text" } },
    { type: "response.created", response: { output: [{ type: "function_call" }] } },
    { type: "response.future_event", payload: "unknown" },
  ])("never replays after $type", async (event) => {
    const raw = created + frame(event) + failed;
    const result = await gateResponsesPrelude(sse(raw), new AbortController().signal);
    expect(result.kind).toBe("committed");
    if (result.kind === "committed") expect(await result.response.text()).toBe(raw);
  });

  it.each(["invalid_api_key", "insufficient_quota", "rate_limit_error", "billing_error", "server_error"])("does not open a capacity circuit for %s", async (code) => {
    const raw = created + frame({ type: "response.failed", response: { error: { code, message: "unrelated error" } } });
    const result = await gateResponsesPrelude(sse(raw), new AbortController().signal);
    expect(result.kind).toBe("committed");
    if (result.kind === "committed") expect(await result.response.text()).toBe(raw);
  });

  it("bounds bytes even without a frame boundary, then commits permanently", async () => {
    const raw = ":" + "x".repeat(MAX_PRELUDE_BYTES) + "\n\n" + failed;
    const result = await gateResponsesPrelude(sse(raw), new AbortController().signal);
    expect(result.kind).toBe("committed");
    if (result.kind === "committed") expect(await result.response.text()).toBe(raw);
  });

  it("bounds a stalled prelude and a nonsettling cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pending = gateResponsesPrelude(sse(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(created)); }, cancel,
    })), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(PRELUDE_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending read without waiting for the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pending = gateResponsesPrelude(sse(new ReadableStream({ cancel })), controller.signal);
    const rejected = expect(pending).rejects.toThrow("stop");
    controller.abort(new Error("stop"));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("capacity circuits", () => {
  it("backs off independently by provider and model, caps jitter at five minutes, and clears on success", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const circuits = new CapacityCircuits();
    let now = 1000;
    for (const delay of [31_500, 63_000, 126_000, 252_000, 300_000, 300_000]) {
      const state = circuits.fail("chatgpt", "gpt-6-sol", now);
      expect(state.retryAt - now).toBe(delay);
      now = state.retryAt + 1;
    }
    expect(circuits.get("chatgpt", "other")).toBeUndefined();
    expect(circuits.get("other", "gpt-6-sol")).toBeUndefined();
    circuits.clear("chatgpt", "gpt-6-sol");
    expect(circuits.fail("chatgpt", "gpt-6-sol", now).failures).toBe(1);
  });
});
