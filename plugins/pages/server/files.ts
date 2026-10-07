// Reads workspace and thread-storage files and folders for file pages.
// Path rules and root resolution follow BB core's inline-vis builtin.
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MAX_FOLDER_BYTES, MAX_FOLDER_FILES, MAX_PAGE_HTML_BYTES, MAX_SOURCE_FILE_BYTES, type SourceKey } from "../contract.js";

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

/** Normalizes a source-relative path. Rejects absolute paths and traversal. */
export function relativePath(raw: string): string {
  const file = raw.trim();
  if (!file) throw new FileSourceError("The path is empty.");
  if (path.isAbsolute(file) || path.posix.isAbsolute(file) || /^[a-zA-Z]:[\\/]/u.test(file) || file.startsWith("\\\\")) {
    throw new FileSourceError(`The path must be relative to its source, not absolute: ${file}`);
  }
  const slashed = file.replace(/\\/gu, "/");
  if (slashed.split("/").includes("..")) throw new FileSourceError(`The path must not contain "..": ${file}`);
  const normalized = path.posix.normalize(slashed).replace(/\/$/u, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new FileSourceError(`The path must stay inside its source: ${file}`);
  }
  return normalized;
}

/** A source-relative .html/.md file path. */
export function relativeFile(raw: string): string {
  const file = relativePath(raw);
  fileKind(file);
  return file;
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

const notFound = (message: string) => (error: unknown) => {
  if (typeof error === "object" && error !== null && "status" in error && error.status === 404) throw new FileSourceError(message, 404);
  throw error;
};

export async function readSourceFile(sdk: Sdk, threadId: string, rawFile: string, source: FileSource): Promise<SourceFile> {
  const file = relativeFile(rawFile);
  const root = await resolveRoot(sdk, threadId, source);
  const result = await sdk.files.read({ path: containedPath(root.rootPath, file), rootPath: root.rootPath, hostId: root.hostId }).catch(notFound(`File not found in ${source}: ${file}`));
  if (result.sizeBytes > MAX_SOURCE_FILE_BYTES) throw new FileSourceError(`The file is too large (${result.sizeBytes} bytes; the limit is ${MAX_SOURCE_FILE_BYTES}).`, 413);
  if (result.contentEncoding !== "utf8") throw new FileSourceError(`The file is not valid UTF-8 text: ${file}`);
  return { file, source, sourceKey: sourceKeyOf(root, file), kind: fileKind(file), content: result.content };
}

/** Prefixes our own routes and uploads use. A folder file must not shadow them. */
export const RESERVED_FOLDER_PREFIXES = ["_page/"];

/**
 * Checks a folder's file paths before any byte is read (rules from Superset's validateAssetPaths):
 * relative, forward slashes, no control characters, no empty, "." or ".." segments, no duplicates,
 * nothing under a reserved prefix, and at most MAX_FOLDER_FILES files.
 */
export function validateFolderPaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  const refuse = (file: string, reason: string): never => { throw new FileSourceError(`Folder file ${JSON.stringify(file)} ${reason}`); };
  for (const file of paths) {
    if (seen.has(file)) refuse(file, "appears twice.");
    seen.add(file);
    if (file.startsWith("/") || file.includes("\\")) refuse(file, "must be relative, with forward slashes.");
    // eslint-disable-next-line no-control-regex -- refusing them is the point
    if (/[\x00-\x1f\x7f]/u.test(file)) refuse(file, "contains control characters. Rename it.");
    if (file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) refuse(file, "must not contain empty, \".\" or \"..\" segments.");
    if (RESERVED_FOLDER_PREFIXES.some((prefix) => file.toLowerCase().startsWith(prefix))) refuse(file, `is under ${RESERVED_FOLDER_PREFIXES.join(", ")}, which Pages reserves for its theme and runtime. Rename that folder.`);
  }
  if (!seen.has("index.html")) throw new FileSourceError("The folder has no index.html at its top level. Add one; it is the page.");
  if (paths.length > MAX_FOLDER_FILES) throw new FileSourceError(`The folder has ${paths.length} files; the limit is ${MAX_FOLDER_FILES}. Remove unused files (dotfiles and node_modules are skipped).`, 413);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".wasm": "application/wasm",
};
export const contentTypeOf = (file: string, hostMime?: string) => CONTENT_TYPES[path.posix.extname(file).toLowerCase()] ?? hostMime ?? "application/octet-stream";

