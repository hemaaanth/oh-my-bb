// Publish, find, and manage pages. Shared by RPC, agent tools, and the CLI.
import { createHash } from "node:crypto";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_PAGE_HTML_BYTES, directive, type PageDetail, type PublishFileInput, type SourceKey, type mutationResultSchema, type publishDocumentInputSchema } from "../contract.js";
import { inspectCharts, renderMarkdown, renderPrReview } from "../render/index.js";
import { readSourceFile, relativeFile, resolveRoot, sourceKeyOf, type FileSource, type SourceFile } from "./files.js";
import { inlineLocalImages } from "./images.js";
import { HTTP_BASE, StaleVersionError, type PageStore } from "./store.js";

export type MutationResult = z.infer<typeof mutationResultSchema>;
/** `changed` is false when the bytes matched the current version and nothing was stored. */
export type PublishResult = { result: MutationResult; changed: boolean };
export type PublishDocumentInput = z.input<typeof publishDocumentInputSchema>;
export type PageRef = { pageId?: string; producerKey?: string; key?: string };

export class PageInputError extends Error {}

export const normalizeFolderPath = (value: string) => value.split("/").map((part) => part.trim().replace(/\s+/gu, " ")).join("/");

/** Returned (not thrown) when a producer action targets an archived thread: BB cannot send it a message. */
export const ARCHIVED_THREAD_RESULT = { ok: false, reason: "thread-archived", message: "That thread is archived, so it cannot take review requests. Open the page from an active thread in the project." } as const;
const producerOkSchema = z.object({ ok: z.literal(true) });
const archivedError = (error: unknown) => /thread is archived/iu.test(error instanceof Error ? error.message : String(error));

export const sha256 = (html: string) => createHash("sha256").update(html, "utf8").digest("hex");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/gu, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
      if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? whole;
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/gu, " ")
    .trim();
}

/** Title order: explicit title, the HTML <title>, the first <h1>, then the file name. */
export function deriveTitle(html: string, file: string, explicit?: string): string {
  const fromTag = (pattern: RegExp) => { const match = pattern.exec(html); return match ? plainText(match[1]!) : ""; };
  const title = explicit?.trim()
    || fromTag(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu)
    || fromTag(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/iu)
    || titleFromFileName(file);
  return title.length > 180 ? `${title.slice(0, 179).trimEnd()}…` : title;
}

