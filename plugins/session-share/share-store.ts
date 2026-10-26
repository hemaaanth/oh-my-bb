import type Database from "better-sqlite3";
import type { ShareMode, TunnelMode } from "./contract.js";
import type { GuestAccessCredentials } from "./guest-server.js";

export const SHARE_MIGRATIONS = [
  `CREATE TABLE persistent_shares (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('view', 'review')),
    tunnel_mode TEXT NOT NULL CHECK (tunnel_mode IN ('quick', 'custom')),
    public_url TEXT NOT NULL,
    access_code TEXT NOT NULL,
    access_code_salt BLOB NOT NULL,
    access_code_hash BLOB NOT NULL,
    preview_url TEXT,
    started_at INTEGER NOT NULL,
    expires_at INTEGER
  )`,
  `CREATE INDEX persistent_shares_started_at
    ON persistent_shares (started_at DESC)`,
  `ALTER TABLE persistent_shares ADD COLUMN review_ref TEXT NOT NULL DEFAULT ''`,
  `UPDATE persistent_shares SET review_ref = 'review_' || lower(hex(randomblob(32))) WHERE mode = 'review'`,
] as const;

export interface PersistentShare {
  id: string;
  threadId: string;
  title: string;
  mode: ShareMode;
  tunnelMode: TunnelMode;
  publicUrl: string;
  accessCode: string;
  accessCredentials: GuestAccessCredentials;
  previewUrl: string | null;
  startedAt: number;
  expiresAt: number | null;
  reviewRef: string;
}

interface PersistentShareRow {
  id: string;
  thread_id: string;
  title: string;
  mode: ShareMode;
  tunnel_mode: TunnelMode;
  public_url: string;
  access_code: string;
  access_code_salt: Buffer;
  access_code_hash: Buffer;
  preview_url: string | null;
  started_at: number;
  expires_at: number | null;
  review_ref: string;
}

function fromRow(row: PersistentShareRow): PersistentShare {
  return {
    id: row.id,
    threadId: row.thread_id,
    title: row.title,
    mode: row.mode,
    tunnelMode: row.tunnel_mode,
    publicUrl: row.public_url,
    accessCode: row.access_code,
    accessCredentials: {
      salt: Buffer.from(row.access_code_salt),
      hash: Buffer.from(row.access_code_hash),
    },
    previewUrl: row.preview_url,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    reviewRef: row.review_ref,
  };
}

export function createShareStore(database: Database.Database) {
  const saveStatement = database.prepare(`
    INSERT INTO persistent_shares (
      id, thread_id, title, mode, tunnel_mode, public_url, access_code,
      access_code_salt, access_code_hash, preview_url, started_at, expires_at, review_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      thread_id = excluded.thread_id,
      title = excluded.title,
      mode = excluded.mode,
      tunnel_mode = excluded.tunnel_mode,
      public_url = excluded.public_url,
      access_code = excluded.access_code,
      access_code_salt = excluded.access_code_salt,
      access_code_hash = excluded.access_code_hash,
      preview_url = excluded.preview_url,
      started_at = excluded.started_at,
      expires_at = excluded.expires_at,
      review_ref = excluded.review_ref
  `);
  const selectAll = database.prepare(`
    SELECT * FROM persistent_shares ORDER BY started_at DESC
  `);
  const selectById = database.prepare(`
    SELECT * FROM persistent_shares WHERE id = ?
  `);
  const selectByThread = database.prepare(`
    SELECT * FROM persistent_shares WHERE thread_id = ?
  `);
  const updatePublicUrl = database.prepare(`
    UPDATE persistent_shares SET public_url = ? WHERE id = ?
  `);
  const remove = database.prepare(`DELETE FROM persistent_shares WHERE id = ?`);
  const removeExpired = database.prepare(`
    DELETE FROM persistent_shares
    WHERE expires_at IS NOT NULL AND expires_at <= ?
  `);

  return {
    save(share: PersistentShare): void {
      saveStatement.run(
        share.id,
        share.threadId,
        share.title,
        share.mode,
        share.tunnelMode,
        share.publicUrl,
        share.accessCode,
        share.accessCredentials.salt,
        share.accessCredentials.hash,
        share.previewUrl,
        share.startedAt,
        share.expiresAt,
        share.reviewRef,
      );
    },
    list(): PersistentShare[] {
      return (selectAll.all() as PersistentShareRow[]).map(fromRow);
    },
    get(id: string): PersistentShare | null {
      const row = selectById.get(id) as PersistentShareRow | undefined;
      return row ? fromRow(row) : null;
    },
    getByThread(threadId: string): PersistentShare | null {
      const row = selectByThread.get(threadId) as PersistentShareRow | undefined;
      return row ? fromRow(row) : null;
    },
    updatePublicUrl(id: string, publicUrl: string): void {
      updatePublicUrl.run(publicUrl, id);
    },
    delete(id: string): boolean {
      return remove.run(id).changes > 0;
    },
    deleteExpired(now = Date.now()): number {
      return removeExpired.run(now).changes;
    },
  };
}
