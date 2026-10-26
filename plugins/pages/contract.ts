// Shared contract for the Pages plugin.
// T1–T4 build against this file. Change it only through the planner, so the
// four worker threads stay in step. See CONTRACT.md for file ownership.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---- Limits ---------------------------------------------------------------
export const MAX_PAGE_HTML_BYTES = 10 * 1024 * 1024;
export const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024;
/** Folder publishes: files counted after skipping dotfiles and node_modules, index.html included. */
export const MAX_FOLDER_FILES = 200;
export const MAX_FOLDER_BYTES = 25 * 1024 * 1024;
/** Where the plugin's HTTP routes are mounted. */
export const HTTP_BASE = "/api/v1/plugins/pages/http";
/** Payload: `{ pageId, versionId?, sourceKey? }`. sourceKey is set for pages made from a file path. */
export const REALTIME_CHANNEL = "pages-changed";

// ---- Identity -------------------------------------------------------------
const uuid = z.string().uuid();
const shortText = z.string().trim().min(1).max(4_000);
export const titleSchema = z.string().trim().min(1).max(180);
export const labelSchema = z.string().trim().min(1).max(240);
export const folderPathSchema = z.string().trim().min(1).max(120).refine(
  (value) => !value.split("/").some((part) => !part.trim() || part.trim() === "." || part.trim() === ".."),
  "Use slash-separated folder names without empty, '.' or '..' segments.",
);
/** A stable name chosen by the caller, e.g. "boost-daily". Maps to source_key "key:<name>". */
export const pageKeySchema = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u, "Use lowercase letters, digits, '.', '_' or '-'.");
export const fileSourceSchema = z.enum(["workspace", "thread-storage"]);
/** How a chat directive shows a page: "card" (framed thumbnail, the default) or "inline" (borderless, part of the reply). */
export const displaySchema = z.enum(["card", "inline"]);
export type PageDisplay = z.infer<typeof displaySchema>;
/** Source-relative file path. No absolute paths, no "..". Validated again on the server. */
export const relativeFileSchema = z.string().trim().min(1).max(1_000);

// source_key forms:
//   workspace:<environmentId>:<path>   a workspace file
//   storage:<threadId>:<path>          a thread-storage file
//   key:<name>                         a caller-chosen stable key (automations)
export type SourceKey = `workspace:${string}:${string}` | `storage:${string}:${string}` | `key:${string}`;

export const pageKindSchema = z.enum(["file", "document"]);
export const accessSchema = z.enum(["restricted", "password", "link"]);
export type Access = z.infer<typeof accessSchema>;

