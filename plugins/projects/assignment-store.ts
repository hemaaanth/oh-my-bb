import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AssignmentError, assignmentRecordSchema, destinations, receiptSchema, transferIdentitySchema, validateRecords,
  type AssignmentKind, type AssignmentRecord, type AssignmentReceipt, type TransferIdentity,
} from "./assignments.js";

export const assignmentMigration = `CREATE TABLE assignment_transfers (
  kind TEXT PRIMARY KEY, state TEXT NOT NULL, identity_json TEXT NOT NULL,
  reverse_generation TEXT, reverse_digest TEXT, receipt_json TEXT
);
CREATE TABLE assignment_exports (
  kind TEXT NOT NULL, ordinal INTEGER NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY (kind, ordinal)
);
CREATE TABLE assignment_legacy_records (
  kind TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (kind, record_json)
);
CREATE TABLE assignment_import_receipts (name TEXT PRIMARY KEY, input_json TEXT NOT NULL, result_json TEXT NOT NULL);`;

export const assignmentAbortMigration = `CREATE TABLE assignment_aborts (
  kind TEXT NOT NULL, generation TEXT NOT NULL, identity_json TEXT NOT NULL,
  previous_state TEXT NOT NULL, receipt_json TEXT, aborted_at TEXT NOT NULL,
  PRIMARY KEY (kind, generation)
);`;

