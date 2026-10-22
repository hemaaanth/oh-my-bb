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

/** Match picker labels while keeping transport IDs unchanged. */
export function modelDisplayName(model: string): string {
  const bare = model.replace(/^(?:model-gateway|openai-codex|openai|anthropic)\//u, "").replace(/^gw-/u, "");
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-(astra|sol|luna|terra|codex-spark))?$/u.exec(bare);
  if (gpt) return `${gpt[1]}${gpt[2] ? `-${gpt[2] === "codex-spark" ? "Spark" : gpt[2][0]!.toUpperCase() + gpt[2].slice(1)}` : ""}`;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/u.exec(bare);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return model;
}

export function gatewayModelDetails(id: string) {
  const known = GATEWAY_MODELS[id.replace(/^gw-/u, "")];
  return { id, name: modelDisplayName(id), reasoning: true, input: known?.input ?? ["text", "image"],
    contextWindow: known?.contextWindow ?? 200000, maxTokens: known?.maxTokens ?? 64000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}


/** Fast mode is available only on these Opus models. */
export function supportsClaudeFast(model: string): boolean {
  return /^claude-opus-(?:5(?:-5)?|4-8)(?:-\d{8})?$/.test(model);
}
