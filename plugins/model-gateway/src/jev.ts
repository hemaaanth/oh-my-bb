// Jev automatic model choice (plan WP5.1). Prompt wording and the 0.6 confidence
// floor adapted from soumyacodes007/model_router src/core/tier-catalog.mjs (MIT,
// (c) 2026 Flavius Pop and Jev Router contributors). See THIRD_PARTY.md.
//
// Jev sees only the truncated last user message and the candidate model names.
// It never blocks a turn: any error, a low confidence, or no answer within the
// deadline fails open (the hub keeps the client's model and the chain's order).
import { isRecord } from "./chain.js";

export const JEV_TIMEOUT_MS = 2_000;
export const JEV_MIN_CONFIDENCE = 0.6;
const MAX_PROMPT_CHARS = 4_000;

export interface JevPick {
  /** The chosen candidate, or null to fail open. */
  model: string | null;
  /** Shown in `bb gateway status --thread`, e.g. `jev 0.82` or `fail open: timeout`. */
  reason: string;
}

/** The last user message's text (Messages or Responses body), truncated. */
export function lastUserText(body: unknown): string {
  if (!isRecord(body)) return "";
  const text = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (part) =>
                isRecord(part) &&
                (part.type === "text" || part.type === "input_text") &&
                typeof part.text === "string",
            )
            .map((part) => (part as { text: string }).text)
            .join("\n")
        : "";
  const items: unknown[] =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : Array.isArray(body.messages)
        ? body.messages
        : Array.isArray(body.input)
          ? body.input
          : [];
  const last = items.filter((item) => isRecord(item) && item.role === "user").at(-1);
  return isRecord(last) ? text(last.content).slice(0, MAX_PROMPT_CHARS) : "";
}

/** Asks Jev (OpenRouter chat completions) which candidate fits the prompt. Never throws. */
export async function askJev(options: {
  fetch: typeof fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** Cheapest first. */
  candidates: readonly string[];
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<JevPick> {
  const { candidates } = options;
  const deadline = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await options.fetch(
      `${options.baseUrl.replace(/\/+$/u, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          max_tokens: 64,
          messages: [
            {
              role: "system",
              content: [
                "Pick the cheapest model that can fully complete this coding request in one pass, without a retry on a stronger model.",
                "Judge the reasoning the request demands, not the length of the reply it asks for.",
                `Candidates, cheapest first: ${candidates.join(", ")}.`,
                'Answer with JSON only: {"choice": "<candidate>", "confidence": <0 to 1>}.',
              ].join("\n"),
            },
            { role: "user", content: options.prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "model_choice",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  choice: { type: "string", enum: candidates },
                  confidence: { type: "number" },
                },
                required: ["choice", "confidence"],
                additionalProperties: false,
              },
            },
          },
        }),
        signal: AbortSignal.any([options.signal, deadline]),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { model: null, reason: `fail open: HTTP ${response.status}` };
    }
    const reply: unknown = await response.json();
    const choices = isRecord(reply) && Array.isArray(reply.choices) ? reply.choices : [];
    const message = isRecord(choices[0]) ? choices[0].message : null;
    const content = isRecord(message) && typeof message.content === "string" ? message.content : "";
    const answer: unknown = JSON.parse(/\{[\s\S]*\}/u.exec(content)?.[0] ?? "null");
    const choice = isRecord(answer) ? answer.choice : null;
    const confidence = isRecord(answer) ? answer.confidence : null;
    if (typeof choice !== "string" || !candidates.includes(choice) || typeof confidence !== "number")
      return { model: null, reason: "fail open: unreadable answer" };
    if (confidence < JEV_MIN_CONFIDENCE)
      return { model: null, reason: `fail open: low confidence ${confidence.toFixed(2)}` };
    return { model: choice, reason: `jev ${confidence.toFixed(2)}` };
  } catch {
    return {
      model: null,
      reason: deadline.aborted ? "fail open: timeout" : "fail open: error",
    };
  }
}
