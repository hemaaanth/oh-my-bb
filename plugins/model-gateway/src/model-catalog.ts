// Codex catalog snapshot: Pi's cached openai-codex catalog, 2026-10-16.
// Keep model discovery and context admission consistent across Pi and OMP.
export const CODEX_MODELS: Record<string, { contextWindow: number; maxTokens: number; input?: Array<"text" | "image"> }> = {
  "gpt-5.3-codex-spark": { contextWindow: 128000, maxTokens: 128000, input: ["text"] },
  "gpt-5.5": { contextWindow: 272000, maxTokens: 128000 },
  "gpt-5.6-luna": { contextWindow: 272000, maxTokens: 128000 },
  "gpt-5.6-sol": { contextWindow: 272000, maxTokens: 128000 },
  "gpt-5.6-terra": { contextWindow: 272000, maxTokens: 128000 },
  "gpt-6-astra": { contextWindow: 272000, maxTokens: 128000 },
  "gpt-6-luna": { contextWindow: 272000, maxTokens: 128000 },
  "gpt-6-sol": { contextWindow: 272000, maxTokens: 128000 },
  "gpt-6.1-sol": { contextWindow: 500000, maxTokens: 128000 },
};

// Installed Pi Anthropic catalog snapshot, 2026-10-21.
export const CLAUDE_MODELS: typeof CODEX_MODELS = {
  "claude-opus-5": { contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-5-5": { contextWindow: 1000000, maxTokens: 128000 },
  "claude-fable-5-1": { contextWindow: 1000000, maxTokens: 128000 },
  "claude-sonnet-5-5": { contextWindow: 1000000, maxTokens: 128000 },
};
export const GATEWAY_MODELS = { ...CODEX_MODELS, ...CLAUDE_MODELS };

export function gatewayModelDetails(id: string) {
  const known = GATEWAY_MODELS[id.replace(/^gw-/u, "")];
  return { id, name: id, reasoning: true, input: known?.input ?? ["text", "image"],
    contextWindow: known?.contextWindow ?? 200000, maxTokens: known?.maxTokens ?? 64000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
