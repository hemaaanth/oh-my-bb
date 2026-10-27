import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AssignmentKind, BundleInput, NativeCapabilityInput, SourceInput } from "./contract.js";
import { assignmentMigration } from "./assignment-store.js";

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
  assignmentMigration,
];

export interface Source extends Omit<SourceInput, "id"> {
  id: string;
  approvedReleaseId: string | null;
  approvedRevision: string | null;
  pendingReleaseId: string | null;
  pendingRevision: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredFile { path: string; content: string; contentEncoding: "utf8" | "base64" }
export interface DiscoveredSkill {
  skillId: string;
  name: string;
  description: string;
  relativePath: string;
  digest: string;
  files: StoredFile[];
}
export interface ApprovedSkill extends DiscoveredSkill {
  id: string;
  sourceId: string;
  sourceName: string;
  revision: string;
  enabled: boolean;
}
export interface Bundle extends Omit<BundleInput, "id"> {
  id: string;
  sourceId: string | null;
  nativeCapability: NativeCapabilityInput | null;
  createdAt: string;
  updatedAt: string;
}
export interface Assignment { bundleId: string; kind: AssignmentKind; targetId: string }

interface SourceRow {
  id: string; name: string; repository_url: string; git_ref: string; subdirectory: string;
  update_policy: SourceInput["updatePolicy"]; enabled: number; approved_release_id: string | null;
  pending_release_id: string | null; last_checked_at: string | null; last_error: string | null;
  created_at: string; updated_at: string; approved_revision: string | null; pending_revision: string | null;
}

function now() { return new Date().toISOString(); }
function sourceDto(row: SourceRow): Source {
  return {
    id: row.id, name: row.name, repositoryUrl: row.repository_url, gitRef: row.git_ref,
    subdirectory: row.subdirectory, updatePolicy: row.update_policy, enabled: Boolean(row.enabled),
    approvedReleaseId: row.approved_release_id, approvedRevision: row.approved_revision,
    pendingReleaseId: row.pending_release_id, pendingRevision: row.pending_revision,
    lastCheckedAt: row.last_checked_at, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class CatalogStore {
  constructor(private readonly db: Database.Database) {}

  private sourceQuery(where = "") {
    return `SELECT s.*, approved.revision AS approved_revision, pending.revision AS pending_revision
      FROM catalog_sources s
      LEFT JOIN catalog_releases approved ON approved.id = s.approved_release_id
      LEFT JOIN catalog_releases pending ON pending.id = s.pending_release_id ${where}`;
  }

  listSources(): Source[] {
    return (this.db.prepare(`${this.sourceQuery()} ORDER BY s.name COLLATE NOCASE`).all() as SourceRow[]).map(sourceDto);
  }
  getSource(id: string): Source | null {
    const row = this.db.prepare(this.sourceQuery("WHERE s.id = ?")).get(id) as SourceRow | undefined;
    return row ? sourceDto(row) : null;
  }
  requireSource(id: string): Source {
    const source = this.getSource(id);
    if (!source) throw new Error(`Unknown Executor source: ${id}`);
    return source;
  }
  saveSource(input: SourceInput): Source {
    const existing = input.id ? this.getSource(input.id) : null;
    const id = existing?.id ?? input.id ?? randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO catalog_sources
      (id, name, repository_url, git_ref, subdirectory, update_policy, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, repository_url=excluded.repository_url,
      git_ref=excluded.git_ref, subdirectory=excluded.subdirectory, update_policy=excluded.update_policy,
      enabled=excluded.enabled, updated_at=excluded.updated_at`).run(
      id, input.name, input.repositoryUrl, input.gitRef, input.subdirectory, input.updatePolicy,
      input.enabled ? 1 : 0, existing?.createdAt ?? timestamp, timestamp,
    );
    this.ensurePackageBundle(id);
    return this.requireSource(id);
  }
  deleteSource(id: string) { this.requireSource(id); this.db.prepare("DELETE FROM catalog_sources WHERE id = ?").run(id); }

  saveRelease(sourceId: string, revision: string, skills: DiscoveredSkill[], autoApprove: boolean): { releaseId: string; changed: boolean } {
    const source = this.requireSource(sourceId);
    const existing = this.db.prepare("SELECT id FROM catalog_releases WHERE source_id = ? AND revision = ?").get(sourceId, revision) as { id: string } | undefined;
    if (existing) {
      this.markChecked(sourceId, null);
      return { releaseId: existing.id, changed: existing.id !== source.approvedReleaseId };
    }
    const releaseId = randomUUID();
    const timestamp = now();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO catalog_releases (id, source_id, revision, created_at) VALUES (?, ?, ?, ?)").run(releaseId, sourceId, revision, timestamp);
      const insert = this.db.prepare(`INSERT INTO catalog_release_skills
        (release_id, skill_id, name, description, relative_path, digest, files_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const skill of skills) insert.run(releaseId, skill.skillId, skill.name, skill.description, skill.relativePath, skill.digest, JSON.stringify(skill.files));
      const approve = autoApprove || source.approvedReleaseId === null;
      this.db.prepare(`UPDATE catalog_sources SET approved_release_id = CASE WHEN ? THEN ? ELSE approved_release_id END,
        pending_release_id = CASE WHEN ? THEN NULL ELSE ? END, last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
        .run(approve ? 1 : 0, releaseId, approve ? 1 : 0, releaseId, timestamp, timestamp, sourceId);
    })();
    return { releaseId, changed: true };
  }
  markChecked(sourceId: string, error: string | null) {
    const timestamp = now();
    this.db.prepare("UPDATE catalog_sources SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(timestamp, error, timestamp, sourceId);
  }
  approveSource(id: string): Source {
    const source = this.requireSource(id);
    if (!source.pendingReleaseId) throw new Error(`${source.name} has no update awaiting approval`);
    this.db.prepare("UPDATE catalog_sources SET approved_release_id = pending_release_id, pending_release_id = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    return this.requireSource(id);
  }

  listApprovedSkills(options: { includeDisabled?: boolean } = {}): ApprovedSkill[] {
    const rows = this.db.prepare(`SELECT rs.*, s.id AS source_id, s.name AS source_name, r.revision,
        COALESCE(st.enabled, 1) AS enabled
      FROM catalog_sources s JOIN catalog_releases r ON r.id = s.approved_release_id
      JOIN catalog_release_skills rs ON rs.release_id = r.id
      LEFT JOIN catalog_skill_states st ON st.source_id = s.id AND st.skill_id = rs.skill_id
      ORDER BY s.name COLLATE NOCASE, rs.name COLLATE NOCASE`).all() as Array<{
        skill_id: string; name: string; description: string; relative_path: string; digest: string; files_json: string;
        source_id: string; source_name: string; revision: string; enabled: number;
      }>;
    return rows.filter((row) => options.includeDisabled || row.enabled === 1).map((row) => ({
      id: `${row.source_id}:${row.skill_id}`, sourceId: row.source_id, sourceName: row.source_name,
      skillId: row.skill_id, name: row.name, description: row.description, relativePath: row.relative_path,
      digest: row.digest, revision: row.revision, enabled: row.enabled === 1,
      files: JSON.parse(row.files_json) as StoredFile[],
    }));
  }
  setSkillEnabled(id: string, enabled: boolean) {
    const skill = this.listApprovedSkills({ includeDisabled: true }).find((candidate) => candidate.id === id);
    if (!skill) throw new Error(`Unknown Executor skill: ${id}`);
    this.db.prepare(`INSERT INTO catalog_skill_states (source_id, skill_id, enabled, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, skill_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .run(skill.sourceId, skill.skillId, enabled ? 1 : 0, now());
  }

  /** Every source owns one package bundle so a synced source is assignable without extra setup. */
  ensurePackageBundle(sourceId: string): Bundle {
    const source = this.requireSource(sourceId);
    const existing = this.db.prepare("SELECT id FROM catalog_bundles WHERE source_id = ?").get(sourceId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const name = this.availableBundleName(source.name, id);
    const description = `Every enabled skill from ${source.name}.`;
    const timestamp = now();
    if (existing) this.db.prepare("UPDATE catalog_bundles SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, timestamp, id);
    else this.db.prepare("INSERT INTO catalog_bundles (id, name, description, skill_ids, source_id, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?, ?)")
      .run(id, name, description, sourceId, timestamp, timestamp);
    return this.requireBundle(id);
  }
  private availableBundleName(preferred: string, selfId: string): string {
    const taken = new Set((this.db.prepare("SELECT id, name FROM catalog_bundles").all() as Array<{ id: string; name: string }>)
      .filter((row) => row.id !== selfId).map((row) => row.name.toLowerCase()));
    const candidates = [preferred, `${preferred} package`, `${preferred} package ${selfId.slice(0, 4)}`];
    return (candidates.find((candidate) => !taken.has(candidate.toLowerCase())) ?? candidates[2]!).slice(0, 100);
  }

  saveNativeCapability(input: NativeCapabilityInput): { bundle: Bundle; changed: boolean } {
    const existing = this.listBundles().find((bundle) => bundle.id === input.id);
    if (existing?.sourceId) throw new Error(`${existing.name} belongs to a skill source and cannot become a native capability`);
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
    const enabledSkills = this.listApprovedSkills();
    return (this.db.prepare(`SELECT b.*, n.plugin_id, n.tool_ids, n.skill_ids AS native_skill_ids,
      n.setup_json, n.assignment_changed_rpc
      FROM catalog_bundles b LEFT JOIN catalog_native_capabilities n ON n.bundle_id = b.id
      ORDER BY b.source_id IS NULL, b.name COLLATE NOCASE`).all() as Array<{
        id: string; name: string; description: string; skill_ids: string; source_id: string | null;
        created_at: string; updated_at: string; plugin_id: string | null; tool_ids: string | null;
        native_skill_ids: string | null; setup_json: string | null; assignment_changed_rpc: string | null;
      }>).map((row) => ({
        id: row.id, name: row.name, description: row.description, sourceId: row.source_id,
        skillIds: row.source_id
          ? enabledSkills.filter((skill) => skill.sourceId === row.source_id).map((skill) => skill.id)
          : JSON.parse(row.skill_ids) as string[],
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
  requireBundle(id: string): Bundle { const bundle = this.listBundles().find((value) => value.id === id); if (!bundle) throw new Error(`Unknown Executor bundle: ${id}`); return bundle; }
  saveBundle(input: BundleInput): Bundle {
    const existing = input.id ? this.listBundles().find((value) => value.id === input.id) : null;
    if (existing?.nativeCapability) throw new Error(`${existing.name} is managed by plugin ${existing.nativeCapability.pluginId}`);
    if (existing?.sourceId) throw new Error(`${existing.name} is a source package: turn its individual skills on or off instead`);
    const id = existing?.id ?? input.id ?? randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO catalog_bundles (id, name, description, skill_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
      skill_ids=excluded.skill_ids, updated_at=excluded.updated_at`).run(id, input.name, input.description, JSON.stringify([...new Set(input.skillIds)]), existing?.createdAt ?? timestamp, timestamp);
    return this.requireBundle(id);
  }
  deleteBundle(id: string) {
    const bundle = this.requireBundle(id);
    if (bundle.nativeCapability) throw new Error(`${bundle.name} is managed by plugin ${bundle.nativeCapability.pluginId}`);
    if (bundle.sourceId) throw new Error(`${bundle.name} belongs to a source and is removed with it`);
    this.db.prepare("DELETE FROM catalog_bundles WHERE id = ?").run(id);
  }
  listAssignments(): Assignment[] {
    return this.db.prepare("SELECT bundle_id AS bundleId, kind, target_id AS targetId FROM catalog_assignments ORDER BY kind, target_id").all() as Assignment[];
  }
  setAssignment(bundleId: string, kind: AssignmentKind, targetId: string, enabled: boolean) {
    this.requireBundle(bundleId);
    if (enabled) this.db.prepare("INSERT OR IGNORE INTO catalog_assignments (bundle_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)").run(bundleId, kind, targetId, now());
    else this.db.prepare("DELETE FROM catalog_assignments WHERE bundle_id = ? AND kind = ? AND target_id = ?").run(bundleId, kind, targetId);
  }
  effectiveBundleIds(context: { projectId?: string | null; projectEnvironmentId?: string | null; agentProfileId?: string | null }): string[] {
    const assignments = this.listAssignments();
    return [...new Set(assignments.filter((assignment) => assignment.kind === "global"
      || (assignment.kind === "project" && assignment.targetId === context.projectId)
      || (assignment.kind === "project-environment" && assignment.targetId === context.projectEnvironmentId)
      || (assignment.kind === "agent-profile" && assignment.targetId === context.agentProfileId)).map((assignment) => assignment.bundleId))];
  }
  effectiveSkills(context: { projectId?: string | null; projectEnvironmentId?: string | null; agentProfileId?: string | null }): ApprovedSkill[] {
    const ids = new Set(this.effectiveBundleIds(context).flatMap((id) => this.requireBundle(id).skillIds));
    return this.listApprovedSkills().filter((skill) => ids.has(skill.id));
  }
  /** Globally assigned skills: what a machine's own skill roots receive. */
  machineSkills(): ApprovedSkill[] { return this.effectiveSkills({}); }
  /**
   * Skills a single workspace receives, excluding the globally assigned ones its
   * machine roots already carry. Agent-profile assignments have no workspace of
   * their own, so they stay out of the projection and reach agents through the
   * skill tools.
   */
  workspaceSkills(context: { projectId: string; projectEnvironmentId?: string | null }): ApprovedSkill[] {
    const machine = new Set(this.machineSkills().map((skill) => skill.id));
    return this.effectiveSkills({ projectId: context.projectId, projectEnvironmentId: context.projectEnvironmentId })
      .filter((skill) => !machine.has(skill.id));
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
