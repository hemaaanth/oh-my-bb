// Server executors for the thread tools (SPEC §11.6). Each one returns the
// result string or throws an Error with a one-line reason. Owned by P1.
import { LIST_THREADS } from "../../shared/constants.js";
import type { ToolContext } from "../../shared/contract.js";
import type { ServerContext } from "../context.js";
import { relativeTime, threadTitle } from "./live.js";
import { threadOutcome } from "./outcome.js";
import { providersFor, resolveModel, routingTarget } from "./resolve.js";

export type ToolArgs = Record<string, unknown>;

/** Latest assistant output in a read_thread result is clipped to this. */
export const READ_OUTPUT_MAX = 4000;
/** show_diff lists at most this many files. */
export const DIFF_FILES_MAX = 50;

export const compact = (value: unknown): string => JSON.stringify(value);

export function requireString(args: ToolArgs, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  return value.trim();
}

export function optionalString(args: ToolArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

async function getThread(ctx: ServerContext, threadId: string) {
  try {
    return await ctx.bb.sdk.threads.get({ threadId, include: "environment" });
  } catch {
    throw new Error(`There is no thread with id ${threadId}. Look it up with list_threads or search_threads.`);
  }
}

async function projectName(ctx: ServerContext, projectId: string | null): Promise<string> {
  if (!projectId) return "no project";
  try {
    const projects = await ctx.bb.sdk.projects.list();
    return projects.find((project) => project.id === projectId)?.name ?? "Unknown project";
  } catch {
    return "Unknown project";
  }
}

/** The machine name from a thread read with `include: "environment"`. */
export function machineOf(thread: object): string | null {
  const withHost = thread as { host?: { name?: string } | null; environmentHostName?: string | null };
  return withHost.host?.name ?? withHost.environmentHostName ?? null;
}

/** On a phone call there is no screen, so the server opens the thread in the BB app window. */
export async function openOnDesktop(ctx: ServerContext, threadId: string, context: ToolContext): Promise<void> {
  if (context.channel !== "phone" || context.focus === false) return;
  try {
    await ctx.bb.sdk.threads.open({ threadId, file: null });
  } catch (error) {
    ctx.bb.log.info(`Dispatch could not open the thread in the app: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

// ---------------------------------------------------------------------------
// Projects, machines, providers

export async function listProjects(ctx: ServerContext): Promise<string> {
  const projects = await ctx.bb.sdk.projects.list();
  return compact(projects.map((project) => ({ id: project.id, name: project.name, personal: project.kind === "personal" })));
}

export async function listMachines(ctx: ServerContext, args: ToolArgs, context: ToolContext): Promise<string> {
  const sdk = ctx.bb.sdk;
  const projectId = optionalString(args, "project_id") ?? context.projectId;
  const [hosts, projects] = await Promise.all([sdk.hosts.list(), projectId ? sdk.projects.list() : Promise.resolve([])]);
  const project = projectId ? projects.find((entry) => entry.id === projectId) : undefined;
  if (projectId && !project && optionalString(args, "project_id")) throw new Error(`There is no project with id ${projectId}.`);
  return compact({
    ...(project ? { project: project.name } : {}),
    machines: hosts.map((host) => ({
      id: host.id,
      name: host.name,
      status: host.status,
      ...(project
        ? {
            holdsProject: project.sources.some((source) => source.hostId === host.id),
            isDefault: project.sources.some((source) => source.hostId === host.id && source.isDefault),
          }
        : {}),
    })),
  });
}

// ---------------------------------------------------------------------------
// Threads

export async function listThreads(ctx: ServerContext, args: ToolArgs, now = Date.now()): Promise<string> {
  const sdk = ctx.bb.sdk;
  const requested = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : LIST_THREADS.default;
  const limit = Math.min(LIST_THREADS.max, Math.max(1, requested));
  const projectId = optionalString(args, "project_id");
  const archived = args.archived === true;
  const [rows, projects] = await Promise.all([
    sdk.threads.list({ archived, limit: limit * 2, ...(projectId ? { projectId } : {}) }),
    sdk.projects.list(),
  ]);
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const threads = rows
    .filter((row) => row.visibility !== "hidden")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      title: threadTitle(row),
      status: row.runtime.displayStatus,
      project: names.get(row.projectId) ?? "Unknown project",
      lastActive: relativeTime(row.updatedAt, now),
    }));
  return compact(threads);
}

export async function searchThreads(ctx: ServerContext, args: ToolArgs): Promise<string> {
  const query = requireString(args, "query");
  const found = await ctx.bb.sdk.threads.search({ query, limitPerGroup: "20" });
  const pick = (results: typeof found.active.results, archived: boolean) =>
    results
      .filter((result) => result.thread.visibility !== "hidden")
      .map((result) => ({ id: result.thread.id, title: threadTitle(result.thread), ...(archived ? { archived: true } : {}) }));
  return compact([...pick(found.active.results, false), ...pick(found.archived.results, true)]);
}

export async function readThread(ctx: ServerContext, args: ToolArgs): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const thread = await getThread(ctx, threadId);
  const [{ output }, project] = await Promise.all([ctx.bb.sdk.threads.output({ threadId }), projectName(ctx, thread.projectId)]);
  const result: Record<string, unknown> = {
    id: thread.id,
    title: threadTitle(thread),
    status: thread.runtime.displayStatus,
    project,
    machine: machineOf(thread) ?? "Unknown machine",
  };
  if (output && output.trim() !== "") {
    result.latestOutput = clip(output.trim(), READ_OUTPUT_MAX);
  } else {
    const outcome = await threadOutcome(ctx, threadId);
    result.lastOutcome = outcome ?? { kind: "none", summary: "The thread has no output yet." };
  }
  return compact(result);
}

export async function getThreadError(ctx: ServerContext, args: ToolArgs): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const thread = await getThread(ctx, threadId);
  const outcome = await threadOutcome(ctx, threadId, { errorsOnly: true });
  if (!outcome) return compact({ id: thread.id, title: threadTitle(thread), error: null, summary: "no error" });
  return compact({ id: thread.id, title: threadTitle(thread), ...outcome });
}

// A change verb near a configuration noun. Matches "switch to the opus model",
// "change the provider", "move this to my laptop machine".
const CONFIG_VERBS = "switch|change|swap|set|move|use|put|run";
const CONFIG_NOUNS = "model|provider|machine|host";
const CONFIG_REQUEST = new RegExp(
  `\\b(${CONFIG_VERBS})\\b.{0,40}\\b(${CONFIG_NOUNS})s?\\b|\\b(${CONFIG_NOUNS})s?\\b.{0,20}\\b(${CONFIG_VERBS})\\b`,
  "is",
);

/** True when a message asks to change the thread's model, provider, or machine. */
export function isConfigurationRequest(message: string): boolean {
  return CONFIG_REQUEST.test(message);
}

export const CONFIG_REFUSAL =
  "send_to_thread cannot change a thread's model, provider, or machine. Use set_thread_model to change the model. For another provider or machine, start a new thread with start_thread.";

export async function sendToThread(ctx: ServerContext, args: ToolArgs, context: ToolContext): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const message = requireString(args, "message");
  if (isConfigurationRequest(message)) throw new Error(CONFIG_REFUSAL);
  const thread = await getThread(ctx, threadId);
  await ctx.bb.sdk.threads.send({ threadId, input: [{ type: "text", text: message, mentions: [] }], mode: "auto" });
  await openOnDesktop(ctx, threadId, context);
  const hidden = args.quiet === true || context.focus === false;
  return compact({
    threadId,
    title: threadTitle(thread),
    sent: true,
    ...(hidden ? { note: "The thread was not brought on screen." } : {}),
  });
}

export async function setThreadModel(ctx: ServerContext, args: ToolArgs): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const wanted = requireString(args, "model");
  const thread = await getThread(ctx, threadId);
  const target = routingTarget({ hostId: null, environmentId: thread.environmentId, project: null });
  const providers = await providersFor(ctx, target, thread.providerId);
  let chosen;
  try {
    chosen = resolveModel(wanted, providers);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The model was not found.";
    throw new Error(`${reason} A thread keeps its provider; for a model from another provider, start a new thread.`);
  }
  await ctx.bb.sdk.threads.update({ threadId, model: chosen.model.id });
  return compact({ threadId, title: threadTitle(thread), provider: chosen.provider.displayName, model: chosen.model.displayName });
}

export async function stopThread(ctx: ServerContext, args: ToolArgs): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const thread = await getThread(ctx, threadId);
  await ctx.bb.sdk.threads.stop({ threadId });
  return compact({ threadId, title: threadTitle(thread), stopped: true });
}

export async function archiveThread(ctx: ServerContext, args: ToolArgs): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const thread = await getThread(ctx, threadId);
  await ctx.bb.sdk.threads.archiveAll({ threadId });
  return compact({ threadId, title: threadTitle(thread), archived: true, note: "Its child threads were archived too." });
}

export async function renameThread(ctx: ServerContext, args: ToolArgs): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const title = requireString(args, "title");
  await getThread(ctx, threadId);
  await ctx.bb.sdk.threads.update({ threadId, title });
  return compact({ threadId, title });
}

export async function showDiff(ctx: ServerContext, args: ToolArgs, context: ToolContext): Promise<string> {
  const threadId = requireString(args, "thread_id");
  const thread = await getThread(ctx, threadId);
  const base = {
    threadId,
    title: threadTitle(thread),
    ...(context.focus === false ? { note: "The thread was not brought on screen." } : {}),
  };
  if (!thread.environmentId) return compact({ ...base, files: [], summary: "The thread has no workspace yet, so there are no changes." });
  const diff = await ctx.bb.sdk.environments.diffFiles({ environmentId: thread.environmentId, target: "uncommitted" });
  await openOnDesktop(ctx, threadId, context);
  if (diff.outcome === "not_applicable") return compact({ ...base, files: [], summary: diff.message });
  if (diff.outcome === "unavailable") throw new Error(`The changes for "${base.title}" are not available: ${diff.failure.message}`);
  const files = diff.files.slice(0, DIFF_FILES_MAX).map((file) => ({
    path: file.path,
    change: file.changeKind,
    additions: file.additions,
    deletions: file.deletions,
    ...(file.binary ? { binary: true } : {}),
  }));
  const additions = diff.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diff.files.reduce((sum, file) => sum + file.deletions, 0);
  return compact({
    ...base,
    totals: { files: diff.files.length, additions, deletions },
    files,
    ...(diff.truncated || diff.files.length > files.length ? { truncated: true } : {}),
  });
}