// ---- PR review document (moved unchanged from artifacts/contract.ts) --------
export const reviewTargetSchema = z.object({
  kind: z.enum(["current-branch", "working-tree", "pull-request", "ref-range", "commit-range", "path", "other"]),
  label: z.string().trim().min(1).max(240),
  baseRef: z.string().trim().min(1).max(240).optional(), headRef: z.string().trim().min(1).max(240).optional(),
  baseSha: z.string().trim().min(7).max(64).optional(), headSha: z.string().trim().min(7).max(64).optional(),
  url: z.string().url().max(2_048).optional(),
}).strict();
const reviewFindingSchema = z.object({
  id: z.string().trim().min(1).max(100),
  severity: z.enum(["important", "nit", "pre-existing"]),
  category: z.string().trim().min(1).max(80), title: z.string().trim().min(1).max(180),
  explanation: z.string().trim().min(1).max(4_000), evidence: z.string().trim().min(1).max(4_000),
  path: z.string().trim().min(1).max(1_000), line: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
  confidence: z.enum(["high", "medium"]), suggestedAction: z.string().trim().min(1).max(2_000).optional(),
}).strict().refine(({ line, endLine }) => line === undefined || endLine === undefined || endLine >= line, { message: "endLine must be greater than or equal to line", path: ["endLine"] });
const renderedDiagramSchema = z.object({
  title: shortText, alt: shortText,
  assets: z.array(z.object({ id: z.string(), lens: z.enum(["architecture", "data-flow"]), theme: z.enum(["light", "dark"]), view: z.string().nullable(), svg: z.string(), width: z.number().positive(), height: z.number().positive(), animated: z.boolean() }).strict()).optional(),
  svg: z.string().optional(),
}).strict().refine((value) => Boolean(value.svg || value.assets?.length), { message: "A diagram needs an SVG or rendered assets" });
// Optional for existing review pages. Kept in sync with PR Review's wire contract.
const diffCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const diffBreakdownSchema = z.object({
  complete: z.boolean(), note: z.string().optional(),
  rows: z.array(z.object({
    category: z.enum(["runtime", "tests", "evals", "docs", "build-config", "dependencies", "generated", "other"]),
    files: diffCountSchema, additions: diffCountSchema, deletions: diffCountSchema, binaryFiles: diffCountSchema,
  }).strict()).max(8),
}).strict();
export const prReviewDocumentSchema = z.object({
  schema: z.literal("pr-review/v1"), title: titleSchema, target: reviewTargetSchema,
  intent: z.string().trim().min(1).max(4_000), summary: z.string().trim().min(1).max(6_000),
  verdict: z.enum(["pass", "changes-requested", "advisory"]),
  diagramPolicy: z.enum(["auto", "yes", "no"]).optional(), commentPolicy: z.enum(["off", "draft", "post"]).optional(),
  coverage: z.object({ reviewed: z.array(shortText).max(100), skipped: z.array(shortText).max(100), validation: z.array(shortText).max(100) }).strict(),
  diffBreakdown: diffBreakdownSchema.optional(),
  findings: z.array(reviewFindingSchema).max(100), diagrams: z.array(renderedDiagramSchema).max(20).optional(),
}).strict();
export type PrReviewDocument = z.infer<typeof prReviewDocumentSchema>;
/** Only document schema. report/v1 is removed; imported Flint reports become file-kind HTML pages. */
export const pageDocumentSchema = prReviewDocumentSchema;
export type PageDocument = PrReviewDocument;

export const provenanceSchema = z.object({
  threadId: z.string().min(1), parentThreadId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1), environmentId: z.string().min(1).nullable().optional(),
  subject: z.string().trim().min(1).max(1_000).optional(), sourceVersion: z.string().trim().min(1).max(240).optional(),
}).strict();
export type Provenance = z.infer<typeof provenanceSchema>;

