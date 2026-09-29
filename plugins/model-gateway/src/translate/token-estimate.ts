// Adapted from opencodex src/lib/token-estimate.ts (MIT, (c) 2026 opencodex contributors). See THIRD_PARTY.md.
//
// Local answer for `/v1/messages/count_tokens` when the active upstream is not
// Anthropic (Claude Code calls it from `/context` with {model, messages, tools}).
// A heuristic: over-counting is the safe direction (compaction starts earlier).

// Code and JSON, which dominate agent traffic, run near 3.5 chars per token; Hangul,
// Han and kana run near 1.5, so the two scripts are counted apart.
const LATIN_CHARS_PER_TOKEN = 3.5;
const CJK_CHARS_PER_TOKEN = 1.5;
// Images and documents: a flat cost instead of counting their base64 payload as text.
const MEDIA_TOKENS = 1600;

function countCjk(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)
      || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
  }
  return cjk;
}

/** Estimated input tokens for an Anthropic Messages (or count_tokens) body. */
export function estimateTokens(body: unknown): number {
  let media = 0;
  // Serialize everything except base64 payloads; each media block costs a flat amount.
  const text = JSON.stringify(body ?? {}, (key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const rec = value as Record<string, unknown>;
      if ((rec.type === "image" || rec.type === "document") && typeof rec.source === "object") {
        media++;
        return { type: rec.type };
      }
    }
    return value;
  });
  const cjk = countCjk(text);
  return Math.ceil((text.length - cjk) / LATIN_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN) + media * MEDIA_TOKENS;
}
