import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AssignmentKind, NativeCapabilityInput } from "./contract.js";

export const migrations = [
  `CREATE TABLE catalog_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    repository_url TEXT NOT NULL,
    git_ref TEXT NOT NULL,
    subdirectory TEXT NOT NULL DEFAULT '',
    update_policy TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    approved_release_id TEXT,
    pending_release_id TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE catalog_releases (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(source_id, revision)
  );
  CREATE TABLE catalog_release_skills (
    release_id TEXT NOT NULL REFERENCES catalog_releases(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    digest TEXT NOT NULL,
    files_json TEXT NOT NULL,
    PRIMARY KEY(release_id, skill_id)
  );
  CREATE TABLE catalog_bundles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    skill_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE catalog_assignments (
    bundle_id TEXT NOT NULL REFERENCES catalog_bundles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(bundle_id, kind, target_id)
  );`,
  `ALTER TABLE catalog_bundles ADD COLUMN source_id TEXT REFERENCES catalog_sources(id) ON DELETE CASCADE;
  CREATE UNIQUE INDEX catalog_bundles_source ON catalog_bundles(source_id);
  CREATE TABLE catalog_skill_states (
    source_id TEXT NOT NULL REFERENCES catalog_sources(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(source_id, skill_id)
  );`,
  `CREATE TABLE catalog_native_capabilities (
    bundle_id TEXT PRIMARY KEY REFERENCES catalog_bundles(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL UNIQUE,
    tool_ids TEXT NOT NULL,
    skill_ids TEXT NOT NULL,
    setup_json TEXT NOT NULL,
    assignment_changed_rpc TEXT,
    updated_at TEXT NOT NULL
  );`,
  `ALTER TABLE catalog_bundles ADD COLUMN executor_connections TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE catalog_bundles ADD COLUMN executor_integration TEXT;
  CREATE UNIQUE INDEX catalog_bundles_executor_integration ON catalog_bundles(executor_integration) WHERE executor_integration IS NOT NULL;`,
  // Executor access moved from skill sets to project toolkit mappings; drop the
  // generated sets and columns the previous migration added.
  `DROP INDEX catalog_bundles_executor_integration;
  DELETE FROM catalog_bundles WHERE executor_integration IS NOT NULL;
  ALTER TABLE catalog_bundles DROP COLUMN executor_integration;
  ALTER TABLE catalog_bundles DROP COLUMN executor_connections;`,
  // One row per Executor call a plugin backend made through `executorCall`.
  // It records who asked, not what came back.
  `CREATE TABLE executor_plugin_calls (
    id TEXT PRIMARY KEY,
    caller TEXT NOT NULL,
    toolkit TEXT NOT NULL,
    mode TEXT NOT NULL,
    purpose TEXT NOT NULL,
    bytes_out INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    error TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX executor_plugin_calls_caller_at ON executor_plugin_calls(caller, at);`,
  `CREATE TABLE catalog_assignment_authority (
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
);`,
  // Executor v2 serves skills from apps, and Projects owns assignments. Drop
  // the Git source copies, the skill sets, and the old assignment tables. The
  // empty catalog_sources table stays because catalog_bundles.source_id still
  // references it, and SQLite cannot drop that column.
  `DELETE FROM catalog_bundles WHERE source_id IS NOT NULL OR id NOT IN (SELECT bundle_id FROM catalog_native_capabilities);
  DROP INDEX catalog_bundles_source;
  DROP TABLE catalog_skill_states;
  DROP TABLE catalog_release_skills;
  DROP TABLE catalog_releases;
  DELETE FROM catalog_sources;
  DROP TABLE catalog_assignments;
  DROP TABLE catalog_assignment_authority;
  DROP TABLE catalog_assignment_records;
  DROP TABLE catalog_assignment_history;
  DROP TABLE catalog_assignment_aborts;`,
  // One OAuth grant per Executor connection. Tokens stay in this plugin's own
  // database; they never go to kv, settings, or the frontend.
  `CREATE TABLE executor_grants (
    connection TEXT PRIMARY KEY, origin TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    access_token TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER NOT NULL, updated_at TEXT NOT NULL
  );`,
];

export interface StoredFile { path: string; content: string; contentEncoding: "utf8" | "base64" }
/** One skill file set, as projected into skill roots. */
export interface ApprovedSkill {
  /** `<app>/<name>`. */
  id: string;
  skillId: string;
  /** The Executor app slug. */
  sourceId: string;
  /** The Executor app name. Projected skill names use it. */
  sourceName: string;
  name: string;
  description: string;
  relativePath: string;
  revision: string;
  digest: string;
  enabled: boolean;
  files: StoredFile[];
}
export interface Bundle {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  sourceId: string | null;
  nativeCapability: NativeCapabilityInput | null;
  createdAt: string;
  updatedAt: string;
}
export interface Assignment { bundleId: string; kind: AssignmentKind; targetId: string }

function now() { return new Date().toISOString(); }

/** Native capability bundles and the plugin call log. Skills live in Executor; assignments live in Projects. */
export class CatalogStore {
  constructor(private readonly db: Database.Database) {}

