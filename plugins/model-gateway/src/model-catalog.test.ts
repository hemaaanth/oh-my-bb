import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { modelDisplayName } from "./model-catalog.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextWindow, gatewayModels, ompModels, DEFAULT_MODEL_MAP } from "./chain.js";
import { piExtension, writePiStandalone } from "./setup.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["gpt-6.1-sol", "6.1-Sol"], ["model-gateway/gw-gpt-6-sol", "6-Sol"],
  ["gpt-5.3-codex-spark", "5.3-Spark"], ["gpt-5.5", "5.5"],
  ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-4-5-20250929", "Sonnet 4.5"],
  ["kimi-k3", "kimi-k3"],
])("labels %s as %s without changing custom IDs", (id, label) => {
  expect(modelDisplayName(id)).toBe(label);
});

describe("Codex discovery", () => {
  it("loads the Pi extension with current tier models and accurate limits, independent of model-map targets", async () => {
    vi.stubEnv("MODEL_GATEWAY_BASE_URL", "http://gateway.test/v1");
    vi.stubEnv("MODEL_GATEWAY_TOKEN", "test-token");
    const map = { "chatgpt-oauth": { "custom-alias": "custom-target" } };
    const source = piExtension(gatewayModels(map));
    // The generated extension exists only at runtime; exercise its module-loading boundary.
    const extension = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const registered: Record<string, { models: Array<{ id: string; contextWindow: number; maxTokens: number; input: string[] }> }> = {};
    extension.default({ on: () => {}, registerProvider: (name: string, config: typeof registered[string]) => { registered[name] = config; } });
    const models = registered["model-gateway"]!.models;
    expect(models.find(({ id }) => id === "gpt-6.1-sol")).toMatchObject({ name: "6.1-Sol", contextWindow: 500000, maxTokens: 128000 });
    expect(models.find(({ id }) => id === "gpt-5.3-codex-spark")).toMatchObject({ contextWindow: 128000, maxTokens: 128000, input: ["text"] });
    for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-terra", "gpt-6-luna", "custom-target"])
      expect(models.some((model) => model.id === id)).toBe(true);
    expect(new Set(ompModels(map))).toEqual(new Set(models.map(({ id }) => `gw-${id}`)));
  });

  it("removes native routes and stops a managed session when its model cannot be routed", async () => {
    vi.stubEnv("MODEL_GATEWAY_REQUIRED", "1");
    vi.stubEnv("MODEL_GATEWAY_BASE_URL", "http://gateway.test/v1");
    vi.stubEnv("MODEL_GATEWAY_TOKEN", "test-token");
    const source = piExtension(gatewayModels(DEFAULT_MODEL_MAP));
    const extension = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const hooks: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
    const registrations: Array<[string, unknown]> = [];
    const setModel = vi.fn(async () => true);
    extension.default({ on: (name: string, hook: typeof hooks[string]) => { hooks[name] = hook; }, registerProvider: (name: string, value: unknown) => registrations.push([name, value]), setModel });
    const routed = { provider: "model-gateway", id: "gpt-6-sol" };
    const ctx = { model: { provider: "openai-codex", id: "gpt-6-sol" }, modelRegistry: { getAll: () => [{ provider: "openai-codex" }, { provider: "anthropic" }, routed], find: () => routed }, shutdown: vi.fn() };
    await hooks.session_start!({}, ctx);
    expect(registrations).toContainEqual(["openai-codex", { models: [] }]);
    expect(registrations).toContainEqual(["anthropic", { models: [] }]);
    expect(setModel).toHaveBeenCalledWith(routed);
    ctx.model.id = "unsupported-native-model";
    await expect(hooks.session_start!({}, ctx)).rejects.toThrow(/Select an available Model Gateway/);
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it("admits the actual model context sizes rather than the generic GPT fallback", () => {
    expect(contextWindow("gpt-6.1-sol", new Headers())).toBe(500000);
    expect(contextWindow("gpt-5.3-codex-spark", new Headers())).toBe(128000);
    expect(contextWindow("gpt-6-sol", new Headers())).toBe(272000);
    expect(ompModels(DEFAULT_MODEL_MAP)).toContain("gw-gpt-6.1-sol");
  });
});


it("uses standalone credentials only outside managed BB sessions", async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), "mgw-extension-"));
  try {
    vi.stubEnv("BB_THREAD_ID", "");
    vi.stubEnv("MODEL_GATEWAY_REQUIRED", "");
    vi.stubEnv("MODEL_GATEWAY_BASE_URL", undefined);
    vi.stubEnv("MODEL_GATEWAY_TOKEN", undefined);
    await fs.mkdir(path.join(home, "extensions"));
    const file = path.join(home, "extensions", "model-gateway.mjs");
    await fs.writeFile(file, piExtension(["gpt-6.1-sol"]));
    await writePiStandalone(home, "http://standalone.test/v1", "standalone-token");
    const extension = await import(/* @vite-ignore */ pathToFileURL(file).href);
    let config: { baseUrl: string; apiKey: string };
    let start: (event: unknown, ctx: unknown) => Promise<void>;
    const api = { on: (_name: string, hook: typeof start) => { start = hook; }, registerProvider: (_name: string, value: typeof config) => { config = value; } };
    extension.default(api);
    expect(config!).toMatchObject({ baseUrl: "http://standalone.test/v1", apiKey: "standalone-token" });
    await start!({}, { model: { provider: "model-gateway" } });
    expect(process.env.MODEL_GATEWAY_BASE_URL).toBe("http://standalone.test/v1");
    expect(process.env.MODEL_GATEWAY_TOKEN).toBe("standalone-token");
    vi.stubEnv("MODEL_GATEWAY_BASE_URL", undefined);
    vi.stubEnv("MODEL_GATEWAY_TOKEN", undefined);
    vi.stubEnv("MODEL_GATEWAY_REQUIRED", "1");
    extension.default(api);
    const ctx = { model: { provider: "model-gateway" }, shutdown: vi.fn() };
    await expect(start!({}, ctx)).rejects.toThrow(/credentials are missing/);
    expect(ctx.shutdown).toHaveBeenCalledOnce();
    vi.stubEnv("MODEL_GATEWAY_BASE_URL", "http://managed.test/v1");
    vi.stubEnv("MODEL_GATEWAY_TOKEN", "managed-token");
    extension.default(api);
    expect(config!).toMatchObject({ baseUrl: "http://managed.test/v1", apiKey: "managed-token" });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
