// SQLite access for pages, versions, and (read-only here) shares.
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { z } from "zod";
import { HTTP_BASE, type Page, type PageDetail, type PageDocument, type Provenance, type Share, type Version, type pageListItemSchema, type versionSummarySchema } from "../contract.js";

export { HTTP_BASE };
export const previewUrl = (versionId: string) => `${HTTP_BASE}/v?id=${encodeURIComponent(versionId)}`;

type PageRow = { id: string; title: string; kind: "file" | "document"; project_id: string | null; folder_path: string | null; source_key: string | null; producer: string | null; producer_key: string | null; current_version_id: string; created_at: string; updated_at: string; deleted_at: string | null };
type VersionRow = { id: string; page_id: string; n: number; label: string | null; html: string; document_json: string | null; provenance_json: string | null; source_path: string | null; sha256: string; has_charts: number; thread_id: string | null; created_at: string };
type ShareRow = { page_id: string; slug: string; url: string; access: Share["access"]; allowed_domains_json: string; allowed_emails_json: string; password: string | null; follow: string; live_version_id: string | null; status: Share["status"]; last_error: string | null; updated_at: string };
type VersionSummary = z.infer<typeof versionSummarySchema>;
export type PageListItem = z.infer<typeof pageListItemSchema>;

/** Fields for a new page row. */
export type NewPage = { id?: string; title: string; kind: Page["kind"]; projectId: string | null; folderPath?: string | null; sourceKey: string | null; producer: string | null; producerKey: string | null; createdAt?: string };
/** Fields for a new version row. `n` defaults to the next number. `files` are a folder page's files other than index.html (which is `html`). */
export type NewVersion = { id?: string; n?: number; label: string | null; html: string; sha256: string; hasCharts: boolean; document: PageDocument | null; provenance: Provenance | null; sourcePath: string | null; threadId: string | null; legacyHtml?: string | null; createdAt?: string; files?: readonly NewVersionFile[] };
export type NewVersionFile = { path: string; contentType: string; bytes: Buffer };
/** A stored version with its HTML, for serving and publishing. `folder` is true when the version has files besides index.html. */
export type StoredHtml = { versionId: string; pageId: string; html: string; hasCharts: boolean; folder: boolean };
/** One file of a folder version (index.html is not listed; it is the version's HTML). */
export type StoredFileEntry = { path: string; contentType: string; sha256: string };

export class StaleVersionError extends Error {}

const toPage = (row: PageRow): Page => ({
  id: row.id, title: row.title, kind: row.kind, projectId: row.project_id, folderPath: row.folder_path, sourceKey: row.source_key, producer: row.producer, producerKey: row.producer_key,
  currentVersionId: row.current_version_id, createdAt: row.created_at, updatedAt: row.updated_at,
});
const toSummary = (row: Pick<VersionRow, "id" | "n" | "label" | "created_at">): VersionSummary => ({ id: row.id, n: row.n, label: row.label, createdAt: row.created_at });
const toVersion = (row: VersionRow): Version => ({
  ...toSummary(row), pageId: row.page_id, sourcePath: row.source_path, sha256: row.sha256, threadId: row.thread_id,
  provenance: row.provenance_json ? JSON.parse(row.provenance_json) as Provenance : null,
  document: row.document_json ? JSON.parse(row.document_json) as PageDocument : null,
  hasCharts: row.has_charts === 1,
});
const toShare = (row: ShareRow | undefined): Share | null => row ? {
  pageId: row.page_id, provider: "here-now", slug: row.slug, url: row.url, access: row.access,
  allowedDomains: JSON.parse(row.allowed_domains_json) as string[], allowedEmails: JSON.parse(row.allowed_emails_json) as string[],
  hasPassword: row.password !== null, follow: row.follow, liveVersionId: row.live_version_id, status: row.status, lastError: row.last_error, updatedAt: row.updated_at,
} : null;

const VERSION_COLUMNS = "id, page_id, n, label, html, document_json, provenance_json, source_path, sha256, has_charts, thread_id, created_at";

