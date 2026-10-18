// Query tools for spec fences: Query("file", {path}), Query("commits", {}), and so on.
// The tool list agents see lives in app/spec/tools.ts; keep the two in step.
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { FileSourceError, containedPath, relativePath, storageRoot, workspaceRoot } from "../files.js";
import { parseFile } from "./data-parse.js";
import { SpecError } from "./errors.js";

/** `roots` limits Query("file") to these roots; by default it reads the workspace, thread storage, and /tmp. */
export type ToolCall = { threadId?: string; tool: string; args: Record<string, unknown>; roots?: readonly ReadRoot[] };
type Sdk = BbPluginApi["sdk"];

/** Query("file") reads at most this much. Pages keep data small; the host's own cap is far larger. */
export const FILE_MAX_BYTES = 2 * 1024 * 1024;
const PATCH_MAX_CHARS = 200_000;

const TOOLS: Record<string, (sdk: Sdk, threadId: string, args: Record<string, unknown>, roots?: readonly ReadRoot[]) => Promise<unknown>> = {
  file: (sdk, threadId, args, roots) => readFile(sdk, threadId, args.path, roots),
  changes: changes,
  commits: async (sdk, threadId, args) => {
    const env = await environmentOf(sdk, threadId);
    const status = await sdk.environments.status({ environmentId: env.id });
    if (status.outcome !== "available") throw new SpecError(status.outcome === "not_applicable" ? status.message : status.failure.message);
    const { branch, mergeBase } = status.workspace;
    const commits = (mergeBase?.commits ?? []).slice(0, limitOf(args.limit, 20, 100)).map((commit) => ({ sha: commit.sha, shortSha: commit.shortSha, subject: commit.subject, author: commit.authorName, date: iso(commit.authoredAt) }));
    return { branch: branch.currentBranch ?? env.branchName ?? "", base: mergeBase?.mergeBaseBranch ?? branch.defaultBranch ?? "", ahead: mergeBase?.aheadCount ?? 0, behind: mergeBase?.behindCount ?? 0, commits };
  },
  pull_request: async (sdk, threadId) => {
    const env = await environmentOf(sdk, threadId);
    const result = await sdk.environments.pullRequest({ environmentId: env.id });
    if (result.outcome === "absent") return { pullRequest: null, message: "This branch has no pull request." };
    if (result.outcome !== "available") throw new SpecError(result.message);
    const pr = result.pullRequest;
    return { pullRequest: {
      number: pr.number, title: pr.title, url: pr.url, state: pr.state, base: pr.baseRefName, head: pr.headRefName, updatedAt: pr.updatedAt,
      checks: { state: pr.checks?.state ?? null, passed: pr.checks?.passedCount ?? 0, failed: pr.checks?.failedCount ?? 0, pending: pr.checks?.pendingCount ?? 0, total: pr.checks?.totalCount ?? 0 },
      review: pr.review?.state ?? null, mergeable: pr.mergeability?.state ?? null, attention: pr.attention ?? null,
    }, message: "" };
  },
  threads: async (sdk, threadId, args) => {
    const { projectId } = await sdk.threads.get({ threadId });
    const rows = await sdk.threads.list({ projectId, limit: limitOf(args.limit, 20, 100) });
    return { threads: rows.map((thread) => ({ id: thread.id, title: thread.title || thread.titleFallback || "Untitled", status: thread.status, updatedAt: iso(thread.updatedAt), branch: thread.environmentBranchName ?? null, environment: thread.environmentName ?? null, waiting: Boolean(thread.hasPendingInteraction), current: thread.id === threadId })) };
  },
  environments: async (sdk, threadId) => {
    const thread = await sdk.threads.get({ threadId, include: "environment" });
    const current = "environment" in thread ? thread.environment?.id : undefined;
    const rows = await sdk.environments.list({ projectId: thread.projectId, limit: 100 });
    return { environments: rows.filter((env) => env.status !== "destroyed").map((env) => ({ id: env.id, name: env.name, branch: env.branchName ?? null, base: env.mergeBaseBranch ?? env.baseBranch ?? env.defaultBranch ?? null, status: env.status, path: env.path ?? null, worktree: Boolean(env.isWorktree), updatedAt: iso(env.updatedAt), current: env.id === current })) };
  },
};

