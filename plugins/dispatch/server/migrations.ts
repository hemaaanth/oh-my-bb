// Database migrations (CONTRACTS §4.2). Owned by P0. Append-only: never edit,
// reorder, or remove an entry after it ships. The host keys each entry by its
// index and rejects a changed one. An entry may hold several statements.

export const MIGRATIONS = [
  {
    id: "001-calls",
    sql: `CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  openai_session_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('app','phone')),
  nonce TEXT,
  client_id TEXT,
  device_json TEXT NOT NULL,
  thread_id TEXT,
  project_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  close_reason TEXT,
  billed_seconds REAL NOT NULL DEFAULT 0,
  unclean INTEGER NOT NULL DEFAULT 0 CHECK (unclean IN (0,1))
);
CREATE INDEX calls_started ON calls(started_at DESC);`,
  },
  {
    id: "002-call-trace",
    sql: `CREATE TABLE call_trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX call_trace_call_at ON call_trace(call_id, at);`,
  },
  {
    id: "003-instruction-revisions",
    sql: `CREATE TABLE instruction_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('user','agent','import')),
  note TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL
);`,
  },
  {
    // Import only. The old table's columns are not known to this package, so
    // each old row is kept whole as JSON (CONTRACTS P0 change).
    id: "004-legacy-token-usage",
    sql: `CREATE TABLE legacy_token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);`,
  },
  {
    // The import is gone. Migrations only append, so 004 stays and this drops its table.
    id: "005-drop-legacy-token-usage",
    sql: "DROP TABLE IF EXISTS legacy_token_usage;",
  },
  {
    // Call memory. `forget` is the per-call "do not remember" flag.
    id: "006-call-summaries",
    sql: `ALTER TABLE calls ADD COLUMN forget INTEGER NOT NULL DEFAULT 0;
CREATE TABLE call_summaries (
  call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  local_day TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  thread_ids TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('done','fallback','skipped')),
  created_at INTEGER NOT NULL
);
CREATE INDEX call_summaries_day ON call_summaries(local_day);`,
  },
] as const;

export const MIGRATION_IDS = MIGRATIONS.map((migration) => migration.id);
export const MIGRATION_STATEMENTS = MIGRATIONS.map((migration) => migration.sql);
