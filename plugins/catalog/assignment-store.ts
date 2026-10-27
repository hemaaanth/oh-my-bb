import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CatalogStore } from "./store.js";
import { assignmentDigest } from "./assignment-digest.js";
import {
  AssignmentError, assignmentId, assignmentReceiptSchema, assignmentRecordSchema,
  canonicalRecords, sameIdentity, transferIdentitySchema,
  type AssignmentRecord, type TransferIdentity,
} from "./assignment-contract.js";

export const assignmentMigration = `CREATE TABLE catalog_assignment_authority (
  id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, format_version INTEGER NOT NULL,
  identity_json TEXT, receipt_json TEXT, records_json TEXT, activation_json TEXT,
  reverse_json TEXT, activated_at TEXT
);
CREATE TABLE catalog_assignment_records (
  record_json TEXT PRIMARY KEY, origin_json TEXT NOT NULL
);
CREATE TABLE catalog_assignment_history (
  id TEXT PRIMARY KEY, operation TEXT NOT NULL, identity_json TEXT,
  details_json TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE catalog_assignment_aborts (
  generation TEXT PRIMARY KEY, identity_json TEXT NOT NULL, at TEXT NOT NULL
);`;

interface Row {
  state: "staged" | "active" | "reverse-frozen";
  format_version: number; activation_json: string | null;
  identity_json: string | null; receipt_json: string | null; records_json: string | null;
  reverse_json: string | null; activated_at: string | null;
}

export class CatalogAssignmentStore {
  constructor(private readonly db: Database.Database, private readonly catalog: CatalogStore) {}

