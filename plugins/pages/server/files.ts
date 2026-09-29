// Reads workspace and thread-storage files for file pages.
// Path rules and root resolution follow BB core's inline-vis builtin.
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MAX_SOURCE_FILE_BYTES, type SourceKey } from "../contract.js";

export type FileSource = "workspace" | "thread-storage";
export type FileKind = "html" | "markdown";
type Sdk = BbPluginApi["sdk"];

const KINDS: Record<string, FileKind> = { ".html": "html", ".htm": "html", ".md": "markdown", ".markdown": "markdown" };

export class FileSourceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413 = 400) { super(message); }
}

export function fileKind(file: string): FileKind {
  const kind = KINDS[path.posix.extname(file).toLowerCase()];
  if (!kind) throw new FileSourceError(`The file must end with .html, .htm, .md, or .markdown: ${file}`);
  return kind;
}

/** Normalizes a source-relative path. Rejects absolute paths, traversal, and unsupported extensions. */
export function relativeFile(raw: string): string {
  const file = raw.trim();
  if (!file) throw new FileSourceError("The file path is empty.");
  if (path.isAbsolute(file) || path.posix.isAbsolute(file) || /^[a-zA-Z]:[\\/]/u.test(file) || file.startsWith("\\\\")) {
    throw new FileSourceError(`The file path must be relative to its source, not absolute: ${file}`);
  }
  const slashed = file.replace(/\\/gu, "/");
  if (slashed.split("/").includes("..")) throw new FileSourceError(`The file path must not contain "..": ${file}`);
  const normalized = path.posix.normalize(slashed);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new FileSourceError(`The file path must stay inside its source: ${file}`);
  }
  fileKind(normalized);
  return normalized;
}

/** Joins a checked relative path to its root and confirms the result stays inside the root. */
export function containedPath(rootPath: string, file: string): string {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FileSourceError(`The file path must stay inside its source: ${file}`);
  }
  return target;
}

export type FileRoot = { source: FileSource; rootPath: string; hostId: string; keyPrefix: string };

/**
 * A thread's roots barely change, but every live preview, resolveFile, and publish needs them.
 * Remember each lookup briefly per SDK instance, and share one in-flight lookup between callers.
 * Failures are not remembered.
 */
export const ROOT_CACHE_MS = 30_000;
const rootCache = new WeakMap<Sdk, Map<string, { expires: number; value: Promise<unknown> }>>();

function remembered<T>(sdk: Sdk, key: string, load: () => Promise<T>): Promise<T> {
  let cache = rootCache.get(sdk);
  if (!cache) rootCache.set(sdk, cache = new Map());
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;
  if (cache.size >= 500) for (const [old, entry] of cache) if (entry.expires <= now) cache.delete(old);
  const value = load();
  const entry = { expires: now + ROOT_CACHE_MS, value };
  cache.set(key, entry);
  value.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return value;
}

export function workspaceRoot(sdk: Sdk, threadId: string): Promise<(FileRoot & { projectId: string }) | null> {
  return remembered(sdk, `workspace:${threadId}`, async () => {
    const thread = await sdk.threads.get({ threadId, include: "environment" });
    const environment = "environment" in thread ? thread.environment : null;
    if (!environment?.path || !environment.hostId) return null;
    return { source: "workspace" as const, rootPath: environment.path, hostId: environment.hostId, keyPrefix: `workspace:${environment.id}:`, projectId: thread.projectId };
  });
}

export function storageRoot(sdk: Sdk, threadId: string): Promise<FileRoot> {
  return remembered(sdk, `storage:${threadId}`, async () => {
    const location = await sdk.threads.storageLocation({ threadId });
    return { source: "thread-storage" as const, rootPath: location.storageRootPath, hostId: location.hostId, keyPrefix: `storage:${threadId}:` };
  });
}

export async function resolveRoot(sdk: Sdk, threadId: string, source: FileSource): Promise<FileRoot> {
  if (source === "thread-storage") return storageRoot(sdk, threadId);
  const root = await workspaceRoot(sdk, threadId);
  if (!root) throw new FileSourceError("This thread has no workspace. Use source \"thread-storage\" or run from a thread with an environment.");
  return root;
}

export const sourceKeyOf = (root: FileRoot, file: string) => `${root.keyPrefix}${file}` as SourceKey;

export type SourceFile = { file: string; source: FileSource; sourceKey: SourceKey; kind: FileKind; content: string };

export async function readSourceFile(sdk: Sdk, threadId: string, rawFile: string, source: FileSource): Promise<SourceFile> {
  const file = relativeFile(rawFile);
  const root = await resolveRoot(sdk, threadId, source);
  const result = await sdk.files.read({ path: containedPath(root.rootPath, file), rootPath: root.rootPath, hostId: root.hostId }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) throw new FileSourceError(`File not found in ${source}: ${file}`, 404);
    throw error;
  });
  if (result.sizeBytes > MAX_SOURCE_FILE_BYTES) throw new FileSourceError(`The file is too large (${result.sizeBytes} bytes; the limit is ${MAX_SOURCE_FILE_BYTES}).`, 413);
  if (result.contentEncoding !== "utf8") throw new FileSourceError(`The file is not valid UTF-8 text: ${file}`);
  return { file, source, sourceKey: sourceKeyOf(root, file), kind: fileKind(file), content: result.content };
}

/**
 * Maps a path given to the CLI to a source and a source-relative path, using
 * the calling thread's roots. Relative paths resolve against `cwd`.
 */
export async function mapCliPath(sdk: Sdk, threadId: string, rawPath: string, cwd: string | undefined): Promise<{ source: FileSource; file: string }> {
  const given = rawPath.trim();
  if (!path.posix.isAbsolute(given) && !cwd) throw new FileSourceError("Use an absolute file path. The working directory is unknown.");
  const absolute = path.posix.resolve(cwd ?? "/", given);
  const [storage, workspace] = await Promise.all([storageRoot(sdk, threadId), workspaceRoot(sdk, threadId)]);
  const roots: FileRoot[] = workspace ? [storage, workspace] : [storage];
  const matches = roots
    .map((root) => ({ root, relative: path.posix.relative(path.posix.resolve(root.rootPath), absolute) }))
    .filter(({ relative }) => relative && relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))
    .sort((a, b) => b.root.rootPath.length - a.root.rootPath.length);
  const match = matches[0];
  if (!match) {
    const places = roots.map((root) => `${root.source} (${root.rootPath})`).join(" or ");
    throw new FileSourceError(`${absolute} is outside this thread's ${places}. Move the file into one of them.`);
  }
  return { source: match.root.source, file: relativeFile(match.relative) };
}
