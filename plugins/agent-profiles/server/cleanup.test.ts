import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { roomSchema, type Job } from "./channels/contract";
import { Runtime } from "./channels/runtime";
import { Store } from "./channels/store";
import type { Profiles } from "./profiles";
import {
  cleanupProfileResources,
  sweepOrphanedProfileResources,
} from "./cleanup";

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const REPLACEMENT_ID = "10000000-0000-4000-8000-000000000002";
const ORPHAN_ID = "10000000-0000-4000-8000-000000000003";
const ROOM_ID = "20000000-0000-4000-8000-000000000001";

type ThreadState = {
  status: "pending" | "starting" | "active" | "idle";
  visibility: "hidden" | "visible";
  archivedAt: number | null;
};

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function setup(
  threads: Record<string, ThreadState>,
  pausedIds: string[] = [],
) {
  const queued = new Map<
    string,
    Array<{ id: string; content: never[] }>
  >();
  const archiveFailures = new Map<string, number>();
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const state = threads[threadId];
          if (!state) throw new Error("Thread not found");
          return makeThreadResponse({ id: threadId, ...state });
        },
        stop: async ({ threadId }) => {
          const state = threads[threadId];
          if (!state) throw new Error("Thread not found");
          state.status = "idle";
          return { ok: true };
        },
        archive: async ({ threadId }) => {
          const remainingFailures = archiveFailures.get(threadId) ?? 0;
          if (remainingFailures) {
            archiveFailures.set(threadId, remainingFailures - 1);
            throw new Error("Archive unavailable");
          }
          const state = threads[threadId];
          if (!state) throw new Error("Thread not found");
          state.archivedAt = Date.now();
        },
        queuedMessages: {
          list: async ({ threadId }) => queued.get(threadId) ?? [],
          delete: async ({ threadId, queuedMessageId }) => {
            queued.set(
              threadId,
              (queued.get(threadId) ?? []).filter(
                (entry) => entry.id !== queuedMessageId,
              ),
            );
            return { ok: true };
          },
        },
      },
    },
  });
  for (const id of pausedIds)
    await host.bb.storage.kv.set(`channel-agent-paused:${id}`, true);
  const db = host.bb.storage.database();
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE profile_revisions (
      profile_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, revision)
    );
    CREATE TABLE thread_bindings (
      thread_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      parent_thread_id TEXT,
      environment_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE document_revisions (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      key TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      json TEXT NOT NULL,
      UNIQUE(agent_id, key)
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE rooms (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE room_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE thread_members (
      parent_thread_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      removed_at TEXT,
      PRIMARY KEY (parent_thread_id, profile_id)
    );
  `);
  const channels = await Store.create(host.bb, db);
  const runtime = new Runtime(host.bb, channels, {} as Profiles);
  const homesRoot = join(
    tmpdir(),
    `agent-profile-cleanup-${randomUUID()}`,
  );
  temporaryRoots.push(homesRoot);
  return {
    ...host,
    db,
    channels,
    runtime,
    homesRoot,
    queued,
    archiveFailures,
    context: { bb: host.bb, db, channels, runtime, homesRoot },
  };
}

type TestDatabase = { db: Database.Database };

function roomJson(memberIds: string[]) {
  return JSON.stringify({
    id: ROOM_ID,
    name: "Cleanup",
    memberIds,
    responseBehavior: "directed",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  });
}

function storedRoomMemberIds(test: TestDatabase) {
  const row = test.db
    .prepare("SELECT json FROM rooms WHERE id = ?")
    .get(ROOM_ID) as { json: string } | undefined;
  if (!row) throw new Error("Missing cleanup test room");
  return roomSchema.parse(JSON.parse(row.json)).memberIds;
}

function insertProfile(
  test: TestDatabase,
  id: string,
  isDefault = false,
) {
  test.db
    .prepare("INSERT INTO profiles(id, name, is_default) VALUES (?, ?, ?)")
    .run(id, id, isDefault ? 1 : 0);
}

function job(
  id: string,
  agentId: string,
  status: Job["status"],
  threadId: string | null,
): Job {
  return {
    agentKind: "full",
    id,
    agentId,
    conversationKey: "mission",
    threadId,
    text: "work",
    status,
    reply: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: status === "running" ? 1 : null,
    dispatchStartedAt: null,
    roomId: null,
    runId: null,
    triggerMessageId: null,
    depth: 0,
    attachments: [],
    outputAttachments: [],
  };
}

function insertJob(test: TestDatabase, value: Job) {
  test.db
    .prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?)")
    .run(
      value.id,
      value.agentId,
      value.status,
      value.createdAt,
      JSON.stringify(value),
    );
}

function insertConversation(
  test: TestDatabase,
  agentId: string,
  threadId: string,
) {
  const value = {
    id: `conversation:${threadId}`,
    agentKind: "full" as const,
    agentId,
    key: `key:${threadId}`,
    threadId,
    title: threadId,
    kind: "mission" as const,
    createdAt: 1,
  };
  test.db
    .prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)")
    .run(value.id, agentId, value.key, threadId, JSON.stringify(value));
}

function insertBinding(
  test: TestDatabase,
  profileId: string,
  threadId: string,
) {
  test.db
    .prepare("INSERT INTO thread_bindings VALUES (?, ?, 1, NULL, NULL, ?)")
    .run(threadId, profileId, new Date(0).toISOString());
}

describe("profile resource cleanup", () => {
  it("cancels work, archives only hidden owned threads, and removes every owned resource except channel messages", async () => {
    const test = await setup(
      {
        conversation: {
          status: "active",
          visibility: "hidden",
          archivedAt: null,
        },
        child: { status: "active", visibility: "hidden", archivedAt: null },
        promoted: {
          status: "idle",
          visibility: "visible",
          archivedAt: null,
        },
      },
      [PROFILE_ID],
    );
    try {
      insertProfile(test, PROFILE_ID, true);
      insertProfile(test, REPLACEMENT_ID);
      insertConversation(test, PROFILE_ID, "conversation");
      insertBinding(test, PROFILE_ID, "child");
      insertBinding(test, PROFILE_ID, "promoted");
      insertJob(test, job("running", PROFILE_ID, "running", "conversation"));
      insertJob(test, job("queued", PROFILE_ID, "queued", null));
      insertJob(test, job("done", PROFILE_ID, "done", "conversation"));
      test.queued.set("conversation", [
        { id: "queued-conversation", content: [] },
      ]);
      test.queued.set("child", [{ id: "queued-child", content: [] }]);
      test.db
        .prepare("INSERT INTO profile_revisions VALUES (?, 1, '{}', ?)")
        .run(PROFILE_ID, new Date(0).toISOString());
      test.db
        .prepare(
          "INSERT INTO document_revisions(scope, text, actor, created_at) VALUES (?, '', '', 1)",
        )
        .run(`agent:${PROFILE_ID}:MEMORY.md`);
      test.db
        .prepare("INSERT INTO thread_members VALUES ('parent', ?, ?, NULL)")
        .run(PROFILE_ID, new Date(0).toISOString());
      test.db
        .prepare("INSERT INTO rooms VALUES (?, ?)")
        .run(ROOM_ID, roomJson([PROFILE_ID, REPLACEMENT_ID]));
      test.db
        .prepare("INSERT INTO room_messages VALUES ('message', 'room', ?)")
        .run(JSON.stringify({ id: "message", agentId: REPLACEMENT_ID }));
      await mkdir(join(test.homesRoot, PROFILE_ID), { recursive: true });
      await writeFile(join(test.homesRoot, PROFILE_ID, "MEMORY.md"), "memory");

      const counts = await cleanupProfileResources(test.context, PROFILE_ID, {
        deleteProfile: true,
        guardChannelMessages: true,
      });

      expect(counts).toMatchObject({
        profiles: 1,
        jobs: 3,
        jobsCancelled: 2,
        conversations: 1,
        threadBindings: 2,
        profileRevisions: 1,
        documentRevisions: 1,
        threadMemberships: 1,
        roomMemberships: 1,
        threadsArchived: 2,
        homes: 1,
      });
      expect(test.harness.inspection.sdk.callsTo("threads.archive")).toEqual([
        [{ threadId: "conversation" }],
        [{ threadId: "child" }],
      ]);
      expect(test.harness.inspection.sdk.callsTo("threads.queuedMessages.delete"))
        .toHaveLength(2);
      expect(test.db.prepare("SELECT id FROM profiles ORDER BY id").all())
        .toEqual([{ id: REPLACEMENT_ID }]);
      expect(
        test.db.prepare("SELECT is_default FROM profiles WHERE id = ?").get(
          REPLACEMENT_ID,
        ),
      ).toEqual({ is_default: 1 });
      expect(storedRoomMemberIds(test)).toEqual([REPLACEMENT_ID]);
      expect(test.db.prepare("SELECT id FROM room_messages").all()).toEqual([
        { id: "message" },
      ]);
      expect(
        await test.bb.storage.kv.get(`channel-agent-paused:${PROFILE_ID}`),
      ).toBeUndefined();
      await expect(access(join(test.homesRoot, PROFILE_ID))).rejects.toThrow();
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("preserves the profile and all resources when it authored channel history", async () => {
    const test = await setup({
      conversation: {
        status: "idle",
        visibility: "hidden",
        archivedAt: null,
      },
    });
    try {
      insertProfile(test, PROFILE_ID, true);
      insertConversation(test, PROFILE_ID, "conversation");
      test.db
        .prepare("INSERT INTO rooms VALUES (?, ?)")
        .run(ROOM_ID, roomJson([PROFILE_ID]));
      test.db
        .prepare("INSERT INTO room_messages VALUES ('message', 'room', ?)")
        .run(JSON.stringify({ agentId: PROFILE_ID }));

      await expect(
        cleanupProfileResources(test.context, PROFILE_ID, {
          deleteProfile: true,
          guardChannelMessages: true,
        }),
      ).rejects.toThrow("Retire this agent instead.");

      expect(test.db.prepare("SELECT id FROM profiles").all()).toEqual([
        { id: PROFILE_ID },
      ]);
      expect(test.db.prepare("SELECT id FROM conversations").all()).toEqual([
        { id: "conversation:conversation" },
      ]);
      expect(test.harness.inspection.sdk.callsTo("threads.archive")).toEqual([]);
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("leaves durable rows for retry and cleans residuals after an idempotent reentry", async () => {
    const test = await setup({
      conversation: {
        status: "active",
        visibility: "hidden",
        archivedAt: null,
      },
    });
    try {
      insertProfile(test, PROFILE_ID, true);
      insertConversation(test, PROFILE_ID, "conversation");
      await mkdir(join(test.homesRoot, PROFILE_ID), { recursive: true });
      test.archiveFailures.set("conversation", 1);

      await expect(
        cleanupProfileResources(test.context, PROFILE_ID, {
          deleteProfile: true,
          guardChannelMessages: true,
        }),
      ).rejects.toThrow("Archive unavailable");
      expect(test.db.prepare("SELECT id FROM profiles").all()).toEqual([
        { id: PROFILE_ID },
      ]);
      expect(test.db.prepare("SELECT id FROM conversations").all()).toEqual([
        { id: "conversation:conversation" },
      ]);
      await expect(access(join(test.homesRoot, PROFILE_ID))).resolves.toBeUndefined();

      await expect(
        cleanupProfileResources(test.context, PROFILE_ID, {
          deleteProfile: true,
          guardChannelMessages: true,
        }),
      ).resolves.toMatchObject({ profiles: 1, conversations: 1 });
      expect(test.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(2);
      insertConversation(test, PROFILE_ID, "conversation");
      await expect(
        cleanupProfileResources(test.context, PROFILE_ID, {
          deleteProfile: true,
          guardChannelMessages: true,
        }),
      ).resolves.toMatchObject({ profiles: 0, conversations: 1 });
      expect(test.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(2);
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("sweeps orphan jobs, conversations, rows, pause state, memberships, and homes without deleting messages", async () => {
    const test = await setup(
      {
        orphan: {
          status: "active",
          visibility: "hidden",
          archivedAt: null,
        },
      },
      [ORPHAN_ID],
    );
    try {
      insertProfile(test, REPLACEMENT_ID, true);
      insertConversation(test, ORPHAN_ID, "orphan");
      insertBinding(test, ORPHAN_ID, "missing-thread");
      insertJob(test, job("orphan-job", ORPHAN_ID, "running", "orphan"));
      test.db
        .prepare("INSERT INTO profile_revisions VALUES (?, 1, '{}', ?)")
        .run(ORPHAN_ID, new Date(0).toISOString());
      test.db
        .prepare(
          "INSERT INTO document_revisions(scope, text, actor, created_at) VALUES (?, '', '', 1)",
        )
        .run(`agent:${ORPHAN_ID}:MISSION.md`);
      test.db
        .prepare("INSERT INTO thread_members VALUES ('parent', ?, ?, NULL)")
        .run(ORPHAN_ID, new Date(0).toISOString());
      test.db
        .prepare("INSERT INTO rooms VALUES (?, ?)")
        .run(ROOM_ID, roomJson([ORPHAN_ID, REPLACEMENT_ID]));
      test.db
        .prepare("INSERT INTO room_messages VALUES ('message', 'room', ?)")
        .run(JSON.stringify({ agentId: ORPHAN_ID }));
      await mkdir(join(test.homesRoot, ORPHAN_ID), { recursive: true });
      await mkdir(join(test.homesRoot, REPLACEMENT_ID), { recursive: true });

      const counts = await sweepOrphanedProfileResources(test.context);

      expect(counts).toMatchObject({
        owners: 1,
        jobs: 1,
        jobsCancelled: 1,
        conversations: 1,
        threadBindings: 1,
        profileRevisions: 1,
        documentRevisions: 1,
        threadMemberships: 1,
        roomMemberships: 1,
        pausedEntries: 1,
        homes: 1,
      });
      expect(test.db.prepare("SELECT id FROM profiles").all()).toEqual([
        { id: REPLACEMENT_ID },
      ]);
      expect(test.db.prepare("SELECT id FROM room_messages").all()).toEqual([
        { id: "message" },
      ]);
      expect(storedRoomMemberIds(test)).toEqual([REPLACEMENT_ID]);
      await expect(access(join(test.homesRoot, ORPHAN_ID))).rejects.toThrow();
      await expect(access(join(test.homesRoot, REPLACEMENT_ID))).resolves
        .toBeUndefined();
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });
});
