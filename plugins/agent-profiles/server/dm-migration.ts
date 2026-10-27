import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { Profile } from "./contract";
import { memoryHostContract } from "../provider/memory-contract";
type HistoryThread = {
  id: string; providerId: string; deletedAt: number | null;
  archivedAt: number | null; updatedAt: number; parentThreadId: string | null;
  visibility: "visible" | "hidden"; status: string;
};

export type HistoryEntry = {
  profileId: string;
  threadId: string;
  providerId: string;
  model: string | null;
  predecessor: boolean;
  archived: boolean;
};

export async function previewAgentHistory(bb: BbPluginApi, db: Database.Database, profiles: readonly Profile[]) {
  const profilesByProvider = new Map(profiles.map((profile) => [`agent-${profile.id}`, profile]));
  const candidates = new Map<string, Array<HistoryThread & { canonical: boolean }>>();
  const blocked: string[] = [];
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += 100) {
      const page = await bb.sdk.threads.list({ archived, includeHidden: true, limit: 100, offset });
      for (const thread of page) {
        const profile = profilesByProvider.get(thread.providerId);
        if (!profile || thread.deletedAt !== null) continue;
        if (["pending", "starting", "active"].includes(thread.status)) blocked.push(`Thread ${thread.id} is ${thread.status}`);
        const binding = db.prepare("SELECT parent_thread_id AS parentId FROM thread_bindings WHERE thread_id = ?")
          .get(thread.id) as { parentId: string | null } | undefined;
        if (thread.parentThreadId || binding?.parentId || db.prepare("SELECT 1 FROM conversations WHERE thread_id = ?").get(thread.id)
          || db.prepare("SELECT 1 FROM jobs WHERE json_extract(json, '$.threadId') = ?").get(thread.id)) continue;
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: bb.pluginId });
        if (metadata.role === "task" || metadata.role === "channel" || thread.visibility === "hidden") continue;
        const list = candidates.get(profile.id) ?? [];
        list.push({ ...thread, canonical: metadata.role === "dm" });
        candidates.set(profile.id, list);
      }
      if (page.length < 100) break;
    }
  }
  const entries: HistoryEntry[] = [];
  const ambiguous: string[] = [];
  for (const [profileId, threads] of candidates) {
    threads.sort((a, b) => Number(b.canonical) - Number(a.canonical)
      || Number(a.archivedAt !== null) - Number(b.archivedAt !== null)
      || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    if (threads.length > 1 && threads[0]!.canonical === threads[1]!.canonical
      && (threads[0]!.archivedAt !== null) === (threads[1]!.archivedAt !== null)
      && threads[0]!.updatedAt === threads[1]!.updatedAt) ambiguous.push(profileId);
    for (const [index, thread] of threads.entries()) {
      const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
      entries.push({ profileId, threadId: thread.id, providerId: thread.providerId,
        model: execution?.model ?? null, predecessor: index === 0, archived: thread.archivedAt !== null });
    }
  }
  const unfinished = db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued', 'dispatching', 'running') OR json_extract(json, '$.cancellationPending') = 1 LIMIT 1").get();
  if (unfinished) blocked.push("Channel jobs are unfinished");
  const recovering = db.prepare("SELECT 1 FROM agent_dms WHERE state <> 'ready' OR (thread_id IS NULL AND spawn_started_at IS NOT NULL) LIMIT 1").get();
  if (recovering) blocked.push("A DM reservation needs recovery");
  if (entries.length) {
    const primaryHostId = (await bb.sdk.system.config()).primaryHostId;
    if (!primaryHostId) blocked.push("Primary memory host is unavailable");
    else {
      const host = bb.hosts.experimental_client({ contract: memoryHostContract });
      for (const profile of profiles) {
        try {
          const memory = await host.call("memoryState", { profile: profile.memoryKey }, { hostId: primaryHostId });
          if (memory.pending || memory.held) blocked.push(`Agent ${profile.id} has memory work requiring recovery`);
        } catch (error) {
          blocked.push(`Agent ${profile.id} memory state could not be checked: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return { entries, ambiguous, blocked };
}

export async function migrateAgentHistory(bb: BbPluginApi, db: Database.Database, profiles: readonly Profile[]) {
  const preview = await previewAgentHistory(bb, db, profiles);
  if (preview.blocked.length) throw new Error(`Agent migration is blocked: ${preview.blocked.join("; ")}`);
  const insert = db.prepare(`INSERT INTO dm_migration
    (thread_id, profile_id, provider_id, model, predecessor, phase, new_dm_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, 'history', NULL, ?)
    ON CONFLICT(thread_id) DO NOTHING`);
  db.transaction(() => {
    for (const entry of preview.entries)
      insert.run(entry.threadId, entry.profileId, entry.providerId, entry.model,
        entry.predecessor ? 1 : 0, new Date().toISOString());
  })();
  return preview;
}
