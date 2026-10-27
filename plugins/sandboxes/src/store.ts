import type Database from "better-sqlite3";
import { z } from "zod";
import {
  sandboxResizeCapabilityValues,
  sandboxProviderValues,
  type SandboxProvider,
  type SandboxResizeCapability,
  type SandboxProvisionedResources,
  type SandboxResourceSample,
} from "./backend.js";
import { sandboxSizeTierValues, type SandboxSizeTier } from "./size-tiers.js";

export const sandboxStatusValues = [
  "provisioning",
  "ready",
  "error",
  "destroying",
  "destroyed",
] as const;
export type SandboxStatus = (typeof sandboxStatusValues)[number];

export interface SandboxRecord {
  id: string;
  provider: SandboxProvider;
  providerSandboxId: string | null;
  projectId: string;
  projectName: string;
  hostId: string;
  connectMachineId: string | null;
  projectSourceId: string | null;
  workspacePath: string | null;
  credentialProfileId: string | null;
  usesProjectDefaultCredential: boolean;
  threadId: string | null;
  status: SandboxStatus;
  error: string | null;
  /** bb-app the machine runs, recorded at provisioning and after each upgrade. */
  bbAppVersion: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SandboxCleanupStep =
  | "workspace"
  | "projectSource"
  | "providerSandbox"
  | "providerCheckpoint"
  | "host"
  | "connectMachine";

export interface SandboxCleanupRecord {
  sandboxId: string;
  threadAttachDeadlineAt: number | null;
  requestedAt: number | null;
  workspaceTeardownAt: number | null;
  projectSourceDeletedAt: number | null;
  providerSandboxDestroyedAt: number | null;
  providerCheckpointDeletedAt: number | null;
  hostDeletedAt: number | null;
  connectMachineRevokedAt: number | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  completedAt: number | null;
  lastError: string | null;
}

export const sandboxRuntimeStateValues = [
  "live",
  "resizing",
  "sleeping_pending",
  "sleeping",
  "waking",
  "unavailable",
  "destroyed",
] as const;
export type SandboxRuntimeState = (typeof sandboxRuntimeStateValues)[number];

export interface SandboxRuntimeRecord {
  sandboxId: string;
  state: SandboxRuntimeState;
  idleSince: number | null;
  checkpointId: string | null;
  providerStartedAt: number | null;
  lastError: string | null;
  /**
   * Set when an upgrade was requested while a thread was active. The lifecycle
   * loop performs it once the sandbox is idle and clears the mark.
   */
  upgradeRequestedAt: number | null;
  updatedAt: number;
}

export interface SandboxResizeCapabilityRecord {
  provider: SandboxProvider;
  capability: SandboxResizeCapability;
  reason: string | null;
  checkedAt: number;
}

export interface SandboxProviderSettingsRecord {
  provider: SandboxProvider;
  enabled: boolean;
  extraPackages: string[];
  updatedAt: number;
}

export const sandboxImageStatusValues = ["building", "ready", "error"] as const;
export type SandboxImageStatus = (typeof sandboxImageStatusValues)[number];

export interface SandboxImageRecord {
  id: string;
  provider: SandboxProvider;
  name: string;
  status: SandboxImageStatus;
  isDefault: boolean;
  extraPackages: string[];
  error: string | null;
  regionId: string | null;
  sandboxClass: string | null;
  /** bb-app baked into the image, when the build or registry label revealed it. */
  bbAppVersion: string | null;
  /**
   * The size this image was registered at, for providers whose machines take
   * their size from the image. Null for size-agnostic images and for Daytona
   * snapshots registered before tiers existed, which were all M.
   */
  sizeTier: SandboxSizeTier | null;
  /** The build version shared by every tier registered from one image push. */
  imageVersion: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * `manual` profiles come from an operator; `learned` is reserved for sizes
 * derived from observed pressure, so the two never overwrite each other
 * silently.
 */
export const sandboxSizeProfileSourceValues = ["manual", "learned"] as const;
export type SandboxSizeProfileSource =
  (typeof sandboxSizeProfileSourceValues)[number];

/** The size new sandboxes for one project on one provider should start at. */
export interface SandboxSizeProfileRecord {
  projectId: string;
  provider: SandboxProvider;
  cpuCores: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
  /** A tier fills the dimensions above; a custom profile leaves it null. */
  tier: SandboxSizeTier | null;
  /** Provider region override; null means the configured default placement. */
  regionId: string | null;
  source: SandboxSizeProfileSource;
  updatedAt: number;
}

/** A provider-native image pinned for one project without changing the shared default. */
export interface SandboxProjectImageRecord {
  projectId: string;
  provider: SandboxProvider;
  imageId: string;
  imageName: string;
  updatedAt: number;
}

const sandboxRowSchema = z.object({
  id: z.string(),
  provider: z.enum(sandboxProviderValues),
  provider_sandbox_id: z.string().nullable(),
  project_id: z.string(),
  project_name: z.string(),
  host_id: z.string(),
  connect_machine_id: z.string().nullable(),
  project_source_id: z.string().nullable(),
  workspace_path: z.string().nullable(),
  credential_profile_id: z.string().uuid().nullable(),
  uses_project_default_credential: z.number().int(),
  thread_id: z.string().nullable(),
  status: z.enum(sandboxStatusValues),
  error: z.string().nullable(),
  bb_app_version: z.string().nullable().default(null),
  created_at: z.number(),
  updated_at: z.number(),
});
type SandboxRow = z.infer<typeof sandboxRowSchema>;

const sandboxCleanupRowSchema = z.object({
  sandbox_id: z.string(),
  thread_attach_deadline_at: z.number().nullable(),
  requested_at: z.number().nullable(),
  workspace_teardown_at: z.number().nullable(),
  project_source_deleted_at: z.number().nullable(),
  provider_sandbox_destroyed_at: z.number().nullable(),
  provider_checkpoint_deleted_at: z.number().nullable(),
  host_deleted_at: z.number().nullable(),
  connect_machine_revoked_at: z.number().nullable(),
  attempt_count: z.number().int().nonnegative(),
  next_attempt_at: z.number().nullable(),
  completed_at: z.number().nullable(),
  last_error: z.string().nullable(),
});
type SandboxCleanupRow = z.infer<typeof sandboxCleanupRowSchema>;

const sandboxRuntimeRowSchema = z.object({
  sandbox_id: z.string(),
  state: z.enum(sandboxRuntimeStateValues),
  idle_since: z.number().nullable(),
  checkpoint_id: z.string().nullable(),
  provider_started_at: z.number().nullable(),
  last_error: z.string().nullable(),
  upgrade_requested_at: z.number().nullable().default(null),
  updated_at: z.number(),
});
type SandboxRuntimeRow = z.infer<typeof sandboxRuntimeRowSchema>;

const sandboxProviderSettingsRowSchema = z.object({
  provider: z.enum(sandboxProviderValues),
  enabled: z.number().int(),
  extra_packages_json: z.string(),
  updated_at: z.number(),
});

const sandboxResizeCapabilityRowSchema = z.object({
  provider: z.enum(sandboxProviderValues),
  capability: z.enum(sandboxResizeCapabilityValues),
  reason: z.string().nullable(),
  checked_at: z.number(),
});

const sandboxImageRowSchema = z.object({
  id: z.string(),
  provider: z.enum(sandboxProviderValues),
  name: z.string(),
  status: z.enum(sandboxImageStatusValues),
  is_default: z.number().int(),
  extra_packages_json: z.string(),
  error: z.string().nullable(),
  region_id: z.string().nullable(),
  sandbox_class: z.string().nullable(),
  bb_app_version: z.string().nullable().default(null),
  size_tier: z.enum(sandboxSizeTierValues).nullable().default(null),
  image_version: z.string().nullable().default(null),
  created_at: z.number(),
  updated_at: z.number(),
});

const sandboxSizeProfileRowSchema = z.object({
  project_id: z.string(),
  provider: z.enum(sandboxProviderValues),
  cpu_cores: z.number().nullable(),
  memory_bytes: z.number().nullable(),
  disk_bytes: z.number().nullable(),
  tier: z.enum(sandboxSizeTierValues).nullable().default(null),
  region_id: z.string().nullable().default(null),
  source: z.enum(sandboxSizeProfileSourceValues),
  updated_at: z.number(),
});

const sandboxSizeProfileInputSchema = z.object({
  projectId: z.string().min(1),
  provider: z.enum(sandboxProviderValues),
  cpuCores: z.number().positive().nullable(),
  memoryBytes: z.number().int().positive().nullable(),
  diskBytes: z.number().int().positive().nullable(),
  tier: z.enum(sandboxSizeTierValues).nullable().default(null),
  regionId: z.string().min(1).nullable().default(null),
  source: z.enum(sandboxSizeProfileSourceValues),
});

export type SandboxSizeProfileInput = z.input<
  typeof sandboxSizeProfileInputSchema
>;

const extraPackagesSchema = z.array(z.string().min(1));

export const sandboxMigrations = [
  `CREATE TABLE sandboxes (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    provider_sandbox_id TEXT,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    host_id TEXT NOT NULL,
    connect_machine_id TEXT,
    project_source_id TEXT,
    workspace_path TEXT,
    thread_id TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX sandboxes_status_idx ON sandboxes(status, created_at DESC)",
  `CREATE TABLE sandbox_cleanup (
    sandbox_id TEXT PRIMARY KEY NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    thread_attach_deadline_at INTEGER,
    requested_at INTEGER,
    project_source_deleted_at INTEGER,
    provider_sandbox_destroyed_at INTEGER,
    host_deleted_at INTEGER,
    connect_machine_revoked_at INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    completed_at INTEGER,
    last_error TEXT
  )`,
  `CREATE INDEX sandbox_cleanup_due_idx
    ON sandbox_cleanup(completed_at, next_attempt_at)`,
  `CREATE INDEX sandbox_cleanup_thread_attach_idx
    ON sandbox_cleanup(thread_attach_deadline_at)`,
  `ALTER TABLE sandbox_cleanup
    ADD COLUMN provider_checkpoint_deleted_at INTEGER`,
  `CREATE TABLE sandbox_runtime (
    sandbox_id TEXT PRIMARY KEY NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    idle_since INTEGER,
    checkpoint_id TEXT,
    last_error TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX sandbox_runtime_idle_idx
    ON sandbox_runtime(state, idle_since)`,
  `ALTER TABLE sandbox_runtime
    ADD COLUMN provider_started_at INTEGER`,
  `UPDATE sandbox_runtime
    SET provider_started_at = (
      SELECT sandboxes.created_at
      FROM sandboxes
      WHERE sandboxes.id = sandbox_runtime.sandbox_id
    )
    WHERE state = 'live'`,
  `CREATE TABLE sandbox_provider_settings (
    provider TEXT PRIMARY KEY NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    extra_packages_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )`,
  `INSERT INTO sandbox_provider_settings (provider, enabled, updated_at)
    VALUES ('daytona', 1, 0), ('modal', 1, 0), ('e2b', 1, 0)`,
  `CREATE TABLE sandbox_images (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    extra_packages_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(provider, name)
  )`,
  `CREATE INDEX sandbox_images_provider_idx
    ON sandbox_images(provider, is_default DESC, created_at DESC)`,
  `INSERT OR IGNORE INTO sandbox_provider_settings (provider, enabled, updated_at)
    VALUES ('box', 1, 0), ('freestyle', 1, 0), ('nirvana', 1, 0)`,
  `CREATE TABLE sandbox_resource_profiles (
    sandbox_id TEXT PRIMARY KEY NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    cpu_cores REAL,
    memory_bytes INTEGER,
    disk_bytes INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE sandbox_resource_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    sampled_at INTEGER NOT NULL,
    cpu_usage_percent REAL,
    memory_usage_bytes INTEGER,
    disk_usage_bytes INTEGER,
    load_average_1m REAL,
    oom_events INTEGER
  )`,
  `CREATE INDEX sandbox_resource_samples_sandbox_idx
    ON sandbox_resource_samples(sandbox_id, sampled_at DESC)`,
  `ALTER TABLE sandbox_cleanup
    ADD COLUMN workspace_teardown_at INTEGER`,
  `CREATE TABLE IF NOT EXISTS sandbox_size_profiles (
    project_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    cpu_cores REAL,
    memory_bytes INTEGER,
    disk_bytes INTEGER,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, provider)
  )`,
  "ALTER TABLE sandbox_resource_profiles ADD COLUMN target_cpu_cores REAL",
  "ALTER TABLE sandbox_resource_profiles ADD COLUMN target_memory_bytes INTEGER",
  "ALTER TABLE sandbox_resource_profiles ADD COLUMN target_disk_bytes INTEGER",
  `ALTER TABLE sandbox_resource_samples ADD COLUMN oom_kills INTEGER;
   ALTER TABLE sandbox_resource_samples ADD COLUMN memory_peak_bytes INTEGER;
   ALTER TABLE sandbox_resource_samples ADD COLUMN memory_anon_bytes INTEGER;
   ALTER TABLE sandbox_resource_samples ADD COLUMN memory_file_bytes INTEGER;
   ALTER TABLE sandbox_resource_samples ADD COLUMN memory_slab_reclaimable_bytes INTEGER;
   ALTER TABLE sandbox_resource_samples ADD COLUMN cpu_throttled_periods INTEGER;
   ALTER TABLE sandbox_resource_samples ADD COLUMN cpu_throttled_usec INTEGER;
   ALTER TABLE sandbox_resource_samples ADD COLUMN memory_pressure_some_avg10 REAL;
   ALTER TABLE sandbox_resource_samples ADD COLUMN memory_pressure_some_avg60 REAL;
   ALTER TABLE sandbox_resource_samples ADD COLUMN memory_pressure_full_avg10 REAL;
   ALTER TABLE sandbox_resource_samples ADD COLUMN memory_pressure_full_avg60 REAL;
   ALTER TABLE sandbox_resource_samples ADD COLUMN cpu_pressure_some_avg10 REAL;
   ALTER TABLE sandbox_resource_samples ADD COLUMN cpu_pressure_some_avg60 REAL;
   ALTER TABLE sandbox_resource_samples ADD COLUMN cpu_pressure_full_avg10 REAL;
   ALTER TABLE sandbox_resource_samples ADD COLUMN cpu_pressure_full_avg60 REAL`,
  "ALTER TABLE sandbox_images ADD COLUMN region_id TEXT",
  "ALTER TABLE sandbox_images ADD COLUMN sandbox_class TEXT",
  `CREATE TABLE IF NOT EXISTS sandbox_project_images (
    project_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    image_id TEXT NOT NULL REFERENCES sandbox_images(id),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, provider)
  )`,
  "ALTER TABLE sandboxes ADD COLUMN credential_profile_id TEXT",
  "ALTER TABLE sandboxes ADD COLUMN uses_project_default_credential INTEGER NOT NULL DEFAULT 1",
  `CREATE TABLE IF NOT EXISTS sandbox_resize_capabilities (
    provider TEXT PRIMARY KEY NOT NULL,
    capability TEXT NOT NULL,
    reason TEXT,
    checked_at INTEGER NOT NULL
  )`,
  `ALTER TABLE sandbox_resource_samples ADD COLUMN sample_cpu_cores REAL;
   ALTER TABLE sandbox_resource_samples ADD COLUMN sample_memory_bytes INTEGER;
   ALTER TABLE sandbox_resource_samples ADD COLUMN sample_disk_bytes INTEGER`,
  // Versions make a bb upgrade auditable: which images, pins, and machines
  // still carry the previous bb-app, and which upgrades are waiting on a busy
  // thread.
  `ALTER TABLE sandbox_images ADD COLUMN bb_app_version TEXT;
   ALTER TABLE sandboxes ADD COLUMN bb_app_version TEXT;
   ALTER TABLE sandbox_runtime ADD COLUMN upgrade_requested_at INTEGER`,
  // Sizes became tiers: images record the tier they were registered at and
  // the build they came from, projects pick a tier (and optionally a region)
  // instead of raw numbers. Existing names carry the version already.
  `ALTER TABLE sandbox_images ADD COLUMN size_tier TEXT;
   ALTER TABLE sandbox_images ADD COLUMN image_version TEXT;
   UPDATE sandbox_images SET image_version = substr(name, 12)
     WHERE image_version IS NULL AND (name LIKE 'bb-sandbox-%' OR name LIKE 'bb-sandbox:%');
   ALTER TABLE sandbox_size_profiles ADD COLUMN tier TEXT;
   ALTER TABLE sandbox_size_profiles ADD COLUMN region_id TEXT`,
  `CREATE TABLE sandbox_always_on (
    host_id TEXT PRIMARY KEY NOT NULL,
    enabled_at INTEGER NOT NULL
  )`,
  `CREATE TABLE sandbox_image_provenance (
    image_id TEXT PRIMARY KEY NOT NULL REFERENCES sandbox_images(id) ON DELETE CASCADE,
    pinned_reference TEXT NOT NULL,
    source_commit TEXT NOT NULL,
    inputs_sha256 TEXT NOT NULL,
    archive_sha256 TEXT NOT NULL,
    verified_at INTEGER NOT NULL
  )`,
] as const;

function fromSandboxRow(row: SandboxRow): SandboxRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerSandboxId: row.provider_sandbox_id,
    projectId: row.project_id,
    projectName: row.project_name,
    hostId: row.host_id,
    connectMachineId: row.connect_machine_id,
    projectSourceId: row.project_source_id,
    workspacePath: row.workspace_path,
    credentialProfileId: row.credential_profile_id,
    usesProjectDefaultCredential: row.uses_project_default_credential === 1,
    threadId: row.thread_id,
    status: row.status,
    error: row.error,
    bbAppVersion: row.bb_app_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromCleanupRow(row: SandboxCleanupRow): SandboxCleanupRecord {
  return {
    sandboxId: row.sandbox_id,
    threadAttachDeadlineAt: row.thread_attach_deadline_at,
    requestedAt: row.requested_at,
    workspaceTeardownAt: row.workspace_teardown_at,
    projectSourceDeletedAt: row.project_source_deleted_at,
    providerSandboxDestroyedAt: row.provider_sandbox_destroyed_at,
    providerCheckpointDeletedAt: row.provider_checkpoint_deleted_at,
    hostDeletedAt: row.host_deleted_at,
    connectMachineRevokedAt: row.connect_machine_revoked_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

function fromSizeProfileRow(
  row: z.infer<typeof sandboxSizeProfileRowSchema>,
): SandboxSizeProfileRecord {
  return {
    projectId: row.project_id,
    provider: row.provider,
    cpuCores: row.cpu_cores,
    memoryBytes: row.memory_bytes,
    diskBytes: row.disk_bytes,
    tier: row.tier,
    regionId: row.region_id,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

function parseExtraPackages(value: string): string[] {
  return extraPackagesSchema.parse(JSON.parse(value));
}

function fromProviderSettingsRow(
  row: z.infer<typeof sandboxProviderSettingsRowSchema>,
): SandboxProviderSettingsRecord {
  return {
    provider: row.provider,
    enabled: row.enabled === 1,
    extraPackages: parseExtraPackages(row.extra_packages_json),
    updatedAt: row.updated_at,
  };
}

function fromImageRow(
  row: z.infer<typeof sandboxImageRowSchema>,
): SandboxImageRecord {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    isDefault: row.is_default === 1,
    extraPackages: parseExtraPackages(row.extra_packages_json),
    error: row.error,
    regionId: row.region_id,
    sandboxClass: row.sandbox_class,
    bbAppVersion: row.bb_app_version,
    sizeTier: row.size_tier,
    imageVersion: row.image_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SandboxStore {
  constructor(private readonly db: Database.Database) {}

  recordImageProvenance(imageId: string, pinnedReference: string, artifact: { sourceCommit: string; inputsSha256: string; archiveSha256: string }): void {
    this.db.prepare(`INSERT INTO sandbox_image_provenance (image_id, pinned_reference, source_commit, inputs_sha256, archive_sha256, verified_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(image_id) DO UPDATE SET pinned_reference=excluded.pinned_reference,
      source_commit=excluded.source_commit, inputs_sha256=excluded.inputs_sha256, archive_sha256=excluded.archive_sha256, verified_at=excluded.verified_at`)
      .run(imageId, pinnedReference, artifact.sourceCommit, artifact.inputsSha256, artifact.archiveSha256, Date.now());
  }

  imageProvenanceState(imageId: string, compatible: ReadonlyArray<{ sourceCommit: string; inputsSha256: string; archiveSha256: string }>): "verified" | "unknown" | "incompatible" {
    const row = this.db.prepare("SELECT pinned_reference, source_commit, inputs_sha256, archive_sha256 FROM sandbox_image_provenance WHERE image_id = ?").get(imageId) as
      { pinned_reference: string; source_commit: string; inputs_sha256: string; archive_sha256: string } | undefined;
    if (!row || !/@sha256:[a-f0-9]{64}$/u.test(row.pinned_reference)) return "unknown";
    return compatible.some(artifact => row.source_commit === artifact.sourceCommit &&
      row.inputs_sha256 === artifact.inputsSha256 && row.archive_sha256 === artifact.archiveSha256) ? "verified" : "incompatible";
  }

  isAlwaysOn(hostId: string): boolean {
    return this.db.prepare("SELECT 1 FROM sandbox_always_on WHERE host_id = ?").get(hostId) !== undefined;
  }

  setAlwaysOn(hostId: string, enabled: boolean): void {
    if (enabled) {
      this.db.prepare("INSERT INTO sandbox_always_on (host_id, enabled_at) VALUES (?, ?) ON CONFLICT(host_id) DO NOTHING").run(hostId, Date.now());
    } else {
      this.db.prepare("DELETE FROM sandbox_always_on WHERE host_id = ?").run(hostId);
    }
  }

  /**
   * Records created by the pre-0.43 launcher. New native machines live in BB
   * core, but these rows must remain readable until their provider resources
   * have been retired.
   */
  listLegacySandboxes(): SandboxRecord[] {
    return z
      .array(sandboxRowSchema)
      .parse(
        this.db
          .prepare("SELECT * FROM sandboxes ORDER BY created_at DESC")
          .all(),
      )
      .map(fromSandboxRow);
  }

  getLegacySandbox(idOrHostId: string): SandboxRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sandboxes
         WHERE id = ? OR host_id = ?
         ORDER BY id = ? DESC, created_at DESC
         LIMIT 1`,
      )
      .get(idOrHostId, idOrHostId, idOrHostId);
    return row === undefined
      ? null
      : fromSandboxRow(sandboxRowSchema.parse(row));
  }

