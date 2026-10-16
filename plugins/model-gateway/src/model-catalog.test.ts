import { describe, expect, it } from "vitest";
import { contextWindow, gatewayModels, ompModels, DEFAULT_MODEL_MAP } from "./chain.js";
import { piExtension } from "./setup.js";

describe("Codex discovery", () => {
  it("loads the Pi extension with current tier models and accurate limits, independent of model-map targets", async () => {
    const map = { "chatgpt-oauth": { "custom-alias": "custom-target" } };
    const source = piExtension(gatewayModels(map));
    // The generated extension exists only at runtime; exercise its module-loading boundary.
    const extension = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const registered: Record<string, { models: Array<{ id: string; contextWindow: number; maxTokens: number; input: string[] }> }> = {};
    extension.default({ registerProvider: (name: string, config: typeof registered[string]) => { registered[name] = config; } });
    const models = registered["model-gateway"]!.models;
    expect(models.find(({ id }) => id === "gpt-6.1-sol")).toMatchObject({ contextWindow: 500000, maxTokens: 128000 });
    expect(models.find(({ id }) => id === "gpt-5.3-codex-spark")).toMatchObject({ contextWindow: 128000, maxTokens: 128000, input: ["text"] });
    for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-terra", "gpt-6-luna", "custom-target"])
      expect(models.some((model) => model.id === id)).toBe(true);
    expect(new Set(ompModels(map))).toEqual(new Set(models.map(({ id }) => `gw-${id}`)));
  });

  it("admits the actual model context sizes rather than the generic GPT fallback", () => {
    expect(contextWindow("gpt-6.1-sol", new Headers())).toBe(500000);
    expect(contextWindow("gpt-5.3-codex-spark", new Headers())).toBe(128000);
    expect(contextWindow("gpt-6-sol", new Headers())).toBe(272000);
    expect(ompModels(DEFAULT_MODEL_MAP)).toContain("gw-gpt-6.1-sol");
  });
});
