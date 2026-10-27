import { describe, expect, it } from "vitest";
import {
  resolveAgentExecution,
  resolveExecution,
  type DefaultFamily,
  type ExecutionModel,
  type ModelFamily,
  type ModelLevel,
  type ReasoningLevel,
} from "./model-levels";

const effort = (reasoningEffort: ReasoningLevel) => ({ reasoningEffort });

function model(
  value: string,
  supported: ReasoningLevel[] = ["low", "medium", "high"],
  isDefault = false,
): ExecutionModel {
  return {
    model: value,
    displayName: value,
    supportedReasoningEfforts: supported.map(effort),
    defaultReasoningEffort: supported.includes("medium") ? "medium" : supported[0]!,
    isDefault,
  };
}

function catalog(providerId: string) {
  const prefix = providerId === "acp-omp"
    ? { codex: "openai-codex/", claude: "anthropic/" }
    : { codex: "", claude: "" };
  return [
    model(`${prefix.codex}gpt-6-astra`),
    model(`${prefix.codex}gpt-6-sol`, undefined, true),
    model(`${prefix.codex}gpt-5.6-terra`),
    model(`${prefix.codex}gpt-6-luna`),
    model(`${prefix.claude}claude-fable-5-1`),
    model(`${prefix.claude}claude-opus-5-5${providerId === "claude-code" ? "[1m]" : ""}`),
    model(`${prefix.claude}claude-sonnet-5`),
    model(`${prefix.claude}claude-haiku-4-5`),
  ];
}

const expected: Record<ModelFamily, Partial<Record<ModelLevel, [string, ReasoningLevel]>>> = {
  codex: {
    xhigh: ["astra", "high"],
    high: ["sol", "high"],
    medium: ["sol", "medium"],
    low: ["terra", "medium"],
    xlow: ["luna", "low"],
  },
  claude: {
    xhigh: ["fable", "high"],
    high: ["opus", "high"],
    medium: ["opus", "medium"],
    low: ["sonnet", "medium"],
    xlow: ["haiku", "low"],
  },
  unknown: {},
};

const callers = {
  codex: (providerId: string) => ({
    providerId,
    model: providerId === "acp-omp" ? "openai-codex/gpt-6-sol" : "gpt-6-sol",
  }),
  claude: (providerId: string) => ({
    providerId,
    model: providerId === "acp-omp" ? "anthropic/claude-opus-5-5" : "claude-opus-5-5",
  }),
};

const levels: ModelLevel[] = ["xhigh", "high", "medium", "low", "xlow"];
const providers = ["codex", "acp-omp", "claude-code"];

function resolve(
  level: ModelLevel,
  models: ExecutionModel[],
  caller?: { providerId: string; model: string },
  defaultFamily: DefaultFamily = "Codex via OMP",
) {
  return resolveExecution({ caller, defaultFamily, level, models });
}