// ---- Records --------------------------------------------------------------
export const pageSchema = z.object({
  id: uuid, title: z.string(), kind: pageKindSchema, projectId: z.string().nullable(), folderPath: z.string().nullable(),
  sourceKey: z.string().nullable(), producer: z.string().nullable(), producerKey: z.string().nullable(),
  currentVersionId: uuid, createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type Page = z.infer<typeof pageSchema>;

export const versionSummarySchema = z.object({ id: uuid, n: z.number().int().positive(), label: z.string().nullable(), createdAt: z.string() }).strict();
export const versionSchema = versionSummarySchema.extend({
  pageId: uuid, sourcePath: z.string().nullable(), sha256: z.string(), threadId: z.string().nullable(),
  provenance: provenanceSchema.nullable(), document: pageDocumentSchema.nullable(),
  hasCharts: z.boolean(),
}).strict();
export type Version = z.infer<typeof versionSchema>;

/** Never contains the password. Use revealPassword (app only) to read it. */
export const shareSchema = z.object({
  pageId: uuid, provider: z.literal("here-now"), slug: z.string(), url: z.string().url(),
  access: accessSchema, allowedDomains: z.array(z.string()), allowedEmails: z.array(z.string()),
  hasPassword: z.boolean(), follow: z.union([z.literal("latest"), uuid]),
  liveVersionId: uuid.nullable(), status: z.enum(["ready", "publishing", "error"]), lastError: z.string().nullable(), updatedAt: z.string(),
}).strict();
export type Share = z.infer<typeof shareSchema>;

export const pageDetailSchema = z.object({
  page: pageSchema, version: versionSchema, versions: z.array(versionSummarySchema),
  share: shareSchema.nullable(),
  /** URL of the themed page for the preview iframe: /api/v1/plugins/pages/http/v?id=<versionId>. Append &theme=light|dark. */
  previewUrl: z.string(),
}).strict();
export type PageDetail = z.infer<typeof pageDetailSchema>;

export const pageListItemSchema = z.object({
  page: pageSchema, version: versionSummarySchema, share: shareSchema.pick({ access: true, status: true, url: true }).nullable(), previewUrl: z.string(),
}).strict();

export const mutationResultSchema = pageDetailSchema.extend({
  /** Canonical chat directive, e.g. ::page{id="…" version="…"} */
  directive: z.string(),
  /** True when this call created the page, false when it added a version. */
  created: z.boolean(),
}).strict();

export const directive = (pageId: string, versionId: string, display: PageDisplay = "card") =>
  `::page{id="${pageId}" version="${versionId}"${display === "inline" ? ' display="inline"' : ""}}`;

// ---- Inputs ---------------------------------------------------------------
export const publishFileInputSchema = z.object({
  threadId: z.string().min(1),
  /** Exactly one of file (an .html/.md file) or dir (a folder with index.html). */
  file: relativeFileSchema.optional(), dir: relativeFileSchema.optional(), source: fileSourceSchema.default("workspace"),
  title: titleSchema.optional(), label: labelSchema.optional(),
  folder: folderPathSchema.optional().describe("Logical subfolder inside the BB project, e.g. Reports/Weekly"),
  /** Exactly one identity override may be given; otherwise identity is the file's or dir's source key. */
  key: pageKeySchema.optional(), pageId: uuid.optional(),
}).strict().refine((v) => !(v.key && v.pageId), { message: "Pass key or pageId, not both" })
  .refine((v) => Boolean(v.file) !== Boolean(v.dir), { message: "Pass exactly one of file or dir" });
export type PublishFileInput = z.infer<typeof publishFileInputSchema>;

/** Producers (PR Review) create or revise a document page. Revising needs the exact current version. */
export const publishDocumentInputSchema = z.object({
  producer: z.string().trim().min(1).max(100), producerKey: z.string().trim().min(1).max(1_000),
  title: titleSchema, provenance: provenanceSchema, document: pageDocumentSchema,
  label: labelSchema.optional(), baseVersionId: uuid.optional(), display: displaySchema.optional(),
}).strict();

export const pageRefSchema = z.object({ pageId: uuid.optional(), producerKey: z.string().trim().min(1).max(1_000).optional(), key: pageKeySchema.optional() }).strict()
  .refine((v) => [v.pageId, v.producerKey, v.key].filter(Boolean).length === 1, { message: "Provide exactly one of pageId, producerKey, key" });

export const shareInputSchema = z.object({
  pageId: uuid, access: accessSchema,
  allowedDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/u)).max(20).optional(),
  allowedEmails: z.array(z.string().trim().toLowerCase().email()).max(50).optional(),
  follow: z.union([z.literal("latest"), uuid]).optional(),
  /** Attach an existing Here.now site instead of creating one (keeps its URL). */
  adoptSlug: z.string().trim().regex(/^[a-z0-9-]{3,80}$/u).optional(),
}).strict().refine((v) => v.access !== "restricted" || (v.allowedDomains?.length ?? 0) + (v.allowedEmails?.length ?? 0) > 0, { message: "Restricted access needs at least one domain or email" });
export type ShareInput = z.infer<typeof shareInputSchema>;

// ---- Forms ----------------------------------------------------------------
/** At most this many characters across every answer value of one submission. */
export const MAX_FORM_CHARS = 50_000;
const answerValueSchema = z.union([z.string().max(10_000), z.array(z.string().max(1_000)).max(100), z.boolean()]);
/** One named field: its name, the label the reader saw, and its value. A checkbox is a boolean; a group or multi-select is a list. */
export const formAnswerSchema = z.object({ name: z.string().min(1).max(200), label: z.string().max(300), value: answerValueSchema }).strict();
export type FormAnswer = z.infer<typeof formAnswerSchema>;
/**
 * What the frame bridge posts for a submitted form. `action` is the clicked button, when it says which.
 * `formKey` names the form on its page (its id, its name, or its place), so a sent form can be shown sent again.
 */
