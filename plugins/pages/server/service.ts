// Publish, find, and manage pages. Shared by RPC, agent tools, and the CLI.
import { createHash } from "node:crypto";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_PAGE_HTML_BYTES, directive, type FormSubmission, type FormTarget, type PageDetail, type PublishFileInput, type SourceKey, type mutationResultSchema, type publishDocumentInputSchema } from "../contract.js";
import { hasForm, inspectCharts, renderMarkdown, renderPrReview } from "../render/index.js";
import { hasSpecBlocks } from "../render/spec-baked.js";
import { readSourceFile, readSourceFolder, relativeFile, resolveRoot, sourceKeyOf, type FileSource, type SourceFile } from "./files.js";
import { inlineLocalImages } from "./images.js";
import type { SpecBaker } from "./spec/index.js";
import { HTTP_BASE, StaleVersionError, type PageStore } from "./store.js";

export type MutationResult = z.infer<typeof mutationResultSchema>;
/** `changed` is false when the bytes matched the current version and nothing was stored. */
export type PublishResult = { result: MutationResult; changed: boolean };
export type PublishDocumentInput = z.input<typeof publishDocumentInputSchema>;
export type PageRef = { pageId?: string; producerKey?: string; key?: string };

export class PageInputError extends Error {}

export const normalizeFolderPath = (value: string) => value.split("/").map((part) => part.trim().replace(/\s+/gu, " ")).join("/");

/** Returned (not thrown) when a producer action targets an archived thread: BB cannot send it a message. */
export const ARCHIVED_THREAD_RESULT = { ok: false, reason: "thread-archived", message: "That thread is archived, so it cannot take requests. Open the page from an active thread in the project." } as const;
const producerOkSchema = z.object({ ok: z.literal(true) });
const archivedError = (error: unknown) => /thread is archived/iu.test(error instanceof Error ? error.message : String(error));

/** "page ID …, version N (the current version is M), published from x.html": which page and version the user saw. */
function pageVersionText({ page, version, versions }: PageDetail): string {
  const current = versions.find((entry) => entry.id === page.currentVersionId)?.n;
  const seen = `version ${version.n}${current !== undefined && current !== version.n ? ` (the current version is ${current})` : ""}`;
  const source = version.sourcePath ? `, published from ${version.sourcePath}` : "";
  return `page ID ${page.id}, ${seen}${source}`;
}

/** The thread message for panel feedback: the note, then how to republish the same page. */
export function feedbackMessage(detail: PageDetail, text: string): string {
  return [
    `Feedback on the page "${detail.page.title}" (${pageVersionText(detail)}):`,
    "",
    text.trim(),
    "",
    `Update the page, then republish it with page_publish and pageId "${detail.page.id}", so it stays one page with a new version.`,
  ].join("\n");
}

function answerText(value: FormSubmission["answers"][number]["value"]): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(none selected)";
  return value.trim() ? value : "(left blank)";
}

/**
 * Where a form was sent from. `where` finishes "The user sent the form … ", `publishedIn` is the thread
 * that published a page version, and `update` tells the agent how to change what the user saw.
 */
export type FormPlace = { where: string; publishedIn: string | null; update: string };

export const pageFormPlace = (detail: PageDetail): FormPlace => ({
  where: `on the page "${detail.page.title}" (${pageVersionText(detail)})`,
  publishedIn: detail.version.threadId,
  update: `If you update the page, republish it with page_publish and pageId "${detail.page.id}", so it stays one page with a new version.`,
});

export const fileFormPlace = (file: string, source: FileSource, pageId: string | null): FormPlace => ({
  where: `in the live file ${file} (${source}${pageId ? `, also published as page ID ${pageId}` : ""})`,
  publishedIn: null,
  update: `The ::inline-vis view shows the file as it is now. To change the form, edit ${file}.`,
});

/**
 * The thread message for a form the user sent: which form and page or file, the clicked action,
 * then every answer under the label the user saw. Blank answers are kept. `threadId` is where it goes:
 * when that is not the thread that published the version, a line says so.
 */
