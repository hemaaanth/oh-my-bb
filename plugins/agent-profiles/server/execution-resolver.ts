import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  resolveAgentExecution,
  type ExecutionModel, type ModelLevel, type ModelMode,
  type ReasoningLevel, type ResolvedExecution,
} from "./model-levels";

const MODEL_CACHE_MS = 5 * 60_000;

type ProfileExecution = {
  modelMode: ModelMode;
  level: ModelLevel;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
};

type CachedModels = {
  expiresAt: number;
  models: ExecutionModel[];
};

export type ModelLevelPreview = {
  codex: Omit<ResolvedExecution, "family"> & { family: "codex"; displayName: string };
};

export interface ExecutionResolver {
  resolveAgent(profile: ProfileExecution): Promise<ResolvedExecution>;
  preview(level: ModelLevel): Promise<ModelLevelPreview>;
}

export function createExecutionResolver(bb: BbPluginApi): ExecutionResolver {
  let cached: CachedModels | undefined;
  const modelsFor = async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    const result = await bb.sdk.providers.models({ providerId: "hempi" });
    cached = { expiresAt: Date.now() + MODEL_CACHE_MS, models: result.models };
    return result.models;
  };


  return {
    async resolveAgent(profile) {
      return resolveAgentExecution(profile, await modelsFor());
    },
    async preview(level) {
      const models = await modelsFor();
      const execution = resolveAgentExecution({
        modelMode: "level", level, providerId: "hempi",
        model: "openai-codex/gpt-family", reasoningLevel: "medium",
      }, models);
      return { codex: { ...execution, family: "codex",
        displayName: models.find(({ model }) => model === execution.model)?.displayName ?? execution.model } };
    },
  };
}
