import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  exactProjectMatch,
  interpretProjectChoice,
  projectChoiceQuestion,
  type JevProjectChoiceAnswer,
  type ProjectRoutingCandidate,
  type ProjectRoutingHint,
} from "./project-router.js";
import {
  appendTrace,
  createTrace,
  matchSuggestion,
  normalizePrompt,
  routingExamples,
  type RecordedSuggestion,
  type RoutingTrace,
} from "./routing-trace.js";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_TIMEOUT_MS = 15_000;
const PROJECT_CATALOG_TTL_MS = 10 * 60 * 1_000;
const MAX_RECENT_SUGGESTIONS = 200;
const MAX_TIMELINE_PAGES = 4;
const ROUTING_TRACES_KEY = "routing-traces";

const taskRoutingHintsSchema = z.object({
  tasks: z.array(z.object({
    projectId: z.string().nullable(),
    identifier: z.string(),
    identifiers: z.array(z.string()),
    refs: z.array(z.object({
      identifier: z.string(),
      url: z.string().nullable(),
      relatedUrls: z.array(z.string()),
      repository: z.string().nullable(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

export type ProjectSuggestion = ReturnType<typeof interpretProjectChoice>;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw new Error("Request timed out");
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Suggests a project for a new-thread draft with Jev, and records where the user
 * actually started the thread so Projects can learn from hits and misses.
 */
export function createJevRouting(bb: BbPluginApi, deps: {
  apiKey: () => Promise<string | undefined>;
  loadCatalog: () => Promise<ProjectRoutingCandidate[]>;
}) {
  let catalogCache: { expiresAt: number; projects: ProjectRoutingCandidate[] } | null = null;
  let catalogLoad: Promise<ProjectRoutingCandidate[]> | null = null;
  let taskHintsCache: { expiresAt: number; hints: ProjectRoutingHint[] } | null = null;
  const recentSuggestions: RecordedSuggestion[] = [];

  function resetCatalog() {
    catalogCache = null;
  }

  async function catalog(): Promise<ProjectRoutingCandidate[]> {
    if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.projects;
    catalogLoad ??= deps.loadCatalog().then((projects) => {
      catalogCache = { expiresAt: Date.now() + PROJECT_CATALOG_TTL_MS, projects };
      bb.log.info(`Prepared ${projects.length} projects for Jev routing`);
      return projects;
    }).finally(() => { catalogLoad = null; });
    return catalogLoad;
  }

  async function taskHints(): Promise<ProjectRoutingHint[]> {
    if (taskHintsCache && taskHintsCache.expiresAt > Date.now()) return taskHintsCache.hints;
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "task-workspaces", method: "listTasks", input: null, outputSchema: taskRoutingHintsSchema,
      });
      const byProject = new Map<string, string[]>();
      for (const task of result.tasks) {
        if (!task.projectId) continue;
        const values = [
          task.identifier,
          ...task.identifiers,
          ...task.refs.flatMap((ref) => [ref.identifier, ref.url, ref.repository, ...ref.relatedUrls]),
        ].filter((value): value is string => typeof value === "string" && value.trim().length >= 4);
        byProject.set(task.projectId, [...(byProject.get(task.projectId) ?? []), ...values]);
      }
      const hints = [...byProject].map(([projectId, values]) => ({ projectId, values: [...new Set(values)] }));
      taskHintsCache = { expiresAt: Date.now() + 30_000, hints };
      return hints;
    } catch {
      return [];
    }
  }

  async function readTraces(): Promise<RoutingTrace[]> {
    const stored = await bb.storage.kv.get<{ version: 1; traces: RoutingTrace[] }>(ROUTING_TRACES_KEY);
    return stored?.version === 1 ? stored.traces : [];
  }

  async function routeProject(prompt: string): Promise<ProjectSuggestion> {
    const candidates = await catalog();
    if (!candidates.length) {
      return { suggestion: null, alternatives: [], noProject: null, confidence: 0, autoApply: false };
    }
    const examples = routingExamples(await readTraces());
    const projects = candidates.map((project) => ({ ...project, recentRequests: examples.get(project.id) ?? [] }));
    const exact = exactProjectMatch(prompt, projects, await taskHints());
    if (exact) {
      const suggestion = { ...exact, probability: 1 };
      return { suggestion, alternatives: [suggestion], noProject: null, confidence: 1, autoApply: true };
    }
    const apiKey = (await deps.apiKey())?.trim();
    if (!apiKey) throw new Error("Jev API key missing. Enter it in Projects settings.");
    let response: Response | null = null;
    for (const retryDelay of [0, 300, 900]) {
      if (retryDelay) await delay(retryDelay);
      response = await fetchWithTimeout(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "jev-latest",
          state: prompt,
          questions: { project: projectChoiceQuestion(projects, examples.get("no_project") ?? []) },
        }),
      }, JEV_TIMEOUT_MS);
      if (response.status !== 429 && response.status !== 529) break;
    }
    if (!response?.ok) throw new Error(`Jev returned HTTP ${response?.status ?? "unknown"}`);
    const body = await response.json() as { answers?: { project?: JevProjectChoiceAnswer } };
    const result = interpretProjectChoice(projects, body.answers?.project);
    bb.log.info(
      result.suggestion
        ? `Jev routed the new thread to ${result.suggestion.name} (${Math.round(result.suggestion.probability * 100)}%, confidence ${Math.round(result.confidence * 100)}%)`
        : result.noProject
          ? `Jev suggested no project for the new thread (${Math.round(result.noProject.probability * 100)}%, confidence ${Math.round(result.confidence * 100)}%)`
          : `Jev found no project match for the new thread (confidence ${Math.round(result.confidence * 100)}%)`,
    );
    return result;
  }

  async function suggestProject(prompt: string): Promise<ProjectSuggestion> {
    const result = await routeProject(prompt);
    recentSuggestions.unshift({
      prompt: normalizePrompt(prompt),
      at: Date.now(),
      kind: result.suggestion ? "project" : result.noProject ? "no_project" : "none",
      projectId: result.suggestion?.id ?? null,
      probability: result.suggestion?.probability ?? result.noProject?.probability ?? 0,
      confidence: result.confidence,
      autoApply: result.autoApply,
    });
    recentSuggestions.splice(MAX_RECENT_SUGGESTIONS);
    return result;
  }

  async function firstUserMessage(threadId: string): Promise<string | null> {
    let first: { text: string; at: number } | null = null;
    let beforeAnchorId: string | undefined;
    let beforeAnchorSeq: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_TIMELINE_PAGES; pageIndex += 1) {
      const timeline = await bb.sdk.threads.timeline({
        threadId,
        includeNestedRows: "false",
        segmentLimit: "100",
        ...(beforeAnchorId && beforeAnchorSeq ? { beforeAnchorId, beforeAnchorSeq } : {}),
      });
      for (const row of timeline.rows) {
        if (row.kind !== "conversation" || row.role !== "user" || !row.text.trim()) continue;
        const at = new Date(row.createdAt).getTime();
        if (!first || at < first.at) first = { text: row.text, at };
      }
      const cursor = timeline.timelinePage.olderCursor;
      if (!cursor) break;
      beforeAnchorId = cursor.anchorId;
      beforeAnchorSeq = String(cursor.anchorSeq);
    }
    return first?.text ?? null;
  }

  // A thread started from the new-thread composer, waiting for its first message.
  const pendingRoutedThreads = new Map<string, number>();
  let personalProjectId: string | null = null;

  async function recordRoutingTrace(threadId: string, projectId: string, createdAt: number) {
    const message = await firstUserMessage(threadId);
    if (!message) return false;
    const suggestion = matchSuggestion(message, createdAt, recentSuggestions);
    if (!suggestion) return true;
    personalProjectId ??= (await bb.sdk.projects.list({ includePersonal: true }))
      .find((project) => project.kind === "personal")?.id ?? null;
    const trace = createTrace({
      threadId,
      createdAt,
      message,
      suggestion,
      finalProjectId: projectId === personalProjectId ? null : projectId,
    });
    await bb.storage.kv.set(ROUTING_TRACES_KEY, { version: 1, traces: appendTrace(await readTraces(), trace) });
    bb.log.info(`Recorded a Jev routing ${trace.outcome} for thread ${threadId}`);
    return true;
  }

  // Runs on active and again on idle, in case the first message was not readable yet.
  function captureRoutingTrace(thread: { id: string; projectId: string }, finalAttempt: boolean) {
    const createdAt = pendingRoutedThreads.get(thread.id);
    if (createdAt === undefined) return;
    pendingRoutedThreads.delete(thread.id);
    void recordRoutingTrace(thread.id, thread.projectId, createdAt).then((done) => {
      if (!done && !finalAttempt) pendingRoutedThreads.set(thread.id, createdAt);
    }).catch((cause) => {
      bb.log.warn(`Could not record the Jev routing trace for ${thread.id}: ${errorText(cause)}`);
    });
  }

  bb.events.on("thread.created", ({ thread }) => {
    if (thread.parentThreadId || thread.sourceThreadId || thread.originPluginId || thread.originKind) return;
    const cutoff = Date.now() - 30 * 60_000;
    for (const [threadId, createdAt] of pendingRoutedThreads) if (createdAt < cutoff) pendingRoutedThreads.delete(threadId);
    pendingRoutedThreads.set(thread.id, thread.createdAt);
  });
  bb.events.on("thread.active", ({ thread }) => captureRoutingTrace(thread, false));
  bb.events.on("thread.idle", ({ thread }) => captureRoutingTrace(thread, true));

  return { suggestProject, readTraces, resetCatalog };
}
