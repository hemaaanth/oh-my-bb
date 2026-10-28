import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { Store } from "./channels/store";
import type { Profiles } from "./profiles";
import { AGENTS_PROVIDER_ID, agentModelId } from "./provider-ids";

// Under Node's 24.8-day timer limit, so the hold never fires early.
export const PLACEHOLDER_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

type DmRow = {
  profileId: string;
  threadId: string | null;
  creationToken: string;
  state: "creating" | "ready" | "missing";
  projectId: string | null;
  environmentId: string | null;
  spawnStartedAt: string | null;
};

type DmThread = {
  id: string;
  providerId: string;
  parentThreadId: string | null;
  projectId: string;
  environmentId: string | null;
  deletedAt: number | null;
  archivedAt: number | null;
};

export interface AgentDms {
  ensureAgentDm(profileId: string): Promise<{ threadId: string }>;
  restoreArchived(signal?: AbortSignal): Promise<void>;
  archived(threadId: string): Promise<void>;
  deleted(threadId: string): void;
}

export function createAgentDms(bb: BbPluginApi, db: Database.Database, profiles: Profiles, store: Store): AgentDms {
  const inFlight = new Map<string, Promise<{ threadId: string }>>();
  const rowFor = db.prepare(`SELECT profile_id AS profileId, thread_id AS threadId,
    creation_token AS creationToken, state, project_id AS projectId,
    environment_id AS environmentId, spawn_started_at AS spawnStartedAt
    FROM agent_dms WHERE profile_id = ?`);
  const byThread = db.prepare("SELECT profile_id AS profileId FROM agent_dms WHERE thread_id = ?");
  const missing = db.prepare("UPDATE agent_dms SET state = 'missing', updated_at = ? WHERE profile_id = ?");

  async function restore(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.deletedAt !== null) throw new Error("This agent's DM was deleted. It cannot be recreated automatically.");
    if (thread.archivedAt !== null) await bb.sdk.threads.unarchive({ threadId });
    return thread;
  }

  async function bind(row: DmRow, thread: DmThread) {
    const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
    // A DM with no turn yet has no execution model; the reservation token proves its identity until then.
    if (thread.providerId !== AGENTS_PROVIDER_ID || (execution !== null && execution.model !== agentModelId(row.profileId))
      || thread.parentThreadId !== null || thread.projectId !== row.projectId || thread.deletedAt !== null)
      throw new Error("The reserved agent DM has a conflicting thread identity. Repair it before opening again.");
    const profile = profiles.getProfile(row.profileId);
    // A queued start supplies temporary execution options. Persist identity before deleting it.
    await pinModel(thread.id, profile.id);
    db.transaction(() => {
      const current = rowFor.get(row.profileId) as DmRow;
      if (current.creationToken !== row.creationToken || (current.threadId && current.threadId !== thread.id))
        throw new Error("The agent DM reservation changed during creation.");
      db.prepare(`INSERT INTO thread_bindings
        (thread_id, profile_id, revision, parent_thread_id, environment_id, created_at)
        VALUES (?, ?, ?, NULL, ?, ?)
        ON CONFLICT(thread_id) DO NOTHING`)
        .run(thread.id, profile.id, profile.revision, thread.environmentId, new Date().toISOString());
      const bound = profiles.boundProfile(thread.id);
      if (bound?.id !== profile.id) throw new Error("The reserved agent DM is bound to another profile.");
      db.prepare(`UPDATE agent_dms SET thread_id = ?, environment_id = ?, state = 'ready', updated_at = ?
        WHERE profile_id = ?`).run(thread.id, thread.environmentId, new Date().toISOString(), row.profileId);
      db.prepare("UPDATE dm_migration SET new_dm_id = ?, phase = 'linked' WHERE profile_id = ?")
        .run(thread.id, profile.id);
    })();
    await dropPlaceholder(thread.id);
    return { threadId: thread.id };
  }

  // The placeholder never runs, so BB has no model for the DM's first send. Pin the agent as the thread's
  // model. BB checks it against the picker catalog, which is why hidden agents cannot have a DM.
  async function pinModel(threadId: string, profileId: string) {
    await bb.sdk.threads.update({ threadId, model: agentModelId(profileId) });
  }

  async function dropPlaceholder(threadId: string) {
    try {
      for (const queued of await bb.sdk.threads.queuedMessages.list({ threadId }))
        await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: queued.id });
    } catch (error) {
      bb.log.warn(`Could not drop the placeholder message in agent DM ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function reconcile(row: DmRow) {
    const found: DmThread[] = [];
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 100) {
        const threads = await bb.sdk.threads.list({ archived, originPluginId: bb.pluginId,
          includeHidden: true, limit: 100, offset });
        for (const thread of threads) {
          const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: bb.pluginId });
          if (metadata.role === "dm" && metadata.schemaVersion === 1 && metadata.profileId === row.profileId
            && metadata.creationToken === row.creationToken) found.push(thread);
        }
        if (threads.length < 100) break;
      }
    }
    if (found.length > 1) throw new Error("Multiple threads have this agent DM reservation. Repair before opening.");
    return found[0];
  }

  async function allocate(profileId: string): Promise<{ threadId: string }> {
    const profile = profiles.getProfile(profileId);
    if (!profile.showInSidebar)
      throw new Error(`${profile.name} is hidden, so it has no DM. Turn on Show in sidebar to talk to it directly.`);
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO agent_dms
      (profile_id, thread_id, creation_token, state, project_id, environment_id, spawn_started_at, created_at, updated_at)
      VALUES (?, NULL, ?, 'creating', ?, NULL, NULL, ?, ?)`)
      .run(profile.id, randomUUID(), profile.runProjectId, timestamp, timestamp);
    const row = rowFor.get(profile.id) as DmRow;
    if (row.state === "missing") throw new Error("This agent's DM is missing or deleted. It cannot be recreated automatically.");
    if (row.threadId) {
      let thread: DmThread;
      try { thread = await bb.sdk.threads.get({ threadId: row.threadId }); }
      catch (error) {
        if (!(error instanceof Error) || !/not found|does not exist/i.test(error.message)) throw error;
        missing.run(new Date().toISOString(), profile.id);
        throw new Error("This agent's DM is missing or deleted. It cannot be recreated automatically.");
      }
      if (thread.deletedAt !== null) {
        missing.run(new Date().toISOString(), profile.id);
        throw new Error("This agent's DM is missing or deleted. It cannot be recreated automatically.");
      }
      const [metadata, execution] = await Promise.all([
        bb.sdk.threads.getPluginMetadata({ threadId: row.threadId, pluginId: bb.pluginId }),
        bb.sdk.threads.defaultExecutionOptions({ threadId: row.threadId }),
      ]);
      if (metadata.role !== "dm" || metadata.schemaVersion !== 1 || metadata.profileId !== profile.id
        || metadata.creationToken !== row.creationToken || thread.providerId !== AGENTS_PROVIDER_ID
        || (execution !== null && execution.model !== agentModelId(profile.id)) || thread.projectId !== row.projectId)
        throw new Error("The agent DM thread identity does not match its reservation.");
      if (thread.archivedAt !== null) await bb.sdk.threads.unarchive({ threadId: row.threadId });
      await pinModel(row.threadId, profile.id);
      return { threadId: row.threadId };
    }
    if (row.spawnStartedAt) {
      const recovered = await reconcile(row);
      if (!recovered) throw new Error("Agent DM spawn outcome is uncertain. No second DM will be created; inspect the reservation and retry recovery.");
      const result = await bind(row, recovered);
      await restore(result.threadId);
      return result;
    }
    const target = profile.runProjectId
      ? await profiles.fixedProjectEnvironment(profile)
      : await (async () => {
        const projectId = await store.ensureProject();
        const home = await profiles.homes.ensureHome(profile);
        const hostId = home.hostId ?? (await bb.sdk.system.config()).primaryHostId;
        if (!hostId) throw new Error("The agent home has no connected host.");
        return { projectId, environment: { type: "host" as const, hostId,
          workspace: { type: "unmanaged" as const, path: home.path } } };
      })();
    const claimed = db.prepare(`UPDATE agent_dms SET project_id = ?, spawn_started_at = ?, updated_at = ?
      WHERE profile_id = ? AND creation_token = ? AND spawn_started_at IS NULL AND thread_id IS NULL`)
      .run(target.projectId, new Date().toISOString(), new Date().toISOString(), profile.id, row.creationToken);
    if (!claimed.changes) {
      const current = rowFor.get(profile.id) as DmRow;
      if (current.threadId) return allocate(profileId);
      const recovered = await reconcile(current);
      if (recovered) return await bind(current, recovered);
      throw new Error("Agent DM creation is already in progress or uncertain. No second DM will be created.");
    }
    row.projectId = target.projectId;
    try {
      const thread = await bb.sdk.threads.spawn({ projectId: target.projectId, environment: target.environment,
        title: profile.name, providerId: AGENTS_PROVIDER_ID, model: agentModelId(profile.id),
        permissionMode: "full", serviceTier: profile.serviceTier,
        // BB requires a first input. Hold it far in the future and delete it once bound, so the DM starts empty.
        input: [{ type: "text", text: `Open ${profile.name}`, mentions: [] }], sendAt: Date.now() + PLACEHOLDER_DELAY_MS,
        pluginMetadata: { role: "dm", profileId: profile.id, schemaVersion: 1, creationToken: row.creationToken } });
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: bb.pluginId });
      if (metadata.role !== "dm" || metadata.schemaVersion !== 1 || metadata.profileId !== row.profileId
        || metadata.creationToken !== row.creationToken)
        throw new Error("The spawned thread has no matching agent DM reservation.");
      return await bind(row, thread);
    } catch (error) {
      const recovered = await reconcile(row);
      if (recovered) return await bind(row, recovered);
      bb.log.warn(`Agent DM spawn for ${profile.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`Agent DM spawn outcome is uncertain. No second DM will be created; inspect the reservation and retry recovery. Cause: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  return {
    ensureAgentDm(profileId) {
      const pending = inFlight.get(profileId);
      if (pending) return pending;
      const operation = allocate(profileId).finally(() => { inFlight.delete(profileId); });
      inFlight.set(profileId, operation);
      return operation;
    },
    async restoreArchived(signal) {
      const rows = db.prepare("SELECT profile_id AS profileId, thread_id AS threadId FROM agent_dms WHERE state = 'ready'")
        .all() as Array<{ profileId: string; threadId: string }>;
      for (const row of rows) {
        if (signal?.aborted) return;
        try {
          await restore(row.threadId);
          if (profiles.getProfile(row.profileId).showInSidebar) await allocate(row.profileId);
        }
        catch (error) { bb.log.warn(`Could not restore agent DM ${row.profileId}: ${String(error)}`); }
      }
    },
    async archived(threadId) {
      if (!byThread.get(threadId)) return;
      try { await restore(threadId); }
      catch (error) { bb.log.warn(`Could not restore archived agent DM ${threadId}: ${String(error)}`); }
    },
    deleted(threadId) {
      const row = byThread.get(threadId) as { profileId: string } | undefined;
      if (row) missing.run(new Date().toISOString(), row.profileId);
    },
  };
}
