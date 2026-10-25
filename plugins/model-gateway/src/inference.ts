// Subscription-only background inference for other plugins (Journal). One
// thread-free Responses call on the ChatGPT OAuth pool: no API keys, chains,
// model routes, auto pick, priority tier or thread route.
import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isRecord } from "./chain.js";
import type { AccountPoolHub } from "./hub.js";

// A Set, not a Record: pluginId is caller-supplied and must not hit prototype keys.
export const INFERENCE_CALLERS: ReadonlySet<string> = new Set(["journal"]);
export const INFERENCE_MODELS = ["gpt-6-luna", "gpt-5.6-luna"] as const;
export const INFERENCE_MAX_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_MESSAGE_CHARS = 300;
const BUSY_RETRY_MS = 2_000;
const STOPPED_RETRY_MS = 5_000;

export const inferenceCompleteInputSchema = z
  .object({
    system: z.string().min(1).max(16_000),
    input: z.string().min(1).max(64_000),
    model: z.enum(INFERENCE_MODELS).optional(),
    schema: z
      .object({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
        schema: z.record(z.string(), z.unknown()),
      })
      .strict()
      .refine((value) => Buffer.byteLength(JSON.stringify(value.schema), "utf8") <= MAX_SCHEMA_BYTES, {
        message: `schema.schema must be at most ${MAX_SCHEMA_BYTES} bytes of JSON.`,
      })
      .optional(),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  })
  .strict()
  // Each field is capped; this also caps their sum after JSON escaping.
  .refine(
    (value) => Buffer.byteLength(JSON.stringify([value.system, value.input, value.schema ?? null]), "utf8") <= MAX_REQUEST_BYTES,
    { message: `system, input and schema must total at most ${MAX_REQUEST_BYTES} bytes of JSON.` },
  );

const inferenceCodeSchema = z.enum([
  "forbidden",
  "unavailable",
  "rate_limited",
  "busy",
  "timeout",
  "stopped",
  "upstream_error",
  "invalid_output",
]);

export const inferenceCompleteOutputSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      text: z.string(),
      model: z.enum(INFERENCE_MODELS),
      billing: z.literal("subscription"),
      usage: z
        .object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: inferenceCodeSchema,
      message: z.string().max(MAX_MESSAGE_CHARS),
      retryAt: z.number().int().nullable(),
    })
    .strict(),
]);

export const inferenceStatusOutputSchema = z
  .object({
    available: z.boolean(),
    models: z.array(z.enum(INFERENCE_MODELS)),
    usableAccounts: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    maxConcurrent: z.number().int().positive(),
    retryAt: z.number().int().nullable(),
    reason: z.string().nullable(),
  })
  .strict();

export type InferenceCompleteInput = z.infer<typeof inferenceCompleteInputSchema>;
export type InferenceCompleteOutput = z.infer<typeof inferenceCompleteOutputSchema>;
type InferenceCode = z.infer<typeof inferenceCodeSchema>;

const FORBIDDEN_MESSAGE = "Background inference is limited to the Journal plugin.";
const NO_ACCOUNT_MESSAGE = "No enabled ChatGPT subscription account. Add one with `bb gateway account add`.";

function failure(code: InferenceCode, message: string, retryAt: number | null = null): InferenceCompleteOutput {
  return { ok: false, code, message: message.slice(0, MAX_MESSAGE_CHARS), retryAt };
}

function allowed(context: ExperimentalPluginRpcHandlerContext | undefined): boolean {
  const caller = context?.experimental_caller;
  return caller?.kind === "plugin" && INFERENCE_CALLERS.has(caller.pluginId);
}

/** The Responses body the ChatGPT Codex backend takes: no output limit or sampling fields. */
export function backgroundRequestBody(input: InferenceCompleteInput, model: string): Record<string, unknown> {
  return {
    model,
    instructions: input.system,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input.input }] }],
    stream: true,
    store: false,
    reasoning: { effort: "low" },
    ...(input.schema === undefined
      ? {}
      : { text: { format: { type: "json_schema", name: input.schema.name, schema: input.schema.schema, strict: true } } }),
  };
}

