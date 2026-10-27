export const modelModes = ["level", "pinned"] as const;
export const modelLevels = ["xhigh", "high", "medium", "low", "xlow"] as const;
export const defaultFamilies = [
  "Codex via OMP",
  "Codex via Codex",
  "Claude via Claude Code",
] as const;

export type ModelMode = (typeof modelModes)[number];
export type ModelLevel = (typeof modelLevels)[number];
export type DefaultFamily = (typeof defaultFamilies)[number];
export type ModelFamily = "codex" | "claude" | "unknown";
export type ReasoningLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "ultracode"
  | "max"
  | "ultra";

export type ExecutionModel = {
  model: string;
  displayName: string;
  supportedReasoningEfforts: ReadonlyArray<{
    reasoningEffort: ReasoningLevel;
  }>;
  defaultReasoningEffort: ReasoningLevel;
  isDefault: boolean;
};

export type ResolvedExecution = {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  family: ModelFamily;
  reason: string;
};

type Caller = { providerId: string; model: string };
type Pinned = Caller & { reasoningLevel: ReasoningLevel };
type Tier = "astra" | "sol" | "terra" | "luna" | "fable" | "opus" | "sonnet" | "haiku";

type LevelTarget = {
  codex: Tier;
  claude: Tier;
  effort: ReasoningLevel;
};

const TARGETS: Record<ModelLevel, LevelTarget> = {
  xhigh: { codex: "astra", claude: "fable", effort: "high" },
  high: { codex: "sol", claude: "opus", effort: "high" },
  medium: { codex: "sol", claude: "opus", effort: "medium" },
  low: { codex: "terra", claude: "sonnet", effort: "medium" },
  xlow: { codex: "luna", claude: "haiku", effort: "low" },
};

const FALLBACKS: Record<ModelLevel, readonly ModelLevel[]> = {
  xhigh: ["xhigh", "high", "medium"],
  high: ["high", "medium"],
  medium: ["medium"],
  low: ["low", "medium"],
  xlow: ["xlow", "low", "medium"],
};

const EFFORT_RANK: Record<ReasoningLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  ultracode: 5,
  max: 6,
  ultra: 7,
};

export function modelFamily(model: string): ModelFamily {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gpt-") || normalized.startsWith("openai-codex/"))
    return "codex";
  if (normalized.startsWith("claude-") || normalized.startsWith("anthropic/"))
    return "claude";
  return "unknown";
}

export function defaultFamilyTarget(defaultFamily: DefaultFamily) {
  switch (defaultFamily) {
    case "Codex via Codex":
      return { providerId: "codex", family: "codex" as const };
    case "Claude via Claude Code":
      return { providerId: "claude-code", family: "claude" as const };
    default:
      return { providerId: "acp-omp", family: "codex" as const };
  }
}

export function executionTarget(caller: Caller | undefined, defaultFamily: DefaultFamily) {
  const family = caller ? modelFamily(caller.model) : "unknown";
  return caller && family !== "unknown"
    ? { providerId: caller.providerId, family, source: "caller" as const }
    : { ...defaultFamilyTarget(defaultFamily), source: caller ? "default-unknown-caller" as const : "default-no-caller" as const };
}

function shortModel(model: string) {
  return model.slice(model.lastIndexOf("/") + 1);
}

function snapshotBase(model: string) {
  return model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, "");
}

function excludedVariant(model: string) {
  const value = model.toLowerCase();
  return value.includes("openrouter")
    || /(?:^|[-_/:])fast(?:$|[-_/:])/u.test(value)
    || /:batch(?:$|[-_/:])/u.test(value);
}

