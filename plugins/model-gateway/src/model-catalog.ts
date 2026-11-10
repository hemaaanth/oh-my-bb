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
  return COMPATIBLE_KEY_MODELS[bare]?.displayName ?? bare;
}

export interface CompatibleKeyModel {
  contextWindow: number;
  maxTokens: number;
  input: Array<"text" | "image">;
  /** Documented `reasoning.effort` values. Absent means the vendor accepts any. */
  reasoningEfforts?: readonly string[];
  /** Picker label; a routed model's vendor ID is too long for the harness lists. */
  displayName?: string;
}

/**
 * Models a `responses-compatible-key` serves verbatim. They stay out of
 * GATEWAY_MODELS so a route is what advertises them, not the harness catalog.
 */

export const COMPATIBLE_KEY_MODELS: Record<string, CompatibleKeyModel> = {
  // Wafer Responses is text-only; cap output conservatively within its 1M context.
  "DeepSeek-V4.1-Flash-1017": {
    contextWindow: 1048576, maxTokens: 64000, input: ["text"], displayName: "DSF4.1",
  },
  // Lyber publishes these ceilings, reasoning included.
  "deepseek-v4.1-flash-1017-abliterated": {
    contextWindow: 1048576, maxTokens: 126976, input: ["text"],
    reasoningEfforts: ["none", "low", "high", "xhigh", "max"], displayName: "DSF4.1-A",
  },
  "kimi-k31-pro-abliterated": {
    contextWindow: 1048576, maxTokens: 131072, input: ["text"],
    reasoningEfforts: ["none", "low", "high", "max"],
  },
};

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * A route's own ceiling may exclude a level the client asks for. Clamp to the
 * nearest documented level, tie upward, so agent reasoning is not silently cut.
 * Unknown models and unlisted levels pass through unchanged.
 */
export function compatibleReasoningEffort(model: string, effort: string): string {
  const allowed = COMPATIBLE_KEY_MODELS[model.replace(/^gw-/u, "")]?.reasoningEfforts;
  if (allowed === undefined || allowed.includes(effort)) return effort;
  const target = EFFORT_ORDER.indexOf(effort as (typeof EFFORT_ORDER)[number]);
  if (target < 0) return effort;
  let best = allowed[0]!;
  for (const level of allowed) {
    const distance = EFFORT_ORDER.indexOf(level as (typeof EFFORT_ORDER)[number]) - target;
    const bestDistance = EFFORT_ORDER.indexOf(best as (typeof EFFORT_ORDER)[number]) - target;
    if (Math.abs(distance) < Math.abs(bestDistance) || (Math.abs(distance) === Math.abs(bestDistance) && distance > 0))
      best = level;
  }
  return best;
}

export function gatewayModelDetails(id: string) {
  const bare = id.replace(/^gw-/u, "");
  const known = GATEWAY_MODELS[bare] ?? COMPATIBLE_KEY_MODELS[bare];
  return { id, name: modelDisplayName(id), reasoning: true, input: known?.input ?? ["text", "image"],
    contextWindow: known?.contextWindow ?? 200000, maxTokens: known?.maxTokens ?? 64000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}


/** Fast mode is available only on these Opus models. */
export function supportsClaudeFast(model: string): boolean {
  return /^claude-opus-(?:5(?:-5)?|4-8)(?:-\d{8})?$/.test(model);
}
