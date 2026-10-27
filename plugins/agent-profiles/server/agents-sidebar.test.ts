import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Profile } from "./contract";
import { agentsSidebarSnapshot } from "./profiles";

describe("agents sidebar classification", () => {
  it("lists only shown agents and excludes canonical DMs, channel conversations and migration history, not agent tasks", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE agent_dms (profile_id TEXT, thread_id TEXT);
        CREATE TABLE channel_thread_ids (thread_id TEXT);
        CREATE TABLE dm_migration (thread_id TEXT);`);
      db.prepare("INSERT INTO agent_dms VALUES (?, ?)").run("agent-a", "dm-in-code-project");
      db.prepare("INSERT INTO agent_dms VALUES (?, ?)").run("agent-b", null);
      db.prepare("INSERT INTO channel_thread_ids VALUES (?)").run("channel-in-code-project");
      db.prepare("INSERT INTO dm_migration VALUES (?)").run("old-direct-chat");
      const profiles = [
        { id: "agent-a", name: "A", avatar: "A", showInSidebar: true },
        { id: "agent-b", name: "B", avatar: "B", showInSidebar: true },
        { id: "agent-hidden", name: "H", avatar: "H", showInSidebar: false },
      ] as Profile[];
      expect(agentsSidebarSnapshot(db, profiles)).toEqual({
        agents: [
          { id: "agent-a", name: "A", avatar: "A", dmThreadId: "dm-in-code-project" },
          { id: "agent-b", name: "B", avatar: "B", dmThreadId: null },
        ],
        excludedThreadIds: ["dm-in-code-project", "channel-in-code-project", "old-direct-chat"].sort(),
      });
    } finally {
      db.close();
    }
  });
});