const formSubmissionShape = {
  submissionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
  formKey: z.string().min(1).max(200),
  formTitle: z.string().trim().max(300).nullable(),
  action: z.string().trim().max(300).nullable(),
  answers: z.array(formAnswerSchema).max(200),
};
const formChars = ({ answers }: { answers: FormAnswer[] }) =>
  answers.reduce((sum, { value }) => sum + (typeof value === "string" ? value.length : Array.isArray(value) ? value.join("").length : 0), 0);
const withinFormLimit = [(v: { answers: FormAnswer[] }) => formChars(v) <= MAX_FORM_CHARS, { message: `A form can send at most ${MAX_FORM_CHARS} characters.` }] as const;
export const formSubmissionSchema = z.object(formSubmissionShape).strict().refine(...withinFormLimit);
export type FormSubmission = z.infer<typeof formSubmissionSchema>;
/**
 * Where a frame's forms go: the thread the frame is shown in, and what it shows.
 * A page version, or a live ::inline-vis file (named by source and path, read when the form is sent).
 */
const pageFormTargetShape = { threadId: z.string().min(1), pageId: uuid, versionId: uuid };
const fileFormTargetShape = { threadId: z.string().min(1), source: fileSourceSchema, file: relativeFileSchema };
export const formTargetSchema = z.union([z.object(pageFormTargetShape).strict(), z.object(fileFormTargetShape).strict()]);
export type FormTarget = z.infer<typeof formTargetSchema>;
const submitFormInputSchema = z.union([
  z.object({ ...formSubmissionShape, ...pageFormTargetShape }).strict(),
  z.object({ ...formSubmissionShape, ...fileFormTargetShape }).strict(),
]).refine(...withinFormLimit);
/** A form already sent from this view in this thread: the bridge shows it sent and locked. */
export const sentFormSchema = z.object({ formKey: z.string(), action: z.string().nullable(), answers: z.array(formAnswerSchema), sentAt: z.string() }).strict();
export type SentForm = z.infer<typeof sentFormSchema>;

// ---- Spec fences (openui-lang) ------------------------------------------------
/** Web lookups the Pages server runs for spec components (Map, Gallery, ImageSearch). */
export const WEB_METHODS = ["tile", "geocode", "search", "image", "wiki"] as const;
/** A spec call's answer. `ok: false` carries text the component shows, so errors do not throw. */
const specResultSchema = z.union([z.object({ ok: z.literal(true), data: z.unknown() }).strict(), z.object({ ok: z.literal(false), message: z.string() }).strict()]);
export type SpecResult = z.infer<typeof specResultSchema>;
const specArgsSchema = z.record(z.string(), z.unknown());