export function titleFromFileName(file: string): string {
  const words = path.posix.basename(file, path.posix.extname(file)).replace(/[-_.]+/gu, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Untitled page";
}

/** HTML for a source file: HTML as written, Markdown rendered (title: explicit, first "# " heading, file name). */
export function sourceHtml(source: SourceFile, explicitTitle?: string): string {
  if (source.kind === "html") return source.content;
  const heading = /^\s{0,3}#\s+(.+?)\s*#*\s*$/mu.exec(source.content);
  return renderMarkdown(source.content, { title: explicitTitle ?? heading?.[1]!.trim() ?? titleFromFileName(source.file) });
}

type ServiceDeps = {
  sdk: BbPluginApi["sdk"];
  store: PageStore;
  /** Realtime + share hook after every mutation. */
  changed(pageId: string, versionId?: string): void;
  versionCreated(pageId: string, versionId: string): void;
  /** Share cleanup after a soft delete (removes the Here.now site). Never throws. */
  pageDeleted(pageId: string): Promise<void>;
};

export function createPageService({ sdk, store, changed, versionCreated, pageDeleted }: ServiceDeps) {
  const result = (pageId: string, versionId: string, created: boolean, didChange: boolean): PublishResult => {
    const detail = store.detail(pageId, versionId);
    if (!detail) throw new Error(`Page ${pageId} disappeared while publishing.`);
    return { result: { ...detail, directive: directive(pageId, versionId), created }, changed: didChange };
  };

  const checkedHtml = (html: string) => {
    if (Buffer.byteLength(html, "utf8") > MAX_PAGE_HTML_BYTES) throw new PageInputError(`The page HTML is too large (limit ${MAX_PAGE_HTML_BYTES} bytes).`);
    const charts = inspectCharts(html);
    if (charts.errors.length) throw new PageInputError(`The page has invalid charts. Fix these and publish again:\n${charts.errors.map((error) => `- ${error}`).join("\n")}`);
    return charts.hasCharts;
  };

  async function publishFile(input: PublishFileInput): Promise<PublishResult> {
    if (input.key && input.pageId) throw new PageInputError("Pass key or pageId, not both.");
    const source = await readSourceFile(sdk, input.threadId, input.file, input.source);
    // Stored and compared with local images inlined, so an image change adds a version.
    const html = await inlineLocalImages(sdk, input.threadId, source, sourceHtml(source, input.title), { strict: true });
    const hasCharts = checkedHtml(html);
    const title = deriveTitle(html, source.file, input.title);
    const digest = sha256(html);
    const folderPath = input.folder ? normalizeFolderPath(input.folder) : undefined;
    const version = { label: input.label ?? null, html, sha256: digest, hasCharts, document: null, provenance: null, sourcePath: source.file, threadId: input.threadId };

    let pageId: string | null;
    let sourceKey: SourceKey | null = null;
    if (input.pageId) {
      const existing = store.rawPage(input.pageId);
      if (!existing) throw new PageInputError(`Page not found: ${input.pageId}`);
      if (existing.page.kind !== "file") throw new PageInputError(`Page ${input.pageId} is a document page. Only its producer can add versions.`);
      pageId = input.pageId;
    } else {
      sourceKey = input.key ? `key:${input.key}` : source.sourceKey;
      pageId = store.pageIdBySourceKey(sourceKey);
    }

    if (pageId) {
      const existing = store.rawPage(pageId)!;
      if (existing.page.kind !== "file") throw new PageInputError(`The key ${sourceKey} belongs to a document page.`);
      if (!existing.deleted && store.currentSha(pageId) === digest && (folderPath === undefined || folderPath === existing.page.folderPath)) return result(pageId, existing.page.currentVersionId, false, false);
      const added = store.appendVersion(pageId, existing.page.currentVersionId, version, { ...(input.title ? { title } : {}), ...(folderPath === undefined ? {} : { folderPath }) });
      changed(added.pageId, added.versionId);
      versionCreated(added.pageId, added.versionId);
      return result(added.pageId, added.versionId, false, true);
    }
    const thread = await sdk.threads.get({ threadId: input.threadId });
    const created = store.createPage({ title, kind: "file", projectId: thread.projectId, folderPath: folderPath ?? null, sourceKey, producer: null, producerKey: null }, version);
    changed(created.pageId, created.versionId);
    versionCreated(created.pageId, created.versionId);
    return result(created.pageId, created.versionId, true, true);
  }

  function publishDocument(input: z.output<typeof publishDocumentInputSchema>): PublishResult {
    const html = renderPrReview(input.document);
    const hasCharts = checkedHtml(html);
    const version = { label: input.label ?? null, html, sha256: sha256(html), hasCharts, document: input.document, provenance: input.provenance, sourcePath: null, threadId: input.provenance.threadId };
    const pageId = store.pageIdByProducerKey(input.producerKey);
    if (!pageId) {
      if (input.baseVersionId) throw new StaleVersionError(`Stale page version: no page exists for producer key ${input.producerKey}, so baseVersionId ${input.baseVersionId} cannot be current.`);
      const created = store.createPage({ title: input.title, kind: "document", projectId: input.provenance.projectId, folderPath: null, sourceKey: null, producer: input.producer, producerKey: input.producerKey }, version);
      changed(created.pageId, created.versionId);
      versionCreated(created.pageId, created.versionId);
      return result(created.pageId, created.versionId, true, true);
    }
    const existing = store.rawPage(pageId)!;
    if (existing.page.kind !== "document") throw new PageInputError(`The producer key ${input.producerKey} belongs to a file page.`);
    if (input.baseVersionId !== existing.page.currentVersionId) {
      throw new StaleVersionError(`Stale page version: baseVersionId ${input.baseVersionId ?? "(missing)"} is not the current version ${existing.page.currentVersionId}. Reload the page and revise its current version.`);
    }
    const added = store.appendVersion(pageId, input.baseVersionId, version, { title: input.title });
    changed(added.pageId, added.versionId);
    versionCreated(added.pageId, added.versionId);
    return result(added.pageId, added.versionId, false, true);
  }

  function findPage(ref: PageRef): PageDetail | null {
    const pageId = ref.pageId ?? (ref.producerKey ? store.pageIdByProducerKey(ref.producerKey) : ref.key ? store.pageIdBySourceKey(`key:${ref.key}`) : null);
    return pageId ? store.detail(pageId) : null;
  }

  async function resolveFile(input: { threadId: string; file: string; source: FileSource }) {
    const file = relativeFile(input.file);
    const root = await resolveRoot(sdk, input.threadId, input.source);
    const sourceKey = sourceKeyOf(root, file);
    const pageId = store.pageIdBySourceKey(sourceKey);
    return { sourceKey, previewUrl: filePreviewUrl(input.threadId, input.source, file), page: pageId ? store.detail(pageId) : null };
  }

  function renamePage(pageId: string, title: string): PageDetail {
    if (!store.rename(pageId, title)) throw new PageInputError(`Page not found: ${pageId}`);
    changed(pageId);
    return store.detail(pageId)!;
  }

  async function deletePage(pageId: string) {
    if (!store.softDelete(pageId)) throw new PageInputError(`Page not found: ${pageId}`);
    changed(pageId);
    await pageDeleted(pageId);
    return { ok: true as const };
  }

  /**
   * Forwards a panel ⋯ action to the page's producer. Only pr-review has actions.
   * An archived thread is an expected outcome: it returns ARCHIVED_THREAD_RESULT instead of failing.
   */
  async function runProducerAction({ pageId, ...request }: { pageId: string; threadId: string; action: "explain" | "fix" | "rerun"; findingId?: string }) {
    const page = store.rawPage(pageId);
    if (!page || page.deleted) throw new PageInputError(`Page not found: ${pageId}`);
    if (page.page.producer !== "pr-review") throw new PageInputError(`Page ${pageId} has no producer actions.`);
    const thread = await sdk.threads.get({ threadId: request.threadId }).catch(() => null);
    if (thread?.archivedAt) return ARCHIVED_THREAD_RESULT;
    try {
      await sdk.plugins.callRpc({ pluginId: "pr-review", method: "requestReviewAction", input: { id: pageId, ...request }, outputSchema: producerOkSchema });
      return { ok: true as const };
    } catch (error) {
      // The thread can be archived between the check and the send.
      if (archivedError(error)) return ARCHIVED_THREAD_RESULT;
      throw error;
    }
  }

  return { publishFile, publishDocument, findPage, resolveFile, renamePage, deletePage, runProducerAction, getPage: store.detail, listPages: store.list, listFolders: store.listFolders };
}

export const filePreviewUrl = (threadId: string, source: FileSource, file: string) => `${HTTP_BASE}/file?${new URLSearchParams({ threadId, source, file }).toString()}`;

export type PageService = ReturnType<typeof createPageService>;