  getLegacySandboxByThread(threadId: string): SandboxRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sandboxes
         WHERE thread_id = ?
         ORDER BY status = 'destroyed', created_at DESC
         LIMIT 1`,
      )
      .get(threadId);
    return row === undefined
      ? null
      : fromSandboxRow(sandboxRowSchema.parse(row));
  }

  updateLegacySandbox(
    id: string,
    patch: Partial<Pick<SandboxRecord, "status" | "error">>,
  ): SandboxRecord {
    const current = this.getLegacySandbox(id);
    if (current === null || current.id !== id) {
      throw new Error(`Legacy sandbox ${id} was not found`);
    }
    const status = patch.status ?? current.status;
    const error = patch.error === undefined ? current.error : patch.error;
    this.db
      .prepare(
        "UPDATE sandboxes SET status = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, error, Date.now(), id);
    const updated = this.getLegacySandbox(id);
    if (updated === null) throw new Error(`Legacy sandbox ${id} was not found`);
    return updated;
  }

  setLegacyBbAppVersion(id: string, version: string): void {
    this.db
      .prepare("UPDATE sandboxes SET bb_app_version = ?, updated_at = ? WHERE id = ?")
      .run(version, Date.now(), id);
  }

  getLegacyCleanup(id: string): SandboxCleanupRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sandbox_cleanup WHERE sandbox_id = ?")
      .get(id);
    return row === undefined
      ? null
      : fromCleanupRow(sandboxCleanupRowSchema.parse(row));
  }

  getLegacyCheckpointId(id: string): string | null {
    const row = this.db
      .prepare("SELECT checkpoint_id FROM sandbox_runtime WHERE sandbox_id = ?")
      .get(id) as { checkpoint_id: string | null } | undefined;
    return row?.checkpoint_id ?? null;
  }

  ensureLegacyCleanup(id: string): SandboxCleanupRecord {
    if (this.getLegacySandbox(id) === null) {
      throw new Error(`Legacy sandbox ${id} was not found`);
    }
    this.db
      .prepare(
        `INSERT INTO sandbox_cleanup (sandbox_id)
         VALUES (?) ON CONFLICT(sandbox_id) DO NOTHING`,
      )
      .run(id);
    const cleanup = this.getLegacyCleanup(id);
    if (cleanup === null) throw new Error(`Cleanup state for ${id} was not created`);
    return cleanup;
  }

  requestLegacyCleanup(id: string, now = Date.now()): SandboxCleanupRecord {
    this.ensureLegacyCleanup(id);
    this.db
      .prepare(
        `UPDATE sandbox_cleanup SET
           requested_at = COALESCE(requested_at, ?),
           thread_attach_deadline_at = NULL,
           next_attempt_at = CASE
             WHEN completed_at IS NOT NULL THEN next_attempt_at
             WHEN next_attempt_at IS NULL OR next_attempt_at > ? THEN ?
             ELSE next_attempt_at
           END
         WHERE sandbox_id = ?`,
      )
      .run(now, now, now, id);
    return this.ensureLegacyCleanup(id);
  }

  beginLegacyCleanupAttempt(id: string): SandboxCleanupRecord {
    this.ensureLegacyCleanup(id);
    this.db
      .prepare(
        `UPDATE sandbox_cleanup
         SET attempt_count = attempt_count + 1
         WHERE sandbox_id = ? AND completed_at IS NULL`,
      )
      .run(id);
    return this.ensureLegacyCleanup(id);
  }

  markLegacyCleanupStep(
    id: string,
    step: SandboxCleanupStep,
    completedAt = Date.now(),
  ): SandboxCleanupRecord {
    const column = {
      workspace: "workspace_teardown_at",
      projectSource: "project_source_deleted_at",
      providerSandbox: "provider_sandbox_destroyed_at",
      providerCheckpoint: "provider_checkpoint_deleted_at",
      host: "host_deleted_at",
      connectMachine: "connect_machine_revoked_at",
    } satisfies Record<SandboxCleanupStep, string>;
    this.ensureLegacyCleanup(id);
    this.db
      .prepare(
        `UPDATE sandbox_cleanup
         SET ${column[step]} = COALESCE(${column[step]}, ?)
         WHERE sandbox_id = ?`,
      )
      .run(completedAt, id);
    return this.ensureLegacyCleanup(id);
  }

  failLegacyCleanup(
    id: string,
    error: string,
    nextAttemptAt: number,
  ): SandboxCleanupRecord {
    this.ensureLegacyCleanup(id);
    this.db
      .prepare(
        `UPDATE sandbox_cleanup SET
           last_error = ?, next_attempt_at = ?, completed_at = NULL
         WHERE sandbox_id = ?`,
      )
      .run(error, nextAttemptAt, id);
    return this.ensureLegacyCleanup(id);
  }

  completeLegacyCleanup(
    id: string,
    completedAt = Date.now(),
  ): SandboxCleanupRecord {
    this.ensureLegacyCleanup(id);
    this.db
      .prepare(
        `UPDATE sandbox_cleanup SET
           completed_at = ?, next_attempt_at = NULL, last_error = NULL,
           thread_attach_deadline_at = NULL
         WHERE sandbox_id = ?`,
      )
      .run(completedAt, id);
    return this.ensureLegacyCleanup(id);
  }

  listDueLegacyCleanup(now = Date.now(), limit = 10): SandboxCleanupRecord[] {
    return z
      .array(sandboxCleanupRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT * FROM sandbox_cleanup
             WHERE requested_at IS NOT NULL
               AND completed_at IS NULL
               AND next_attempt_at IS NOT NULL
               AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC, requested_at ASC
             LIMIT ?`,
          )
          .all(now, limit),
      )
      .map(fromCleanupRow);
  }

  listProviderSettings(): SandboxProviderSettingsRecord[] {
    return z
      .array(sandboxProviderSettingsRowSchema)
      .parse(
        this.db
          .prepare("SELECT * FROM sandbox_provider_settings ORDER BY provider")
          .all(),
      )
      .map(fromProviderSettingsRow);
  }

  getProviderSettings(
    provider: SandboxProvider,
  ): SandboxProviderSettingsRecord {
    const row = this.db
      .prepare("SELECT * FROM sandbox_provider_settings WHERE provider = ?")
      .get(provider);
    if (row === undefined) {
      throw new Error(`Settings for ${provider} were not initialized`);
    }
    return fromProviderSettingsRow(sandboxProviderSettingsRowSchema.parse(row));
  }

  updateProviderSettings(
    provider: SandboxProvider,
    patch: { enabled?: boolean; extraPackages?: string[] },
  ): SandboxProviderSettingsRecord {
    const current = this.getProviderSettings(provider);
    const enabled = patch.enabled ?? current.enabled;
    const extraPackages = patch.extraPackages ?? current.extraPackages;
    extraPackagesSchema.parse(extraPackages);
    this.db
      .prepare(
        `UPDATE sandbox_provider_settings
         SET enabled = ?, extra_packages_json = ?, updated_at = ?
         WHERE provider = ?`,
      )
      .run(
        enabled ? 1 : 0,
        JSON.stringify(extraPackages),
        Date.now(),
        provider,
      );
    return this.getProviderSettings(provider);
  }

  getSizeProfile(
    projectId: string,
    provider: SandboxProvider,
  ): SandboxSizeProfileRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM sandbox_size_profiles WHERE project_id = ? AND provider = ?",
    ).get(projectId, provider);
    return row === undefined
      ? null
      : fromSizeProfileRow(sandboxSizeProfileRowSchema.parse(row));
  }

  listSizeProfiles(projectId?: string): SandboxSizeProfileRecord[] {
    const rows = projectId === undefined
      ? this.db.prepare(
          "SELECT * FROM sandbox_size_profiles ORDER BY project_id, provider",
        ).all()
      : this.db.prepare(
          `SELECT * FROM sandbox_size_profiles WHERE project_id = ?
           ORDER BY provider`,
        ).all(projectId);
    return z
      .array(sandboxSizeProfileRowSchema)
      .parse(rows)
      .map(fromSizeProfileRow);
  }

  upsertSizeProfile(input: SandboxSizeProfileInput): SandboxSizeProfileRecord {
    const profile = sandboxSizeProfileInputSchema.parse(input);
    this.db.prepare(
      `INSERT INTO sandbox_size_profiles (
        project_id, provider, cpu_cores, memory_bytes, disk_bytes, tier,
        region_id, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, provider) DO UPDATE SET
        cpu_cores = excluded.cpu_cores,
        memory_bytes = excluded.memory_bytes,
        disk_bytes = excluded.disk_bytes,
        tier = excluded.tier,
        region_id = excluded.region_id,
        source = excluded.source,
        updated_at = excluded.updated_at`,
    ).run(
      profile.projectId,
      profile.provider,
      profile.cpuCores,
      profile.memoryBytes,
      profile.diskBytes,
      profile.tier,
      profile.regionId,
      profile.source,
      Date.now(),
    );
    const stored = this.getSizeProfile(profile.projectId, profile.provider);
    if (stored === null) {
      throw new Error(
        `Size profile for ${profile.projectId} on ${profile.provider} was not persisted`,
      );
    }
    return stored;
  }

  deleteSizeProfile(projectId: string, provider: SandboxProvider): boolean {
    return this.db.prepare(
      "DELETE FROM sandbox_size_profiles WHERE project_id = ? AND provider = ?",
    ).run(projectId, provider).changes > 0;
  }

  listImages(provider?: SandboxProvider): SandboxImageRecord[] {
    const rows =
      provider === undefined
        ? this.db
            .prepare(
              "SELECT * FROM sandbox_images ORDER BY provider, is_default DESC, created_at DESC",
            )
            .all()
        : this.db
            .prepare(
              `SELECT * FROM sandbox_images WHERE provider = ?
               ORDER BY is_default DESC, created_at DESC`,
            )
            .all(provider);
    return z.array(sandboxImageRowSchema).parse(rows).map(fromImageRow);
  }

  failInterruptedImageBuilds(): number {
    const result = this.db
      .prepare(
        `UPDATE sandbox_images
         SET status = 'error', is_default = 0,
             error = 'Image build was interrupted by a plugin restart',
             updated_at = ?
         WHERE status = 'building'`,
      )
      .run(Date.now());
    return result.changes;
  }

  /**
   * The active image for a provider, or for one size of a provider whose
   * machines are sized by their image. Without a tier this is the M image,
   * which is also what an untiered legacy snapshot counts as, so callers that
   * predate tiers keep getting the same answer. With a region, only images
   * registered into that region (or before regions were recorded) qualify.
   */
  getDefaultImage(
    provider: SandboxProvider,
    tier?: SandboxSizeTier | null,
    regionId?: string | null,
  ): SandboxImageRecord | null {
    const wanted = tier ?? null;
    const rows = z
      .array(sandboxImageRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT * FROM sandbox_images
             WHERE provider = ? AND is_default = 1 AND status = 'ready'
             ORDER BY updated_at DESC`,
          )
          .all(provider),
      )
      .map(fromImageRow)
      .filter(
        (image) =>
          regionId === undefined ||
          regionId === null ||
          image.regionId === null ||
          image.regionId === regionId,
      );
    const exact = rows.find((image) => image.sizeTier === wanted);
    if (exact !== undefined) return exact;
    // Untiered images and M are interchangeable in both directions.
    if (wanted === null) return rows.find((image) => image.sizeTier === "M") ?? null;
    if (wanted === "M") return rows.find((image) => image.sizeTier === null) ?? null;
    return null;
  }

  /** Every active image of a provider, one per registered tier. */
  listDefaultImages(provider: SandboxProvider): SandboxImageRecord[] {
    return z
      .array(sandboxImageRowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT * FROM sandbox_images
             WHERE provider = ? AND is_default = 1 AND status = 'ready'
             ORDER BY updated_at DESC`,
          )
          .all(provider),
      )
      .map(fromImageRow);
  }

  beginImageBuild(input: {
    id: string;
    provider: SandboxProvider;
    name: string;
    extraPackages: string[];
    bbAppVersion?: string | null;
    sizeTier?: SandboxSizeTier | null;
    imageVersion?: string | null;
  }): SandboxImageRecord {
    extraPackagesSchema.parse(input.extraPackages);
    const now = Date.now();
    // Registering the same reference twice is an ordinary retry: CI publishes a
    // tag, and someone re-runs registration after a provider failed or a
    // network blip. Restarting the existing row beats a UNIQUE violation that
    // surfaces as a raw SQL error.
    this.db
      .prepare(
        `INSERT INTO sandbox_images (
          id, provider, name, status, is_default, extra_packages_json,
          bb_app_version, size_tier, image_version, created_at, updated_at
        ) VALUES (?, ?, ?, 'building', 0, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, name) DO UPDATE SET
          status = 'building', error = NULL, extra_packages_json = excluded.extra_packages_json,
          bb_app_version = COALESCE(excluded.bb_app_version, sandbox_images.bb_app_version),
          size_tier = COALESCE(excluded.size_tier, sandbox_images.size_tier),
          image_version = COALESCE(excluded.image_version, sandbox_images.image_version),
          updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.provider,
        input.name,
        JSON.stringify(input.extraPackages),
        input.bbAppVersion ?? null,
        input.sizeTier ?? null,
        input.imageVersion ?? null,
        now,
        now,
      );
    return this.imageByProviderName(input.provider, input.name) ?? this.requireImage(input.id);
  }

  imageByProviderName(
    provider: SandboxProvider,
    name: string,
  ): SandboxImageRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM sandbox_images WHERE provider = ? AND name = ? LIMIT 1",
      )
      .get(provider, name);
    return row === undefined
      ? null
      : fromImageRow(sandboxImageRowSchema.parse(row));
  }

  /** Record the bb-app an image carries once a build or registry label reveals it. */
  setImageBbAppVersion(id: string, version: string | null): SandboxImageRecord {
    this.requireImage(id);
    this.db
      .prepare(
        "UPDATE sandbox_images SET bb_app_version = ?, updated_at = ? WHERE id = ?",
      )
      .run(version, Date.now(), id);
    return this.requireImage(id);
  }

  requireImage(id: string): SandboxImageRecord {
    const row = this.db
      .prepare("SELECT * FROM sandbox_images WHERE id = ?")
      .get(id);
    if (row === undefined) throw new Error(`Sandbox image ${id} was not found`);
    return fromImageRow(sandboxImageRowSchema.parse(row));
  }

  /**
   * A row is opened before the image reference is known so the build is
   * visible while it runs. Nirvana's provider name is that reference, so its
   * row is corrected once the digest resolves.
   */
  renameImage(id: string, name: string): SandboxImageRecord {
    this.requireImage(id);
    this.db
      .prepare(
        "UPDATE sandbox_images SET name = ?, updated_at = ? WHERE id = ?",
      )
      .run(name, Date.now(), id);
    return this.requireImage(id);
  }

  finishImageBuild(
    id: string,
    placement?: { regionId: string; sandboxClass: string },
  ): SandboxImageRecord {
    const image = this.requireImage(id);
    const transaction = this.db.transaction(() => {
      this.clearDefaultForTier(image.provider, image.sizeTier, placement?.regionId ?? null);
      this.db
        .prepare(
          `UPDATE sandbox_images
           SET status = 'ready', is_default = 1, error = NULL,
               region_id = ?, sandbox_class = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          placement?.regionId ?? null,
          placement?.sandboxClass ?? null,
          Date.now(),
          id,
        );
    });
    transaction();
    return this.requireImage(id);
  }

  setDefaultImage(id: string): SandboxImageRecord {
    const image = this.requireImage(id);
    if (image.status !== "ready") {
      throw new Error(`Sandbox image ${image.name} is not ready`);
    }
    const transaction = this.db.transaction(() => {
      this.clearDefaultForTier(image.provider, image.sizeTier, image.regionId);
      this.db
        .prepare(
          "UPDATE sandbox_images SET is_default = 1, updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), id);
    });
    transaction();
    return this.requireImage(id);
  }

  /**
   * One active image per provider, tier, and region. An untiered image and an
   * M image answer the same lookups, so activating either retires the other;
   * an image without a recorded region predates regions and yields to any.
   */
  private clearDefaultForTier(
    provider: SandboxProvider,
    tier: SandboxSizeTier | null,
    regionId: string | null,
  ): void {
    const tierClause =
      tier === null || tier === "M"
        ? "(size_tier IS NULL OR size_tier = 'M')"
        : "size_tier = ?";
    const tierParams = tier === null || tier === "M" ? [] : [tier];
    this.db
      .prepare(
        `UPDATE sandbox_images SET is_default = 0
         WHERE provider = ? AND ${tierClause}
           AND (region_id IS NULL OR ? IS NULL OR region_id = ?)`,
      )
      .run(provider, ...tierParams, regionId, regionId);
  }

  clearDefaultImage(provider: SandboxProvider): number {
    return this.db
      .prepare("UPDATE sandbox_images SET is_default = 0 WHERE provider = ?")
      .run(provider).changes;
  }


  failImageBuild(id: string, error: string): SandboxImageRecord {
    this.requireImage(id);
    this.db
      .prepare(
        `UPDATE sandbox_images
         SET status = 'error', is_default = 0, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(error, Date.now(), id);
    return this.requireImage(id);
  }

  importDefaultImage(
    provider: SandboxProvider,
    name: string,
  ): SandboxImageRecord {
    const existing = this.getDefaultImage(provider);
    if (existing !== null) return existing;
    const id = `img_imported_${provider}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sandbox_images (
          id, provider, name, status, is_default, extra_packages_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'ready', 1, '[]', ?, ?)
        ON CONFLICT(provider, name) DO UPDATE SET
          status = 'ready', is_default = 1, error = NULL, updated_at = excluded.updated_at`,
      )
      .run(id, provider, name, now, now);
    return this.getDefaultImage(provider) ?? this.requireImage(id);
  }

}