type State = "source-owned" | "frozen/exported" | "destination-staged" | "destination-owned" | "reverse-frozen";
interface Row { state: State; identity_json: string; reverse_generation: string | null; reverse_digest: string | null; receipt_json: string | null }
export const MAX_ASSIGNMENT_RECORDS = 100_000;
export function canonicalRecords(records: AssignmentRecord[]): AssignmentRecord[] {
  return records.map((record) => {
    const parsed = assignmentRecordSchema.parse(record);
    return { record: parsed, key: JSON.stringify(parsed) };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(({ record }) => record);
}
export function assignmentDigest(records: AssignmentRecord[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalRecords(records))).digest("hex");
}

export class AssignmentStore {
  constructor(private readonly db: Database.Database) {}

  requireReady() {
    if (!this.db.prepare("SELECT 1 FROM migration_markers WHERE name = 'suite-v1'").get()) {
      throw new AssignmentError("not-migrated", "Assignments are not imported. Run the explicit legacy import, or confirm a new installation with no legacy assignments. Native projects and groups remain available.");
    }
  }

  private row(kind: AssignmentKind): Row | undefined {
    return this.db.prepare("SELECT * FROM assignment_transfers WHERE kind = ?").get(kind) as Row | undefined;
  }

  status(kind: AssignmentKind) {
    const ready = Boolean(this.db.prepare("SELECT 1 FROM migration_markers WHERE name = 'suite-v1'").get());
    const row = this.row(kind);
    return { kind, state: ready ? row?.state ?? "source-owned" as const : "not-migrated" as const,
      transfer: row ? transferIdentitySchema.parse(JSON.parse(row.identity_json)) : null,
      reverseGeneration: row?.reverse_generation ?? null };
  }

  requireWritable(kind: AssignmentKind) {
    this.requireReady();
    const status = this.status(kind);
    if (status.state !== "source-owned") throw new AssignmentError("assignment-frozen", `${kind} is ${status.state}. Resume its handoff; do not restore the old writer.`);
  }

  rememberLegacy(kind: AssignmentKind, records: AssignmentRecord[]) {
    validateRecords(kind, records);
    const insert = this.db.prepare("INSERT OR IGNORE INTO assignment_legacy_records (kind, record_json) VALUES (?, ?)");
    for (const record of records) insert.run(kind, JSON.stringify(assignmentRecordSchema.parse(record)));
  }

  records(kind: AssignmentKind): AssignmentRecord[] {
    const tables = kind === "applicationBindings" ? ["project_configuration"] : kind === "bundles" ? ["project_bundles", "global_bundles"] : ["project_agents", "global_agents"];
    const count = this.db.prepare(`SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM ${table})`).join(" + ")} + (SELECT COUNT(*) FROM assignment_legacy_records WHERE kind = ?) AS n`).get(kind) as { n: number };
    if (count.n > MAX_ASSIGNMENT_RECORDS) throw new AssignmentError("handoff-mismatch", `Export exceeds ${MAX_ASSIGNMENT_RECORDS} records. Leave authority unchanged.`);
    const records: AssignmentRecord[] = [];
    if (kind === "applicationBindings") {
      for (const row of this.db.prepare("SELECT project_id, credential_id FROM project_configuration ORDER BY project_id").all() as Array<{ project_id: string; credential_id: string | null }>) {
        records.push({ type: "binding", projectId: row.project_id, credentialId: row.credential_id });
      }
    } else {
      const [local, global, column] = kind === "bundles" ? ["project_bundles", "global_bundles", "bundle_id"] : ["project_agents", "global_agents", "agent_id"];
      for (const row of this.db.prepare(`SELECT project_id, ${column} AS id FROM ${local}`).all() as Array<{ project_id: string; id: string }>) records.push({ type: "reference", projectId: row.project_id, targetId: row.id });
      for (const row of this.db.prepare(`SELECT ${column} AS id FROM ${global}`).all() as Array<{ id: string }>) records.push({ type: "reference", projectId: null, targetId: row.id });
    }
    for (const row of this.db.prepare("SELECT record_json FROM assignment_legacy_records WHERE kind = ?").all(kind) as Array<{ record_json: string }>) records.push(assignmentRecordSchema.parse(JSON.parse(row.record_json)));
    if (records.length > MAX_ASSIGNMENT_RECORDS) throw new AssignmentError("handoff-mismatch", `Export exceeds ${MAX_ASSIGNMENT_RECORDS} records. Leave authority unchanged.`);
    return canonicalRecords(records);
  }

  freeze(kind: AssignmentKind, destination: string, destinationVersion: string) {
    this.requireReady();
    if (destination !== destinations[kind]) throw new AssignmentError("handoff-mismatch", "Assignment destination is fixed by kind.");
    return this.db.transaction(() => {
      const existing = this.status(kind);
      if (existing.state === "source-owned" && existing.reverseGeneration !== null) throw new AssignmentError("handoff-mismatch", "Repeated forward handoff after a completed reverse is unsupported. Keep the existing transfer identity and reverse generation.");
      if (existing.state !== "source-owned") {
        if (existing.transfer?.destination === destination && existing.transfer.destinationVersion === destinationVersion) return existing;
        throw new AssignmentError("handoff-mismatch", "A different handoff already exists.");
      }
      const records = this.records(kind);
      const identity: TransferIdentity = { schemaVersion: 1, kind, generation: randomUUID(), semanticDigest: assignmentDigest(records), destination, destinationVersion, adapterVersion: 1 };
      this.db.prepare("INSERT INTO assignment_transfers (kind, state, identity_json) VALUES (?, 'frozen/exported', ?) ON CONFLICT(kind) DO UPDATE SET state = excluded.state, identity_json = excluded.identity_json, reverse_generation = NULL, reverse_digest = NULL, receipt_json = NULL").run(kind, JSON.stringify(identity));
      this.db.prepare("DELETE FROM assignment_exports WHERE kind = ?").run(kind);
      const insert = this.db.prepare("INSERT INTO assignment_exports (kind, ordinal, record_json) VALUES (?, ?, ?)");
      records.forEach((record, ordinal) => insert.run(kind, ordinal, JSON.stringify(record)));
      return this.status(kind);
    })();
  }

  match(identity: TransferIdentity) {
    this.requireReady();
    const current = this.status(identity.kind);
    if (JSON.stringify(current.transfer) !== JSON.stringify(transferIdentitySchema.parse(identity))) throw new AssignmentError("handoff-mismatch", "Kind, generation, digest, destination and versions must match the frozen transfer.");
    return current;
  }

  transition(identity: TransferIdentity, from: State[], to: State, receipt?: AssignmentReceipt) {
    return this.db.transaction(() => {
      const current = this.match(identity);
      if (current.state === to) return current;
      if (!from.includes(current.state as State)) throw new AssignmentError("handoff-mismatch", `Cannot transition ${current.state} to ${to}.`);
      let receiptJson: string | null = null;
      if (receipt) {
        if (to === "destination-owned") {
          const saved = this.row(identity.kind)!.receipt_json;
          const previous = saved ? z.object({ destinationReceipt: receiptSchema }).parse(JSON.parse(saved)) : null;
          if (!previous || JSON.stringify(previous.destinationReceipt) !== JSON.stringify(receipt)) throw new AssignmentError("handoff-mismatch", "Destination staged revision or conflict receipt changed before commit.");
        }
        receiptJson = JSON.stringify({
          schemaVersion: 1, sourcePluginId: "projects", sourceGeneration: identity.generation,
          sourceSemanticDigest: identity.semanticDigest, destinationRevision: receipt.destinationRevision,
          countByKind: { [identity.kind]: receipt.recordCount }, conflicts: receipt.conflicts,
          phase: to, completedAt: new Date().toISOString(), destinationReceipt: receipt,
        });
      }
      this.db.prepare("UPDATE assignment_transfers SET state = ?, receipt_json = COALESCE(?, receipt_json) WHERE kind = ?").run(to, receiptJson, identity.kind);
      return this.status(identity.kind);
    })();
  }

  abort(identity: TransferIdentity) {
    this.requireReady();
    return this.db.transaction(() => {
      const encoded = JSON.stringify(transferIdentitySchema.parse(identity));
      const abandoned = this.db.prepare("SELECT identity_json, previous_state FROM assignment_aborts WHERE kind = ? AND generation = ?").get(identity.kind, identity.generation) as { identity_json: string; previous_state: State } | undefined;
      if (abandoned) {
        if (abandoned.identity_json !== encoded) throw new AssignmentError("handoff-mismatch", "The abandoned transfer identity differs.");
        return { status: this.status(identity.kind), notifyDestination: abandoned.previous_state === "destination-staged" };
      }
      const current = this.match(identity);
      if (current.state !== "frozen/exported" && current.state !== "destination-staged") throw new AssignmentError("handoff-mismatch", `Cannot abort ${current.state}; committed ownership requires reverse reconciliation.`);
      this.db.prepare("INSERT INTO assignment_aborts (kind, generation, identity_json, previous_state, receipt_json, aborted_at) VALUES (?, ?, ?, ?, ?, ?)").run(identity.kind, identity.generation, encoded, current.state, this.row(identity.kind)!.receipt_json, new Date().toISOString());
      this.db.prepare("UPDATE assignment_transfers SET state = 'source-owned', receipt_json = NULL WHERE kind = ?").run(identity.kind);
      return { status: this.status(identity.kind), notifyDestination: current.state === "destination-staged" };
    })();
  }

  page(kind: AssignmentKind, generation: string, cursor: number) {
    this.requireReady();
    const current = this.status(kind);
    if (!current.transfer || current.transfer.generation !== generation || current.state === "source-owned") throw new AssignmentError("handoff-mismatch", "Freeze this assignment kind before export; use its exact generation.");
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM assignment_exports WHERE kind = ?").get(kind) as { n: number };
    const recordCount = count.n;
    if (cursor > recordCount) throw new AssignmentError("handoff-mismatch", "Cursor exceeds the frozen export.");
    const records = (this.db.prepare("SELECT record_json FROM assignment_exports WHERE kind = ? AND ordinal >= ? ORDER BY ordinal LIMIT 200").all(kind, cursor) as Array<{ record_json: string }>).map((row) => assignmentRecordSchema.parse(JSON.parse(row.record_json)));
    return { ...current.transfer, frozen: true as const, records, recordCount, nextCursor: cursor + records.length < recordCount ? cursor + records.length : null };
  }

  reconcileReverse(identity: TransferIdentity, reverseGeneration: string, reverseDigest: string, records: AssignmentRecord[]) {
    validateRecords(identity.kind, records);
    if (assignmentDigest(records) !== reverseDigest) throw new AssignmentError("handoff-mismatch", "Reverse export digest differs from its records.");
    return this.db.transaction(() => {
      const current = this.match(identity);
      const row = this.row(identity.kind)!;
      if (current.state === "source-owned" && row.reverse_generation === reverseGeneration && row.reverse_digest === reverseDigest) return current;
      if (current.state !== "reverse-frozen") throw new AssignmentError("handoff-mismatch", "Freeze the destination before reverse reconciliation.");
      const kind = identity.kind;
      const receivedLegacy = new Set(records.filter((record) => record.type === "legacyBundle" || record.type === "legacyBinding").map((record) => JSON.stringify(assignmentRecordSchema.parse(record))));
      const preservedLegacy = this.db.prepare("SELECT record_json FROM assignment_legacy_records WHERE kind = ?").all(kind) as Array<{ record_json: string }>;
      if (preservedLegacy.some((record) => !receivedLegacy.has(JSON.stringify(assignmentRecordSchema.parse(JSON.parse(record.record_json)))))) throw new AssignmentError("handoff-mismatch", "Reverse export omitted preserved legacy records. Repair the destination export before resuming source authority.");
      if (kind === "applicationBindings") {
        this.db.prepare("UPDATE project_configuration SET credential_id = NULL").run();
        const insert = this.db.prepare("INSERT INTO project_configuration (project_id, credential_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET credential_id = excluded.credential_id");
        for (const record of records) if (record.type === "binding") insert.run(record.projectId, record.credentialId);
      } else {
        const [local, global, column] = kind === "bundles" ? ["project_bundles", "global_bundles", "bundle_id"] : ["project_agents", "global_agents", "agent_id"];
        this.db.prepare(`DELETE FROM ${local}`).run();
        this.db.prepare(`DELETE FROM ${global}`).run();
        const insertGlobal = this.db.prepare(`INSERT INTO ${global} (${column}) VALUES (?)`);
        const insertProject = this.db.prepare(`INSERT INTO ${local} (project_id, ${column}) VALUES (?, ?)`);
        for (const record of records) if (record.type === "reference") {
          if (record.projectId === null) insertGlobal.run(record.targetId);
          else insertProject.run(record.projectId, record.targetId);
        }
      }
      this.db.prepare("DELETE FROM assignment_legacy_records WHERE kind = ?").run(kind);
      this.rememberLegacy(kind, records.filter((record) => record.type === "legacyBundle" || record.type === "legacyBinding"));
      this.db.prepare("UPDATE assignment_transfers SET state = 'source-owned', reverse_generation = ?, reverse_digest = ? WHERE kind = ?").run(reverseGeneration, reverseDigest, kind);
      return this.status(kind);
    })();
  }
}
