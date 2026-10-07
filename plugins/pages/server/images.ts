// Inlines a page's local images as data: URIs, at publish and in the live preview.
// Relative paths resolve against the page's folder; absolute paths must sit
// inside the thread's workspace or thread storage.
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MAX_PAGE_HTML_BYTES } from "../contract.js";
import { dataUri, findLocalImages, isImageBytes, replaceImages, type ImageRef } from "../render/images.js";
import { FileSourceError, containedPath, resolveRoot, storageRoot, workspaceRoot, type FileRoot, type FileSource } from "./files.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIB = 1024 * 1024;
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;
type Sdk = BbPluginApi["sdk"];
type Image = { uri: string } | { problem: string };

const outside = (file: string, root: string) => {
  const relative = path.posix.relative(path.posix.resolve(root), file);
  return !relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative);
};

/** The root and root-relative path an image reference names, or why it cannot be used. */
async function locate(sdk: Sdk, threadId: string, page: { file: string; source: FileSource }, ref: string): Promise<{ root: FileRoot; file: string } | { problem: string }> {
  const slashed = ref.replace(/\\/gu, "/");
  if (path.posix.isAbsolute(slashed)) {
    const absolute = path.posix.normalize(slashed);
    const [storage, workspace] = await Promise.all([storageRoot(sdk, threadId), workspaceRoot(sdk, threadId)]);
    const root = [storage, ...(workspace ? [workspace] : [])]
      .filter((candidate) => !outside(absolute, candidate.rootPath))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    if (!root) return { problem: "is outside this thread's workspace and thread storage. Copy the image next to the page and use a relative path." };
    return { root, file: path.posix.relative(path.posix.resolve(root.rootPath), absolute) };
  }
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(page.file), slashed));
  if (file === ".." || file.startsWith("../")) return { problem: `resolves outside the ${page.source}. Keep images inside it, next to the page.` };
  return { root: await resolveRoot(sdk, threadId, page.source), file };
}

async function readImage(sdk: Sdk, threadId: string, page: { file: string; source: FileSource }, ref: string): Promise<Image> {
  const place = await locate(sdk, threadId, page, ref);
  if ("problem" in place) return place;
  const { root, file } = place;
  let read;
  try {
    read = await sdk.files.read({ path: containedPath(root.rootPath, file), rootPath: root.rootPath, hostId: root.hostId });
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return { problem: `was not found (looked for ${file} in ${root.source}). Relative paths start at the page's folder.` };
    if (error instanceof FileSourceError) return { problem: error.message };
    return { problem: `could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (read.sizeBytes > MAX_IMAGE_BYTES) return { problem: `is ${mib(read.sizeBytes)}; each image must be at most ${mib(MAX_IMAGE_BYTES)}. Resize or compress it.` };
  const bytes = Buffer.from(read.content, read.contentEncoding === "base64" ? "base64" : "utf8");
  if (!isImageBytes(bytes)) return { problem: "is not a PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or SVG image." };
  return { uri: dataUri(file, bytes) };
}

/**
 * Replaces local image references with data: URIs, so the page is self-contained.
 * Strict (publish): any unusable image throws one FileSourceError listing every problem.
 * Otherwise (live preview): unusable images stay as written and show as broken.
 */
export async function inlineLocalImages(sdk: Sdk, threadId: string, page: { file: string; source: FileSource }, html: string, options: { strict: boolean }): Promise<string> {
  const refs = findLocalImages(html);
  if (!refs.length) return html;
  const byPath = new Map<string, ImageRef[]>();
  for (const ref of refs) byPath.set(ref.path, [...(byPath.get(ref.path) ?? []), ref]);
  const images = await Promise.all([...byPath.keys()].map(async (ref) => [ref, await readImage(sdk, threadId, page, ref)] as const));

  // Each image costs its data URI per use, less the path it replaces. Images past the page limit are left out.
  const uris = new Map<string, string>();
  const problems: string[] = [];
  const pageBytes = Buffer.byteLength(html, "utf8");
  let total = pageBytes;
  for (const [ref, image] of images) {
    if ("problem" in image) {
      problems.push(`${ref} ${image.problem}`);
      continue;
    }
    total += byPath.get(ref)!.reduce((sum, use) => sum + image.uri.length - Buffer.byteLength(html.slice(use.start, use.end), "utf8"), 0);
    if (total <= MAX_PAGE_HTML_BYTES) uris.set(ref, image.uri);
  }
  if (total > MAX_PAGE_HTML_BYTES) problems.push(`With its images inlined the page is ${mib(total)}; the limit is ${mib(MAX_PAGE_HTML_BYTES)}. Use fewer or smaller images.`);
  if (options.strict && problems.length) {
    throw new FileSourceError(`Some local images could not be inlined. Fix these and publish again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  return replaceImages(html, refs, uris);
}