describe("resolveExecution", () => {
  it.each(providers.flatMap((providerId) =>
    (["codex", "claude"] as const).flatMap((family) =>
      levels.map((level) => ({ providerId, family, level })),
    ),
  ))("maps $level for $family on $providerId", ({ providerId, family, level }) => {
    const result = resolve(level, catalog(providerId), callers[family](providerId));
    const [tier, reasoningLevel] = expected[family][level]!;
    expect(result).toMatchObject({ providerId, family, reasoningLevel });
    expect(result.model).toContain(tier);
    if (providerId === "acp-omp") {
      expect(result.model).toMatch(family === "codex" ? /^openai-codex\//u : /^anthropic\//u);
    }
  });

  it("selects the latest tier version and ignores excluded variants", () => {
    const models = [
      model("gpt-5.6-sol", undefined, true),
      model("gpt-6-sol"),
      model("gpt-7-sol"),
      model("gpt-8-sol-fast"),
      model("openrouter/openai/gpt-9-sol"),
      model("gpt-10-sol:batch"),
    ];
    expect(resolve("medium", models, callers.codex("codex")).model).toBe("gpt-7-sol");
  });

  it("prefers an undated Claude alias over its dated duplicate", () => {
    const models = [
      model("claude-opus-5-5-20260901"),
      model("claude-opus-5-5"),
      model("claude-opus-5-4"),
    ];
    expect(resolve("medium", models, callers.claude("claude-code")).model)
      .toBe("claude-opus-5-5");
  });

  it("uses the Claude Code long-context alias for equal versions", () => {
    const models = [model("claude-opus-5-5"), model("claude-opus-5-5[1m]")];
    expect(resolve("medium", models, callers.claude("claude-code")).model)
      .toBe("claude-opus-5-5[1m]");
  });

  it("clamps effort to the nearest supported value at or below the target", () => {
    const models = [model("gpt-6-sol", ["none", "low", "xhigh"])];
    expect(resolve("high", models, callers.codex("codex")).reasoningLevel).toBe("low");
  });

  it("uses the model default when no supported effort is at or below the target", () => {
    const models = [model("gpt-6-luna", ["xhigh"])];
    expect(resolve("xlow", models, callers.codex("codex")).reasoningLevel).toBe("xhigh");
  });

  it("steps toward medium when the requested tier is missing", () => {
    const models = [model("gpt-6-sol")];
    expect(resolve("xhigh", models, callers.codex("codex"))).toMatchObject({
      model: "gpt-6-sol",
      reasoningLevel: "high",
      reason: expect.stringContaining("fallback xhigh → high"),
    });
    expect(resolve("xlow", models, callers.codex("codex"))).toMatchObject({
      model: "gpt-6-sol",
      reasoningLevel: "medium",
      reason: expect.stringContaining("fallback xlow → medium"),
    });
  });

  it("uses the provider default when no tier resolves", () => {
    const models = [model("custom-model", ["low", "medium"], true)];
    expect(resolve("high", models, callers.codex("codex"))).toMatchObject({
      model: "custom-model",
      reasoningLevel: "medium",
      reason: expect.stringContaining("provider default fallback"),
    });
  });

  it("uses Default family for an unknown caller and for no caller", () => {
    const models = catalog("claude-code");
    expect(resolve("low", models, { providerId: "acp-omp", model: "deepseek-v4" }, "Claude via Claude Code"))
      .toMatchObject({ providerId: "claude-code", family: "claude", model: "claude-sonnet-5" });
    expect(resolve("medium", catalog("codex"), undefined, "Codex via Codex"))
      .toMatchObject({ providerId: "codex", family: "codex", model: "gpt-6-sol" });
  });

  it("passes pinned execution through unchanged", () => {
    expect(resolveExecution({
      defaultFamily: "Codex via OMP",
      level: "xhigh",
      models: [],
      pinned: {
        providerId: "acp-omp",
        model: "wafer-serverless/DeepSeek-V4",
        reasoningLevel: "low",
      },
    })).toEqual({
      providerId: "acp-omp",
      model: "wafer-serverless/DeepSeek-V4",
      reasoningLevel: "low",
      family: "unknown",
      reason: "Pinned exact model",
    });
  });
});

describe("Pi agent execution policy", () => {
  const catalog = [
    model("openai-codex/gpt-6-astra", ["low", "high"]),
    model("openai-codex/gpt-6-sol", ["low", "medium", "high"]),
    model("openai-codex/gpt-5.6-terra", ["low", "medium"]),
    model("openai-codex/gpt-6-luna", ["low"]),
    model("openai-codex/other-default", ["medium"], true),
    model("anthropic/claude-fable-5-1", ["high"], true),
  ];
  const profile = {
    modelMode: "level" as const,
    level: "medium" as const,
    providerId: "claude-code",
    model: "anthropic/claude-fable-5-1",
    reasoningLevel: "medium" as const,
  };

  it.each([
    ["xhigh", "openai-codex/gpt-6-astra", "high"],
    ["high", "openai-codex/gpt-6-sol", "high"],
    ["medium", "openai-codex/gpt-6-sol", "medium"],
    ["low", "openai-codex/gpt-5.6-terra", "medium"],
    ["xlow", "openai-codex/gpt-6-luna", "low"],
  ] as const)("resolves %s to the existing Codex tier and effort", (level, selected, effort) => {
    expect(resolveAgentExecution({ ...profile, level }, catalog)).toMatchObject({
      providerId: "hempi", model: selected, reasoningLevel: effort, family: "codex",
    });
  });

  it("keeps an available exact pin and requires its requested effort", () => {
    expect(resolveAgentExecution({
      ...profile, modelMode: "pinned", providerId: "openai-codex",
      model: "openai-codex/gpt-6-sol", reasoningLevel: "high",
    }, catalog)).toMatchObject({
      model: "openai-codex/gpt-6-sol", reasoningLevel: "high",
    });
    expect(resolveAgentExecution({
      ...profile, modelMode: "pinned", providerId: "codex",
      model: "gpt-6-sol", reasoningLevel: "high",
    }, catalog)).toMatchObject({
      model: "openai-codex/gpt-6-sol", reasoningLevel: "high",
    });
    expect(() => resolveAgentExecution({
      ...profile, modelMode: "pinned", providerId: "openai-codex",
      model: "openai-codex/gpt-6-luna", reasoningLevel: "high",
    }, catalog)).toThrow("does not support");
  });

  it("keeps Gateway pin identity for required transport and matches the canonical catalog", () => {
    expect(resolveAgentExecution({
      ...profile, modelMode: "pinned", providerId: "model-gateway",
      model: "model-gateway/gpt-6-sol",
    }, catalog)).toMatchObject({
      model: "model-gateway/gpt-6-sol",
      reason: expect.stringContaining("gateway transport required"),
    });
  });

  it("allows an available custom Gateway pin and fails closed on missing models or unsupported effort", () => {
    const selected = "model-gateway/DeepSeek-V4.1-Flash-1017";
    const pin = { ...profile, modelMode: "pinned" as const, providerId: "model-gateway", model: selected, reasoningLevel: "high" as const };
    const registered = [...catalog, model(selected, ["none", "low", "high"])];
    expect(resolveAgentExecution(pin, registered)).toMatchObject({ providerId: "hempi", model: selected, reasoningLevel: "high", family: "unknown" });
    expect(() => resolveAgentExecution(pin, catalog)).toThrow("unavailable");
    expect(() => resolveAgentExecution({ ...pin, reasoningLevel: "xhigh" }, registered)).toThrow("does not support");
    expect(() => resolveAgentExecution({ ...pin, providerId: "hempi" }, registered)).toThrow("Unsupported Pi agent pin");
  });

  it.each([
    ["claude-code", "claude-opus-5-5"],
    ["model-gateway", "model-gateway/claude-fable-5"],
    ["openai-codex", "openai-codex/grok-4"],
    ["openai-codex", "openai-codex/gpt-unknown"],
    ["model-gateway", "openai-codex/gpt-6-sol"],
  ])("rejects unsupported pin %s/%s", (providerId, selected) => {
    expect(() => resolveAgentExecution({
      ...profile, modelMode: "pinned", providerId, model: selected,
    }, catalog)).toThrow();
  });

  it("fails closed on an empty catalog or a catalog with no supported tier", () => {
    expect(() => resolveAgentExecution(profile, [])).toThrow("returned no models");
    expect(() => resolveAgentExecution(profile, [model("openai-codex/custom", ["medium"], true)]))
      .toThrow("returned no models");
    expect(() => resolveAgentExecution(profile, [model("openai-codex/gpt-7-novel", ["medium"], true)]))
      .toThrow("No supported Codex tier");
  });
});
