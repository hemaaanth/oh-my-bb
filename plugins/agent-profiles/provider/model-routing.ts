type PiModel = { provider: string; id: string };

export function isCodexPiModel(model: { provider?: string; id?: string }): boolean {
  return typeof model.id === "string" && model.id.length > 0 && (model.provider === "openai-codex"
    || (model.provider === "model-gateway" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(model.id)));
}

export function requireCodexModel(model: { provider?: string; id?: string }): void {
  if (!isCodexPiModel(model)) {
    throw new Error("Hempi requires a registered Model Gateway model or an openai-codex model.");
  }
}

export function piModelProvider(env: Readonly<Record<string, string | undefined>>): "openai-codex" | "model-gateway" {
  return env.MODEL_GATEWAY_BASE_URL ? "model-gateway" : "openai-codex";
}

export function routePiModel(model: PiModel, env: Readonly<Record<string, string | undefined>>): PiModel {
  requireCodexModel(model);
  if (!env.MODEL_GATEWAY_BASE_URL || !env.MODEL_GATEWAY_TOKEN)
    throw new Error("Model Gateway is required for Hempi turns. Check gateway setup on this host.");
  return { provider: "model-gateway", id: model.id };
}
