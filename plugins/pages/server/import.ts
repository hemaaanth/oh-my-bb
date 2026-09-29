// One-time, idempotent import of the old `artifacts` plugin database.
// Page id = artifact id and version id = revision id, so ::artifact{id revision} still resolves.
// A finished run records the old store's file signature in page_meta, so later plugin loads
// only stat the file and skip the import until the old store changes.
import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { prReviewDocumentSchema, provenanceSchema, type PageDocument, type Provenance } from "../contract.js";
import { convertLegacyReport, inspectCharts, renderPrReview } from "../render/index.js";
import { sha256 } from "./service.js";
import type { NewVersion, PageStore } from "./store.js";

const SOURCE = "artifacts";
export const IMPORT_MARKER_KEY = "import:artifacts";

type ArtifactRow = { id: string; title: string; kind: string; producer: string; producer_key: string; created_at: string; updated_at: string };
type RevisionRow = { id: string; sequence: number; provenance_json: string; document_json: string; bundle_json: string; created_at: string };
/** `upToDate`: the old store has not changed since the last finished import, so nothing was read. */
export type ImportCounts = { pages: number; versions: number; skipped: number; failed: number; upToDate: boolean };
type Logger = { info(message: string): void; warn(message: string): void };

function legacyHtml(bundleJson: string): string | null {
  try {
    const bundle: unknown = JSON.parse(bundleJson);
    return typeof bundle === "object" && bundle !== null && "html" in bundle && typeof bundle.html === "string" ? bundle.html : null;
  } catch { return null; }
}

function renderRevision(kind: string, revision: RevisionRow): Pick<NewVersion, "html" | "document"> {
  const raw: unknown = JSON.parse(revision.document_json);
  if (kind === "pr-review") {
    const document: PageDocument = prReviewDocumentSchema.parse(raw);
    return { html: renderPrReview(document), document };
  }
  return { html: convertLegacyReport(raw), document: null };
}

/** Size and mtime of the database file and its WAL. Null when the database does not exist. */
export function legacySignature(legacyPath: string): string | null {
  const stat = (file: string) => { try { const info = statSync(file); return `${info.size}:${info.mtimeMs}`; } catch { return null; } };
  const main = stat(legacyPath);
  return main === null ? null : `${main}|${stat(`${legacyPath}-wal`) ?? "-"}`;
}

/**
 * Imports every artifact revision not yet recorded in `page_imports`, once per change of the old store.
 * `open` opens the legacy database read-only; a missing file or table is not an error.
 */
export function importLegacyArtifacts({ db, store, legacyPath, open, log }: { db: Database.Database; store: PageStore; legacyPath: string; open: (path: string) => Database.Database; log: Logger }): ImportCounts {
  const counts: ImportCounts = { pages: 0, versions: 0, skipped: 0, failed: 0, upToDate: false };
  const signature = legacySignature(legacyPath);
  if (signature === null) return counts;
  const marker = db.prepare<[string], { value: string }>("SELECT value FROM page_meta WHERE key = ?");
  if (marker.get(IMPORT_MARKER_KEY)?.value === signature) return { ...counts, upToDate: true };

  const legacy = open(legacyPath);
  try {
    const tables = new Set(legacy.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (tables.has("artifacts") && tables.has("artifact_revisions")) importRevisions(db, store, legacy, counts, log);
  } finally {
    legacy.close();
  }
  // Failures are logged once; retrying them on every load would fail the same way.
  db.prepare("INSERT INTO page_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(IMPORT_MARKER_KEY, signature);
  if (counts.pages || counts.versions || counts.failed) {
    log.info(`artifacts import: ${counts.pages} pages and ${counts.versions} versions imported, ${counts.skipped} already imported, ${counts.failed} failed`);
  }
  return counts;
}

function importRevisions(db: Database.Database, store: PageStore, legacy: Database.Database, counts: ImportCounts, log: Logger) {
  const imported = new Set(db.prepare<[string], { source_id: string }>("SELECT source_id FROM page_imports WHERE source = ?").all(SOURCE).map((row) => row.source_id));
  // Ids only: the JSON of already imported revisions is never read.
  const pending = new Set<string>();
  for (const { id } of legacy.prepare<[], { id: string }>("SELECT id FROM artifact_revisions").all()) {
    if (imported.has(id)) counts.skipped += 1;
    else pending.add(id);
  }
  if (pending.size === 0) return;

  const record = db.prepare("INSERT INTO page_imports (source, source_id, page_id, version_id, imported_at) VALUES (?, ?, ?, ?, ?)");
  const revisionsOf = legacy.prepare<[string], RevisionRow>("SELECT id, sequence, provenance_json, document_json, bundle_json, created_at FROM artifact_revisions WHERE artifact_id = ? ORDER BY sequence");
  for (const artifact of legacy.prepare<[], ArtifactRow>("SELECT id, title, kind, producer, producer_key, created_at, updated_at FROM artifacts ORDER BY created_at").all()) {
    let added = 0;
    for (const revision of revisionsOf.all(artifact.id)) {
      if (!pending.has(revision.id)) continue;
      try {
        const rendered = renderRevision(artifact.kind, revision);
        const provenanceParse = provenanceSchema.safeParse(JSON.parse(revision.provenance_json));
        const provenance: Provenance | null = provenanceParse.success ? provenanceParse.data : null;
        const version: NewVersion = {
          id: revision.id, n: revision.sequence, label: null, ...rendered, sha256: sha256(rendered.html), hasCharts: inspectCharts(rendered.html).hasCharts,
          provenance, sourcePath: null, threadId: provenance?.threadId ?? null, legacyHtml: legacyHtml(revision.bundle_json), createdAt: revision.created_at,
        };
        db.transaction(() => {
          const existing = store.rawPage(artifact.id);
          if (!existing) {
            store.createPage({ id: artifact.id, title: artifact.title, kind: artifact.kind === "pr-review" ? "document" : "file", projectId: provenance?.projectId ?? null, sourceKey: null, producer: artifact.producer, producerKey: artifact.producer_key, createdAt: artifact.created_at }, version);
            counts.pages += 1;
          } else if (store.versionIdByN(artifact.id, revision.sequence)) {
            throw new Error(`page ${artifact.id} already has version ${revision.sequence}`);
          } else {
            store.appendVersion(artifact.id, existing.page.currentVersionId, version, { title: artifact.title, projectId: provenance?.projectId ?? null });
          }
          record.run(SOURCE, revision.id, artifact.id, revision.id, new Date().toISOString());
        })();
        counts.versions += 1;
        added += 1;
      } catch (error) {
        counts.failed += 1;
        log.warn(`import skipped artifact ${artifact.id} revision ${revision.sequence}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Keep the library order of the old artifacts.
    if (added) db.prepare("UPDATE pages SET updated_at = ? WHERE id = ?").run(artifact.updated_at, artifact.id);
  }
}
