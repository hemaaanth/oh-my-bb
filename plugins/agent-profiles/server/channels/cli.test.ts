import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import type { Profile } from "../contract";
import { messageSchema, roomSchema, type Job } from "./contract";
import { Store } from "./store";

const profileInput = {
  name: "CLI Agent",
  slug: "cli-agent",
  description: "Exercises the channels CLI",
  avatar: "🤖",
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "medium" as const,
  serviceTier: "default" as const,
  permissionMode: "auto" as const,
  instructions: "",
  skillIds: [],
  mcpServerIds: [],
  isDefault: false,
};

async function setup() {
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
    agentSkillIds: ["agents"],
    sdk: {
      plugins: {
        callRpc: async ({ method }: { method: string }) => {
          if (
            method === "setGlobalAgent" ||
            method === "removeAgent" ||
            method === "setProjectAgent"
          )
            return { ok: true };
          if (method === "agentAssignments")
            return { global: true, projectIds: [] };
          throw new Error(`Unexpected Projects RPC: ${method}`);
        },
      },
      system: {
        config: async () => ({
          primaryHostId: "host-primary",
          voiceTranscriptionEnabled: false,
        }) as never,
      },
      projects: {
        create: async () => ({ id: "agents-project" }) as never,
      },
    },
  });
  await plugin(host.bb);
  const store = await Store.create(host.bb, host.bb.storage.database());
  await store.ensureProject();
  return { ...host, store };
}

async function saveAgent(harness: FakePluginHarness) {
  return harness.behavior.callRpc("saveProfile", profileInput) as Promise<Profile>;
}

async function runJson(
  harness: FakePluginHarness,
  argv: string[],
  ctx?: { threadId: string },
) {
  const result = await harness.behavior.runCli([...argv, "--json"], ctx);
  expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("agents channels CLI", () => {
  it("creates a channel, sends a message, and reads its messages", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const room = roomSchema.parse(await runJson(test.harness, [
        "channel",
        "create",
        "CLI review",
        "--agent",
        `@${agent.slug}`,
        "--mode",
        "automatic",
      ]));
      expect(room.memberIds).toEqual([agent.id]);
      expect(room.responseBehavior).toBe("smart");

      const requestId = randomUUID();
      const message = messageSchema.parse(await runJson(test.harness, [
        "channel",
        "send",
        room.id,
        "--text",
        "Review this change",
        "--request-id",
        requestId,
        "--mode",
        "followup",
      ]));
      expect(message).toMatchObject({
        id: requestId,
        roomId: room.id,
        sendMode: "followup",
      });

      const page = await runJson(test.harness, [
        "channel",
        "messages",
        room.id,
      ]) as { messages: unknown[]; reactions: unknown[] };
      expect(page.messages.map((value) => messageSchema.parse(value).text))
        .toContain("Review this change");
      expect(page.reactions).toEqual([]);
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("stops and retries one queued response", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const room = roomSchema.parse(await runJson(test.harness, [
        "channel",
        "create",
        "Retry work",
        "--agent",
        agent.id,
        "--mode",
        "smart",
      ]));
      await runJson(test.harness, [
        "channel",
        "send",
        room.id,
        "--text",
        "Start work",
      ]);
      const original = test.store.activity(agent.id, room.id, 1, 0)[0]!;

      expect(await runJson(test.harness, ["stop", original.id])).toEqual({
        cancelled: true,
      });
      const retry = await runJson(test.harness, ["retry", original.id]) as Job;
      expect(retry).toMatchObject({
        agentId: agent.id,
        roomId: room.id,
        retryOf: original.id,
        status: "queued",
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("binds channel creation and message authorship to ctx.threadId", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const threadId = "cli-agent-admin";
      test.store.putConversation({
        id: randomUUID(),
        agentId: agent.id,
        key: "admin",
        threadId,
        title: agent.name,
        kind: "admin",
        createdAt: Date.now(),
      });
      const room = roomSchema.parse(await runJson(
        test.harness,
        ["channel", "create", "Agent-created"],
        { threadId },
      ));
      expect(room.memberIds).toEqual([agent.id]);

      const message = messageSchema.parse(await runJson(
        test.harness,
        ["channel", "send", room.id, "--text", "Agent-authored note"],
        { threadId },
      ));
      expect(message).toMatchObject({
        agentId: agent.id,
        speaker: agent.name,
        sourceThreadId: threadId,
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("requires --yes before deleting a channel", async () => {
    const test = await setup();
    try {
      const room = roomSchema.parse(await runJson(test.harness, [
        "channel",
        "create",
        "Delete confirmation",
      ]));
      const rejected = await test.harness.behavior.runCli([
        "channel",
        "delete",
        room.id,
        "--json",
      ]);
      expect(rejected.exitCode).not.toBe(0);
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        ok: false,
        error: { code: "confirmation_required" },
      });
      expect(test.store.findRoom(room.id)).not.toBeNull();

      expect(await runJson(test.harness, [
        "channel",
        "delete",
        room.id,
        "--yes",
      ])).toEqual({ deleted: true });
      expect(test.store.findRoom(room.id)).toBeNull();
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });
  it("switches agent type through CLI and rejects thin mission commands", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const thin = await runJson(test.harness, ["kind", agent.id, "thin"]) as Profile;
      expect(thin).toMatchObject({ kind: "thin", revision: agent.revision + 1 });
      const shown = await test.harness.behavior.runCli(["show", agent.id]);
      expect(shown.stdout).toContain("Type: thin");
      for (const argv of [
        ["mission", agent.id],
        ["persona", agent.id],
        ["schedule", agent.id, "--every", "1h"],
        ["wake", agent.id],
      ]) {
        const result = await test.harness.behavior.runCli(argv);
        expect(result.exitCode, argv.join(" ")).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toMatch(/no mission or persona|do not have mission schedules|do not have standing missions/i);
      }
      const full = await runJson(test.harness, ["kind", agent.id, "full"]) as Profile;
      expect(full).toMatchObject({ kind: "full", revision: thin.revision + 1 });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });
  it("sets and shows a mission schedule", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const scheduled = await runJson(test.harness, [
        "schedule",
        agent.id,
        "--every",
        "4h",
      ]) as { intervalMinutes: number; nextWakeAt: number | null };
      expect(scheduled.intervalMinutes).toBe(240);
      expect(scheduled.nextWakeAt).toBeNull();

      const shown = await runJson(test.harness, [
        "show",
        agent.id,
      ]) as {
        profile: Profile;
        schedule: {
          intervalMinutes: number | null;
          paused: boolean;
          retired: boolean;
          nextWakeAt: number | null;
        };
      };
      expect(shown.profile.intervalMinutes).toBe(240);
      expect(shown.schedule).toEqual({
        intervalMinutes: 240,
        paused: true,
        retired: false,
        nextWakeAt: null,
      });

      const off = await runJson(test.harness, [
        "schedule",
        agent.id,
        "--every",
        "off",
      ]) as { intervalMinutes: number | null };
      expect(off.intervalMinutes).toBeNull();
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

});
