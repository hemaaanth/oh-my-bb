import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProjectGroup, ProjectGroupColor } from "./contract.js";
import { assignmentAbortMigration, assignmentMigration } from "./assignment-store.js";

export const migrations = [
  `CREATE TABLE project_groups (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     color TEXT NOT NULL,
     position INTEGER NOT NULL,
     is_default INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE project_configuration (
     project_id TEXT PRIMARY KEY,
     group_id TEXT REFERENCES project_groups(id) ON DELETE SET NULL,
     position INTEGER NOT NULL DEFAULT 0,
     icon TEXT NOT NULL DEFAULT '',
     credential_id TEXT
   );
   CREATE TABLE project_agents (
     project_id TEXT NOT NULL,
     agent_id TEXT NOT NULL,
     PRIMARY KEY (project_id, agent_id)
   );
   CREATE TABLE global_agents (agent_id TEXT PRIMARY KEY);
   CREATE TABLE project_bundles (
     project_id TEXT NOT NULL,
     bundle_id TEXT NOT NULL,
     PRIMARY KEY (project_id, bundle_id)
   );
   CREATE TABLE global_bundles (bundle_id TEXT PRIMARY KEY);
   CREATE TABLE migration_markers (name TEXT PRIMARY KEY, imported_at TEXT NOT NULL);`,
  `ALTER TABLE project_configuration ADD COLUMN routing_description TEXT NOT NULL DEFAULT '';
   ALTER TABLE project_configuration ADD COLUMN routing_keywords_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE project_configuration ADD COLUMN routing_aliases_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE project_configuration ADD COLUMN routing_repositories_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE project_configuration ADD COLUMN routing_source TEXT NOT NULL DEFAULT 'none';
   ALTER TABLE project_configuration ADD COLUMN routing_updated_at TEXT;
   ALTER TABLE project_configuration ADD COLUMN routing_fingerprint TEXT;`,
  `ALTER TABLE project_configuration ADD COLUMN routing_not_for_json TEXT NOT NULL DEFAULT '[]';`,
  `ALTER TABLE project_configuration ADD COLUMN routing_learned_for_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE project_configuration ADD COLUMN routing_learned_not_for_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE project_configuration ADD COLUMN routing_learned_at TEXT;
   ALTER TABLE project_configuration ADD COLUMN routing_learned_fingerprint TEXT;`,
  assignmentMigration,
  assignmentAbortMigration,
];

interface GroupRow {
  id: string;
  name: string;
  color: ProjectGroupColor;
  position: number;
  is_default: number;
}

interface ConfigurationRow {
  project_id: string;
  group_id: string | null;
  position: number;
  icon: string;
  credential_id: string | null;
  routing_description: string;
  routing_keywords_json: string;
  routing_aliases_json: string;
  routing_repositories_json: string;
  routing_not_for_json: string;
  routing_source: "none" | "generated" | "manual";
  routing_updated_at: string | null;
  routing_fingerprint: string | null;
  routing_learned_for_json: string;
  routing_learned_not_for_json: string;
  routing_learned_at: string | null;
  routing_learned_fingerprint: string | null;
}

export interface StoredRoutingProfile {
  description: string;
  keywords: string[];
  aliases: string[];
  repositories: string[];
  notFor: string[];
  source: "none" | "generated" | "manual";
  updatedAt: string | null;
  fingerprint: string | null;
  /** Written only by routing-history learning; never by hand or by profile generation. */
  learnedFor: string[];
  learnedNotFor: string[];
  learnedAt: string | null;
  learnedFingerprint: string | null;
}

export interface ProjectConfiguration {
  projectId: string;
  groupId: string | null;
  position: number;
  icon: string;
  credentialId: string | null;
  agentIds: string[];
  bundleIds: string[];
  routingProfile: StoredRoutingProfile;
}

function stringArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function routingProfile(row: ConfigurationRow | undefined): StoredRoutingProfile {
  return {
    description: row?.routing_description ?? "",
    keywords: stringArray(row?.routing_keywords_json),
    aliases: stringArray(row?.routing_aliases_json),
    repositories: stringArray(row?.routing_repositories_json),
    notFor: stringArray(row?.routing_not_for_json),
    source: row?.routing_source ?? "none",
    updatedAt: row?.routing_updated_at ?? null,
    fingerprint: row?.routing_fingerprint ?? null,
    learnedFor: stringArray(row?.routing_learned_for_json),
    learnedNotFor: stringArray(row?.routing_learned_not_for_json),
    learnedAt: row?.routing_learned_at ?? null,
    learnedFingerprint: row?.routing_learned_fingerprint ?? null,
  };
}

