import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AI_BACKENDS, GATEWAY_MODELS } from "./shared";

// One seam for every Journal model call. OpenRouter is the paid API-key backend;
// "subscription" goes only through the Model Gateway plugin's inference RPC, which
// uses ChatGPT subscription accounts and never falls back to paid keys.
export type AiBackend = typeof AI_BACKENDS[number];
export const GATEWAY_PLUGIN_ID = "model-gateway";
export type GatewayModel = typeof GATEWAY_MODELS[number];
const GATEWAY_STATUS_TIMEOUT_MS = 3_000;
const OPENROUTER_TIMEOUT_MS = 20_000;
export const GATEWAY_INPUT_CHARS = 64_000;
export const GATEWAY_REQUEST_BYTES = 128 * 1024;

export const gatewayStatusSchema = z.object({
  available: z.boolean(), models: z.array(z.string()), usableAccounts: z.number().int(), inFlight: z.number().int(),
  maxConcurrent: z.number().int(), retryAt: z.number().int().nullable(), reason: z.string().nullable(),
});
export const gatewayCompleteSchema = z.discriminatedUnion("ok", [
  // billing must be "subscription": any other answer fails validation and is treated as unavailable.
  z.object({ ok: z.literal(true), text: z.string(), model: z.string(), billing: z.literal("subscription"),
    usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).nullable() }),
  z.object({ ok: z.literal(false), code: z.enum(["forbidden", "unavailable", "rate_limited", "timeout", "upstream_error", "invalid_output", "stopped", "busy"]),
    message: z.string(), retryAt: z.number().int().nullable() }),
]);

/** The backend cannot serve requests right now. Callers keep cached results and retry later. */
export class AiUnavailableError extends Error {
  constructor(message: string, readonly retryAt: number | null = null) { super(message); }
}

export type JsonSchemaFormat = { name: string; schema: { [key: string]: JsonValue } };
export type AiRequest = { system: string; input: string; schema: JsonSchemaFormat; maxTokens: number; timeoutMs?: number };
export type AiResult =
  | { billing: "openrouter"; text: string; model: string; usage: unknown }
  | { billing: "subscription"; text: string; model: string; usage: { inputTokens: number; outputTokens: number } | null };
type Plugins = Pick<BbPluginApi["sdk"]["plugins"], "callRpc">;

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const clip = (value: string, max: number) => { const clean = value.replace(/\s+/gu, " ").trim(); return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`; };

export async function completeWithGateway(plugins: Plugins, model: GatewayModel, request: AiRequest): Promise<AiResult> {
  const timeoutMs = request.timeoutMs ?? 30_000;
  const controller = new AbortController();
  // The gateway enforces timeoutMs; the extra 5 s only covers a gateway that never answers.
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000);
  let result: z.infer<typeof gatewayCompleteSchema>;
  // Facts are trimmed to valid JSON by Journal. For plain-text briefing input, keep its opening
  // and its newest tail when a byte-heavy transcript needs a final cut. Never send invalid JSON facts.
  let input = request.input;
  const marker = "\n[older middle content omitted to fit gateway limits]\n";
  const fits = (text: string) => text.length <= GATEWAY_INPUT_CHARS
    && Buffer.byteLength(JSON.stringify([request.system, text, request.schema]), "utf8") <= GATEWAY_REQUEST_BYTES;
  if (!fits(input)) {
    if (request.schema.name !== "thread_brief") throw new AiUnavailableError("Journal facts exceed the Model Gateway request limit");
    let budget = Math.min(input.length, GATEWAY_INPUT_CHARS - marker.length);
    while (budget > 0) {
      const first = Math.floor(budget * 0.3); const last = budget - first;
      const candidate = `${input.slice(0, first)}${marker}${input.slice(-last)}`;
      if (fits(candidate)) { input = candidate; break; }
      budget = Math.floor(budget * 0.9);
    }
    if (!fits(input)) throw new AiUnavailableError("Thread briefing exceeds the Model Gateway request limit");
  }
  try {
    result = await plugins.callRpc({
      pluginId: GATEWAY_PLUGIN_ID, method: "inference.complete", signal: controller.signal, outputSchema: gatewayCompleteSchema,
      input: { system: request.system, input, model, schema: request.schema, timeoutMs },
    });
  } catch (cause) {
    throw new AiUnavailableError(`Model Gateway request failed: ${clip(errorText(cause), 240)}`);
  } finally { clearTimeout(timer); }
  if (result.ok) return { billing: "subscription", text: result.text, model: result.model, usage: result.usage };
  const message = `Model Gateway ${result.code}: ${clip(result.message, 240)}`;
  if (result.code === "invalid_output") throw new Error(message);
  throw new AiUnavailableError(message, result.retryAt);
}

export async function completeWithOpenRouter(apiKey: string, model: string, request: AiRequest): Promise<AiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "BB Journal" },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: request.maxTokens,
        provider: { require_parameters: true, allow_fallbacks: true },
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.input }],
        response_format: { type: "json_schema", json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema } },
      }),
    }).catch((cause: unknown) => { throw new AiUnavailableError(`OpenRouter request failed: ${errorText(cause)}`); });
    if (!response.ok) throw new AiUnavailableError(`OpenRouter returned ${response.status}: ${clip(await response.text(), 240)}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string | null } }>; usage?: unknown };
    return { billing: "openrouter", text: body.choices?.[0]?.message?.content ?? "", model, usage: body.usage };
  } finally { clearTimeout(timer); }
}

export type AiAvailability = { available: boolean; reason: string | null; retryAt: number | null };

/** Gateway readiness without a model call. Never throws. */
export async function gatewayAvailability(plugins: Plugins): Promise<AiAvailability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_STATUS_TIMEOUT_MS);
  try {
    const status = await plugins.callRpc({ pluginId: GATEWAY_PLUGIN_ID, method: "inference.status", input: null, signal: controller.signal, outputSchema: gatewayStatusSchema });
    return { available: status.available, reason: status.reason, retryAt: status.retryAt };
  } catch (cause) {
    return { available: false, reason: `Model Gateway did not answer: ${clip(errorText(cause), 200)}`, retryAt: null };
  } finally { clearTimeout(timer); }
}
