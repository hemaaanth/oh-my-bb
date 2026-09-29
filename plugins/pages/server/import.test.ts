import Database from "better-sqlite3";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_MIGRATIONS } from "../migrations.js";
import { IMPORT_MARKER_KEY, importLegacyArtifacts } from "./import.js";
import { createPageStore } from "./store.js";

// Schema of the retired `artifacts` plugin (plugins/artifacts/migrations.ts), copied so this
// fixture outlives that plugin's deletion.
const ARTIFACT_MIGRATIONS = [
  `CREATE TABLE artifacts (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, producer TEXT NOT NULL, producer_key TEXT NOT NULL UNIQUE, current_revision_id TEXT NOT NULL, live_revision_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX artifacts_updated ON artifacts(updated_at DESC);`,
  `CREATE TABLE artifact_revisions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, sequence INTEGER NOT NULL, parent_revision_id TEXT, provenance_json TEXT NOT NULL, document_json TEXT NOT NULL, bundle_json TEXT NOT NULL, brand_source_commit TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(artifact_id, sequence));`,
  `CREATE TABLE artifact_publications (artifact_id TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT NOT NULL, site_url TEXT, remote_version_id TEXT, access_mode TEXT, updated_at TEXT NOT NULL);`,
  `ALTER TABLE artifact_revisions ADD COLUMN base_live_revision_id TEXT;
  ALTER TABLE artifact_revisions ADD COLUMN base_remote_version_id TEXT;`,
];

const REVIEW_ID = "f4ea2a85-0b7b-403b-99e2-7a1048e58207";
const REPORT_ID = "0c9df367-cedd-462c-9cf2-a7cfe804391e";
const rev = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const review = (summary: string) => ({ schema: "pr-review/v1", title: "PR #1", target: { kind: "pull-request", label: "PR #1" }, intent: "Check", summary, verdict: "pass", coverage: { reviewed: [], skipped: [], validation: [] }, findings: [] });
const provenance = { threadId: "thr_old", projectId: "proj_old" };
const silent = { info() {}, warn() {} };

