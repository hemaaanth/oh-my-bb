import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { capabilityIds, type CapabilityId } from "./contract.js";

export const migrations = [
  `CREATE TABLE runtime_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    environment_name TEXT NOT NULL DEFAULT '',
    environment_id TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL DEFAULT '',
    service_account_name TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]',
    setup_script TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE project_bindings (
    project_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES runtime_profiles(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE machine_preparations (
    project_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    profile_id TEXT,
    ready INTEGER NOT NULL,
    checks TEXT NOT NULL,
    prepared_at TEXT NOT NULL,
    PRIMARY KEY (project_id, host_id, workspace_path)
  );`,
  // Here.now publishing moved to the Pages plugin; drop the retired capability from saved profiles.
  `UPDATE runtime_profiles
    SET capabilities = (SELECT json_group_array(value) FROM json_each(runtime_profiles.capabilities) WHERE value <> 'here-now')
    WHERE capabilities LIKE '%"here-now"%';`,
  // Retool and FLORA moved to Executor through Catalog; drop their retired capabilities from saved profiles.
  `UPDATE runtime_profiles
    SET capabilities = (SELECT json_group_array(value) FROM json_each(runtime_profiles.capabilities) WHERE value NOT IN ('retool', 'flora'))
    WHERE capabilities LIKE '%"retool"%' OR capabilities LIKE '%"flora"%';`,
  // PostHog, Vercel, Railway, Notion, Slack, Grain and Linear moved to Executor; their CLIs are no longer installed.
  `UPDATE runtime_profiles
    SET capabilities = (SELECT json_group_array(value) FROM json_each(runtime_profiles.capabilities) WHERE value NOT IN ('posthog', 'vercel', 'railway', 'ntn', 'slack', 'grain', 'linear'))
    WHERE capabilities LIKE '%"posthog"%' OR capabilities LIKE '%"vercel"%' OR capabilities LIKE '%"railway"%' OR capabilities LIKE '%"ntn"%'
      OR capabilities LIKE '%"slack"%' OR capabilities LIKE '%"grain"%' OR capabilities LIKE '%"linear"%';`,
];

const knownCapabilities = new Set<string>(capabilityIds);

export interface ProfileInput {
  id?: string;
  name: string;
  environmentName: string;
  environmentId: string;
  account: string;
  serviceAccountName: string;
  capabilities: CapabilityId[];
  setupScript: string;
  instructions: string;
}

