import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { migrateAgentHistory, previewAgentHistory } from "./dm-migration";
import { snapshot } from "./profiles";
import type { Profile } from "./contract";

const input = {
  name: "Atlas", slug: "atlas", kind: "thin" as const, description: "", avatar: "🤖",
  modelMode: "level" as const, level: "medium" as const, providerId: "hempi",
  model: "openai-codex/gpt-6-sol", reasoningLevel: "medium" as const,
  serviceTier: "default", permissionMode: "full" as const, instructions: "",
  skillIds: [], mcpServerIds: [], runProjectId: null, runInCheckout: false, isDefault: false,
};

type Thread = {
  id: string; providerId: string; archivedAt: number | null; updatedAt: number;
  parentThreadId: string | null; visibility: "visible" | "hidden";
  status: "error" | "active" | "idle" | "pending" | "starting" | "stopping";
};
async function setup() {
  const threads = new Map<string, Thread>();
  const metadata = new Map<string, Record<string, unknown>>();
  let memory = { home: "/agent-memory", pending: null as null | { operationId: string }, held: false };
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
    sdk: {
      plugins: { callRpc: async () => ({ ok: true }) },
      system: { config: async () => ({ primaryHostId: "primary" }) as never },
      threads: {
        list: async ({ archived, offset = 0, limit = 100 } = {}) =>
          [...threads.values()].filter((thread) => (thread.archivedAt !== null) === archived)
            .slice(offset, offset + limit) as never,
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        defaultExecutionOptions: async () => ({ model: "openai-codex/gpt-6-sol", permissionMode: "full", reasoningLevel: "medium", serviceTier: "default", source: "explicit" }) as never,
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return thread;
        },
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      if (method === "memoryState") return memory;
      throw new Error(`Unexpected host call ${method}`);
    },
  });
  await plugin(host.bb);
  const profile = await host.harness.behavior.callRpc("saveProfile", input) as Profile;
  const db = host.bb.storage.database();
  const add = (id: string, overrides: Partial<Thread> = {}, role?: string) => {
    threads.set(id, makeThreadResponse({ id, providerId: `agent-${profile.id}`, status: "idle",
      updatedAt: 1_000, archivedAt: null, ...overrides }));
    if (role) metadata.set(id, { role });
  };
  return { ...host, threads, db, profile, add, setMemory(value: typeof memory) { memory = value; } };
}

describe("legacy history cutover", () => {
  it("selects a standalone predecessor, reports ties, and preserves all archived, task and channel IDs", async () => {
    const x = await setup();
    const temp = mkdtempSync(join(tmpdir(), "agents-history-"));
    try {
      x.add("direct-old", { updatedAt: 10 });
      x.add("direct-new", { updatedAt: 20 });
      x.add("direct-tie", { updatedAt: 20 });
      x.add("archived", { updatedAt: 50, archivedAt: 100 });
      x.add("child", { parentThreadId: "parent", updatedAt: 100 });
      x.add("automated", { parentThreadId: null, visibility: "hidden" }, "task");
      x.add("channel", { updatedAt: 200 }, "channel");
      x.db.prepare("INSERT INTO conversations (id, agent_id, key, thread_id, json) VALUES (?, ?, ?, ?, ?)")
        .run("conversation", x.profile.id, "room:one", "channel", "{}");
      const revisionsBefore = x.db.prepare("SELECT snapshot FROM profile_revisions WHERE profile_id = ? ORDER BY revision").all(x.profile.id);
      const before = await previewAgentHistory(x.bb, x.db, [x.profile]);
      expect(before.entries.map(({ threadId }) => threadId).sort()).toEqual(["archived", "direct-new", "direct-old", "direct-tie"]);
      expect(before.entries.find(({ predecessor }) => predecessor)?.threadId).toBe("direct-new");
      expect(before.ambiguous).toEqual([x.profile.id]);
      expect(before.blocked).toEqual([]);
      await x.db.backup(join(temp, "before.sqlite"));
      const backup = new Database(join(temp, "before.sqlite"));
      try {
        expect((await previewAgentHistory(x.bb, backup, [x.profile])).entries).toEqual(before.entries);
      } finally { backup.close(); }
      await migrateAgentHistory(x.bb, x.db, [x.profile]);
      await migrateAgentHistory(x.bb, x.db, [x.profile]);
      expect(x.db.prepare("SELECT thread_id AS threadId, predecessor, phase FROM dm_migration ORDER BY thread_id").all())
        .toEqual([
          { threadId: "archived", predecessor: 0, phase: "history" },
          { threadId: "direct-new", predecessor: 1, phase: "history" },
          { threadId: "direct-old", predecessor: 0, phase: "history" },
          { threadId: "direct-tie", predecessor: 0, phase: "history" },
        ]);
      expect(x.db.prepare("SELECT snapshot FROM profile_revisions WHERE profile_id = ? ORDER BY revision").all(x.profile.id)).toEqual(revisionsBefore);
      expect((await x.bb.sdk.threads.get({ threadId: "archived" })).archivedAt).toBe(100);
      const renamed = await x.harness.behavior.callRpc("saveProfile", { ...snapshot(x.profile), slug: "atlas-new" }) as Profile;
      expect(renamed.memoryKey).toBe(x.profile.memoryKey);
      expect(x.db.prepare("SELECT count(*) AS count FROM dm_migration").get()).toEqual({ count: 4 });
    } finally { await x.harness.lifecycle.dispose(); rmSync(temp, { recursive: true, force: true }); }
  });

  it("blocks active threads, unfinished jobs, DM recovery and pending memory before writing the ledger", async () => {
    const x = await setup();
    try {
      x.add("direct");
      x.add("active", { status: "active" });
      await expect(migrateAgentHistory(x.bb, x.db, [x.profile])).rejects.toThrow("active");
      x.threads.delete("active");
      x.db.prepare("INSERT INTO jobs (id, agent_id, status, created_at, json) VALUES (?, ?, ?, ?, ?)")
        .run("job", x.profile.id, "running", 1, "{}");
      await expect(migrateAgentHistory(x.bb, x.db, [x.profile])).rejects.toThrow("Channel jobs");
      x.db.prepare("DELETE FROM jobs").run();
      x.db.prepare(`INSERT INTO agent_dms (profile_id, creation_token, state, created_at, updated_at)
        VALUES (?, ?, 'creating', ?, ?)`).run(x.profile.id, "reservation", "now", "now");
      await expect(migrateAgentHistory(x.bb, x.db, [x.profile])).rejects.toThrow("reservation");
      x.db.prepare("DELETE FROM agent_dms").run();
      x.setMemory({ home: "/agent-memory", pending: { operationId: "00000000-0000-4000-8000-000000000000" }, held: false });
      await expect(migrateAgentHistory(x.bb, x.db, [x.profile])).rejects.toThrow("memory");
      expect(x.db.prepare("SELECT count(*) AS count FROM dm_migration").get()).toEqual({ count: 0 });
    } finally { await x.harness.lifecycle.dispose(); }
  });
});