let dir: string;
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  dir = mkdtempSync(path.join(tmpdir(), "pages-import-"));
  const legacyPath = path.join(dir, "artifacts.db");
  const legacy = new Database(legacyPath);
  legacy.exec(ARTIFACT_MIGRATIONS.join("\n"));
  const addArtifact = legacy.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)");
  const addRevision = legacy.prepare("INSERT INTO artifact_revisions (id, artifact_id, sequence, parent_revision_id, provenance_json, document_json, bundle_json, brand_source_commit, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'x', ?)");
  addArtifact.run(REVIEW_ID, "PR #1", "pr-review", "pr-review", "pr-review:example#1", rev(2), "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
  addRevision.run(rev(1), REVIEW_ID, 1, JSON.stringify(provenance), JSON.stringify(review("one")), JSON.stringify({ html: "<p>old 1</p>" }), "2026-09-01T00:00:00.000Z");
  addRevision.run(rev(2), REVIEW_ID, 2, JSON.stringify(provenance), JSON.stringify(review("two")), JSON.stringify({ html: "<p>old 2</p>" }), "2026-09-02T00:00:00.000Z");
  addArtifact.run(REPORT_ID, "Flint chart", "report", "flint", "flint:proj:thr:1", rev(3), "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
  addRevision.run(rev(3), REPORT_ID, 1, JSON.stringify(provenance), JSON.stringify({ schema: "report/v1", title: "Flint chart", blocks: [] }), JSON.stringify({ html: "<p>old report</p>" }), "2026-09-03T00:00:00.000Z");
  const db = new Database(":memory:");
  for (const statement of PAGE_MIGRATIONS) db.exec(statement);
  const store = createPageStore(db);
  let opens = 0;
  const run = () => importLegacyArtifacts({ db, store, legacyPath, open: (file) => { opens += 1; return new Database(file, { readonly: true, fileMustExist: true }); }, log: silent });
  /** Marks the old database as changed, as a write from the old plugin would. */
  let touches = 0;
  const touch = () => { touches += 1; const later = new Date(Date.now() + touches * 60_000); utimesSync(legacyPath, later, later); };
  return { legacy, db, store, run, touch, opens: () => opens };
}

describe("importLegacyArtifacts", () => {
  it("keeps artifact and revision ids, and imports each revision exactly once", () => {
    const { legacy, db, store, run, touch } = fixture();
    expect(run()).toEqual({ pages: 2, versions: 3, skipped: 0, failed: 0, upToDate: false });

    const reviewPage = store.detail(REVIEW_ID)!;
    expect(reviewPage.page).toMatchObject({ kind: "document", producer: "pr-review", producerKey: "pr-review:example#1", projectId: "proj_old", currentVersionId: rev(2), updatedAt: "2026-09-02T00:00:00.000Z" });
    expect(reviewPage.versions.map((v) => [v.id, v.n])).toEqual([[rev(2), 2], [rev(1), 1]]);
    expect(reviewPage.version.document?.summary).toBe("two");
    expect(store.detail(REVIEW_ID, rev(1))?.version.threadId).toBe("thr_old");
    expect(store.detail(REPORT_ID)!.page).toMatchObject({ kind: "file", sourceKey: null, producer: "flint", producerKey: "flint:proj:thr:1" });
    expect(store.detail(REPORT_ID)!.version.document).toBeNull();
    expect(db.prepare("SELECT legacy_html FROM page_versions WHERE id = ?").pluck().get(rev(3))).toBe("<p>old report</p>");

    // Nothing changed, so the next start does not read the old store.
    expect(run()).toEqual({ pages: 0, versions: 0, skipped: 0, failed: 0, upToDate: true });
    expect(db.prepare("SELECT COUNT(*) FROM page_versions").pluck().get()).toBe(3);
    // A changed store with nothing new is scanned once, by id only.
    touch();
    expect(run()).toEqual({ pages: 0, versions: 0, skipped: 3, failed: 0, upToDate: false });

    // A revision added to the old plugin later is picked up on the next start.
    legacy.prepare("INSERT INTO artifact_revisions (id, artifact_id, sequence, parent_revision_id, provenance_json, document_json, bundle_json, brand_source_commit, created_at) VALUES (?, ?, 3, NULL, ?, ?, '{}', 'x', ?)")
      .run(rev(4), REVIEW_ID, JSON.stringify(provenance), JSON.stringify(review("three")), "2026-09-04T00:00:00.000Z");
    touch();
    expect(run()).toEqual({ pages: 0, versions: 1, skipped: 3, failed: 0, upToDate: false });
    expect(store.detail(REVIEW_ID)!.version).toMatchObject({ id: rev(4), n: 3 });
    legacy.close();
  });

  it("opens the old database only when its file changed since the last finished run", () => {
    const { legacy, db, run, touch, opens } = fixture();
    legacy.close();
    run();
    expect(opens()).toBe(1);
    expect(db.prepare("SELECT value FROM page_meta WHERE key = ?").pluck().get(IMPORT_MARKER_KEY)).toEqual(expect.any(String));
    for (let load = 0; load < 5; load += 1) expect(run().upToDate).toBe(true);
    expect(opens()).toBe(1);
    touch();
    expect(run().upToDate).toBe(false);
    expect(opens()).toBe(2);
  });

  it("does nothing when the old database or its tables are missing", () => {
    const { db, store } = fixture();
    const empty = path.join(dir, "empty.db");
    new Database(empty).close();
    const open = (file: string) => new Database(file, { readonly: true, fileMustExist: true });
    expect(importLegacyArtifacts({ db, store, legacyPath: path.join(dir, "absent.db"), open, log: silent })).toMatchObject({ pages: 0, versions: 0 });
    expect(importLegacyArtifacts({ db, store, legacyPath: empty, open, log: silent })).toMatchObject({ pages: 0, versions: 0 });
  });
});