// ---- RPC ------------------------------------------------------------------
// Core methods: T1. Share methods: T4. The app (T3) calls both.
export const rpcContract = defineRpcContract({
  // T1
  publishFile: { input: publishFileInputSchema, output: mutationResultSchema },
  publishDocument: { input: publishDocumentInputSchema, output: mutationResultSchema },
  getPage: { input: z.object({ pageId: uuid, versionId: uuid.optional() }).strict(), output: pageDetailSchema.nullable() },
  findPage: { input: pageRefSchema, output: pageDetailSchema.nullable() },
  /** For ::inline-vis cards: which page (if any) this live file already belongs to. */
  resolveFile: { input: z.object({ threadId: z.string().min(1), file: relativeFileSchema, source: fileSourceSchema.default("workspace") }).strict(), output: z.object({ sourceKey: z.string(), previewUrl: z.string(), page: pageDetailSchema.nullable() }).strict() },
  listPages: { input: z.object({ offset: z.number().int().nonnegative().default(0), projectId: z.string().optional(), folder: folderPathSchema.optional(), query: z.string().trim().min(1).max(200).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(), output: z.object({ pages: z.array(pageListItemSchema), nextOffset: z.number().int().nonnegative().nullable() }).strict() },
  listFolders: { input: z.object({ projectId: z.string().optional() }).strict(), output: z.object({ folders: z.array(z.object({ projectId: z.string().nullable(), path: z.string().nullable(), count: z.number().int().nonnegative() }).strict()) }).strict() },
  renamePage: { input: z.object({ pageId: uuid, title: titleSchema }).strict(), output: pageDetailSchema },
  deletePage: { input: z.object({ pageId: uuid }).strict(), output: z.object({ ok: z.literal(true) }).strict() },
  /** Producer actions from the panel ⋯ menu. Pages forwards them to the producer plugin (pr-review: requestReviewAction). */
  /** `ok: false` is an expected outcome (the target thread is archived), not an error. */
  runProducerAction: { input: z.object({ pageId: uuid, threadId: z.string().min(1), action: z.enum(["explain", "fix", "rerun"]), findingId: z.string().trim().min(1).max(100).optional() }).strict(), output: z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), reason: z.literal("thread-archived"), message: z.string() }).strict()]) },
  /** The panel's Send feedback box. Sends the note to the thread with the page ID, so the agent republishes the same page. Not for producer pages. */
  sendFeedback: { input: z.object({ pageId: uuid, versionId: uuid, threadId: z.string().min(1), text: z.string().trim().min(1).max(4_000) }).strict(), output: z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), reason: z.literal("thread-archived"), message: z.string() }).strict()]) },
  /** A form the reader sent from a page (FRAME_MESSAGE.submit). Queues one message in the thread the page is shown in. Not for producer pages. */
  submitForm: { input: submitFormInputSchema, output: z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), reason: z.enum(["thread-archived", "rate-limited"]), message: z.string() }).strict()]) },
  /** Forms already sent from this page version or live file in this thread, latest send per form. */
  sentForms: { input: formTargetSchema, output: z.object({ forms: z.array(sentFormSchema) }).strict() },
  /** A Query("tool", {args}) from a spec fence. threadId names the thread the fence is in (absent in the gallery). server/spec/data.ts. */
  specTool: { input: z.object({ threadId: z.string().min(1).optional(), tool: z.string().trim().min(1).max(80), args: specArgsSchema }).strict(), output: specResultSchema },
  /** A web lookup for a spec component. Off when the "Web lookups" setting is off. server/spec/web.ts. */
  specWeb: { input: z.object({ method: z.enum(WEB_METHODS), input: specArgsSchema }).strict(), output: specResultSchema },
  // T4
  getShare: { input: z.object({ pageId: uuid }).strict(), output: z.object({ configured: z.boolean(), share: shareSchema.nullable(), defaults: z.object({ access: accessSchema, allowedDomains: z.array(z.string()) }).strict() }).strict() },
  sharePage: { input: shareInputSchema, output: shareSchema },
  setFollow: { input: z.object({ pageId: uuid, follow: z.union([z.literal("latest"), uuid]) }).strict(), output: shareSchema },
  unsharePage: { input: z.object({ pageId: uuid }).strict(), output: z.object({ ok: z.literal(true) }).strict() },
  revealPassword: { input: z.object({ pageId: uuid }).strict(), output: z.object({ password: z.string() }).strict() },
  rotatePassword: { input: z.object({ pageId: uuid }).strict(), output: shareSchema },
});
export type PagesRpc = typeof rpcContract;

// ---- HTTP routes (mounted at /api/v1/plugins/pages/http) -------------------
// T1 registers them; T2 supplies the HTML/asset transforms.
// Routes are exact-path, so ids go in the query string. Pages use assetBase "./",
// so their relative `_page/<asset>` URLs resolve to the shared asset routes.
//   GET /v?id=<versionId>[&theme=light|dark]           themed page HTML (CSP header, theme injected)
//   GET /a?id=<versionId>&path=<file>[&theme=]          one file of a folder version (HTML pages themed like /v)
//   GET /file?threadId=&source=&file=[&theme=]         themed live preview of a workspace/thread-storage file (::inline-vis cards; single files only)
//   BB previews (theme or frame set) also get the frame bridge; see FRAME_MESSAGE below.
//   GET /_page/<asset>[?v=<version>]                   theme.css, inter.roman.var.woff2, charts.js, spec.js (same bytes for every page;
//                                                      preview pages add the content version, which makes them cacheable for good)
// Folder previews inline their files as data: URLs: a sandboxed frame's subrequests carry no BB session cookie,
// so they fail through the remote BB tunnel. Links to other pages of the folder go through /a, loaded by the parent.
export const PAGE_ASSET_NAMES = ["theme.css", "inter.roman.var.woff2", "charts.js", "spec.js"] as const;
export type PageAssetName = (typeof PAGE_ASSET_NAMES)[number];