function groupDto(row: GroupRow): ProjectGroup {
  return { id: row.id, name: row.name, color: row.color, position: row.position, isDefault: Boolean(row.is_default) };
}

export class ProjectsStore {
  constructor(private readonly db: Database.Database) {}

  listGroups(): ProjectGroup[] {
    return (this.db.prepare("SELECT * FROM project_groups ORDER BY position, name COLLATE NOCASE").all() as GroupRow[]).map(groupDto);
  }

  requireGroup(id: string): ProjectGroup {
    const row = this.db.prepare("SELECT * FROM project_groups WHERE id = ?").get(id) as GroupRow | undefined;
    if (!row) throw new Error(`Unknown project group: ${id}`);
    return groupDto(row);
  }

  defaultGroup(): ProjectGroup {
    const existing = this.db.prepare("SELECT * FROM project_groups WHERE is_default = 1 ORDER BY position LIMIT 1").get() as GroupRow | undefined;
    if (existing) return groupDto(existing);
    return this.saveGroup({ name: "Personal", color: "amber", makeDefault: true });
  }

  saveGroup(input: { id?: string; name: string; color: ProjectGroupColor; makeDefault?: boolean }): ProjectGroup {
    const existing = input.id ? this.db.prepare("SELECT * FROM project_groups WHERE id = ?").get(input.id) as GroupRow | undefined : undefined;
    const id = existing?.id ?? randomUUID();
    const position = existing?.position ?? ((this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM project_groups").get() as { position: number }).position);
    const isDefault = input.makeDefault || (!existing && this.listGroups().length === 0);
    const save = this.db.transaction(() => {
      if (isDefault) this.db.prepare("UPDATE project_groups SET is_default = 0").run();
      this.db.prepare(`INSERT INTO project_groups (id, name, color, position, is_default) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, is_default = excluded.is_default`)
        .run(id, input.name, input.color, position, isDefault ? 1 : existing?.is_default ?? 0);
    });
    save();
    return this.requireGroup(id);
  }

  deleteGroup(id: string): void {
    const group = this.requireGroup(id);
    if (group.isDefault) throw new Error("The default project group cannot be deleted");
    const fallback = this.defaultGroup();
    const affected = this.db.prepare("SELECT project_id FROM project_configuration WHERE group_id = ? ORDER BY position, project_id").all(id) as Array<{ project_id: string }>;
    const nextPosition = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM project_configuration WHERE group_id = ?").get(fallback.id) as { position: number }).position;
    this.db.transaction(() => {
      const move = this.db.prepare("UPDATE project_configuration SET group_id = ?, position = ? WHERE project_id = ?");
      affected.forEach(({ project_id }, offset) => move.run(fallback.id, nextPosition + offset, project_id));
      this.db.prepare("DELETE FROM project_groups WHERE id = ?").run(id);
    })();
  }

  setGroupOrder(groupIds: readonly string[]): void {
    const knownIds = this.listGroups().map((group) => group.id);
    const knownIdSet = new Set(knownIds);
    if (
      groupIds.length !== knownIds.length ||
      groupIds.some((id) => !knownIdSet.has(id))
    ) {
      throw new Error("Group order must include every project group exactly once");
    }
    const update = this.db.prepare(
      "UPDATE project_groups SET position = ? WHERE id = ?",
    );
    this.db.transaction(() => {
      groupIds.forEach((id, position) => update.run(position, id));
    })();
  }

  getConfiguration(projectId: string): ProjectConfiguration {
    const row = this.db.prepare("SELECT * FROM project_configuration WHERE project_id = ?").get(projectId) as ConfigurationRow | undefined;
    const fallback = this.defaultGroup();
    return {
      projectId,
      groupId: row?.group_id ?? fallback.id,
      position: row?.position ?? 0,
      icon: row?.icon ?? "",
      credentialId: row?.credential_id ?? null,
      agentIds: (this.db.prepare("SELECT agent_id AS id FROM project_agents WHERE project_id = ? ORDER BY agent_id").all(projectId) as Array<{ id: string }>).map(({ id }) => id),
      bundleIds: (this.db.prepare("SELECT bundle_id AS id FROM project_bundles WHERE project_id = ? ORDER BY bundle_id").all(projectId) as Array<{ id: string }>).map(({ id }) => id),
      routingProfile: routingProfile(row),
    };
  }

  getConfigurations(projectIds: readonly string[]): Map<string, ProjectConfiguration> {
    const wanted = new Set(projectIds);
    const rows = (this.db.prepare("SELECT * FROM project_configuration").all() as ConfigurationRow[])
      .filter((row) => wanted.has(row.project_id));
    const agents = this.db.prepare("SELECT project_id, agent_id AS id FROM project_agents ORDER BY agent_id").all() as Array<{ project_id: string; id: string }>;
    const bundles = this.db.prepare("SELECT project_id, bundle_id AS id FROM project_bundles ORDER BY bundle_id").all() as Array<{ project_id: string; id: string }>;
    const rowByProject = new Map(rows.map((row) => [row.project_id, row]));
    const agentIdsByProject = new Map<string, string[]>();
    const bundleIdsByProject = new Map<string, string[]>();
    for (const row of agents) {
      if (!wanted.has(row.project_id)) continue;
      const ids = agentIdsByProject.get(row.project_id) ?? [];
      ids.push(row.id);
      agentIdsByProject.set(row.project_id, ids);
    }
    for (const row of bundles) {
      if (!wanted.has(row.project_id)) continue;
      const ids = bundleIdsByProject.get(row.project_id) ?? [];
      ids.push(row.id);
      bundleIdsByProject.set(row.project_id, ids);
    }
    const fallbackGroupId = this.defaultGroup().id;
    return new Map(projectIds.map((projectId) => {
      const row = rowByProject.get(projectId);
      return [projectId, {
        projectId,
        groupId: row?.group_id ?? fallbackGroupId,
        position: row?.position ?? 0,
        icon: row?.icon ?? "",
        credentialId: row?.credential_id ?? null,
        agentIds: agentIdsByProject.get(projectId) ?? [],
        bundleIds: bundleIdsByProject.get(projectId) ?? [],
        routingProfile: routingProfile(row),
      }];
    }));
  }

  bundleAssignmentSnapshot(): { globalBundleIds: string[]; projects: Array<{ projectId: string; bundleIds: string[] }> } {
    const rows = this.db.prepare("SELECT project_id, bundle_id FROM project_bundles ORDER BY project_id, bundle_id").all() as Array<{ project_id: string; bundle_id: string }>;
    const byProject = new Map<string, string[]>();
    for (const row of rows) {
      const bundleIds = byProject.get(row.project_id) ?? [];
      bundleIds.push(row.bundle_id);
      byProject.set(row.project_id, bundleIds);
    }
    return {
      globalBundleIds: this.globalBundleIds(),
      projects: [...byProject].map(([projectId, bundleIds]) => ({ projectId, bundleIds })),
    };
  }

  private ensureConfiguration(projectId: string): void {
    const fallback = this.defaultGroup();
    this.db.prepare(`INSERT OR IGNORE INTO project_configuration (project_id, group_id, position, icon, credential_id)
      VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM project_configuration WHERE group_id = ?), 0), '', NULL)`)
      .run(projectId, fallback.id, fallback.id);
  }

  setProjectGroup(projectId: string, groupId: string): void {
    this.requireGroup(groupId);
    this.ensureConfiguration(projectId);
    const position = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM project_configuration WHERE group_id = ?").get(groupId) as { position: number }).position;
    this.db.prepare("UPDATE project_configuration SET group_id = ?, position = ? WHERE project_id = ?").run(groupId, position, projectId);
  }

  setProjectOrder(groupId: string, projectIds: readonly string[]): void {
    this.requireGroup(groupId);
    const update = this.db.prepare("UPDATE project_configuration SET group_id = ?, position = ? WHERE project_id = ?");
    this.db.transaction(() => projectIds.forEach((projectId, position) => { this.ensureConfiguration(projectId); update.run(groupId, position, projectId); }))();
  }

  updateProject(projectId: string, input: { icon?: string; credentialId?: string | null }): void {
    this.ensureConfiguration(projectId);
    if (input.icon !== undefined) this.db.prepare("UPDATE project_configuration SET icon = ? WHERE project_id = ?").run(input.icon, projectId);
    if (input.credentialId !== undefined) this.db.prepare("UPDATE project_configuration SET credential_id = ? WHERE project_id = ?").run(input.credentialId, projectId);
  }

  saveRoutingProfile(projectId: string, input: {
    description: string;
    keywords: readonly string[];
    aliases: readonly string[];
    repositories: readonly string[];
    notFor: readonly string[];
    source: "generated" | "manual";
    fingerprint: string | null;
  }): StoredRoutingProfile {
    this.ensureConfiguration(projectId);
    const updatedAt = new Date().toISOString();
    this.db.prepare(`UPDATE project_configuration SET
      routing_description = ?, routing_keywords_json = ?, routing_aliases_json = ?,
      routing_repositories_json = ?, routing_not_for_json = ?, routing_source = ?, routing_updated_at = ?, routing_fingerprint = ?
      WHERE project_id = ?`).run(
        input.description,
        JSON.stringify(input.keywords),
        JSON.stringify(input.aliases),
        JSON.stringify(input.repositories),
        JSON.stringify(input.notFor),
        input.source,
        updatedAt,
        input.fingerprint,
        projectId,
      );
    return this.getConfiguration(projectId).routingProfile;
  }

  saveRoutingLearning(projectId: string, input: {
    learnedFor: readonly string[];
    learnedNotFor: readonly string[];
    fingerprint: string;
  }): StoredRoutingProfile {
    this.ensureConfiguration(projectId);
    this.db.prepare(`UPDATE project_configuration SET
      routing_learned_for_json = ?, routing_learned_not_for_json = ?, routing_learned_at = ?, routing_learned_fingerprint = ?
      WHERE project_id = ?`).run(
        JSON.stringify(input.learnedFor),
        JSON.stringify(input.learnedNotFor),
        new Date().toISOString(),
        input.fingerprint,
        projectId,
      );
    return this.getConfiguration(projectId).routingProfile;
  }

  toggleProjectReference(kind: "agent" | "bundle", projectId: string, targetId: string, enabled: boolean): void {
    const [table, column] = kind === "agent" ? ["project_agents", "agent_id"] : ["project_bundles", "bundle_id"];
    if (enabled) this.db.prepare(`INSERT OR IGNORE INTO ${table} (project_id, ${column}) VALUES (?, ?)`).run(projectId, targetId);
    else this.db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND ${column} = ?`).run(projectId, targetId);
  }

  toggleGlobalReference(kind: "agent" | "bundle", targetId: string, enabled: boolean): void {
    const [table, column] = kind === "agent" ? ["global_agents", "agent_id"] : ["global_bundles", "bundle_id"];
    if (enabled) this.db.prepare(`INSERT OR IGNORE INTO ${table} (${column}) VALUES (?)`).run(targetId);
    else this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(targetId);
  }

  globalAgentIds(): string[] { return (this.db.prepare("SELECT agent_id AS id FROM global_agents ORDER BY agent_id").all() as Array<{ id: string }>).map(({ id }) => id); }
  globalBundleIds(): string[] { return (this.db.prepare("SELECT bundle_id AS id FROM global_bundles ORDER BY bundle_id").all() as Array<{ id: string }>).map(({ id }) => id); }

  assignments(kind: "agent" | "bundle", targetId: string): string[] {
    const [table, column] = kind === "agent" ? ["project_agents", "agent_id"] : ["project_bundles", "bundle_id"];
    return (this.db.prepare(`SELECT project_id AS id FROM ${table} WHERE ${column} = ? ORDER BY project_id`).all(targetId) as Array<{ id: string }>).map(({ id }) => id);
  }

  credentialAssignments(credentialId: string): string[] {
    return (this.db.prepare("SELECT project_id AS id FROM project_configuration WHERE credential_id = ? ORDER BY project_id").all(credentialId) as Array<{ id: string }>).map(({ id }) => id);
  }

  removeReference(kind: "agent" | "bundle" | "credential", targetId: string): void {
    if (kind === "agent") {
      this.db.prepare("DELETE FROM project_agents WHERE agent_id = ?").run(targetId);
      this.db.prepare("DELETE FROM global_agents WHERE agent_id = ?").run(targetId);
    } else if (kind === "bundle") {
      this.db.prepare("DELETE FROM project_bundles WHERE bundle_id = ?").run(targetId);
      this.db.prepare("DELETE FROM global_bundles WHERE bundle_id = ?").run(targetId);
    } else this.db.prepare("UPDATE project_configuration SET credential_id = NULL WHERE credential_id = ?").run(targetId);
  }

  hasMigration(name: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM migration_markers WHERE name = ?").get(name)); }
  markMigration(name: string): void { this.db.prepare("INSERT OR IGNORE INTO migration_markers (name, imported_at) VALUES (?, ?)").run(name, new Date().toISOString()); }
}