  private row(): Row | undefined {
    const row = this.db.prepare("SELECT * FROM catalog_assignment_authority WHERE id = 1").get() as Row | undefined;
    if (row && row.format_version !== 1) throw new AssignmentError("handoff-mismatch", "Unsupported persisted assignment/provenance format. Use a compatible Executor release; do not restore old authority.");
    return row;
  }
  status() {
    const row = this.row();
    const receipt = row?.receipt_json ? assignmentReceiptSchema.parse(JSON.parse(row.receipt_json)) : null;
    return { state: row?.state ?? "uninitialized" as const,
      transfer: row?.identity_json ? transferIdentitySchema.parse(JSON.parse(row.identity_json)) : null,
      destinationRevision: receipt?.destinationRevision ?? null, conflicts: receipt?.conflicts ?? 0 };
  }
  private recordChange(operation: string, details: unknown, identity: TransferIdentity | null = this.status().transfer) {
    this.db.prepare("INSERT INTO catalog_assignment_history (id, operation, identity_json, details_json, at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), operation, identity ? JSON.stringify(identity) : null, JSON.stringify(details), new Date().toISOString());
  }
  private requireUnabandoned(identity: TransferIdentity) {
    const row = this.db.prepare("SELECT identity_json FROM catalog_assignment_aborts WHERE generation = ?").get(identity.generation) as { identity_json: string } | undefined;
    if (row) throw new AssignmentError("handoff-mismatch", "This transfer generation was durably abandoned.");
  }
  initializeFresh() {
    return this.db.transaction(() => {
      const status = this.status();
      if (status.state === "active" && status.transfer === null) { this.requireActive(); return; }
      if (status.state !== "uninitialized" || this.catalog.listAssignments().length) {
        throw new AssignmentError("not-migrated", "Existing or staged assignments require handoff, not fresh initialization.");
      }
      this.db.prepare("INSERT INTO catalog_assignment_authority (id, state, format_version, activation_json, activated_at) VALUES (1, 'active', 1, ?, ?)")
        .run(JSON.stringify({ formatVersion: 1, transfer: null, initialization: "no-legacy-assignments" }), new Date().toISOString());
      this.recordChange("fresh-initialized", { confirmation: "no-legacy-assignments", sourceAbsence: "native-installed-plugin-metadata", checkedAt: new Date().toISOString() });
    })();
  }
  stage(identity: TransferIdentity, records: AssignmentRecord[]) {
    const sorted = canonicalRecords(records);
    if (assignmentDigest(sorted) !== identity.semanticDigest) throw new AssignmentError("handoff-mismatch", "Source digest differs from the complete staged records.");
    return this.db.transaction(() => {
      this.requireUnabandoned(identity);
      const status = this.status();
      if (sameIdentity(status.transfer, identity)) return this.receipt(identity);
      if (status.state !== "uninitialized") {
        throw new AssignmentError("assignment-frozen", "A different assignment generation already exists. Do not replace staged, active or reverse-frozen authority.");
      }
      const known = new Set(this.catalog.listBundles().map((bundle) => bundle.id));
      const conflicts = sorted.filter((record) => record.type === "legacyBundle" || !known.has(record.targetId)).length;
      const receipt = { ...identity, phase: "staged" as const, recordCount: sorted.length, destinationRevision: randomUUID(), conflicts };
      const localLegacy = this.catalog.listAssignments().map((row) => ({ type: "legacyBundle" as const, ...row }));
      canonicalRecords([...new Map([...sorted, ...localLegacy].map((record) => [JSON.stringify(record), record])).values()]);
      const provenance = { schemaVersion: 1, sourcePluginId: "projects", sourceGeneration: identity.generation,
        sourceSemanticDigest: identity.semanticDigest, destinationRevision: receipt.destinationRevision,
        countByKind: { bundles: sorted.length }, conflicts, phase: "staged", completedAt: new Date().toISOString(),
        localLegacy, sourceRecords: sorted };
      this.recordChange("staged", provenance, identity);
      this.db.prepare(`INSERT INTO catalog_assignment_authority (id, state, format_version, identity_json, receipt_json, records_json)
        VALUES (1, 'staged', 1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state='staged', format_version=1, identity_json=excluded.identity_json,
        receipt_json=excluded.receipt_json, records_json=excluded.records_json, reverse_json=NULL, activated_at=NULL, activation_json=NULL`)
        .run(JSON.stringify(identity), JSON.stringify(receipt), JSON.stringify({ source: sorted, localLegacy }));
      return receipt;
    })();
  }
  receipt(identity: TransferIdentity) {
    this.requireUnabandoned(identity);
    if (!sameIdentity(this.status().transfer, identity)) throw new AssignmentError("handoff-mismatch", "No exact staged assignment identity.");
    const saved = this.row()?.receipt_json;
    if (!saved) throw new AssignmentError("handoff-mismatch", "No staged receipt.");
    return assignmentReceiptSchema.parse(JSON.parse(saved));
  }
  activate(identity: TransferIdentity) {
    return this.db.transaction(() => {
      this.requireUnabandoned(identity);
      const status = this.status();
      if (!sameIdentity(status.transfer, identity)) throw new AssignmentError("handoff-mismatch", "Activation identity differs from the staged transfer.");
      if (status.state === "active") { this.requireActive(identity); return; }
      if (status.state !== "staged") throw new AssignmentError("assignment-frozen", "Only a staged transfer can activate.");
      const staged = JSON.parse(this.row()!.records_json!) as { source: AssignmentRecord[]; localLegacy: AssignmentRecord[] };
      const insert = this.db.prepare("INSERT OR IGNORE INTO catalog_assignment_records (record_json, origin_json) VALUES (?, ?)");
      this.db.prepare("DELETE FROM catalog_assignment_records").run();
      for (const record of staged.source) insert.run(JSON.stringify(assignmentRecordSchema.parse(record)), JSON.stringify({ source: "projects", generation: identity.generation }));
      // Legacy local rows are evidence, never an extra grant of project/global scope.
      for (const record of staged.localLegacy) insert.run(JSON.stringify(assignmentRecordSchema.parse(record)), JSON.stringify({ source: "catalog-legacy", generation: identity.generation }));
      const activation = { formatVersion: 1, transfer: identity, destinationRevision: status.destinationRevision, completedAt: new Date().toISOString() };
      this.db.prepare("UPDATE catalog_assignment_authority SET state = 'active', activation_json = ?, activated_at = ? WHERE id = 1")
        .run(JSON.stringify(activation), activation.completedAt);
      this.recordChange("activated", { destinationRevision: status.destinationRevision });
    })();
  }
  abort(identity: TransferIdentity) {
    this.db.transaction(() => {
      const status = this.status();
      const exact = sameIdentity(status.transfer, identity);
      if (status.transfer?.generation === identity.generation && !exact) throw new AssignmentError("handoff-mismatch", "Abort identity differs from the staged generation.");
      if (exact && status.state !== "staged") throw new AssignmentError("handoff-mismatch", "An advisory abort cannot revoke active or reverse-frozen ownership.");
      const previous = this.db.prepare("SELECT identity_json FROM catalog_assignment_aborts WHERE generation = ?").get(identity.generation) as { identity_json: string } | undefined;
      const encoded = JSON.stringify(transferIdentitySchema.parse(identity));
      if (previous && previous.identity_json !== encoded) throw new AssignmentError("handoff-mismatch", "Abandoned identity differs from this generation.");
      if (!previous) {
        this.db.prepare("INSERT INTO catalog_assignment_aborts (generation, identity_json, at) VALUES (?, ?, ?)").run(identity.generation, encoded, new Date().toISOString());
        this.recordChange("abandoned", { staged: exact }, identity);
      }
      if (exact) this.db.prepare("DELETE FROM catalog_assignment_authority WHERE id = 1 AND state = 'staged'").run();
    })();
  }
  requireActive(identity?: TransferIdentity) {
    const status = this.status();
    if (identity && !sameIdentity(status.transfer, identity)) throw new AssignmentError("handoff-mismatch", "Compatibility request differs from active identity.");
    if (status.state !== "active") throw new AssignmentError(status.state === "uninitialized" ? "not-migrated" : "assignment-frozen", "Executor assignment authority is not active.");
    const saved = this.row()!.activation_json;
    const activation = saved ? JSON.parse(saved) as { formatVersion?: unknown; transfer?: unknown; initialization?: unknown } : null;
    if (!activation || activation.formatVersion !== 1 || (status.transfer
      ? !sameIdentity(transferIdentitySchema.parse(activation.transfer), status.transfer)
      : activation.transfer !== null || activation.initialization !== "no-legacy-assignments")) {
      throw new AssignmentError("handoff-mismatch", "Local durable activation receipt is missing or incompatible.");
    }
  }
  records(): AssignmentRecord[] {
    this.row();
    return canonicalRecords((this.db.prepare("SELECT record_json FROM catalog_assignment_records").all() as { record_json: string }[])
      .map((row) => assignmentRecordSchema.parse(JSON.parse(row.record_json))));
  }
  projection() {
    this.requireActive();
    const globalBundleIds: string[] = [];
    const projects = new Map<string, string[]>();
    for (const record of this.records()) if (record.type === "reference") {
      if (record.projectId === null) globalBundleIds.push(record.targetId);
      else projects.set(record.projectId, [...(projects.get(record.projectId) ?? []), record.targetId]);
    }
    return { globalBundleIds, projects: [...projects].map(([projectId, bundleIds]) => ({ projectId, bundleIds })) };
  }
  write(method: "setGlobalBundle" | "setProjectBundle" | "removeBundle", input: { targetId?: string; projectId?: string; enabled?: boolean; bundleId?: string }) {
    this.db.transaction(() => {
      this.requireActive();
      if (method === "removeBundle") {
        for (const record of this.records()) if (record.type === "reference" && record.targetId === input.bundleId) {
          this.db.prepare("DELETE FROM catalog_assignment_records WHERE record_json = ?").run(JSON.stringify(record));
        }
      } else {
        const record = assignmentRecordSchema.parse({ type: "reference", projectId: method === "setGlobalBundle" ? null : input.projectId, targetId: input.targetId });
        if (input.enabled) this.db.prepare("INSERT OR IGNORE INTO catalog_assignment_records (record_json, origin_json) VALUES (?, ?)")
          .run(JSON.stringify(record), JSON.stringify({ source: "catalog", at: new Date().toISOString() }));
        else this.db.prepare("DELETE FROM catalog_assignment_records WHERE record_json = ?").run(JSON.stringify(record));
      }
      this.recordChange(method, input);
      this.records();
    })();
  }
  reverseGeneration(): string | null {
    const encoded = this.row()?.reverse_json;
    if (!encoded) return null;
    const snapshot: unknown = JSON.parse(encoded);
    if (!snapshot || typeof snapshot !== "object" || !("reverseGeneration" in snapshot)) throw new AssignmentError("handoff-mismatch", "Reverse snapshot has no generation.");
    return assignmentId.parse(snapshot.reverseGeneration);
  }
  reverseExport(identity: TransferIdentity, cursor: number, reverseGeneration: string | null) {
    return this.db.transaction(() => {
      const status = this.status();
      if (!sameIdentity(status.transfer, identity)) throw new AssignmentError("handoff-mismatch", "Reverse identity differs from active transfer.");
      if (status.state !== "active" && status.state !== "staged" && status.state !== "reverse-frozen") throw new AssignmentError("assignment-frozen", "Only preserved staged or active ownership can reverse-freeze.");
      let snapshot: { reverseGeneration: string; reverseDigest: string; records: AssignmentRecord[] };
      const existing = this.row()!.reverse_json;
      if (existing) snapshot = JSON.parse(existing) as typeof snapshot;
      else {
        if (status.state === "active") this.requireActive(identity);
        const staged = this.row()!.records_json ? JSON.parse(this.row()!.records_json!) as { source: AssignmentRecord[]; localLegacy: AssignmentRecord[] } : null;
        const records = status.state === "staged" && staged
          ? canonicalRecords([...new Map([...staged.source, ...staged.localLegacy].map((record) => [JSON.stringify(record), record])).values()])
          : this.records();
        snapshot = { reverseGeneration: randomUUID(), reverseDigest: assignmentDigest(records), records };
        this.db.prepare("UPDATE catalog_assignment_authority SET state='reverse-frozen', reverse_json=? WHERE id=1").run(JSON.stringify(snapshot));
        this.recordChange("reverse-frozen", { reverseGeneration: snapshot.reverseGeneration, reverseDigest: snapshot.reverseDigest, recordCount: records.length });
      }
      if (reverseGeneration !== null && reverseGeneration !== snapshot.reverseGeneration) throw new AssignmentError("handoff-mismatch", "Reverse generation differs from the durable snapshot.");
      if (cursor > snapshot.records.length) throw new AssignmentError("handoff-mismatch", "Reverse cursor exceeds record count.");
      const records = snapshot.records.slice(cursor, cursor + 200);
      return { ...identity, reverseGeneration: snapshot.reverseGeneration, reverseDigest: snapshot.reverseDigest,
        recordCount: snapshot.records.length, frozen: true as const, records, nextCursor: cursor + records.length < snapshot.records.length ? cursor + records.length : null };
    })();
  }
}