/**
 * The frame bridge between a BB preview and the BB app, over postMessage (render/frame-bridge.ts, app/bridge.ts).
 *   page -> host  { type: ready }                            the bridge started, before the body paints; the host answers with theme
 *   host -> page  { type: theme, theme: "light" | "dark", tokens? }  the app theme and its HOST_TOKENS values; the first theme also rides in the URL
 *   page -> host  { type: open, url }                        an http(s) link the reader clicked
 *   page -> host  { type: height, height }                   content height in CSS pixels (inline frames only)
 *   page -> host  { type: page, url }                        a link to another page of the same folder version (/v or /a);
 *                                                            the host loads it into the same frame
 *   page -> host  { type: submit, ...FormSubmission }        a form the reader sent; the host calls submitForm
 *   host -> page  { type: submitted, submissionId, ok, message }  the outcome, shown in the form's status line
 *   host -> page  { type: restore, forms: SentForm[] }       forms already sent in this thread; the page shows them sent
 */
export const FRAME_MESSAGE = { ready: "bb-pages:ready", theme: "bb-pages:theme", open: "bb-pages:open", height: "bb-pages:height", page: "bb-pages:page", submit: "bb-pages:submit", submitted: "bb-pages:submitted", restore: "bb-pages:restore" } as const;
/**
 * The BB app's CSS variables a preview takes on, so a page that follows the app (body.auto) looks native.
 * The bridge sets each as `--bb-host-<name>` on the page root; assets/theme.css maps them onto its own tokens.
 */
export const HOST_TOKENS = ["background", "foreground", "muted-foreground", "secondary", "border", "input", "accent", "primary", "primary-foreground", "success", "destructive", "warning", "font-sans", "font-mono", "radius"] as const;
/** A token value the bridge takes: plain CSS, no url(), escapes, or rule breaks. */
export const HOST_TOKEN_VALUE = /^(?!.*url\()[^;{}<>\\]{1,200}$/iu;

/** A form with this attribute is left to the page's own script. */
export const MANUAL_FORM_ATTRIBUTE = "data-bb-pages-manual";
/** The bridge sets this on a form: "sending", "sent", or "error". The theme styles each state. */
export const FORM_STATE_ATTRIBUTE = "data-bb-pages-state";

// ---- Directives (T3) -------------------------------------------------------
//   ::page{id version height? display?}          canonical
//   ::artifact{id revision height? display?}     alias; imported artifact ids == page ids, revision ids == version ids
//   ::inline-vis{file source? height? display?}  alias; live file preview + Share (snapshots via publishFile)
//   display="inline" drops the card chrome and fits the page height; the default is the card.

// ---- Agent tools (T1 core, T4 share) ---------------------------------------
//   page_publish  { file | dir, source?, title?, label?, key?, pageId?, display? } -> directive text
//   page_lookup   { pageId | producerKey | key }                     -> JSON (no HTML, no password)
//   page_browse   { projectId?, folder?, query?, limit? }            -> bounded page and folder summaries
//   page_share    { pageId, access, allowedDomains?, allowedEmails? } -> BB confirmation, then share
// Tool parameter schemas must not use z.record (BB rejects it); use z.looseObject({}) for free-form objects.

// ---- Settings (T4) ---------------------------------------------------------
//   hereNowApiKey (secret), defaultAccess ("password"), defaultAllowedDomains ("" comma list)