export interface Profile extends Omit<ProfileInput, "id"> {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow {
  id: string;
  name: string;
  environment_name: string;
  environment_id: string;
  account: string;
  service_account_name: string;
  capabilities: string;
  setup_script: string;
  instructions: string;
  created_at: string;
  updated_at: string;
}

export interface Preparation {
  projectId: string;
  profileId: string | null;
  hostId: string;
  workspacePath: string;
  ready: boolean;
  preparedAt: string;
  checks: Array<{ id: string; label: string; status: "ready" | "missing" | "warning" | "skipped"; detail: string }>;
}

interface PreparationRow {
  project_id: string;
  profile_id: string | null;
  host_id: string;
  workspace_path: string;
  ready: number;
  checks: string;
  prepared_at: string;
}

function now() {
  return new Date().toISOString();
}

function profileDto(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    environmentName: row.environment_name,
    environmentId: row.environment_id,
    account: row.account,
    serviceAccountName: row.service_account_name,
    // Skip ids that are no longer in the catalog, so a retired capability never breaks a saved profile.
    capabilities: (JSON.parse(row.capabilities) as string[]).filter((id): id is CapabilityId => knownCapabilities.has(id)),
    setupScript: row.setup_script,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function preparationDto(row: PreparationRow): Preparation {
  return {
    projectId: row.project_id,
    profileId: row.profile_id,
    hostId: row.host_id,
    workspacePath: row.workspace_path,
    ready: Boolean(row.ready),
    checks: JSON.parse(row.checks) as Preparation["checks"],
    preparedAt: row.prepared_at,
  };
}

export class ProjectEnvironmentStore {
  constructor(private readonly db: Database.Database) {}

  listProfiles(): Profile[] {
    return (this.db.prepare("SELECT * FROM runtime_profiles ORDER BY name COLLATE NOCASE").all() as ProfileRow[]).map(profileDto);
  }

  getProfile(id: string): Profile | null {
    const row = this.db.prepare("SELECT * FROM runtime_profiles WHERE id = ?").get(id) as ProfileRow | undefined;
    return row ? profileDto(row) : null;
  }

  requireProfile(id: string): Profile {
    const profile = this.getProfile(id);
    if (!profile) throw new Error(`Unknown project environment: ${id}`);
    return profile;
  }

  findProfileByName(name: string): Profile | null {
    const row = this.db.prepare("SELECT * FROM runtime_profiles WHERE name = ? COLLATE NOCASE").get(name) as ProfileRow | undefined;
    return row ? profileDto(row) : null;
  }

  saveProfile(input: ProfileInput): Profile {
    const existing = input.id ? this.getProfile(input.id) : null;
    const id = existing?.id ?? randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO runtime_profiles (
      id, name, description, environment_name, environment_id, account,
      service_account_name, capabilities, setup_script, instructions, created_at, updated_at
    ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      environment_name = excluded.environment_name,
      environment_id = excluded.environment_id,
      account = excluded.account,
      service_account_name = excluded.service_account_name,
      capabilities = excluded.capabilities,
      setup_script = excluded.setup_script,
      instructions = excluded.instructions,
      updated_at = excluded.updated_at`).run(
      id, input.name, input.environmentName, input.environmentId,
      input.account, input.serviceAccountName, JSON.stringify([...new Set(input.capabilities)]),
      input.setupScript, input.instructions, existing?.createdAt ?? timestamp, timestamp,
    );
    return this.requireProfile(id);
  }

  deleteProfile(id: string): void {
    this.db.prepare("DELETE FROM runtime_profiles WHERE id = ?").run(id);
  }

  listBindings(): Array<{ projectId: string; profileId: string }> {
    return this.db.prepare("SELECT project_id AS projectId, profile_id AS profileId FROM project_bindings ORDER BY project_id").all() as Array<{ projectId: string; profileId: string }>;
  }

  profileForProject(projectId: string): Profile | null {
    const row = this.db.prepare(`SELECT p.* FROM runtime_profiles p
      JOIN project_bindings b ON b.profile_id = p.id WHERE b.project_id = ?`).get(projectId) as ProfileRow | undefined;
    return row ? profileDto(row) : null;
  }

  bindProject(projectId: string, profileId: string | null): void {
    if (profileId === null) {
      this.db.prepare("DELETE FROM project_bindings WHERE project_id = ?").run(projectId);
      return;
    }
    this.requireProfile(profileId);
    this.db.prepare(`INSERT INTO project_bindings (project_id, profile_id, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at`)
      .run(projectId, profileId, now());
  }

  savePreparation(value: Preparation): void {
    this.db.prepare(`INSERT INTO machine_preparations
      (project_id, host_id, workspace_path, profile_id, ready, checks, prepared_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, host_id, workspace_path) DO UPDATE SET
        profile_id = excluded.profile_id, ready = excluded.ready,
        checks = excluded.checks, prepared_at = excluded.prepared_at`)
      .run(value.projectId, value.hostId, value.workspacePath, value.profileId, value.ready ? 1 : 0, JSON.stringify(value.checks), value.preparedAt);
  }

  listPreparations(): Preparation[] {
    return (this.db.prepare("SELECT * FROM machine_preparations ORDER BY prepared_at DESC").all() as PreparationRow[]).map(preparationDto);
  }

  preparationsForProject(projectId: string): Preparation[] {
    return (this.db.prepare("SELECT * FROM machine_preparations WHERE project_id = ? ORDER BY prepared_at DESC").all(projectId) as PreparationRow[]).map(preparationDto);
  }

  preparationsForProfile(profileId: string): Preparation[] {
    return (this.db.prepare("SELECT * FROM machine_preparations WHERE profile_id = ? ORDER BY prepared_at DESC").all(profileId) as PreparationRow[]).map(preparationDto);
  }

  deletePreparation(projectId: string, hostId: string, workspacePath: string): void {
    this.db.prepare("DELETE FROM machine_preparations WHERE project_id = ? AND host_id = ? AND workspace_path = ?").run(projectId, hostId, workspacePath);
  }
}
