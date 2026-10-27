import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { rpcContract, type Profile } from "../contract";
import { messageSchema, type Job, type Room } from "./contract";
import type { ChannelContext } from "./workspace-contract";
import { Store } from "./store";

const profileInput = {
  name: "Channel Agent",
  slug: "channel-agent",
  description: "Works in channels",
  avatar: "🤖",
  modelMode: "pinned" as const,
  level: "medium" as const,
  providerId: "hempi",
  model: "openai-codex/gpt-6-sol",
  reasoningLevel: "medium" as const,
  serviceTier: "default" as const,
  permissionMode: "auto" as const,
  instructions: "",
  skillIds: [],
  mcpServerIds: [],
  isDefault: false,
};

type CrossPluginRpc = (call: {
  pluginId: string;
  method: string;
  input?: unknown;
}) => Promise<unknown> | unknown;

async function setup(
  settings?: { defaultResponseBehavior?: string },
  crossPluginRpc?: CrossPluginRpc,
) {
  const fileRead = vi.fn();
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
    settings,
    agentSkillIds: ["agents"],
    sdk: {
      plugins: {
        callRpc: async (call: {
          pluginId: string;
          method: string;
          input?: unknown;
        }) => {
          if (call.pluginId === "status-sidebar") {
            if (crossPluginRpc) return crossPluginRpc(call);
            throw new Error("Plugin status-sidebar is not running");
          }
          if (call.pluginId === "pages") {
            if (crossPluginRpc) return crossPluginRpc(call);
            throw new Error("Plugin pages is not running");
          }
          if (
            call.method === "setGlobalAgent" ||
            call.method === "removeAgent" ||
            call.method === "setProjectAgent"
          )
            return { ok: true };
          if (call.method === "agentAssignments")
            return { global: true, projectIds: [] };
          throw new Error(`Unexpected Projects RPC: ${call.method}`);
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
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: "cdp_dbt",
          kind: "standard",
          sources: [],
        }) as never,
      },
      providers: {
        models: async () => ({ models: [
          { model: "openai-codex/gpt-6-sol", displayName: "GPT 6 Sol",
            supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
            defaultReasoningEffort: "medium", isDefault: true },
        ] }) as never,
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, environmentId: "fixed-env", providerId: "agents" }),
      },
      environments: {
        get: async () => ({
          id: "fixed-env",
          projectId: "fixed-project",
          hostId: "fixed-host",
          path: "/work/cdp_dbt",
        }) as never,
      },
      files: {
        read: fileRead,
      },
    },
  });
  await plugin(host.bb);
  const store = await Store.create(host.bb, host.bb.storage.database());
  await store.ensureProject();
  return { ...host, store, fileRead };
}

async function saveAgent(harness: FakePluginHarness) {
  return harness.behavior.callRpc("saveProfile", profileInput) as Promise<Profile>;
}

async function createRoom(
  harness: FakePluginHarness,
  memberIds: string[] = [],
  name = "Channel test",
) {
  return harness.behavior.callRpc("createRoom", {
    name,
    memberIds,
    requestId: randomUUID(),
  }) as Promise<Room>;
}

function activateChannelJob(
  store: Store,
  agent: Profile,
  room: Room,
  threadId: string,
) {
  store.putConversation({
    id: randomUUID(),
    agentId: agent.id,
    key: `group:${room.id}`,
    threadId,
    title: room.name,
    kind: "group",
    createdAt: Date.now(),
  });
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    agentId: agent.id,
    conversationKey: `group:${room.id}`,
    threadId,
    text: "Current channel request",
    status: "running",
    reply: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    dispatchStartedAt: now,
    roomId: room.id,
    runId: randomUUID(),
    triggerMessageId: randomUUID(),
    depth: 0,
    attachments: [],
    outputAttachments: [],
  };
  store.enqueue(job);
  return job;
}

