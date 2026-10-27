import { z } from "zod";

export const MAX_ROUTING_TRACES = 500;
const MAX_TRACE_MESSAGE_LENGTH = 1_000;
const SUGGESTION_MATCH_WINDOW_MS = 30 * 60 * 1_000;

export const routingSuggestionSchema = z.object({
  kind: z.enum(["project", "no_project", "none"]),
  projectId: z.string().nullable(),
  probability: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  autoApply: z.boolean(),
});

/** One new thread started from the composer: what Jev suggested and where the user actually started. */
export const routingTraceSchema = z.object({
  threadId: z.string(),
  createdAt: z.number(),
  message: z.string(),
  suggested: routingSuggestionSchema,
  /** null means the thread started without a project. */
  finalProjectId: z.string().nullable(),
  outcome: z.enum(["hit", "miss", "unguided"]),
});

export type RoutingSuggestion = z.infer<typeof routingSuggestionSchema>;
export type RoutingTrace = z.infer<typeof routingTraceSchema>;

export interface RecordedSuggestion extends RoutingSuggestion {
  prompt: string;
  at: number;
}

export function normalizePrompt(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Finds the suggestion Jev made for the draft that became this thread's first message. */
export function matchSuggestion(
  message: string,
  createdAt: number,
  recent: readonly RecordedSuggestion[],
): RecordedSuggestion | null {
  const text = normalizePrompt(message);
  const inWindow = recent
    .filter(({ at }) => at <= createdAt + 5_000 && at >= createdAt - SUGGESTION_MATCH_WINDOW_MS)
    .sort((left, right) => right.at - left.at);
  return inWindow.find(({ prompt }) => prompt === text)
    ?? inWindow.find(({ prompt }) => text.startsWith(prompt) || prompt.startsWith(text))
    ?? null;
}

export function traceOutcome(suggested: RoutingSuggestion, finalProjectId: string | null): RoutingTrace["outcome"] {
  if (suggested.kind === "none") return "unguided";
  const suggestedProjectId = suggested.kind === "no_project" ? null : suggested.projectId;
  return suggestedProjectId === finalProjectId ? "hit" : "miss";
}

export function createTrace(input: {
  threadId: string;
  createdAt: number;
  message: string;
  suggestion: RecordedSuggestion;
  finalProjectId: string | null;
}): RoutingTrace {
  const { prompt: _prompt, at: _at, ...suggested } = input.suggestion;
  return {
    threadId: input.threadId,
    createdAt: input.createdAt,
    message: normalizePrompt(input.message).slice(0, MAX_TRACE_MESSAGE_LENGTH),
    suggested,
    finalProjectId: input.finalProjectId,
    outcome: traceOutcome(suggested, input.finalProjectId),
  };
}

export function appendTrace(traces: readonly RoutingTrace[], trace: RoutingTrace): RoutingTrace[] {
  return [trace, ...traces.filter(({ threadId }) => threadId !== trace.threadId)]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_ROUTING_TRACES);
}

/**
 * Real first messages grouped by where the user started them, keyed by project id or
 * "no_project". Corrections come first because they teach the most.
 */
export function routingExamples(
  traces: readonly RoutingTrace[],
  options: { perTarget?: number; maxLength?: number } = {},
): Map<string, string[]> {
  const perTarget = options.perTarget ?? 3;
  const maxLength = options.maxLength ?? 160;
  const ordered = [...traces].sort((left, right) =>
    Number(right.outcome === "miss") - Number(left.outcome === "miss") || right.createdAt - left.createdAt);
  const examples = new Map<string, string[]>();
  for (const trace of ordered) {
    const key = trace.finalProjectId ?? "no_project";
    const list = examples.get(key) ?? [];
    const text = trace.message.length > maxLength ? `${trace.message.slice(0, maxLength - 1)}…` : trace.message;
    if (list.length >= perTarget || list.includes(text)) continue;
    list.push(text);
    examples.set(key, list);
  }
  return examples;
}