export type FolderFile = { path: string; contentType: string; bytes: Buffer };
export type SourceFolder = { dir: string; source: FileSource; sourceKey: SourceKey; index: string; files: FolderFile[] };

/** Reads a folder with index.html. `files` excludes index.html, which is returned as text. */
export async function readSourceFolder(sdk: Sdk, threadId: string, rawDir: string, source: FileSource): Promise<SourceFolder> {
  const dir = relativePath(rawDir);
  const root = await resolveRoot(sdk, threadId, source);
  const absolute = containedPath(root.rootPath, dir);
  const listed = await sdk.files.list({ path: absolute, hostId: root.hostId, limit: MAX_FOLDER_FILES + 1, includeHidden: false, excludeNames: ["node_modules"] }).catch(notFound(`Folder not found in ${source}: ${dir}`));
  if (!listed.files.length) throw new FileSourceError(`Folder not found or empty in ${source}: ${dir}`, 404);
  if (listed.truncated) throw new FileSourceError(`The folder has more than ${MAX_FOLDER_FILES} files. Remove unused files (dotfiles and node_modules are skipped).`, 413);
  // Dotfiles, dot-folders, and node_modules never become part of a page. The host skips them already; this guards other hosts.
  const paths = listed.files.map((file) => file.path).filter((file) => !file.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules")).sort();
  validateFolderPaths(paths);

  const read: FolderFile[] = [];
  let total = 0;
  // A few reads at a time: one host round trip each, and the size limit stops the rest early.
  for (let at = 0; at < paths.length; at += 8) {
    const batch = await Promise.all(paths.slice(at, at + 8).map(async (file) => {
      const result = await sdk.files.read({ path: containedPath(absolute, file), rootPath: root.rootPath, hostId: root.hostId }).catch(notFound(`File disappeared while publishing: ${dir}/${file}`));
      return { path: file, contentType: contentTypeOf(file, result.mimeType), bytes: Buffer.from(result.content, result.contentEncoding) };
    }));
    for (const file of batch) {
      total += file.bytes.byteLength;
      if (total > MAX_FOLDER_BYTES) throw new FileSourceError(`The folder is larger than ${MAX_FOLDER_BYTES / 1024 / 1024} MB. Shrink or remove large files (compress images, drop unused media).`, 413);
      read.push(file);
    }
  }
  const index = read.find((file) => file.path === "index.html")!;
  if (index.bytes.byteLength > MAX_PAGE_HTML_BYTES) throw new FileSourceError(`index.html is too large (${index.bytes.byteLength} bytes; the limit is ${MAX_PAGE_HTML_BYTES}).`, 413);
  return { dir, source, sourceKey: sourceKeyOf(root, dir), index: index.bytes.toString("utf8"), files: read.filter((file) => file !== index) };
}

/**
 * Maps a path given to the CLI to a source and a source-relative path, using
 * the calling thread's roots. Relative paths resolve against `cwd`.
 */
export async function mapCliPath(sdk: Sdk, threadId: string, rawPath: string, cwd: string | undefined): Promise<{ source: FileSource; file: string }> {
  const given = rawPath.trim();
  if (!path.posix.isAbsolute(given) && !cwd) throw new FileSourceError("Use an absolute path. The working directory is unknown.");
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
    throw new FileSourceError(`${absolute} is outside this thread's ${places}. Move it into one of them.`);
  }
  return { source: match.root.source, file: relativePath(match.relative) };
}