function tierOf(model: string, family: Exclude<ModelFamily, "unknown">): Tier | null {
  const value = snapshotBase(shortModel(model).toLowerCase());
  if (family === "codex") {
    const match = /^gpt-[0-9]+(?:[.-][0-9]+)*-(astra|sol|terra|luna)(?:$|[-[])/u.exec(value);
    return (match?.[1] as Tier | undefined) ?? null;
  }
  const match = /^claude-(fable|opus|sonnet|haiku)-[0-9]+(?:[.-][0-9]+)*(?:\[1m\])?$/u.exec(value);
  return (match?.[1] as Tier | undefined) ?? null;
}

function versionOf(model: string, family: Exclude<ModelFamily, "unknown">) {
  const value = snapshotBase(shortModel(model).toLowerCase());
  const match = family === "codex"
    ? /^gpt-([0-9]+(?:[.-][0-9]+)*)-/u.exec(value)
    : /^claude-(?:fable|opus|sonnet|haiku)-([0-9]+(?:[.-][0-9]+)*)/u.exec(value);
  return (match?.[1] ?? "0").split(/[.-]/u).map(Number);
}

function compareVersion(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function latestModel(
  models: readonly ExecutionModel[],
  providerId: string,
  family: Exclude<ModelFamily, "unknown">,
  tier: Tier,
) {
  const undated = new Set(models.map(({ model }) => model).filter((model) => snapshotBase(model) === model));
  return models
    .filter(({ model }) => !excludedVariant(model) && tierOf(model, family) === tier)
    .filter(({ model }) => snapshotBase(model) === model || !undated.has(snapshotBase(model)))
    .sort((left, right) => {
      const version = compareVersion(versionOf(right.model, family), versionOf(left.model, family));
      if (version) return version;
      const preferLongContext = providerId === "claude-code";
      const leftLong = /\[1m\]/u.test(left.model);
      const rightLong = /\[1m\]/u.test(right.model);
      if (leftLong !== rightLong) return leftLong === preferLongContext ? -1 : 1;
      return left.model.length - right.model.length || left.model.localeCompare(right.model);
    })[0];
}

function clampEffort(model: ExecutionModel, desired: ReasoningLevel) {
  const supported = model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort);
  const nearest = supported
    .filter((effort) => EFFORT_RANK[effort] <= EFFORT_RANK[desired])
    .sort((left, right) => EFFORT_RANK[right] - EFFORT_RANK[left])[0];
  return nearest ?? model.defaultReasoningEffort;
}

export function resolveExecution({
  caller,
  defaultFamily,
  level,
  models,
  pinned,
}: {
  caller?: Caller;
  defaultFamily: DefaultFamily;
  level: ModelLevel;
  models: readonly ExecutionModel[];
  pinned?: Pinned;
}): ResolvedExecution {
  if (pinned) {
    return {
      ...pinned,
      family: modelFamily(pinned.model),
      reason: "Pinned exact model",
    };
  }

  const target = executionTarget(caller, defaultFamily);
  for (const candidateLevel of FALLBACKS[level]) {
    const candidateTarget = TARGETS[candidateLevel];
    const tier = candidateTarget[target.family];
    const model = latestModel(models, target.providerId, target.family, tier);
    if (!model) continue;
    const fallback = candidateLevel === level ? "" : `; fallback ${level} → ${candidateLevel}`;
    const source = target.source === "caller"
      ? `caller ${target.family} family`
      : target.source === "default-no-caller"
      ? "Default family; no caller"
      : "Default family; caller model unrecognized";
    return {
      providerId: target.providerId,
      model: model.model,
      reasoningLevel: clampEffort(model, candidateTarget.effort),
      family: target.family,
      reason: `${source}; ${tier} tier${fallback}`,
    };
  }

  const fallback = models.find(({ isDefault }) => isDefault) ?? models[0];
  if (!fallback) throw new Error(`Provider ${target.providerId} returned no models.`);
  return {
    providerId: target.providerId,
    model: fallback.model,
    reasoningLevel: clampEffort(fallback, TARGETS[level].effort),
    family: target.family,
    reason: `${target.source === "caller" ? `caller ${target.family} family` : "Default family"}; provider default fallback from ${level}`,
  };
}

export function resolveAgentExecution(
  profile: { modelMode: ModelMode; level: ModelLevel; providerId: string; model: string; reasoningLevel: ReasoningLevel },
  catalog: readonly ExecutionModel[],
): ResolvedExecution {
  const models = catalog.filter(({ model }) => /^openai-codex\/gpt-[a-z0-9.-]+$/u.test(model));
  if (profile.modelMode === "pinned") {
    if (profile.providerId === "model-gateway" && /^model-gateway\/(?!gpt-)[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(profile.model)) {
      const selected = catalog.find(({ model }) => model === profile.model);
      if (!selected) throw new Error(`Pinned Gateway model ${profile.model} is unavailable.`);
      if (!selected.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === profile.reasoningLevel))
        throw new Error(`Pinned Gateway model ${profile.model} does not support ${profile.reasoningLevel} effort.`);
      return { providerId: "hempi", model: profile.model, reasoningLevel: profile.reasoningLevel, family: modelFamily(profile.model.slice("model-gateway/".length)), reason: "Pinned Gateway model; gateway transport required" };
    }
    const normalized = profile.model.startsWith("model-gateway/")
      ? profile.model.replace(/^model-gateway\//u, "openai-codex/")
      : profile.providerId === "codex" && profile.model.startsWith("gpt-")
        ? `openai-codex/${profile.model}`
        : profile.model;
    if (!/^openai-codex\/gpt-[a-z0-9.-]+$/u.test(normalized)
      || !["openai-codex", "model-gateway", "hempi", "acp-omp", "codex"].includes(profile.providerId)
      || (profile.model.startsWith("model-gateway/") !== (profile.providerId === "model-gateway")))
      throw new Error(`Unsupported Pi agent pin: ${profile.providerId}/${profile.model}. Choose a Codex model or level.`);
    const selected = models.find(({ model }) => model === normalized);
    if (!selected) throw new Error(`Pinned Pi agent model ${profile.model} is unavailable in the Codex catalog.`);
    if (!selected.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === profile.reasoningLevel))
      throw new Error(`Pinned Pi agent model ${profile.model} does not support ${profile.reasoningLevel} effort.`);
    return {
      providerId: "hempi",
      model: profile.model.startsWith("model-gateway/") ? profile.model : normalized,
      reasoningLevel: profile.reasoningLevel,
      family: "codex",
      reason: profile.model.startsWith("model-gateway/") ? "Pinned Gateway model; gateway transport required" : "Pinned exact Pi model",
    };
  }
  const resolved = resolveExecution({
    caller: { providerId: "hempi", model: "openai-codex/gpt-family" },
    defaultFamily: "Codex via OMP",
    level: profile.level,
    models,
  });
  if (resolved.reason.includes("provider default fallback"))
    throw new Error(`No supported Codex tier is available for Pi agent level ${profile.level}.`);
  return resolved;
}

export function modelLevelLabel(level: ModelLevel) {
  return ({
    xhigh: "Extra high",
    high: "High",
    medium: "Medium",
    low: "Low",
    xlow: "Extra low",
  } as const)[level];
}
