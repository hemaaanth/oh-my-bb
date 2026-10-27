import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createExecutionResolver } from "./execution-resolver";

const model = {
  model: "openai-codex/gpt-6-sol",
  displayName: "GPT-6 Sol",
  supportedReasoningEfforts: [
    { reasoningEffort: "low" as const },
    { reasoningEffort: "medium" as const },
    { reasoningEffort: "high" as const },
  ],
  defaultReasoningEffort: "medium" as const,
  isDefault: true,
};

function setup() {
  const models = vi.fn(async () => ({ models: [model] }));
  const warn = vi.fn();
  const bb = {
    sdk: { providers: { models } },
    log: { warn },
  } as unknown as BbPluginApi;
  return {
    resolver: createExecutionResolver(bb),
    models,
    warn,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("execution resolver provider catalog", () => {
  it("caches a provider catalog for five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
    const { resolver, models } = setup();
    const profile = {
      modelMode: "level" as const,
      level: "medium" as const,
      providerId: "codex",
      model: "ignored",
      reasoningLevel: "medium" as const,
    };

    await resolver.resolveAgent(profile);
    await resolver.resolveAgent(profile);
    expect(models).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    await resolver.resolveAgent(profile);
    expect(models).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported saved pins before returning a model", async () => {
    const { resolver } = setup();
    await expect(resolver.resolveAgent({
      modelMode: "pinned",
      level: "medium",
      providerId: "claude-code",
      model: "claude-opus-5-5[1m]",
      reasoningLevel: "high",
    })).rejects.toThrow("Unsupported Pi agent pin");
  });
});

describe("Pi agent resolver catalog", () => {
  it("uses Hempi's unbound Codex catalog, not the Agents picker or a Claude default", async () => {
    const { resolver, models } = setup();
    await expect(resolver.resolveAgent({
      modelMode: "level", level: "medium", providerId: "claude-code",
      model: "claude-opus-5-5", reasoningLevel: "high",
    })).resolves.toMatchObject({ providerId: "hempi", model: model.model, reasoningLevel: "medium" });
    expect(models).toHaveBeenCalledWith({ providerId: "hempi" });
  });
});