type Parsed =
  | { kind: "text"; text: string; usage: { inputTokens: number; outputTokens: number } | null }
  | { kind: "error"; code: InferenceCode; message: string };

function outputText(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  let text = "";
  let found = false;
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        text += part.text;
        found = true;
      }
    }
  }
  return found ? text : null;
}

function usageOf(response: Record<string, unknown>) {
  const usage = response.usage;
  if (!isRecord(usage)) return null;
  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage;
  return Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) &&
    (inputTokens as number) >= 0 && (outputTokens as number) >= 0
    ? { inputTokens: inputTokens as number, outputTokens: outputTokens as number }
    : null;
}

/**
 * Reads at most MAX_STREAM_BYTES of a Responses SSE stream. Text comes from
 * the terminal response, else finished output items, else text deltas: the
 * ChatGPT backend may send `response.completed` with an empty output list.
 */
export async function parseResponsesStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Parsed> {
  const reader = body.getReader();
  // Cancelling ends a pending read even when the body ignores its own abort.
  const cancel = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  // A CR at a chunk end may pair with an LF in the next chunk.
  let pendingCr = false;
  const items: unknown[] = [];
  let deltas = "";
  let terminal: Record<string, unknown> | null = null;
  let streamError: string | null = null;
  const frame = (raw: string) => {
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data === "" || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === "response.output_item.done") items.push(event.item);
    else if (event.type === "response.output_text.delta" && typeof event.delta === "string") deltas += event.delta;
    else if (
      (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") &&
      isRecord(event.response)
    )
      terminal = event.response;
    else if (event.type === "error") streamError = "ChatGPT stream reported an error.";
  };
  try {
    while (terminal === null) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES)
        return { kind: "error", code: "invalid_output", message: "ChatGPT response exceeded the background inference size limit." };
      let text: string = (pendingCr ? "\r" : "") + decoder.decode(chunk.value, { stream: true });
      pendingCr = text.endsWith("\r");
      if (pendingCr) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/gu, "\n");
      let end = buffer.indexOf("\n\n");
      while (end >= 0 && terminal === null) {
        frame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
      }
    }
    if (terminal === null) {
      buffer += (pendingCr ? "\n" : "") + decoder.decode();
      if (buffer.trim() !== "") frame(buffer);
    }
  } catch {
    // A read failed (aborted or broken stream): judged below by what arrived.
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
  }
  const response = terminal as Record<string, unknown> | null;
  if (response === null)
    return { kind: "error", code: "upstream_error", message: streamError ?? "ChatGPT ended the response without completing it." };
  if (response.status !== "completed")
    return {
      kind: "error",
      code: response.status === "incomplete" ? "invalid_output" : "upstream_error",
      message: `ChatGPT response ${typeof response.status === "string" ? response.status.slice(0, 32) : "failed"}.`,
    };
  const text = outputText(response.output) ?? outputText(items) ?? (deltas === "" ? null : deltas);
  if (text === null) return { kind: "error", code: "invalid_output", message: "ChatGPT returned no output text." };
  if (text.length > MAX_TEXT_CHARS)
    return { kind: "error", code: "invalid_output", message: `ChatGPT output exceeded ${MAX_TEXT_CHARS} characters.` };
  return { kind: "text", text, usage: usageOf(response) };
}

/** At most 2 KiB of an error body; the upstream `error.message` only, never raw text. */
async function errorDetail(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 2_048) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const message = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.message : isRecord(parsed) ? parsed.detail : null;
    if (typeof message === "string") return ` ${message.replace(/\s+/gu, " ").slice(0, 200)}`;
  } catch {
    // Not JSON, or cut off: say nothing more than the status.
  }
  return "";
}

function retryAtFrom(retryAfter: string | null, now: number): number | null {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? now + Math.ceil(seconds) * 1_000 : null;
}

