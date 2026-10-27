import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { Runtime } from "./channels/runtime";
import type { Store } from "./channels/store";
import { roomSchema } from "./channels/contract";

const PAUSED_KEY_PREFIX = "channel-agent-paused:";
const ACTIVE_THREAD_STATUS: Readonly<Record<string, true>> = {
  pending: true,
  starting: true,
  active: true,
};

type CleanupChannels = Pick<
  Store,
  "clearPaused" | "putJob" | "work"
>;
type CleanupRuntime = Pick<
  Runtime,
  "busy" | "cancel" | "changed" | "locked"
>;

export type ProfileCleanupContext = {
  bb: BbPluginApi;
  db: Database.Database;
  channels: CleanupChannels;
  runtime: CleanupRuntime;
  homesRoot: string;
};

export type ProfileCleanupCounts = {
  owners: number;
  profiles: number;
  jobs: number;
  jobsCancelled: number;
  conversations: number;
  threadBindings: number;
  profileRevisions: number;
  documentRevisions: number;
  threadMemberships: number;
  roomMemberships: number;
  queuedMessages: number;
  threadsStopped: number;
  threadsArchived: number;
  pausedEntries: number;
  homes: number;
};

const emptyCounts = (): ProfileCleanupCounts => ({
  owners: 0,
  profiles: 0,
  jobs: 0,
  jobsCancelled: 0,
  conversations: 0,
  threadBindings: 0,
  profileRevisions: 0,
  documentRevisions: 0,
  threadMemberships: 0,
  roomMemberships: 0,
  queuedMessages: 0,
  threadsStopped: 0,
  threadsArchived: 0,
  pausedEntries: 0,
  homes: 0,
});

function addCounts(target: ProfileCleanupCounts, source: ProfileCleanupCounts) {
  for (const key of Object.keys(target) as Array<keyof ProfileCleanupCounts>)
    target[key] += source[key];
}

