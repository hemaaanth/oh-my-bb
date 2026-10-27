import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import type { Profile } from "../contract";
import { ChannelData } from "./channel-data";
import type { Room, RoomMessage } from "./contract";
import { Store } from "./store";

async function setup() {
  let projectCreates = 0;
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
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
        config: async () => ({ primaryHostId: "host-primary" }) as never,
      },
      projects: {
        create: async () => {
          projectCreates++;
          return { id: "agents-project" } as never;
        },
      },
    },
  });
  await plugin(host.bb);
  const store = await Store.create(host.bb, host.bb.storage.database());
  await store.ensureProject();
  return {
    ...host,
    store,
    projectCreates: () => projectCreates,
  };
}

function room(memberIds: string[] = []): Room {
  return {
    id: randomUUID(),
    name: "Store test",
    memberIds,
    responseBehavior: "directed",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function message(channel: Room, index: number): RoomMessage {
  return {
    id: `message-${index}`,
    roomId: channel.id,
    runId: `run-${index}`,
    agentId: null,
    speaker: "You",
    replyTo: null,
    attachments: [],
    text: `Message ${index}`,
    createdAt: index,
  };
}

const profileInput = {
  name: "Channel Agent",
  slug: "channel-agent",
  description: "Works in channels",
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

describe("channel store", () => {
  it("creates the shared Agents homes project once and exposes profile agents", async () => {
    const test = await setup();
    try {
      expect(await test.store.ensureProject()).toBe("agents-project");
      const second = await Store.create(test.bb, test.bb.storage.database());
      expect(await second.ensureProject()).toBe("agents-project");
      expect(test.projectCreates()).toBe(1);

      const [profile] = (await test.harness.behavior.callRpc(
        "listProfiles",
        null,
      )) as Profile[];
      expect(second.get(profile!.id)).toMatchObject({
        id: profile!.id,
        handle: profile!.slug,
        home: expect.stringContaining(`/homes/${profile!.id}`),
        projectId: "agents-project",
        paused: true,
        retired: false,
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("stores messages and pages transcript before, after, and around cursors", async () => {
    const test = await setup();
    try {
      const channel = room();
      test.store.putRoom(channel);
      for (let index = 0; index < 12; index++)
        expect(test.store.putMessage(message(channel, index))).toBe(true);
      expect(test.store.putMessage(message(channel, 0))).toBe(false);
      expect(test.store.messages(channel.id, 3).map(({ id }) => id)).toEqual([
        "message-9",
        "message-10",
        "message-11",
      ]);

      const before = test.store.transcript(channel.id, {
        before: "message-8",
        limit: 3,
      });
      expect(before.messages.map(({ id }) => id)).toEqual([
        "message-5",
        "message-6",
        "message-7",
      ]);
      expect(before).toMatchObject({ hasOlder: true, hasNewer: true });

      const after = test.store.transcript(channel.id, {
        after: "message-3",
        limit: 3,
      });
      expect(after.messages.map(({ id }) => id)).toEqual([
        "message-4",
        "message-5",
        "message-6",
      ]);

      const around = test.store.transcript(channel.id, {
        around: "message-6",
        limit: 5,
      });
      expect(around.messages.map(({ id }) => id)).toEqual([
        "message-4",
        "message-5",
        "message-6",
        "message-7",
        "message-8",
      ]);

      expect(
        test.store.react(
          channel.id,
          "message-6",
          "👍",
          "owner",
          "You",
          true,
        ),
      ).toEqual([
        expect.objectContaining({
          messageId: "message-6",
          emoji: "👍",
          actorId: "owner",
        }),
      ]);
      expect(
        test.store.react(
          channel.id,
          "message-6",
          "👍",
          "owner",
          "You",
          false,
        ),
      ).toEqual([]);
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("stages, claims, expires, and discards draft attachments", async () => {
    const test = await setup();
    try {
      const channel = room();
      test.store.putRoom(channel);
      const first = {
        id: randomUUID(),
        roomId: channel.id,
        projectId: "agents-project",
        name: "draft.txt",
        path: "files/draft.txt",
        mimeType: "text/plain",
        type: "localFile" as const,
        sizeBytes: 5,
      };
      test.store.stageAttachment(first, Buffer.from("draft"));
      expect(test.store.stagedAttachment(first.id)?.toString()).toBe("draft");
      test.store.claimAttachments([first.id]);
      expect(test.store.stagedAttachment(first.id)).toBeNull();
      expect(test.store.attachment(first.id)).toEqual(first);

      const second = { ...first, id: randomUUID(), name: "discard.txt" };
      test.store.stageAttachment(second, Buffer.from("discard"));
      expect(
        test.store.expiredAttachments(Date.now() + 1).map(({ id }) => id),
      ).toContain(second.id);
      test.store.discardAttachment(second.id);
      expect(test.store.stagedAttachment(second.id)).toBeNull();
      expect(() => test.store.attachment(second.id)).toThrow(
        "Attachment not found.",
      );
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("maps published files to their channel messages newest first", async () => {
    const test = await setup();
    try {
      const channel = room();
      test.store.putRoom(channel);
      const first = {
        id: randomUUID(),
        roomId: channel.id,
        projectId: "agents-project",
        name: "first.csv",
        path: "files/first.csv",
        mimeType: "text/csv",
        type: "localFile" as const,
        sizeBytes: 12,
      };
      const second = {
        ...first,
        id: randomUUID(),
        name: "second.png",
        path: "files/second.png",
        mimeType: "image/png",
        type: "localImage" as const,
      };
      test.store.stageAttachment(first, Buffer.from("first output"));
      test.store.claimAttachments([first.id]);
      test.store.putMessage({
        ...message(channel, 1),
        attachments: [first],
      });
      test.store.stageAttachment(second, Buffer.from("second output"));
      test.store.claimAttachments([second.id]);
      const publisherId = randomUUID();
      test.store.putMessage({
        ...message(channel, 2),
        agentId: publisherId,
        speaker: "Atlas",
        attachments: [second],
      });

      expect(new ChannelData(test.store).files(channel.id)).toEqual({
        files: [
          {
            attachment: second,
            messageId: "message-2",
            agentId: publisherId,
            publisher: "Atlas",
            createdAt: 2,
          },
          {
            attachment: first,
            messageId: "message-1",
            agentId: null,
            publisher: "You",
            createdAt: 1,
          },
        ],
        nextBefore: null,
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("uses compare-and-swap for channel context and records its history", async () => {
    const test = await setup();
    try {
      const channel = room();
      test.store.putRoom(channel);
      const data = new ChannelData(test.store);
      expect(data.context(channel.id)).toEqual({
        brief: "",
        decisions: "",
        memory: "",
        attachmentIds: [],
        version: 0,
        updatedAt: 0,
      });

      const first = data.saveContext(
        channel.id,
        {
          brief: "Initial brief",
          decisions: "",
          memory: "",
          attachmentIds: [],
        },
        0,
        "You",
      );
      expect(first).toMatchObject({ brief: "Initial brief", version: 1 });
      expect(() =>
        data.saveContext(
          channel.id,
          {
            brief: "Stale",
            decisions: "",
            memory: "",
            attachmentIds: [],
          },
          0,
          "You",
        ),
      ).toThrow("Channel context changed. Reload before saving");

      const second = data.saveContext(
        channel.id,
        {
          brief: "Updated brief",
          decisions: "Ship it",
          memory: "",
          attachmentIds: [],
        },
        first.version,
        "Owner",
      );
      expect(second).toMatchObject({
        brief: "Updated brief",
        decisions: "Ship it",
        version: 2,
      });
      const history = data.revisions(`channel:${channel.id}`);
      expect(history).toHaveLength(3);
      expect(history[0]).toMatchObject({ actor: "Owner" });
      expect(JSON.parse(history[0]!.text)).toMatchObject({ version: 2 });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("requires responseBehavior on every persisted room", async () => {
    const test = await setup();
    try {
      const invalid = { ...room(), responseBehavior: undefined } as unknown as Room;
      expect(() => test.store.putRoom(invalid)).toThrow();
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("reads a legacy everyone channel as Automatic", async () => {
    const test = await setup();
    try {
      const legacy = {
        ...room(),
        responseBehavior: "everyone",
      };
      test.store.db
        .prepare("INSERT INTO rooms(id, json) VALUES (?, ?)")
        .run(legacy.id, JSON.stringify(legacy));
      expect(test.store.room(legacy.id).responseBehavior).toBe("smart");
      expect(
        test.store.rooms().find((candidate) => candidate.id === legacy.id)
          ?.responseBehavior,
      ).toBe("smart");
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("removes channel membership when deleting an agent without messages", async () => {
    const test = await setup();
    try {
      const profile = (await test.harness.behavior.callRpc(
        "saveProfile",
        profileInput,
      )) as Profile;
      const channel = room([profile.id]);
      test.store.putRoom(channel);

      await expect(
        test.harness.behavior.callRpc("deleteProfile", { id: profile.id }),
      ).resolves.toEqual({ ok: true });
      expect(test.store.room(channel.id).memberIds).toEqual([]);
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("guards authored channel history while retirement removes membership", async () => {
    const test = await setup();
    try {
      const profile = (await test.harness.behavior.callRpc(
        "saveProfile",
        profileInput,
      )) as Profile;
      const channel = room([profile.id]);
      test.store.putRoom(channel);
      test.store.putMessage({
        ...message(channel, 20),
        agentId: profile.id,
        speaker: profile.name,
      });

      await expect(
        test.harness.behavior.callRpc("deleteProfile", { id: profile.id }),
      ).rejects.toThrow("Retire this agent instead.");
      await expect(
        test.harness.behavior.callRpc("retireAgent", {
          id: profile.id,
          retired: true,
        }),
      ).resolves.toMatchObject({
        id: profile.id,
        retired: true,
        paused: true,
      });
      expect(test.store.room(channel.id).memberIds).toEqual([]);
      expect(test.store.message("message-20")).toMatchObject({
        agentId: profile.id,
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });
});
