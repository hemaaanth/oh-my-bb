export interface ProjectRoutingCandidate {
  id: string;
  name: string;
  repository: string | null;
  summary: string;
  keywords?: string[];
  aliases?: string[];
  repositories?: string[];
  notFor?: string[];
  learnedFor?: string[];
  learnedNotFor?: string[];
  recentRequests?: string[];
}

export interface ProjectRoutingHint {
  projectId: string;
  values: string[];
}

export interface JevProjectChoiceAnswer {
  type?: unknown;
  choice?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
}

const MAX_SUMMARY_LENGTH = 700;

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function packageDescription(content: string | null): string | null {
  if (!content) return null;
  try {
    const value = JSON.parse(content) as { description?: unknown };
    return typeof value.description === "string" && value.description.trim()
      ? normalizeText(value.description).slice(0, MAX_SUMMARY_LENGTH)
      : null;
  } catch {
    return null;
  }
}

export function readmeDescription(content: string | null): string | null {
  if (!content) return null;
  const cleaned = content
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/<!--([\s\S]*?)-->/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/gu, (match) => match.replace(/^\[/u, "").replace(/\]\([^)]*\)$/u, ""))
    .split(/\r?\n/u)
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/u, "")
      .replace(/^\s*>\s?/u, "")
      .replace(/^\s*[-*+]\s+/u, "")
      .trim())
    .filter((line) => line && !/^[-=|: ]+$/u.test(line) && !/^<[^>]+>$/u.test(line));
  if (!cleaned.length) return null;
  return normalizeText(cleaned.slice(0, 5).join(" ")).slice(0, MAX_SUMMARY_LENGTH) || null;
}

export function projectSummary(input: {
  name: string;
  repository: string | null;
  packageJson: string | null;
  readme: string | null;
}): string {
  const description = packageDescription(input.packageJson) ?? readmeDescription(input.readme);
  if (description) return description;
  if (input.repository) return `Repository ${input.repository}.`;
  return `${input.name} project.`;
}

export function projectChoiceQuestion(
  candidates: readonly ProjectRoutingCandidate[],
  noProjectRequests: readonly string[] = [],
) {
  return {
    type: "choice" as const,
    instructions: [
      "Choose the BB project whose workspace an agent must work in to carry out this request.",
      "A project is right only when the work needs that project's files, code, data, or tools.",
      "Naming a product, tool, or platform is not enough. The user may be using it, asking about it, or referring to past work done with it.",
      "BB is the app these requests run in. Mentions of BB threads, past threads, agents, sub-agents, skills, or the bb CLI usually describe how to do the work, not where.",
      "Never choose a project for a request that matches one of its notFor entries.",
      "recentRequests are real requests the user recently started in that option; similar requests usually belong there too.",
      "Choose no_project when the request is ad hoc: a question, research, writing, personal errands, or a one-off task that needs no listed project's files.",
    ].join(" "),
    criteria: Object.fromEntries([
      ...candidates.map((candidate, index) => [
        `p${index}`,
        {
          project: candidate.name,
          repositories: candidate.repositories?.length
            ? candidate.repositories
            : candidate.repository ? [candidate.repository] : [],
          description: candidate.summary,
          aliases: candidate.aliases ?? [],
          keywords: candidate.keywords ?? [],
          notFor: [...new Set([...(candidate.notFor ?? []), ...(candidate.learnedNotFor ?? [])])],
          learnedFor: candidate.learnedFor ?? [],
          recentRequests: candidate.recentRequests ?? [],
        },
      ]),
      ["no_project", {
        description: "Work outside any project. The request is ad hoc or needs no listed project's files, or no listed project is clearly the workspace.",
        recentRequests: noProjectRequests,
      }],
    ]),
  };
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/https?:\/\//gu, "").replace(/\.git\b/gu, "").replace(/[^\p{L}\p{N}#./_-]+/gu, " ").trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  const value = normalized(phrase);
  if (value.length < 4) return false;
  return ` ${text} `.includes(` ${value} `) || text.includes(`github.com/${value}`) || text.includes(`${value}#`);
}

export function exactProjectMatch(
  prompt: string,
  candidates: readonly ProjectRoutingCandidate[],
  hints: readonly ProjectRoutingHint[] = [],
): ProjectRoutingCandidate | null {
  const text = normalized(prompt);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const hint of hints) {
    if (hint.values.some((value) => containsPhrase(text, value))) return byId.get(hint.projectId) ?? null;
  }
  for (const candidate of candidates) {
    const repositories = candidate.repositories?.length
      ? candidate.repositories
      : candidate.repository ? [candidate.repository] : [];
    if (repositories.some((value) => containsPhrase(text, value))) return candidate;
  }
  // Names and aliases go to Jev: mentioning a product is not a request to work in its repository.
  return null;
}

export function interpretProjectChoice(
  candidates: readonly ProjectRoutingCandidate[],
  answer: JevProjectChoiceAnswer | null | undefined,
): {
  suggestion: (ProjectRoutingCandidate & { probability: number }) | null;
  alternatives: Array<ProjectRoutingCandidate & { probability: number }>;
  noProject: { probability: number } | null;
  confidence: number;
  autoApply: boolean;
} {
  const probabilities = answer?.probabilities && typeof answer.probabilities === "object"
    ? answer.probabilities as Record<string, unknown>
    : {};
  const scored = candidates
    .map((candidate, index) => ({
      ...candidate,
      probability: typeof probabilities[`p${index}`] === "number"
        ? Math.max(0, Math.min(1, probabilities[`p${index}`] as number))
        : 0,
    }))
    .sort((left, right) => right.probability - left.probability);
  const confidence = typeof answer?.confidence === "number"
    ? Math.max(0, Math.min(1, answer.confidence))
    : 0;
  const choice = typeof answer?.choice === "string" ? answer.choice : "";
  const choiceIndex = /^p\d+$/u.test(choice) ? Number(choice.slice(1)) : -1;
  const selected = choiceIndex >= 0 && choiceIndex < candidates.length
    ? scored.find(({ id }) => id === candidates[choiceIndex]?.id) ?? null
    : null;
  const noProjectProbability = typeof probabilities.no_project === "number"
    ? Math.max(0, Math.min(1, probabilities.no_project))
    : 0;
  const suggestion = selected && selected.probability > noProjectProbability ? selected : null;
  const noProject = !suggestion && choice === "no_project" && confidence >= 0.5 && noProjectProbability >= 0.5
    ? { probability: noProjectProbability }
    : null;
  return {
    suggestion,
    alternatives: scored.slice(0, 3),
    noProject,
    confidence,
    autoApply: Boolean(suggestion && confidence >= 0.5 && suggestion.probability >= 0.35),
  };
}
