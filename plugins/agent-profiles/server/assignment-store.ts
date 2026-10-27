import type Database from "better-sqlite3";

// Historical SQL stays exact. Portable identity neither populates nor deletes these tables.
export const assignmentMigration = `CREATE TABLE agent_assignment_authority (
  id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, format_version INTEGER NOT NULL,
  identity_json TEXT, receipt_json TEXT, records_json TEXT, activation_json TEXT, reverse_json TEXT
);
CREATE TABLE agent_assignment_records (record_json TEXT PRIMARY KEY, origin_json TEXT NOT NULL);
CREATE TABLE agent_assignment_history (
  id TEXT PRIMARY KEY, operation TEXT NOT NULL, identity_json TEXT, details_json TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE agent_assignment_aborts (generation TEXT PRIMARY KEY, identity_json TEXT NOT NULL, at TEXT NOT NULL);`;

export function assertNoAssignmentOwner(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM agent_assignment_authority LIMIT 1").get()
    || db.prepare("SELECT 1 FROM agent_assignment_records LIMIT 1").get()) {
    throw new Error("membership-recovery-required: An applied C1 assignment generation exists. Keep its data and reconcile with retained recovery branch foundations/agents-c1-reviewed-471502f before using portable identity.");
  }
}

export function membershipRetired(): never {
  throw new Error("membership-retired: Saved profiles are portable. Project and sandbox membership is historical and cannot be changed. Native project access and independent capability consent still apply.");
}