  saveNativeCapability(input: NativeCapabilityInput): { bundle: Bundle; changed: boolean } {
    const existing = this.listBundles().find((bundle) => bundle.id === input.id);
    const native = existing?.nativeCapability;
    if (existing && native
      && existing.name === input.name
      && existing.description === input.description
      && native.pluginId === input.pluginId
      && JSON.stringify(native.toolIds) === JSON.stringify(input.toolIds)
      && JSON.stringify(native.skillIds) === JSON.stringify(input.skillIds)
      && JSON.stringify(native.setup) === JSON.stringify(input.setup)
      && native.assignmentChangedRpc === input.assignmentChangedRpc) {
      return { bundle: existing, changed: false };
    }
    const timestamp = now();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO catalog_bundles (id, name, description, skill_ids, created_at, updated_at)
        VALUES (?, ?, ?, '[]', ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, updated_at=excluded.updated_at`)
        .run(input.id, input.name, input.description, existing?.createdAt ?? timestamp, timestamp);
      this.db.prepare(`INSERT INTO catalog_native_capabilities
        (bundle_id, plugin_id, tool_ids, skill_ids, setup_json, assignment_changed_rpc, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bundle_id) DO UPDATE SET plugin_id=excluded.plugin_id, tool_ids=excluded.tool_ids,
          skill_ids=excluded.skill_ids, setup_json=excluded.setup_json,
          assignment_changed_rpc=excluded.assignment_changed_rpc, updated_at=excluded.updated_at`)
        .run(input.id, input.pluginId, JSON.stringify(input.toolIds), JSON.stringify(input.skillIds),
          JSON.stringify(input.setup), input.assignmentChangedRpc, timestamp);
    })();
    return { bundle: this.requireBundle(input.id), changed: true };
  }

  nativeCapability(bundleId: string): NativeCapabilityInput | null {
    return this.requireBundle(bundleId).nativeCapability;
  }

  listBundles(): Bundle[] {
    return (this.db.prepare(`SELECT b.*, n.plugin_id, n.tool_ids, n.skill_ids AS native_skill_ids,
      n.setup_json, n.assignment_changed_rpc
      FROM catalog_bundles b LEFT JOIN catalog_native_capabilities n ON n.bundle_id = b.id
      ORDER BY b.name COLLATE NOCASE`).all() as Array<{
        id: string; name: string; description: string; skill_ids: string; source_id: string | null;
        created_at: string; updated_at: string; plugin_id: string | null; tool_ids: string | null;
        native_skill_ids: string | null; setup_json: string | null; assignment_changed_rpc: string | null;
      }>).map((row) => ({
        id: row.id, name: row.name, description: row.description, sourceId: row.source_id,
        skillIds: JSON.parse(row.skill_ids) as string[],
        nativeCapability: row.plugin_id ? {
          id: row.id,
          pluginId: row.plugin_id,
          name: row.name,
          description: row.description,
          toolIds: JSON.parse(row.tool_ids ?? "[]") as string[],
          skillIds: JSON.parse(row.native_skill_ids ?? "[]") as string[],
          setup: JSON.parse(row.setup_json ?? "[]") as NativeCapabilityInput["setup"],
          assignmentChangedRpc: row.assignment_changed_rpc,
        } : null,
        createdAt: row.created_at, updatedAt: row.updated_at,
      }));
  }
  requireBundle(id: string): Bundle {
    const bundle = this.listBundles().find((value) => value.id === id);
    if (!bundle) throw new Error(`Unknown native capability: ${id}`);
    return bundle;
  }

  /** Records one plugin Executor call and drops rows older than 30 days. */
  recordPluginCall(call: Omit<PluginExecutorCall, "id" | "at">) {
    const at = now();
    this.db.prepare("INSERT INTO executor_plugin_calls (id, caller, toolkit, mode, purpose, bytes_out, duration_ms, outcome, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), call.caller, call.toolkit, call.mode, call.purpose, call.bytesOut, call.durationMs, call.outcome, call.error, at);
    this.db.prepare("DELETE FROM executor_plugin_calls WHERE at < ?").run(new Date(Date.parse(at) - 30 * 24 * 60 * 60_000).toISOString());
  }
  listPluginCalls(caller: string | null, limit = 50): PluginExecutorCall[] {
    return this.db.prepare(`SELECT id, caller, toolkit, mode, purpose, bytes_out AS bytesOut, duration_ms AS durationMs, outcome, error, at
      FROM executor_plugin_calls WHERE ? IS NULL OR caller = ? ORDER BY at DESC LIMIT ?`).all(caller, caller, limit) as PluginExecutorCall[];
  }
  grants(): Grant[] {
    return this.db.prepare(`SELECT connection, origin, client_id AS clientId, redirect_uri AS redirectUri,
      access_token AS accessToken, refresh_token AS refreshToken, expires_at AS expiresAt FROM executor_grants ORDER BY connection`).all() as Grant[];
  }
  saveGrant(grant: Grant) {
    this.db.prepare(`INSERT INTO executor_grants (connection, origin, client_id, redirect_uri, access_token, refresh_token, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection) DO UPDATE SET origin=excluded.origin, client_id=excluded.client_id, redirect_uri=excluded.redirect_uri,
        access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
      .run(grant.connection, grant.origin, grant.clientId, grant.redirectUri, grant.accessToken, grant.refreshToken, grant.expiresAt, now());
  }
  deleteGrant(connection: string) {
    this.db.prepare("DELETE FROM executor_grants WHERE connection = ?").run(connection);
  }

}

/** BB's OAuth grant for one Executor connection. */
export interface Grant {
  connection: string;
  origin: string;
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export interface PluginExecutorCall {
  id: string;
  caller: string;
  toolkit: string;
  mode: "read" | "write";
  purpose: string;
  bytesOut: number;
  durationMs: number;
  /** ok, paused (a write waits for a person), declined (a read that needed approval), or error. */
  outcome: "ok" | "paused" | "declined" | "error";
  error: string | null;
  at: string;
}
