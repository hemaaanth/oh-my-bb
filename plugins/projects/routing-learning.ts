import { createHash } from "node:crypto";
import { z } from "zod";
import { requestOpenRouterJson } from "./routing-profile.js";

const MAX_EVIDENCE_PER_KIND = 20;
const MAX_EVIDENCE_MESSAGE_LENGTH = 300;
const ROUTING_LEARNING_VERSION = 1;

/** The part of a routing trace (see routing-trace.ts) that Projects learns from. */
export const routingTraceSchema = z.object({
  threadId: z.string(),
  createdAt: z.number(),
  message: z.string(),
  suggested: z.object({
    kind: z.enum(["project", "no_project", "none"]),
    projectId: z.string().nullable(),
  }).passthrough(),
  finalProjectId: z.string().nullable(),
  outcome: z.enum(["hit", "miss", "unguided"]),
}).passthrough();

export type RoutingTrace = z.infer<typeof routingTraceSchema>;

export const routingLearningSchema = z.object({
  learnedFor: z.array(z.string().trim().min(1).max(240)).max(6),
  learnedNotFor: z.array(z.string().trim().min(1).max(240)).max(6),
}).strict();

export type RoutingLearning = z.infer<typeof routingLearningSchema>;

export interface ProjectRoutingEvidence {
  /** Requests the user started in this project. */
  startedHere: Array<{ request: string; jevSuggested: string }>;
  /** Requests Jev suggested for this project that the user started elsewhere. */
  wronglySuggestedHere: Array<{ request: string; userStartedIn: string }>;
}

function clip(value: string): string {
  return value.length > MAX_EVIDENCE_MESSAGE_LENGTH ? `${value.slice(0, MAX_EVIDENCE_MESSAGE_LENGTH - 1)}…` : value;
}

function suggestedLabel(trace: RoutingTrace, names: ReadonlyMap<string, string>): string {
  if (trace.suggested.kind === "none") return "nothing";
  if (trace.suggested.kind === "no_project") return "no project";
  return names.get(trace.suggested.projectId ?? "") ?? "another project";
}

export function projectRoutingEvidence(
  projectId: string,
  traces: readonly RoutingTrace[],
  names: ReadonlyMap<string, string>,
): ProjectRoutingEvidence {
  const newest = [...traces].sort((left, right) => right.createdAt - left.createdAt);
  return {
    startedHere: newest
      .filter((trace) => trace.finalProjectId === projectId)
      .slice(0, MAX_EVIDENCE_PER_KIND)
      .map((trace) => ({ request: clip(trace.message), jevSuggested: suggestedLabel(trace, names) })),
    wronglySuggestedHere: newest
      .filter((trace) => trace.suggested.kind === "project" && trace.suggested.projectId === projectId && trace.finalProjectId !== projectId)
      .slice(0, MAX_EVIDENCE_PER_KIND)
      .map((trace) => ({
        request: clip(trace.message),
        userStartedIn: trace.finalProjectId ? names.get(trace.finalProjectId) ?? "another project" : "no project",
      })),
  };
}

export function hasRoutingEvidence(evidence: ProjectRoutingEvidence): boolean {
  return evidence.startedHere.length > 0 || evidence.wronglySuggestedHere.length > 0;
}

export function routingLearningFingerprint(evidence: ProjectRoutingEvidence): string {
  return createHash("sha256").update(JSON.stringify({ version: ROUTING_LEARNING_VERSION, evidence })).digest("hex");
}

export function routingLearningPrompt(input: {
  projectName: string;
  description: string;
  notFor: readonly string[];
  evidence: ProjectRoutingEvidence;
}): string {
  return [
    "You maintain routing guidance for one BB project.",
    "When the user starts a new chat, a router picks the project it should run in, or no project.",
    "A project is right only when the work needs that project's files, code, data, or tools.",
    "Below are the project's profile and the user's real routing history.",
    "startedHere lists requests the user started in this project, with what the router suggested.",
    "wronglySuggestedHere lists requests the router suggested for this project that the user started elsewhere.",
    "Write learnedFor: short phrases for the kinds of requests that belong in this project.",
    "Write learnedNotFor: short phrases for the kinds of requests the router wrongly sends here.",
    "Generalize into kinds of work. Do not copy requests. Leave out names, secrets, and one-off details.",
    "Only write a phrase the history supports. Do not repeat the profile's notFor entries. Empty lists are fine.",
    "",
    JSON.stringify({
      projectName: input.projectName,
      description: input.description,
      notFor: input.notFor,
      startedHere: input.evidence.startedHere,
      wronglySuggestedHere: input.evidence.wronglySuggestedHere,
    }),
  ].join("\n");
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.replace(/\s+/gu, " ").trim())
    .filter((value) => {
      const key = value.toLocaleLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function generateRoutingLearning(input: {
  apiKey: string;
  model: string;
  prompt: string;
  fetchImpl?: typeof fetch;
}): Promise<RoutingLearning> {
  const content = await requestOpenRouterJson({
    apiKey: input.apiKey,
    model: input.model,
    prompt: input.prompt,
    schemaName: "project_routing_learning",
    maxTokens: 600,
    fetchImpl: input.fetchImpl,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        learnedFor: { type: "array", items: { type: "string" }, maxItems: 6 },
        learnedNotFor: { type: "array", items: { type: "string" }, maxItems: 6 },
      },
      required: ["learnedFor", "learnedNotFor"],
    },
  });
  const parsed = routingLearningSchema.parse(content);
  return { learnedFor: unique(parsed.learnedFor), learnedNotFor: unique(parsed.learnedNotFor) };
}