export function createInferenceHandlers(hub: AccountPoolHub, now: () => number) {
  let inFlight = 0;

  async function complete(input: InferenceCompleteInput): Promise<InferenceCompleteOutput> {
    const model = input.model ?? INFERENCE_MODELS[0];
    const body = new TextEncoder().encode(JSON.stringify(backgroundRequestBody(input, model)));
    if (!hub.acceptingRequests) return failure("stopped", "Model Gateway is not accepting requests.", now() + STOPPED_RETRY_MS);
    if (inFlight >= INFERENCE_MAX_CONCURRENT)
      return failure("busy", "Background inference is at its concurrency limit.", now() + BUSY_RETRY_MS);
    // Count before the first await so concurrent calls cannot pass the limit together.
    inFlight += 1;
    const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const readiness = await hub.backgroundReadiness();
      if (readiness.configured === 0) return failure("unavailable", NO_ACCOUNT_MESSAGE);
      if (readiness.ready.length === 0)
        return readiness.retryAt === null
          ? failure("unavailable", "No ChatGPT subscription account can serve now.")
          : failure("rate_limited", "Every ChatGPT subscription account is rate limited.", readiness.retryAt);
      const result = await hub.backgroundResponses(model, body, timeout);
      if (result.kind === "aborted") return failure("timeout", "Background inference timed out.");
      if (result.kind === "stopped") return failure("stopped", "Model Gateway stopped.", now() + STOPPED_RETRY_MS);
      if (result.kind === "none") return failure("unavailable", "No ChatGPT subscription account can serve now.");
      if (result.kind === "failed") {
        const retryAt = retryAtFrom(result.retryAfter, now());
        if (result.status === 429) return failure("rate_limited", "ChatGPT subscription is rate limited.", retryAt);
        if (result.status === 401 || result.status === 403)
          return failure("unavailable", "ChatGPT subscription sign-in was rejected.");
        return failure("upstream_error", `ChatGPT request failed (HTTP ${result.status}).`, retryAt);
      }
      const { response } = result;
      if (!response.ok) {
        const detail = await errorDetail(response);
        return failure("upstream_error", `ChatGPT returned HTTP ${response.status}.${detail}`);
      }
      if (response.body === null) return failure("upstream_error", "ChatGPT returned an empty response.");
      const parsed = await parseResponsesStream(response.body, AbortSignal.any([timeout, hub.stoppedSignal]));
      if (timeout.aborted) return failure("timeout", "Background inference timed out.");
      if (!hub.acceptingRequests && parsed.kind === "error")
        return failure("stopped", "Model Gateway stopped.", now() + STOPPED_RETRY_MS);
      if (parsed.kind === "error") return failure(parsed.code, parsed.message);
      return { ok: true, text: parsed.text, model, billing: "subscription", usage: parsed.usage };
    } catch {
      if (timeout.aborted) return failure("timeout", "Background inference timed out.");
      if (!hub.acceptingRequests) return failure("stopped", "Model Gateway stopped.", now() + STOPPED_RETRY_MS);
      // Never forward raw errors: they may name accounts or carry upstream text.
      return failure("upstream_error", "Background inference failed.");
    } finally {
      inFlight -= 1;
    }
  }

  return {
    "inference.complete": (input: InferenceCompleteInput, context?: ExperimentalPluginRpcHandlerContext) =>
      allowed(context) ? complete(input) : failure("forbidden", FORBIDDEN_MESSAGE),
    "inference.status": async (_input: null, context?: ExperimentalPluginRpcHandlerContext) => {
      const base = { models: [...INFERENCE_MODELS], inFlight, maxConcurrent: INFERENCE_MAX_CONCURRENT };
      if (!allowed(context))
        return { ...base, available: false, usableAccounts: 0, retryAt: null, reason: FORBIDDEN_MESSAGE };
      const readiness = await hub.backgroundReadiness();
      const reason = !readiness.accepting
        ? "Model Gateway is not accepting requests."
        : readiness.configured === 0
          ? NO_ACCOUNT_MESSAGE
          : readiness.ready.length === 0
            ? "Every ChatGPT subscription account is rate limited or unavailable."
            : null;
      return {
        ...base,
        available: reason === null,
        usableAccounts: readiness.ready.length,
        retryAt: readiness.retryAt,
        reason,
      };
    },
  };
}
