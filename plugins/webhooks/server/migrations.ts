// Append-only. Each entry's index is its migration id; never edit or reorder one.
export const MIGRATIONS = [
  `CREATE TABLE endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    auth_mode TEXT NOT NULL CHECK (auth_mode IN ('standard-webhooks','slack','bearer')),
    config_json TEXT NOT NULL,
    secret TEXT NOT NULL,
    secret_hint TEXT NOT NULL,
    secret_updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    dedupe_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('processing','succeeded','failed','rejected')),
    attempts INTEGER NOT NULL DEFAULT 1,
    duplicates INTEGER NOT NULL DEFAULT 0,
    action_type TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX deliveries_dedupe ON deliveries(endpoint_id, dedupe_key)`,
  `CREATE INDEX deliveries_recent ON deliveries(endpoint_id, received_at DESC)`,
] as const;
