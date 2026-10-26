import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHARE_MIGRATIONS,
  createShareStore,
  type PersistentShare,
} from "./share-store.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup() {
  const database = new Database(":memory:");
  databases.push(database);
  for (const migration of SHARE_MIGRATIONS) database.exec(migration);
  return createShareStore(database);
}

function persistentShare(
  overrides: Partial<PersistentShare> = {},
): PersistentShare {
  return {
    id: "share_one",
    threadId: "thr_one",
    title: "Shared thread",
    mode: "view",
    tunnelMode: "custom",
    publicUrl: "https://share.example.test/s/share_one/",
    accessCode: "quiet-river-4821",
    accessCredentials: {
      salt: Buffer.from("salt"),
      hash: Buffer.from("hash"),
    },
    previewUrl: null,
    startedAt: 100,
    expiresAt: null,
    reviewRef: "",
    ...overrides,
  };
}

describe("persistent share store", () => {
  it("round-trips durable shares including access credentials", () => {
    const store = setup();
    const share = persistentShare();

    store.save(share);

    expect(store.get(share.id)).toEqual(share);
    expect(store.getByThread(share.threadId)).toEqual(share);
    expect(store.list()).toEqual([share]);
  });

  it("keeps unbounded shares while removing expired records", () => {
    const store = setup();
    store.save(persistentShare());
    store.save(
      persistentShare({
        id: "share_expired",
        threadId: "thr_expired",
        expiresAt: 99,
      }),
    );

    expect(store.deleteExpired(100)).toBe(1);
    expect(store.list().map((share) => share.id)).toEqual(["share_one"]);
  });

  it("updates a restored quick share to its replacement public URL", () => {
    const store = setup();
    const share = persistentShare({ tunnelMode: "quick" });
    store.save(share);

    store.updatePublicUrl(
      share.id,
      "https://replacement.trycloudflare.com/s/share_one/",
    );

    expect(store.get(share.id)?.publicUrl).toBe(
      "https://replacement.trycloudflare.com/s/share_one/",
    );
  });
  it("migrates legacy review identities without changing links or credentials", () => {
    const database = new Database(":memory:");
    databases.push(database);
    for (const migration of SHARE_MIGRATIONS.slice(0, 2)) database.exec(migration);
    const insert = database.prepare(`INSERT INTO persistent_shares (
      id, thread_id, title, mode, tunnel_mode, public_url, access_code, access_code_salt, access_code_hash, started_at
    ) VALUES (?, ?, 'Legacy review', 'review', 'custom', ?, 'synthetic-code', ?, ?, 100)`);
    for (const id of ["one", "two"]) insert.run(`share_${id}`, `thr_${id}`, `https://review.example.test/s/${id}/`, Buffer.from("salt"), Buffer.from("hash"));
    for (const migration of SHARE_MIGRATIONS.slice(2)) database.exec(migration);
    const store = createShareStore(database);
    const rows = store.list();
    expect(new Set(rows.map((row) => row.reviewRef)).size).toBe(2);
    for (const row of rows) {
      expect(row.reviewRef).toMatch(/^review_[a-f0-9]{64}$/);
      expect(row.reviewRef).not.toBe(row.id);
      expect(row.accessCode).toBe("synthetic-code");
      expect(row.accessCredentials).toEqual({ salt: Buffer.from("salt"), hash: Buffer.from("hash") });
      expect(row.publicUrl).toBe(`https://review.example.test/s/${row.id.slice(6)}/`);
    }
    store.save(rows[0]!);
    expect(store.get(rows[0]!.id)?.reviewRef).toBe(rows[0]!.reviewRef);
  });
});