function missingThread(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:^|\b)(?:thread not found|thread does not exist|HTTP 404)(?:\b|$)/iu.test(
    message,
  );
}
function isMissingFile(cause: unknown) {
  return (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

const AGENT_HOME_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function removeHome(path: string) {
  try {
    await lstat(path);
  } catch (cause) {
    if (isMissingFile(cause)) return 0;
    throw cause;
  }
  await rm(path, { recursive: true, force: true });
  return 1;
}

async function archiveHiddenThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<Pick<
  ProfileCleanupCounts,
  "queuedMessages" | "threadsStopped" | "threadsArchived"
>> {
  const counts = {
    queuedMessages: 0,
    threadsStopped: 0,
    threadsArchived: 0,
  };
  let thread;
  try {
    thread = await bb.sdk.threads.get({ threadId });
  } catch (cause) {
    if (missingThread(cause)) return counts;
    throw cause;
  }
  if (thread.visibility !== "hidden" || thread.archivedAt !== null) return counts;

  const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
  for (const entry of queued) {
    await bb.sdk.threads.queuedMessages.delete({
      threadId,
      queuedMessageId: entry.id,
    });
    counts.queuedMessages += 1;
  }
  if (ACTIVE_THREAD_STATUS[thread.status]) {
    await bb.sdk.threads.stop({ threadId });
    counts.threadsStopped += 1;
  }
  await bb.sdk.threads.archive({ threadId });
  counts.threadsArchived += 1;
  return counts;
}

function removeRoomMemberships(
  db: Database.Database,
  profileId: string,
) {
  let memberships = 0;
  const rooms = db.prepare("SELECT id, json FROM rooms ORDER BY id").all() as Array<{
    id: string;
    json: string;
  }>;
  const update = db.prepare("UPDATE rooms SET json = ? WHERE id = ?");
  for (const row of rooms) {
    const room = roomSchema.parse(JSON.parse(row.json));
    const nextMemberIds = room.memberIds.filter(
      (memberId) => memberId !== profileId,
    );
    const removed = room.memberIds.length - nextMemberIds.length;
    if (!removed) continue;
    memberships += removed;
    update.run(
      JSON.stringify({
        ...room,
        memberIds: nextMemberIds,
        updatedAt: Math.max(Date.now(), room.updatedAt + 1),
      }),
      row.id,
    );
  }
  return memberships;
}

async function withCleanupLocks<T>(
  context: ProfileCleanupContext,
  profileId: string,
  work: () => Promise<T>,
): Promise<T> {
  const roomIds = (
    context.db.prepare("SELECT id FROM rooms ORDER BY id").all() as Array<{
      id: string;
    }>
  ).map(({ id }) => id);
  const lockRoom = (index: number): Promise<T> =>
    index === roomIds.length
      ? context.runtime.locked(profileId, work)
      : context.runtime.locked(`room:${roomIds[index]}`, () =>
          lockRoom(index + 1),
        );
  return context.runtime.locked("rooms", () => lockRoom(0));
}

export async function cleanupProfileResources(
  context: ProfileCleanupContext,
  profileId: string,
  options: {
    deleteProfile?: boolean;
    guardChannelMessages?: boolean;
  } = {},
): Promise<ProfileCleanupCounts> {
  return withCleanupLocks(context, profileId, async () => {
    const counts = emptyCounts();
    counts.owners = 1;
    if (
      options.guardChannelMessages &&
      context.db
        .prepare(
          "SELECT 1 FROM room_messages WHERE json_extract(json, '$.agentId') = ? LIMIT 1",
        )
        .get(profileId)
    )
      throw new Error("This agent has channel history. Retire this agent instead.");

    const threadIds = new Set<string>();
    for (const row of context.db
      .prepare("SELECT thread_id AS threadId FROM conversations WHERE agent_id = ?")
      .all(profileId) as Array<{ threadId: string }>)
      threadIds.add(row.threadId);
    for (const row of context.db
      .prepare("SELECT thread_id AS threadId FROM thread_bindings WHERE profile_id = ?")
      .all(profileId) as Array<{ threadId: string }>)
      threadIds.add(row.threadId);

    for (const job of context.channels.work(profileId)) {
      await context.runtime.cancel(job, "Agent deleted by the owner.");
      if (!job.threadId && job.cancellationPending) {
        job.cancellationPending = false;
        context.channels.putJob(job);
      }
      counts.jobsCancelled += 1;
    }
    for (const threadId of threadIds) {
      const archived = await archiveHiddenThread(context.bb, threadId);
      counts.queuedMessages += archived.queuedMessages;
      counts.threadsStopped += archived.threadsStopped;
      counts.threadsArchived += archived.threadsArchived;
    }

    const pausedKey = `${PAUSED_KEY_PREFIX}${profileId}`;
    if ((await context.bb.storage.kv.get(pausedKey)) !== undefined)
      counts.pausedEntries = 1;
    await context.channels.clearPaused(profileId);
    counts.homes = await removeHome(join(context.homesRoot, profileId));
    context.runtime.busy.delete(profileId);

    context.db.transaction(() => {
      counts.roomMemberships = removeRoomMemberships(context.db, profileId);
      counts.threadMemberships = context.db
        .prepare("DELETE FROM thread_members WHERE profile_id = ?")
        .run(profileId).changes;
      counts.jobs = context.db
        .prepare("DELETE FROM jobs WHERE agent_id = ?")
        .run(profileId).changes;
      counts.conversations = context.db
        .prepare("DELETE FROM conversations WHERE agent_id = ?")
        .run(profileId).changes;
      counts.threadBindings = context.db
        .prepare("DELETE FROM thread_bindings WHERE profile_id = ?")
        .run(profileId).changes;
      counts.profileRevisions = context.db
        .prepare("DELETE FROM profile_revisions WHERE profile_id = ?")
        .run(profileId).changes;
      const documentScopes = context.db
        .prepare("SELECT scope FROM document_revisions WHERE scope LIKE 'agent:%'")
        .all() as Array<{ scope: string }>;
      const deleteScope = context.db.prepare(
        "DELETE FROM document_revisions WHERE scope = ?",
      );
      for (const { scope } of documentScopes) {
        if (!scope.startsWith(`agent:${profileId}:`)) continue;
        counts.documentRevisions += deleteScope.run(scope).changes;
      }
      if (options.deleteProfile) {
        const wasDefault = context.db
          .prepare("SELECT 1 FROM profiles WHERE id = ? AND is_default = 1")
          .get(profileId);
        counts.profiles = context.db
          .prepare("DELETE FROM profiles WHERE id = ?")
          .run(profileId).changes;
        if (
          wasDefault &&
          !context.db
            .prepare("SELECT 1 FROM profiles WHERE is_default = 1")
            .get()
        )
          context.db
            .prepare(
              "UPDATE profiles SET is_default = 1 WHERE id = (SELECT id FROM profiles ORDER BY name COLLATE NOCASE LIMIT 1)",
            )
            .run();
      }
    })();
    context.runtime.changed();
    return counts;
  });
}

function addOrphanIdsFromRows(
  ids: Set<string>,
  rows: Array<{ profileId: string }>,
  profiles: Set<string>,
) {
  for (const { profileId } of rows)
    if (!profiles.has(profileId)) ids.add(profileId);
}

export async function sweepOrphanedProfileResources(
  context: ProfileCleanupContext,
): Promise<ProfileCleanupCounts> {
  const counts = emptyCounts();
  const profiles = new Set(
    (
      context.db.prepare("SELECT id FROM profiles").all() as Array<{ id: string }>
    ).map(({ id }) => id),
  );
  const orphanIds = new Set<string>();
  for (const query of [
    "SELECT DISTINCT agent_id AS profileId FROM jobs",
    "SELECT DISTINCT agent_id AS profileId FROM conversations",
    "SELECT DISTINCT profile_id AS profileId FROM thread_bindings",
    "SELECT DISTINCT profile_id AS profileId FROM profile_revisions",
    "SELECT DISTINCT profile_id AS profileId FROM thread_members",
  ])
    addOrphanIdsFromRows(
      orphanIds,
      context.db.prepare(query).all() as Array<{ profileId: string }>,
      profiles,
    );

  for (const { scope } of context.db
    .prepare("SELECT DISTINCT scope FROM document_revisions WHERE scope LIKE 'agent:%'")
    .all() as Array<{ scope: string }>) {
    const match = /^agent:([^:]+):/u.exec(scope);
    if (match?.[1] && !profiles.has(match[1])) orphanIds.add(match[1]);
  }
  for (const { json } of context.db
    .prepare("SELECT json FROM rooms")
    .all() as Array<{ json: string }>) {
    const room = roomSchema.parse(JSON.parse(json));
    for (const id of room.memberIds)
      if (!profiles.has(id)) orphanIds.add(id);
  }
  for (const key of await context.bb.storage.kv.list(PAUSED_KEY_PREFIX)) {
    const id = key.slice(PAUSED_KEY_PREFIX.length);
    if (id && !profiles.has(id)) orphanIds.add(id);
  }
  try {
    for (const entry of await readdir(context.homesRoot, { withFileTypes: true }))
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        // Only agent homes (named by profile UUID); never other folders here.
        AGENT_HOME_NAME.test(entry.name) &&
        !profiles.has(entry.name)
      )
        orphanIds.add(entry.name);
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }

  for (const id of [...orphanIds].sort())
    addCounts(counts, await cleanupProfileResources(context, id));
  return counts;
}