function markMessageJobRunning(
  store: Store,
  agent: Profile,
  room: Room,
  messageId: string,
  threadId: string,
) {
  const job = store.job(`${messageId}:${agent.id}`);
  if (!job) throw new Error("Expected the sent message to create a job.");
  store.putConversation({
    id: randomUUID(),
    agentId: agent.id,
    key: job.conversationKey,
    threadId,
    title: room.name,
    kind: "group",
    createdAt: Date.now(),
  });
  store.putJob({
    ...job,
    threadId,
    status: "running",
    startedAt: Date.now(),
  });
  return store.job(job.id)!;
}

describe("channel RPC and tools", () => {
  it("rejects a stale Decisions save and preserves the current version", async () => {
    const test = await setup();
    try {
      const room = await createRoom(test.harness);
      const initial = await test.harness.behavior.callRpc("channelContext", {
        id: room.id,
      }) as ChannelContext;
      const saved = await test.harness.behavior.callRpc("saveChannelContext", {
        id: room.id,
        version: initial.version,
        brief: initial.brief,
        decisions: "Use CSV.",
        memory: initial.memory,
        attachmentIds: initial.attachmentIds,
      }) as ChannelContext;

      await expect(
        test.harness.behavior.callRpc("saveChannelContext", {
          id: room.id,
          version: initial.version,
          brief: initial.brief,
          decisions: "Use JSON.",
          memory: initial.memory,
          attachmentIds: initial.attachmentIds,
        }),
      ).rejects.toThrow("Channel context changed. Reload before saving");
      await expect(
        test.harness.behavior.callRpc("channelContext", { id: room.id }),
      ).resolves.toMatchObject({
        decisions: "Use CSV.",
        version: saved.version,
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("persists Automatic by default and accepts both current modes", async () => {
    const test = await setup();
    try {
      const automatic = await createRoom(test.harness);
      expect(automatic.responseBehavior).toBe("smart");

      await test.harness.behavior.setSettings({
        defaultResponseBehavior: "directed",
      });
      const directed = await createRoom(
        test.harness,
        [],
        "Directed channel",
      );
      expect(directed.responseBehavior).toBe("directed");

      await expect(test.harness.behavior.callRpc("createRoom", {
        name: "Automatic channel",
        memberIds: [],
        requestId: randomUUID(),
        responseBehavior: "smart",
      })).resolves.toMatchObject({ responseBehavior: "smart" });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("maps a remembered legacy everyone default to Automatic", async () => {
    const test = await setup({ defaultResponseBehavior: "everyone" });
    try {
      await expect(createRoom(test.harness)).resolves.toMatchObject({
        responseBehavior: "smart",
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("keeps a channel conversation bound to its agent across pin and level changes", async () => {
    const { harness, store } = await setup();
    try {
      const agent = await saveAgent(harness);
      store.putConversation({
        id: "conversation-1", agentId: agent.id, key: "group:room-1", threadId: "hidden-1",
        title: "Room", kind: "group", createdAt: 1,
      });
      await harness.behavior.callRpc("saveProfile", {
        ...profileInput, id: agent.id, modelMode: "level", level: "high",
      });
      expect(store.byThread("hidden-1")?.agentId).toBe(agent.id);
      expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("round-trips an RPC send through the transcript", async () => {
    const test = await setup();
    try {
      const room = await createRoom(test.harness);
      const requestId = randomUUID();
      const sent = await test.harness.behavior.callRpc("send", {
        id: room.id,
        text: "Review the release note.",
        attachmentIds: [],
        replyTo: null,
        requestId,
      });
      expect(sent).toMatchObject({
        id: requestId,
        roomId: room.id,
        agentId: null,
        speaker: "You",
        text: "Review the release note.",
      });
      const transcript = await test.harness.behavior.callRpc("transcript", {
        id: room.id,
      }) as { messages: Array<{ id: string; text: string }> };
      expect(transcript.messages).toContainEqual(
        expect.objectContaining({ id: requestId, text: "Review the release note." }),
      );
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("reports a deleted channel and a vanished cursor as data, not errors", async () => {
    const test = await setup();
    try {
      const room = await createRoom(test.harness);
      const missingId = randomUUID();
      await expect(
        test.harness.behavior.callRpc("room", { id: missingId }),
      ).resolves.toEqual({ missing: "channel" });
      await expect(
        test.harness.behavior.callRpc("transcript", { id: missingId }),
      ).resolves.toEqual({ missing: "channel" });
      await expect(
        test.harness.behavior.callRpc("transcript", { id: room.id, around: randomUUID() }),
      ).resolves.toEqual({ missing: "message" });
      expect(
        rpcContract.room.output.parse(
          await test.harness.behavior.callRpc("room", { id: room.id }),
        ),
      ).toMatchObject({ room: { id: room.id } });

      await test.harness.behavior.callRpc("deleteRoom", { id: room.id });
      await expect(
        test.harness.behavior.callRpc("room", { id: room.id }),
      ).resolves.toEqual({ missing: "channel" });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("binds tool identity to threadId and blocks a duplicate current-channel send", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const source = await createRoom(test.harness, [agent.id], "Source channel");
      const target = await createRoom(test.harness, [agent.id], "Target channel");
      const threadId = "channel-agent-thread";
      activateChannelJob(test.store, agent, source, threadId);

      await expect(test.harness.behavior.callAgentTool(
        "channel_send",
        {
          id: source.id,
          text: "Duplicate final answer",
          attachmentIds: [],
          replyTo: null,
          requestId: randomUUID(),
        },
        { threadId, projectId: "project-1" },
      )).rejects.toThrow("final answer is posted to this channel automatically");

      const requestId = randomUUID();
      await test.harness.behavior.callAgentTool(
        "channel_send",
        {
          id: target.id,
          text: "Cross-channel request",
          attachmentIds: [],
          replyTo: null,
          requestId,
        },
        { threadId, projectId: "project-1" },
      );
      const transcript = await test.harness.behavior.callRpc("transcript", {
        id: target.id,
      }) as { messages: Array<{ id: string; agentId: string | null; speaker: string }> };
      expect(transcript.messages).toContainEqual(
        expect.objectContaining({
          id: requestId,
          agentId: agent.id,
          speaker: agent.name,
        }),
      );
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("refuses to publish a path outside the calling agent home", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const room = await createRoom(test.harness, [agent.id]);
      const threadId = "publishing-agent-thread";
      activateChannelJob(test.store, agent, room, threadId);

      await expect(test.harness.behavior.callAgentTool(
        "channel_publish_file",
        { path: "/tmp/outside-agent-home.txt" },
        { threadId, projectId: "project-1" },
      )).rejects.toThrow("inside your agent home");
      expect(test.fileRead).not.toHaveBeenCalled();
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("reads fixed-project channel files from the child environment's machine", async () => {
    const test = await setup();
    try {
      const agent = await test.harness.behavior.callRpc("saveProfile", {
        ...profileInput,
        runProjectId: "fixed-project",
      }) as Profile;
      const room = await createRoom(test.harness, [agent.id]);
      const threadId = "fixed-project-agent-thread";
      activateChannelJob(test.store, agent, room, threadId);

      await expect(test.harness.behavior.callAgentTool(
        "channel_publish_file",
        { path: "/tmp/outside-workspace.txt" },
        { threadId, projectId: "fixed-project" },
      )).rejects.toThrow("inside your project workspace");
      expect(test.fileRead).not.toHaveBeenCalled();

      test.fileRead.mockRejectedValueOnce(new Error("file read reached target machine"));
      await expect(test.harness.behavior.callAgentTool(
        "channel_publish_file",
        { path: "/work/cdp_dbt/report.csv" },
        { threadId, projectId: "fixed-project" },
      )).rejects.toThrow("file read reached target machine");
      expect(test.fileRead).toHaveBeenCalledWith({
        hostId: "fixed-host",
        path: "/work/cdp_dbt/report.csv",
        rootPath: "/work/cdp_dbt",
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("loads version-pinned page summaries through the Pages plugin", async () => {
    const pageId = "123e4567-e89b-42d3-a456-426614174000";
    const versionId = "123e4567-e89b-42d3-a456-426614174001";
    const getPage = vi.fn((call: Parameters<CrossPluginRpc>[0]) => {
      expect(call).toMatchObject({
        pluginId: "pages",
        method: "getPage",
        input: { pageId, versionId },
      });
      return {
        page: { id: pageId, title: "PR #36 review", producer: "pr-review" },
        version: {
          id: versionId,
          n: 2,
          createdAt: "2026-09-23T12:00:00.000Z",
        },
      };
    });
    const test = await setup(undefined, getPage);
    try {
      await expect(test.harness.behavior.callRpc("artifactSummaries", {
        references: [{ id: pageId, revision: versionId }],
      })).resolves.toEqual([{
        id: pageId,
        revision: versionId,
        available: true,
        title: "PR #36 review",
        kind: "pr-review",
        sequence: 2,
        revisionCreatedAt: "2026-09-23T12:00:00.000Z",
      }]);
      expect(getPage).toHaveBeenCalledOnce();
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("returns unavailable summaries when the Pages plugin is missing", async () => {
    const test = await setup();
    const reference = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      revision: "123e4567-e89b-42d3-a456-426614174001",
    };
    try {
      await expect(test.harness.behavior.callRpc("artifactSummaries", {
        references: [reference],
      })).resolves.toEqual([{ ...reference, available: false }]);
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("serves staged attachments and exposes full channel tools only to managed work", async () => {
    const test = await setup();
    try {
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
      const room = await createRoom(test.harness);
      const attachment = await test.harness.behavior.callRpc("upload", {
        id: room.id,
        name: "preview.png",
        mimeType: "text/plain",
        data: png.toString("base64"),
      }) as { id: string };
      const response = await test.harness.behavior.fetchHttp(
        "GET",
        `/attachment?id=${attachment.id}&inline=1`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-disposition")).toContain("inline");

      const ordinary = await test.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ thread: { id: "ordinary-thread" } }),
      );
      expect(ordinary.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "channel_list",
          "channel_create",
          "channel_send",
          "delegate_agent_profile",
        ]),
      );
      expect(ordinary.tools.map((tool) => tool.name)).not.toContain(
        "channel_publish_file",
      );
      expect(ordinary.skills).toEqual([]);

      const agent = await saveAgent(test.harness);
      const managedRoom = await createRoom(test.harness, [agent.id], "Managed");
      activateChannelJob(test.store, agent, managedRoom, "managed-thread");
      const managed = await test.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ thread: { id: "managed-thread" } }),
      );
      expect(managed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "channel_context",
          "channel_publish_image",
          "channel_publish_file",
          "agent_document_read",
          "agent_persona_update",
        ]),
      );
      expect(managed.skills).toEqual(["agents"]);
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });
  it("returns ordered channel summaries with unread and active state", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const pinned = await createRoom(test.harness, [agent.id], "Pinned unread");
      const routing = await createRoom(test.harness, [], "Routing");
      const executing = await createRoom(test.harness, [], "Executing");
      const archived = await createRoom(test.harness, [], "Archived");

      test.store.putRoom({
        ...pinned,
        pinned: true,
        lastReadAt: 10,
        updatedAt: 100,
      });
      test.store.putRoom({ ...routing, lastReadAt: 300, updatedAt: 300 });
      test.store.putRoom({ ...executing, updatedAt: 200 });
      test.store.putRoom({ ...archived, archived: true, updatedAt: 400 });
      test.store.putRun({
        id: randomUUID(),
        roomId: routing.id,
        status: "queued",
        pendingJobIds: [],
        settledJobIds: [],
        round: 0,
        remaining: [],
        next: [],
        jobId: null,
        createdAt: 1,
        error: null,
        routing: "pending",
      });
      activateChannelJob(test.store, agent, executing, "summary-active-thread");

      await expect(
        test.harness.behavior.callRpc("channelSummaries", null),
      ).resolves.toEqual([
        {
          id: pinned.id,
          name: "Pinned unread",
          pinned: true,
          unread: true,
          active: false,
          memberCount: 1,
          updatedAt: 100,
        },
        {
          id: routing.id,
          name: "Routing",
          pinned: false,
          unread: false,
          active: true,
          memberCount: 0,
          updatedAt: 300,
        },
        {
          id: executing.id,
          name: "Executing",
          pinned: false,
          unread: true,
          active: true,
          memberCount: 0,
          updatedAt: 200,
        },
      ]);
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("debounces summary nudges and skips changes outside the summary", async () => {
    const nudges = vi.fn(async (_input: unknown) => ({ ok: true }));
    const test = await setup(undefined, ({ method, input }) => {
      if (method !== "channelsChanged")
        throw new Error(`Unexpected status-sidebar RPC: ${method}`);
      return nudges(input);
    });
    vi.useFakeTimers();
    try {
      const room = await createRoom(test.harness);
      await test.harness.behavior.callRpc("channelState", {
        id: room.id,
        pinned: true,
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(nudges).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(nudges).toHaveBeenCalledTimes(1);
      expect(nudges).toHaveBeenLastCalledWith({
        channels: [expect.objectContaining({ id: room.id, pinned: true })],
      });

      const sent = await test.harness.behavior.callRpc("send", {
        id: room.id,
        text: "Review this.",
        attachmentIds: [],
        replyTo: null,
        requestId: randomUUID(),
      }) as { id: string };
      // Your own message moves only updatedAt, which no sidebar row shows.
      await vi.advanceTimersByTimeAsync(500);
      expect(nudges).toHaveBeenCalledTimes(1);

      await test.harness.behavior.callRpc("reaction", {
        id: room.id,
        messageId: sent.id,
        emoji: "👍",
        active: true,
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(nudges).toHaveBeenCalledTimes(1);
    } finally {
      await test.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("tolerates a missing status-sidebar and logs it once", async () => {
    const calls: string[] = [];
    const test = await setup(undefined, ({ method }) => {
      calls.push(method);
      throw new Error("Plugin status-sidebar is not running");
    });
    vi.useFakeTimers();
    try {
      const room = await createRoom(test.harness);
      await vi.advanceTimersByTimeAsync(500);
      await test.harness.behavior.callRpc("channelState", {
        id: room.id,
        pinned: true,
      });
      await vi.advanceTimersByTimeAsync(500);

      expect(calls).toEqual(["channelsChanged", "channelsChanged"]);
      expect(
        test.harness.inspection.logEntries.filter(
          (entry) =>
            entry.level === "debug" &&
            entry.message.includes("status-sidebar is unavailable"),
        ),
      ).toHaveLength(1);
    } finally {
      await test.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("accepts every send mode and limits agent tools to auto and fork", async () => {
    const test = await setup();
    try {
      const room = await createRoom(test.harness);
      for (const mode of ["auto", "steer", "followup", "fork"] as const) {
        const sent = messageSchema.parse(
          await test.harness.behavior.callRpc("send", {
            id: room.id,
            text: `Message using ${mode}`,
            attachmentIds: [],
            replyTo: null,
            requestId: randomUUID(),
            sendMode: mode,
          }),
        );
        expect(sent.sendMode).toBe(mode === "auto" ? undefined : mode);
      }

      await expect(
        test.harness.behavior.callAgentTool(
          "channel_send",
          {
            id: room.id,
            text: "Do not let an agent steer",
            attachmentIds: [],
            replyTo: null,
            requestId: randomUUID(),
            sendMode: "steer",
          },
          { threadId: "ordinary-thread", projectId: "project-1" },
        ),
      ).rejects.toThrow();
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("converts a queued job into a steer through the RPC", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const room = await createRoom(test.harness, [agent.id]);
      const first = messageSchema.parse(
        await test.harness.behavior.callRpc("send", {
          id: room.id,
          text: "@channel-agent Start the review",
          attachmentIds: [],
          replyTo: null,
          requestId: randomUUID(),
          sendMode: "auto",
        }),
      );
      const running = markMessageJobRunning(
        test.store,
        agent,
        room,
        first.id,
        "running-steer-thread",
      );
      test.harness.inspection.sdk.stub(
        "threads.send",
        async () => ({ ok: true, delivery: "sent" }) as never,
      );
      const second = messageSchema.parse(
        await test.harness.behavior.callRpc("send", {
          id: room.id,
          text: "@channel-agent Use the new requirements",
          attachmentIds: [],
          replyTo: null,
          requestId: randomUUID(),
          sendMode: "auto",
        }),
      );
      const queuedId = `${second.id}:${agent.id}`;
      const page = rpcContract.room.output.parse(
        await test.harness.behavior.callRpc("room", { id: room.id }),
      );
      if ("missing" in page) throw new Error("Expected the channel to exist.");
      expect(page.jobs.find((job) => job.id === queuedId)).toMatchObject({
        status: "queued",
        queueCanSteer: true,
        queueCanFork: true,
      });

      await expect(
        test.harness.behavior.callRpc("queuedJobAction", {
          jobId: queuedId,
          action: "steer",
        }),
      ).resolves.toEqual({ status: "steered", jobId: running.id });
      expect(test.store.job(queuedId)?.status).toBe("cancelled");
      expect(test.store.job(running.id)?.triggerMessageId).toBe(second.id);
      expect(
        test.harness.inspection.sdk.callsTo("threads.send").at(-1)?.[0],
      ).toMatchObject({ threadId: running.threadId, mode: "steer" });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("converts a queued job into a hidden fork through the RPC", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const room = await createRoom(test.harness, [agent.id]);
      const first = messageSchema.parse(
        await test.harness.behavior.callRpc("send", {
          id: room.id,
          text: "@channel-agent Start the review",
          attachmentIds: [],
          replyTo: null,
          requestId: randomUUID(),
        }),
      );
      const running = markMessageJobRunning(
        test.store,
        agent,
        room,
        first.id,
        "running-fork-thread",
      );
      test.harness.inspection.sdk.stub("providers.list", async () =>
        [{
          id: "agents",
          capabilities: { supportsFork: true },
        }] as never
      );
      test.harness.inspection.sdk.stub(
        "threads.fork",
        async () => makeThreadResponse({ id: "parallel-thread", status: "active" }),
      );
      const second = messageSchema.parse(
        await test.harness.behavior.callRpc("send", {
          id: room.id,
          text: "@channel-agent Check this separately",
          attachmentIds: [],
          replyTo: null,
          requestId: randomUUID(),
        }),
      );
      const queuedId = `${second.id}:${agent.id}`;

      await expect(
        test.harness.behavior.callRpc("queuedJobAction", {
          jobId: queuedId,
          action: "fork",
        }),
      ).resolves.toEqual({ status: "forked", jobId: queuedId });
      expect(test.store.job(queuedId)).toMatchObject({
        status: "running",
        forkSourceThreadId: running.threadId,
        threadId: "parallel-thread",
      });
      expect(
        test.harness.inspection.sdk.callsTo("threads.fork").at(-1)?.[0],
      ).toMatchObject({
        sourceThreadId: running.threadId,
        visibility: "hidden",
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });

  it("sends queued work normally when the target is no longer busy", async () => {
    const test = await setup();
    try {
      const agent = await saveAgent(test.harness);
      const room = await createRoom(test.harness, [agent.id]);
      test.harness.inspection.sdk.stub(
        "threads.spawn",
        async () => makeThreadResponse({ id: "normal-thread", status: "active" }),
      );
      const sent = messageSchema.parse(
        await test.harness.behavior.callRpc("send", {
          id: room.id,
          text: "@channel-agent Start now",
          attachmentIds: [],
          replyTo: null,
          requestId: randomUUID(),
        }),
      );
      const jobId = `${sent.id}:${agent.id}`;

      await expect(
        test.harness.behavior.callRpc("queuedJobAction", {
          jobId,
          action: "steer",
        }),
      ).resolves.toEqual({ status: "sent", jobId });
      expect(test.store.job(jobId)).toMatchObject({
        status: "running",
        threadId: "normal-thread",
      });
    } finally {
      await test.harness.lifecycle.dispose();
    }
  });
});