export function createPageStore(db: Database.Database) {
  const pageRow = db.prepare<[string], PageRow>("SELECT * FROM pages WHERE id = ?");
  const pageBySource = db.prepare<[string], PageRow>("SELECT * FROM pages WHERE source_key = ?");
  const pageByProducer = db.prepare<[string], PageRow>("SELECT * FROM pages WHERE producer_key = ?");
  const versionRow = db.prepare<[string], VersionRow>(`SELECT ${VERSION_COLUMNS} FROM page_versions WHERE id = ?`);
  const summaries = db.prepare<[string], VersionRow>("SELECT id, n, label, created_at FROM page_versions WHERE page_id = ? ORDER BY n DESC");
  const maxN = db.prepare<[string], { n: number | null }>("SELECT MAX(n) AS n FROM page_versions WHERE page_id = ?");
  const shareRow = db.prepare<[string], ShareRow>("SELECT * FROM page_shares WHERE page_id = ?");
  const insertPage = db.prepare("INSERT INTO pages (id, title, kind, project_id, folder_path, source_key, producer, producer_key, current_version_id, created_at, updated_at) VALUES (@id, @title, @kind, @projectId, @folderPath, @sourceKey, @producer, @producerKey, @versionId, @createdAt, @createdAt)");
  const insertVersion = db.prepare("INSERT INTO page_versions (id, page_id, n, label, html, document_json, provenance_json, source_path, sha256, has_charts, legacy_html, thread_id, created_at) VALUES (@id, @pageId, @n, @label, @html, @document, @provenance, @sourcePath, @sha256, @hasCharts, @legacyHtml, @threadId, @createdAt)");
  const insertBlob = db.prepare("INSERT OR IGNORE INTO page_blobs (sha256, bytes) VALUES (?, ?)");
  const insertFile = db.prepare("INSERT INTO page_version_files (version_id, path, sha256, content_type) VALUES (?, ?, ?, ?)");
  const fileRows = db.prepare<[string], { path: string; content_type: string; sha256: string }>("SELECT path, content_type, sha256 FROM page_version_files WHERE version_id = ? ORDER BY path");
  const hasFiles = db.prepare<[string], { one: number }>("SELECT 1 AS one FROM page_version_files WHERE version_id = ? LIMIT 1");
  const blob = db.prepare<[string], { bytes: Buffer }>("SELECT bytes FROM page_blobs WHERE sha256 = ?");

  const live = (row: PageRow | undefined) => (row && row.deleted_at === null ? row : undefined);

  const writeVersion = (pageId: string, version: NewVersion, fallbackN: number) => {
    const id = version.id ?? randomUUID();
    insertVersion.run({
      id, pageId, n: version.n ?? fallbackN, label: version.label, html: version.html,
      document: version.document ? JSON.stringify(version.document) : null, provenance: version.provenance ? JSON.stringify(version.provenance) : null,
      sourcePath: version.sourcePath, sha256: version.sha256, hasCharts: version.hasCharts ? 1 : 0, legacyHtml: version.legacyHtml ?? null,
      threadId: version.threadId, createdAt: version.createdAt ?? new Date().toISOString(),
    });
    for (const file of version.files ?? []) {
      const digest = createHash("sha256").update(file.bytes).digest("hex");
      insertBlob.run(digest, file.bytes);
      insertFile.run(id, file.path, digest, file.contentType);
    }
    return id;
  };

  const detail = (pageId: string, versionId?: string): PageDetail | null => {
    const page = live(pageRow.get(pageId));
    if (!page) return null;
    const version = versionRow.get(versionId ?? page.current_version_id);
    if (!version || version.page_id !== page.id) return null;
    return { page: toPage(page), version: toVersion(version), versions: summaries.all(page.id).map(toSummary), share: toShare(shareRow.get(page.id)), previewUrl: previewUrl(version.id) };
  };

  return {
    detail,
    /** Page row by id, including soft-deleted pages. */
    rawPage: (pageId: string) => { const row = pageRow.get(pageId); return row ? { page: toPage(row), deleted: row.deleted_at !== null } : null; },
    /** Page id for a source or producer key, including soft-deleted pages. */
    pageIdBySourceKey: (sourceKey: string) => pageBySource.get(sourceKey)?.id ?? null,
    pageIdByProducerKey: (producerKey: string) => pageByProducer.get(producerKey)?.id ?? null,
    livePage: (pageId: string) => { const row = live(pageRow.get(pageId)); return row ? toPage(row) : null; },
    currentSha: (pageId: string) => { const page = pageRow.get(pageId); return page ? versionRow.get(page.current_version_id)?.sha256 ?? null : null; },
    storedHtml: (versionId: string): StoredHtml | null => {
      const version = versionRow.get(versionId);
      if (!version || !live(pageRow.get(version.page_id))) return null;
      return { versionId: version.id, pageId: version.page_id, html: version.html, hasCharts: version.has_charts === 1, folder: hasFiles.get(version.id) !== undefined };
    },
    /** A folder version's files besides index.html, sorted by path. Empty for single-file versions. */
    versionFiles: (versionId: string): StoredFileEntry[] => fileRows.all(versionId).map((row) => ({ path: row.path, contentType: row.content_type, sha256: row.sha256 })),
    /** Stored bytes by sha256. */
    blobBytes: (digest: string) => blob.get(digest)?.bytes ?? null,
    /** Version id for a page's version number. */
    versionIdByN: (pageId: string, n: number) => db.prepare<[string, number], { id: string }>("SELECT id FROM page_versions WHERE page_id = ? AND n = ?").get(pageId, n)?.id ?? null,

    createPage: db.transaction((page: NewPage, version: NewVersion) => {
      const pageId = page.id ?? randomUUID();
      const createdAt = page.createdAt ?? version.createdAt ?? new Date().toISOString();
      const versionId = writeVersion(pageId, version, 1);
      insertPage.run({ id: pageId, title: page.title, kind: page.kind, projectId: page.projectId, folderPath: page.folderPath ?? null, sourceKey: page.sourceKey, producer: page.producer, producerKey: page.producerKey, versionId, createdAt });
      return { pageId, versionId };
    }),

    /**
     * Adds a version and makes it current. Fails when the page's current
     * version is no longer `expectedCurrentVersionId`. Revives a soft-deleted page.
     */
    appendVersion: db.transaction((pageId: string, expectedCurrentVersionId: string, version: NewVersion, update: { title?: string; projectId?: string | null; folderPath?: string | null } = {}) => {
      const page = pageRow.get(pageId);
      if (!page) throw new Error(`Page not found: ${pageId}`);
      if (page.current_version_id !== expectedCurrentVersionId) throw new StaleVersionError(`Stale page version: ${expectedCurrentVersionId} is not the current version of page ${pageId} (current: ${page.current_version_id}). Reload the page and try again.`);
      const versionId = writeVersion(pageId, version, (maxN.get(pageId)?.n ?? 0) + 1);
      const now = new Date().toISOString();
      db.prepare("UPDATE pages SET current_version_id = ?, title = COALESCE(?, title), project_id = COALESCE(project_id, ?), folder_path = CASE WHEN ? THEN ? ELSE folder_path END, updated_at = ?, deleted_at = NULL WHERE id = ?")
        .run(versionId, update.title ?? null, update.projectId ?? null, Object.hasOwn(update, "folderPath") ? 1 : 0, update.folderPath ?? null, now, pageId);
      return { pageId, versionId };
    }),

    rename: (pageId: string, title: string) => db.prepare("UPDATE pages SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(title, new Date().toISOString(), pageId).changes === 1,
    /**
     * Soft-deletes the page and drops its versions' folder files, then every blob no version uses.
     * A page revived by a later publish keeps its old versions' HTML, but their folder files are gone.
     */
    softDelete: db.transaction((pageId: string) => {
      const now = new Date().toISOString();
      if (db.prepare("UPDATE pages SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, pageId).changes !== 1) return false;
      db.prepare("DELETE FROM page_version_files WHERE version_id IN (SELECT id FROM page_versions WHERE page_id = ?)").run(pageId);
      db.prepare("DELETE FROM page_blobs WHERE sha256 NOT IN (SELECT sha256 FROM page_version_files)").run();
      return true;
    }),

    list: ({ offset, projectId, folder, query, limit = 50 }: { offset: number; projectId?: string; folder?: string; query?: string; limit?: number }) => {
      const like = query ? `%${query.replace(/[\\%_]/gu, "\\$&")}%` : null;
      const rows = db.prepare<unknown[], PageRow & { v_n: number; v_label: string | null; v_created_at: string; s_access: Share["access"] | null; s_status: Share["status"] | null; s_url: string | null }>(`
        SELECT p.*, v.n AS v_n, v.label AS v_label, v.created_at AS v_created_at, s.access AS s_access, s.status AS s_status, s.url AS s_url
        FROM pages p JOIN page_versions v ON v.id = p.current_version_id LEFT JOIN page_shares s ON s.page_id = p.id
        WHERE p.deleted_at IS NULL
          AND (? IS NULL OR p.project_id = ?)
          AND (? IS NULL OR p.folder_path = ?)
          AND (? IS NULL OR p.title LIKE ? ESCAPE '\\')
        ORDER BY p.updated_at DESC, p.id LIMIT ? OFFSET ?`).all(projectId ?? null, projectId ?? null, folder ?? null, folder ?? null, like, like, limit + 1, offset);
      const pages: PageListItem[] = rows.slice(0, limit).map((row) => ({
        page: toPage(row), version: { id: row.current_version_id, n: row.v_n, label: row.v_label, createdAt: row.v_created_at },
        share: row.s_access && row.s_status && row.s_url ? { access: row.s_access, status: row.s_status, url: row.s_url } : null,
        previewUrl: previewUrl(row.current_version_id),
      }));
      return { pages, nextOffset: rows.length > limit ? offset + limit : null };
    },
    listFolders: (projectId?: string) => db.prepare<unknown[], { project_id: string | null; folder_path: string | null; count: number }>(`
      SELECT project_id, folder_path, COUNT(*) AS count FROM pages
      WHERE deleted_at IS NULL AND (? IS NULL OR project_id = ?)
      GROUP BY project_id, folder_path ORDER BY project_id, folder_path
    `).all(projectId ?? null, projectId ?? null).map((row) => ({ projectId: row.project_id, path: row.folder_path, count: row.count })),
  };
}

export type PageStore = ReturnType<typeof createPageStore>;
