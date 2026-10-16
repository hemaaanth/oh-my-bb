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