export async function runTool(bb: BbPluginApi, call: ToolCall): Promise<unknown> {
  const run = Object.hasOwn(TOOLS, call.tool) ? TOOLS[call.tool] : undefined;
  if (!run) throw new SpecError(`Unknown tool "${call.tool}". Tools: ${Object.keys(TOOLS).join(", ")}.`);
  if (!call.threadId) throw new SpecError(`Query("${call.tool}") needs a thread, and this fence has none.`);
  try {
    return await run(bb.sdk, call.threadId, call.args ?? {}, call.roots);
  } catch (error) {
    if (error instanceof FileSourceError) throw new SpecError(error.message);
    throw error;
  }
}

const iso = (ms: number) => Number.isFinite(ms) ? new Date(ms).toISOString() : "";

function limitOf(raw: unknown, fallback: number, max: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.min(max, Math.floor(raw))) : fallback;
}

async function environmentOf(sdk: Sdk, threadId: string) {
  const thread = await sdk.threads.get({ threadId, include: "environment" });
  const env = "environment" in thread ? thread.environment : null;
  if (!env) throw new SpecError("This thread has no environment.");
  return env;
}

async function changes(sdk: Sdk, threadId: string) {
  const env = await environmentOf(sdk, threadId);
  const result = await sdk.environments.diffFiles({ environmentId: env.id, target: "uncommitted" });
  if (result.outcome !== "available") throw new SpecError(result.outcome === "not_applicable" ? result.message : result.failure.message);
  const patches = new Map(result.initialPatches.map((patch) => [patch.path, patch.patch]));
  let budget = PATCH_MAX_CHARS;
  const files = result.files.map((file) => {
    const patch = patches.get(file.path) ?? "";
    const keep = patch.length <= budget;
    if (keep) budget -= patch.length;
    return { path: file.path, previousPath: file.previousPath ?? null, status: file.changeKind, additions: file.additions ?? 0, deletions: file.deletions ?? 0, binary: Boolean(file.binary), patch: keep ? patch : "" };
  });
  return { files, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0), truncated: Boolean(result.truncated) };
}

/** The roots a file may come from: the workspace, thread storage, and /tmp on the workspace's host. */
export type ReadRoot = { name: string; rootPath: string; hostId: string };

/** Picks the root and checks the path. Relative paths resolve against the first root. Absolute ones take the deepest root that holds them. */
export function locate(roots: readonly ReadRoot[], raw: unknown): { root: ReadRoot; file: string } {
  const given = typeof raw === "string" ? raw.trim() : "";
  if (!given) throw new SpecError('Query("file") needs a path, like {path: "out/report.json"}.');
  if (!path.posix.isAbsolute(given)) return { root: roots[0], file: relativePath(given) };
  const absolute = path.posix.normalize(given);
  const match = roots
    .map((root) => ({ root, relative: path.posix.relative(path.posix.resolve(root.rootPath), absolute) }))
    .filter(({ relative }) => relative && relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))
    .sort((a, b) => b.root.rootPath.length - a.root.rootPath.length)[0];
  if (!match) throw new SpecError(`${given} is outside this thread's ${roots.map((root) => root.name).join(", ")}. Query("file") reads only there.`);
  return { root: match.root, file: relativePath(match.relative) };
}

async function threadRoots(sdk: Sdk, threadId: string): Promise<ReadRoot[]> {
  const [workspace, storage] = await Promise.all([workspaceRoot(sdk, threadId), storageRoot(sdk, threadId)]);
  return [
    ...(workspace ? [{ name: "workspace", rootPath: workspace.rootPath, hostId: workspace.hostId }] : []),
    { name: "thread storage", rootPath: storage.rootPath, hostId: storage.hostId },
    { name: "/tmp", rootPath: "/tmp", hostId: workspace?.hostId ?? storage.hostId },
  ];
}

async function readFile(sdk: Sdk, threadId: string, raw: unknown, only?: readonly ReadRoot[]) {
  const roots = only ?? await threadRoots(sdk, threadId);
  const { root, file } = locate(roots, raw);
  // rootPath makes the host realpath both sides, so a symlink cannot lead out of the root.
  const result = await sdk.files.read({ path: containedPath(root.rootPath, file), rootPath: root.rootPath, hostId: root.hostId }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) throw new SpecError(`No file at ${file} in the ${root.name}.`);
    throw error;
  });
  if (result.sizeBytes > FILE_MAX_BYTES) throw new SpecError(`${file} is ${Math.ceil(result.sizeBytes / 1024)} KB; Query("file") reads at most ${FILE_MAX_BYTES / 1024 / 1024} MB.`);
  if (result.contentEncoding !== "utf8") throw new SpecError(`${file} is not UTF-8 text.`);
  return parseFile(file, result.content);
}
