// SQLite access for page_shares. Reads pages/page_versions (owned by the core store) only to resolve ids.
import type Database from "better-sqlite3";
import type { Access, Share } from "../../contract.js";

export type ShareRow = {
  page_id: string; provider: string; slug: string; url: string; access: Access;
  allowed_domains_json: string; allowed_emails_json: string; password: string | null;
  follow: string; live_version_id: string | null; remote_version_id: string | null;
  status: Share["status"]; last_error: string | null; updated_at: string;
};

export type NewShare = { pageId: string; slug: string; url: string; access: Access; allowedDomains: string[]; allowedEmails: string[]; follow: string; remoteVersionId: string | null };
export type ShareUpdate = Partial<{
  access: Access; allowedDomains: string[]; allowedEmails: string[]; password: string | null; follow: string; url: string;
  liveVersionId: string | null; remoteVersionId: string | null; status: Share["status"]; lastError: string | null;
}>;

const COLUMN: Record<keyof ShareUpdate, string> = {
  access: "access", allowedDomains: "allowed_domains_json", allowedEmails: "allowed_emails_json", password: "password", follow: "follow", url: "url",
  liveVersionId: "live_version_id", remoteVersionId: "remote_version_id", status: "status", lastError: "last_error",
};

/** The public view of a row. The password never leaves this module except through `password()`. */
export function toShare(row: ShareRow): Share {
  return {
    pageId: row.page_id, provider: "here-now", slug: row.slug, url: row.url, access: row.access,
    allowedDomains: JSON.parse(row.allowed_domains_json) as string[], allowedEmails: JSON.parse(row.allowed_emails_json) as string[],
    hasPassword: row.password !== null, follow: row.follow as Share["follow"], liveVersionId: row.live_version_id,
    status: row.status, lastError: row.last_error, updatedAt: row.updated_at,
  };
}

export type ShareStore = {
  get(pageId: string): ShareRow | null;
  bySlug(slug: string): ShareRow | null;
  list(): ShareRow[];
  insert(share: NewShare): void;
  update(pageId: string, changes: ShareUpdate): void;
  delete(pageId: string): void;
  /** A version row, for checking that a pinned id belongs to the page. */
  version(versionId: string): { id: string; page_id: string; n: number } | null;
  versionIdByN(pageId: string, n: number): string | null;
  pageIdByKey(key: string): string | null;
  /** After a restart nothing is uploading. Rows left in `publishing` become errors the owner can retry. */
  markInterrupted(): void;
};

export function createShareStore(db: Database.Database): ShareStore {
  const byPage = db.prepare<[string], ShareRow>("SELECT * FROM page_shares WHERE page_id = ?");
  const bySlug = db.prepare<[string], ShareRow>("SELECT * FROM page_shares WHERE slug = ?");
  const all = db.prepare<[], ShareRow>("SELECT * FROM page_shares ORDER BY updated_at DESC");
  const insert = db.prepare(`INSERT INTO page_shares (page_id, provider, slug, url, access, allowed_domains_json, allowed_emails_json, password, follow, live_version_id, remote_version_id, status, last_error, updated_at)
    VALUES (@pageId, 'here-now', @slug, @url, @access, @domains, @emails, NULL, @follow, NULL, @remoteVersionId, 'publishing', NULL, @now)`);
  const remove = db.prepare<[string]>("DELETE FROM page_shares WHERE page_id = ?");
  const version = db.prepare<[string], { id: string; page_id: string; n: number }>("SELECT id, page_id, n FROM page_versions WHERE id = ?");
  const versionByN = db.prepare<[string, number], { id: string }>("SELECT id FROM page_versions WHERE page_id = ? AND n = ?");
  const pageByKey = db.prepare<[string], { id: string }>("SELECT id FROM pages WHERE source_key = ? AND deleted_at IS NULL");
  const interrupted = db.prepare<[string, string]>("UPDATE page_shares SET status = 'error', last_error = ?, updated_at = ? WHERE status = 'publishing'");

  return {
    get: (pageId: string) => byPage.get(pageId) ?? null,
    bySlug: (slug: string) => bySlug.get(slug) ?? null,
    list: () => all.all(),
    insert(share: NewShare) {
      insert.run({ ...share, domains: JSON.stringify(share.allowedDomains), emails: JSON.stringify(share.allowedEmails), now: new Date().toISOString() });
    },
    update(pageId: string, changes: ShareUpdate) {
      const entries = Object.entries(changes) as Array<[keyof ShareUpdate, unknown]>;
      if (entries.length === 0) return;
      const values: Record<string, unknown> = { pageId, now: new Date().toISOString() };
      const sets = entries.map(([key, value]) => {
        values[key] = Array.isArray(value) ? JSON.stringify(value) : value;
        return `${COLUMN[key]} = @${key}`;
      });
      db.prepare(`UPDATE page_shares SET ${sets.join(", ")}, updated_at = @now WHERE page_id = @pageId`).run(values);
    },
    delete: (pageId: string) => { remove.run(pageId); },
    /** A version row, for checking that a pinned id belongs to the page. */
    version: (versionId: string) => version.get(versionId) ?? null,
    versionIdByN: (pageId: string, n: number) => versionByN.get(pageId, n)?.id ?? null,
    pageIdByKey: (key: string) => pageByKey.get(`key:${key}`)?.id ?? null,
    /** After a restart nothing is uploading. Rows left in `publishing` become errors the owner can retry. */
    markInterrupted: () => interrupted.run("An upload was interrupted by a restart. Retry from the Share popover.", new Date().toISOString()),
  };
}