export function formMessage(place: FormPlace, { formTitle, action, answers }: Pick<FormSubmission, "formTitle" | "action" | "answers">, threadId: string): string {
  const form = formTitle ? `the form "${formTitle}"` : "a form";
  const lines = [`The user sent ${form} ${place.where}.`];
  if (place.publishedIn && place.publishedIn !== threadId) lines.push(`The page was published in thread ${place.publishedIn}. The user sent this form from this thread.`);
  if (action) lines.push("", "**Action**", action);
  for (const answer of answers) lines.push("", `**${answer.label.trim() || answer.name}**`, answerText(answer.value));
  if (!action && !answers.length) lines.push("", "The form has no named fields.");
  lines.push("", place.update);
  return lines.join("\n");
}

/** Forms one thread can take per minute. A page's own script can submit without a click, so this caps a runaway page. */
export const FORM_SUBMISSIONS_PER_MINUTE = 10;
const RATE_LIMITED_RESULT = { ok: false, reason: "rate-limited", message: "Too many forms sent to this thread. Wait a minute and send again." } as const;

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
  /** Stores what a page's openui-lang blocks need (server/spec/bake.ts). Without it, blocks show no data. */
  bake?: SpecBaker;
};

export function createPageService({ sdk, store, changed, versionCreated, pageDeleted, bake }: ServiceDeps) {
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

  /** The page with its openui-lang blocks' data baked in. Compared baked, so new data adds a version. */
  const baked = (html: string, input: PublishFileInput) => bake && hasSpecBlocks(html) ? bake(html, { threadId: input.threadId, source: input.source }) : Promise.resolve(html);

  /** What a publish stores: the page HTML, a folder's other files, and the digest that decides "unchanged". */
  async function readContent(input: PublishFileInput) {
    if (input.dir) {
      const folder = await readSourceFolder(sdk, input.threadId, input.dir, input.source);
      const index = await baked(folder.index, input);
      const manifest = folder.files.map((file) => `${file.path}\0${file.contentType}\0${createHash("sha256").update(file.bytes).digest("hex")}`);
      return { html: index, files: folder.files, sourceKey: folder.sourceKey, sourcePath: folder.dir, digest: sha256([index, ...manifest].join("\0\0")) };
    }
    if (!input.file) throw new PageInputError("Pass file or dir.");
    const source = await readSourceFile(sdk, input.threadId, input.file, input.source);
    // Stored and compared with local images inlined, so an image change adds a version. Folders store their images as files.
    const html = await baked(await inlineLocalImages(sdk, input.threadId, source, sourceHtml(source, input.title), { strict: true }), input);
    return { html, files: [], sourceKey: source.sourceKey, sourcePath: source.file, digest: sha256(html) };
  }

  /** Publishes a file, or a folder with index.html (`dir`), as a version of a file page. */
  async function publishFile(input: PublishFileInput): Promise<PublishResult> {
    if (input.key && input.pageId) throw new PageInputError("Pass key or pageId, not both.");
    if (Boolean(input.file) === Boolean(input.dir)) throw new PageInputError("Pass exactly one of file or dir.");
    const content = await readContent(input);
    const { html, digest } = content;
    const hasCharts = checkedHtml(html);
    const title = deriveTitle(html, content.sourcePath, input.title);
    const folderPath = input.folder ? normalizeFolderPath(input.folder) : undefined;
    const version = { label: input.label ?? null, html, sha256: digest, hasCharts, document: null, provenance: null, sourcePath: content.sourcePath, threadId: input.threadId, files: content.files };

    let pageId: string | null;
    let sourceKey: SourceKey | null = null;
    if (input.pageId) {
      const existing = store.rawPage(input.pageId);
      if (!existing) throw new PageInputError(`Page not found: ${input.pageId}`);
      if (existing.page.kind !== "file") throw new PageInputError(`Page ${input.pageId} is a document page. Only its producer can add versions.`);
      pageId = input.pageId;
    } else {
      sourceKey = input.key ? `key:${input.key}` : content.sourceKey;
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

  /**
   * Sends the user's note from the panel to a thread, with what the agent needs to
   * republish the same page.
   */
  async function sendFeedback({ pageId, versionId, threadId, text }: { pageId: string; versionId: string; threadId: string; text: string }) {
    return sendToThread(threadId, feedbackMessage(userDetail(pageId, versionId), text));
  }

  /** Thread id → times of its recent form submissions. */
  const recentForms = new Map<string, number[]>();
  /** "threadId submissionId" of recent submissions, oldest first, so a resent submission is not sent twice. */
  const sentForms = new Set<string>();

  /**
   * What a frame's forms are about. `subject` keys the forms sent from it: a page version, or a live
   * file at its current content, so an edited file shows its forms fresh.
   */
  async function formSubject(target: FormTarget): Promise<{ subject: string; place: FormPlace }> {
    if ("pageId" in target) return { subject: `version:${target.versionId}`, place: pageFormPlace(userDetail(target.pageId, target.versionId)) };
    const read = await readSourceFile(sdk, target.threadId, target.file, target.source);
    return { subject: `file:${read.sourceKey}:${sha256(read.content)}`, place: fileFormPlace(read.file, read.source, store.pageIdBySourceKey(read.sourceKey)) };
  }

  /**
   * Sends a form the user submitted from a page or live file to the thread it is shown in.
   * Same checks as sendFeedback, plus a per-thread rate limit and a repeat check on the submission id.
   * A sent form is recorded, so the view shows it sent after a reload.
   */
  async function submitForm(input: FormSubmission & FormTarget) {
    const { threadId, submissionId, formKey, formTitle, action, answers } = input;
    const { subject, place } = await formSubject(input);
    const key = `${threadId} ${submissionId}`;
    if (sentForms.has(key)) return { ok: true as const };
    const now = Date.now();
    const recent = (recentForms.get(threadId) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= FORM_SUBMISSIONS_PER_MINUTE) return RATE_LIMITED_RESULT;
    recentForms.set(threadId, [...recent, now]);
    // Held before the send, so the same submission sent twice at once is sent once. A failed send can be retried.
    sentForms.add(key);
    if (sentForms.size > 500) sentForms.delete(sentForms.values().next().value!);
    const result = await sendToThread(threadId, formMessage(place, { formTitle, action, answers }, threadId)).catch((error: unknown) => {
      sentForms.delete(key);
      throw error;
    });
    if (!result.ok) sentForms.delete(key);
    else store.saveSentForm(threadId, subject, { formKey, action, answers });
    return result;
  }

  /** Forms already sent from a page version or live file in a thread. */
  async function listSentForms(target: FormTarget) {
    const { subject } = await formSubject(target);
    return { forms: store.sentForms(target.threadId, subject) };
  }

  /** A page version the user can send notes or forms about. Producer pages are left to their producer's actions. */
  function userDetail(pageId: string, versionId: string) {
    const detail = store.detail(pageId, versionId);
    if (!detail) throw new PageInputError(`Page not found: ${pageId}`);
    if (detail.page.producer) throw new PageInputError(`Page ${pageId} is made by ${detail.page.producer}; use its actions instead.`);
    return detail;
  }

  /** Queues a message in a thread. An archived thread returns ARCHIVED_THREAD_RESULT, like runProducerAction. */
  async function sendToThread(threadId: string, text: string) {
    const thread = await sdk.threads.get({ threadId }).catch(() => null);
    if (thread?.archivedAt) return ARCHIVED_THREAD_RESULT;
    try {
      await sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
      return { ok: true as const };
    } catch (error) {
      if (archivedError(error)) return ARCHIVED_THREAD_RESULT;
      throw error;
    }
  }

  /** True when a stored version's index HTML has a form. */
  const versionHasForm = (versionId: string) => hasForm(store.storedHtml(versionId)?.html ?? "");

  return { publishFile, publishDocument, versionHasForm, findPage, resolveFile, renamePage, deletePage, runProducerAction, sendFeedback, submitForm, listSentForms, getPage: store.detail, listPages: store.list, listFolders: store.listFolders };
}

export const filePreviewUrl = (threadId: string, source: FileSource, file: string) => `${HTTP_BASE}/file?${new URLSearchParams({ threadId, source, file }).toString()}`;

export type PageService = ReturnType<typeof createPageService>;
