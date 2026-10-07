// Agent tools: page_publish and page_lookup. page_share belongs to server/share (T4).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { directive, displaySchema, fileSourceSchema, folderPathSchema, labelSchema, pageKeySchema, relativeFileSchema, titleSchema, type PageDetail, type PageDisplay } from "../contract.js";
import type { PageService, PublishResult } from "./service.js";

/** First line of every publish result: agents must repeat the directive or the card never renders. */
export const DIRECTIVE_RULE = "Copy this directive on its own line into your final reply:";
/** The directive renders the page in the reply, so prose about it only repeats what the reader sees. */
export const RESTATE_RULE = "The reader sees the page where the directive is. Do not announce, describe, or restate it in your reply.";

export function publishSummary({ result, changed }: PublishResult, display: PageDisplay = "card"): string {
  const n = result.version.n;
  const status = !changed ? `unchanged: v${n} already has these bytes` : result.created ? "created v1" : `added v${n}`;
  return `${DIRECTIVE_RULE}\n${directive(result.page.id, result.version.id, display)}\n${RESTATE_RULE}\n\n"${result.page.title}" ${status}.`;
}

/** Lookup view: page, versions, share status, and document. No HTML and no password. */
export function lookupView(detail: PageDetail) {
  const { version } = detail;
  return {
    page: detail.page,
    version: { id: version.id, n: version.n, label: version.label, createdAt: version.createdAt, sourcePath: version.sourcePath, threadId: version.threadId, hasCharts: version.hasCharts, provenance: version.provenance },
    versions: detail.versions,
    share: detail.share,
    document: version.document,
    directive: directive(detail.page.id, version.id),
  };
}

export function registerTools(bb: BbPluginApi, service: PageService) {
  bb.agents.registerTool({
    name: "page_publish",
    description: "Publish a workspace or thread-storage .html/.md file as a versioned page. Publishing the same file (or key, or pageId) again adds a version; unchanged bytes add nothing. Local images referenced by path are embedded at publish.",
    instructions: "After page_publish, copy the returned ::page directive on its own line into your final reply. The reader sees the page there, so do not announce, describe, or restate it. Use display \"inline\" for one chart, a small table, a diagram, or a stat row; keep the default card for tabs, a contents list, several sections, or more than about one screen.",
    presentation: { label: { pending: "Publishing page", completed: "Published page" }, icon: { glyph: "FileText" } },
    parameters: z.object({
      file: relativeFileSchema.describe("Path relative to the source root, e.g. reports/summary.html"),
      source: fileSourceSchema.optional().describe("Where the file lives. Default: workspace"),
      title: titleSchema.optional(), label: labelSchema.optional().describe("Short note for this version"),
      folder: folderPathSchema.optional().describe("Logical subfolder inside this BB project, e.g. Reports/Weekly"),
      key: pageKeySchema.optional().describe("Stable page name, e.g. boost-daily. Use when the path changes between runs"),
      pageId: z.string().uuid().optional().describe("Add a version to this existing page"),
      display: displaySchema.optional().describe("How the returned directive shows the page in chat. card (default): a framed, zoomed-out preview. inline: the page itself, borderless, for one chart, small table, diagram, or stat row"),
    }).strict(),
    async execute({ display, ...input }, { threadId }) {
      return publishSummary(await service.publishFile({ ...input, source: input.source ?? "workspace", threadId }), display);
    },
  });

  bb.agents.registerTool({
    name: "page_lookup",
    description: "Look up a page by pageId, producerKey, key, or file. Returns the page, its versions, share status, and document as JSON, without HTML.",
    presentation: { label: { pending: "Looking up page", completed: "Looked up page" }, icon: { glyph: "FileText" } },
    parameters: z.object({
      pageId: z.string().uuid().optional(), producerKey: z.string().trim().min(1).max(1_000).optional(), key: pageKeySchema.optional(),
      file: relativeFileSchema.optional(), source: fileSourceSchema.optional(),
    }).strict().refine((v) => [v.pageId, v.producerKey, v.key, v.file].filter(Boolean).length === 1, { message: "Provide exactly one of pageId, producerKey, key, file" }),
    async execute(input, { threadId }) {
      const detail = input.file
        ? (await service.resolveFile({ threadId, file: input.file, source: input.source ?? "workspace" })).page
        : service.findPage(input);
      if (!detail) throw new Error("Page not found.");
      return JSON.stringify(lookupView(detail));
    },
  });

  bb.agents.registerTool({
    name: "page_browse",
    description: "Browse previously published pages and logical folders. Defaults to the current project and returns bounded metadata without page HTML.",
    presentation: { label: { pending: "Browsing pages", completed: "Browsed pages" }, icon: { glyph: "FileText" } },
    parameters: z.object({
      projectId: z.string().min(1).optional().describe("Project id. Defaults to the current project"),
      folder: folderPathSchema.optional().describe("Exact logical subfolder"),
      query: z.string().trim().min(1).max(200).optional().describe("Case-insensitive title search"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum pages. Default: 20"),
    }).strict(),
    execute(input, { projectId }) {
      const selectedProjectId = input.projectId ?? projectId;
      const result = service.listPages({ offset: 0, projectId: selectedProjectId, folder: input.folder, query: input.query, limit: input.limit ?? 20 });
      return JSON.stringify({
        projectId: selectedProjectId,
        folders: service.listFolders(selectedProjectId),
        pages: result.pages.map(({ page, version, share }) => ({
          id: page.id, title: page.title, folder: page.folderPath, kind: page.kind, updatedAt: page.updatedAt,
          currentVersion: version, versionCount: service.getPage(page.id)?.versions.length ?? 1,
          shared: share ? { url: share.url, access: share.access, status: share.status } : null,
        })),
        hasMore: result.nextOffset !== null,
      });
    },
  });

  bb.agents.configure(() => ({
    // page_share is registered by server/share (T4); BB allows one configure callback, so it is selected here.
    tools: ["page_publish", "page_lookup", "page_browse", "page_share"],
    skills: ["pages"],
    instructions: "Pages: use page_browse to find prior project artifacts in fresh threads. Write an .html or .md file, publish it with page_publish (or `bb pages publish <file>`), and copy the returned ::page directive into your reply without restating the page. Read the pages skill for the theme, chart, and inline-or-card rules.",
  }));
}
