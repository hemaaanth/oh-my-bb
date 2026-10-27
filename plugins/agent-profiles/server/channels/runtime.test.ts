import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import type { Profile } from "../contract";
import { createProfiles, snapshot } from "../profiles";
import type { Attachment, Job, Room, RoomRun } from "./contract";
import { jobPrompt, passReply, Runtime } from "./runtime";
import { Store } from "./store";

const profileInput = (name: string) => ({
  name,
  slug: name.toLowerCase(),
  description: `${name} channel agent`,
  avatar: "🤖",
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "medium" as const,
  serviceTier: "fast" as const,
  permissionMode: "auto" as const,
  instructions: `${name} persona`,
  skillIds: [],
  mcpServerIds: [],
  isDefault: false,
});

const room = (
  memberIds: string[],
  responseBehavior: Room["responseBehavior"] = "directed",
): Room => ({
  id: randomUUID(),
  name: "Runtime",
  memberIds,
  responseBehavior,
  paused: false,
  createdAt: 1,
  updatedAt: 1,
});
type ListedThread = {
  id: string;
  visibility?: "hidden" | "visible";
};

type ChooseAgentInput = {
  title: string;
  conversation: Array<{
    role: "user" | "assistant";
    name: string;
    text: string;
  }>;
  candidates: Array<{
    id: string;
    name: string;
    handle: string;
    description: string;
  }>;
};
type ChooseAgentResult = {
  agentId: string | null;
  probability: number;
  confidence: number;
};


async function setup(
  route: (
    input: ChooseAgentInput,
  ) => ChooseAgentResult | Promise<ChooseAgentResult> = (input) => ({
    agentId: input.candidates[0]?.id ?? null,
    probability: 1,
    confidence: 1,
  }),
) {
  let sequence = 0;
  let listedThreads: ListedThread[] = [];
  const statusByThread = new Map<string, "active" | "error" | "idle" | "pending">();
  const projectByThread = new Map<string, string>();
  const promptByThread = new Map<string, string>();
  const outputByThread = new Map<string, string>();
  const metadataByThread = new Map<string, Record<string, unknown>>();
  const queuedByThread = new Map<string, Array<{ id: string; content: never[] }>>();
  const chooseAgent = vi.fn(route);
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
        create: async () => ({ id: "agents-project" }) as never,
        get: async ({ projectId }) => ({ id: projectId, name: projectId }) as never,
        attachments: {
          copy: async () => {},
        },
      },
      threads: {
        spawn: async ({ projectId }) => {
          const id = `thread-${++sequence}`;
          statusByThread.set(id, "idle");
          projectByThread.set(id, projectId);
          return makeThreadResponse({ id, projectId, status: "idle" });
        },
        send: async () => ({ ok: true, delivery: "sent" }) as never,
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            providerId: "agents",
            status: statusByThread.get(threadId) ?? "idle",
            projectId: projectByThread.get(threadId) ?? "agents-project",
          }),
        list: async () => listedThreads as never,
        getPluginMetadata: async ({ threadId }) =>
          metadataByThread.get(threadId) ?? {},
        timeline: async ({ threadId }) => ({
          rows: promptByThread.has(threadId)
            ? [
                {
                  kind: "conversation",
                  role: "user",
                  text: promptByThread.get(threadId),
                },
              ]
            : [],
        }) as never,
        output: async ({ threadId }) => ({
          output: outputByThread.get(threadId) ?? null,
        }),
        stop: async () => ({ ok: true }),
        queuedMessages: {
          list: async ({ threadId }) => queuedByThread.get(threadId) ?? [],
          delete: async ({ threadId, queuedMessageId }) => {
            queuedByThread.set(
              threadId,
              (queuedByThread.get(threadId) ?? []).filter(
                (entry) => entry.id !== queuedMessageId,
              ),
            );
            return { ok: true };
          },
        },
      },
    },
  });
  await plugin(host.bb);
  const store = await Store.create(host.bb, host.bb.storage.database());
  const resolveExecution = vi.fn(async (profile: Profile) => ({
    providerId: "agents",
    model: `agent/${profile.id}`,
    reasoningLevel: profile.reasoningLevel,
    family: "codex" as const,
    reason: "test resolver",
  }));
  await store.ensureProject();
  const profiles = await createProfiles(
    host.bb,
    host.bb.storage.database(),
    store,
    {
      resolveAgent: resolveExecution,
      preview: async () => {
        throw new Error("Preview is not used by runtime tests.");
      },
    },
  );
  const atlas = (await host.harness.behavior.callRpc(
    "saveProfile",
    profileInput("Atlas"),
  )) as Profile;
  const scribe = (await host.harness.behavior.callRpc(
    "saveProfile",
    profileInput("Scribe"),
  )) as Profile;
  await store.setPaused(atlas.id, false);
  await store.setPaused(scribe.id, false);
  const runtime = new Runtime(host.bb, store, profiles);
  runtime.chooseAgent = async (input) => chooseAgent(input);

  const startService = async () => {
    const service = host.harness.behavior.runService("channels");
    await delay(100);
    service.controller.abort();
    await service.done;
  };
  const close = async () => {
    await runtime.dispose();
    await host.harness.lifecycle.dispose();
  };

  return {
    ...host,
    store,
    profiles,
    runtime,
    resolveExecution,
    atlas: store.get(atlas.id),
    scribe: store.get(scribe.id),
    statusByThread,
    promptByThread,
    outputByThread,
    metadataByThread,
    queuedByThread,
    chooseAgent,
    setListedThreads(threads: ListedThread[]) {
      listedThreads = threads;
    },
    startService,
    close,
  };
}

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((entry) => entry.close()));
  vi.restoreAllMocks();
});

async function trackedSetup(
  route?: (
    input: ChooseAgentInput,
  ) => ChooseAgentResult | Promise<ChooseAgentResult>,
) {
  const value = await setup(route);
  open.push(value);
  return value;
}

describe("channel dispatch policy", () => {
  it("keeps bound threads unblocked and applies registration, prompt, and busy checks in order", async () => {
    const x = await trackedSetup();
    await x.startService();
    const hook = x.harness.inspection.registrations.hooks["message.dispatch"]!;

    x.store.putConversation({
      id: "busy-conversation",
      agentId: x.atlas.id,
      key: "mission",
      threadId: "busy-thread",
      title: "Mission",
      kind: "mission",
      createdAt: 1,
    });
    await x.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "busy-thread", status: "active" }),
    });
    x.store.db
      .prepare(`INSERT INTO thread_bindings
        (thread_id, profile_id, revision, parent_thread_id, environment_id, created_at)
        VALUES (?, ?, ?, NULL, NULL, ?)`)
      .run(
        "bound-thread",
        x.atlas.id,
        x.profiles.getProfile(x.atlas.id).revision,
        new Date().toISOString(),
      );

    expect(
      await hook(
        makeMessageDispatchHookContext({
          thread: { id: "bound-thread", originPluginId: "agent-profiles" },
        }),
      ),
    ).toEqual({ action: "proceed" });

    const before = Date.now();
    const registration = await hook(
      makeMessageDispatchHookContext({
        thread: { id: "unregistered", originPluginId: "agent-profiles" },
      }),
    );
    expect(registration).toMatchObject({
      action: "wait",
      reason: "Registering agent conversation.",
    });
    expect(
      "sendAt" in registration ? registration.sendAt : 0,
    ).toBeGreaterThanOrEqual(before + 1_500);

    const channel = room([x.atlas.id]);
    x.store.putRoom(channel);
    x.store.putConversation({
      id: "channel-conversation",
      agentId: x.atlas.id,
      key: `group:${channel.id}`,
      threadId: "channel-thread",
      title: channel.name,
      kind: "group",
      createdAt: 2,
    });
    x.runtime.enqueue(x.atlas, {
      id: "channel-job",
      text: "registered prompt",
      conversationKey: `group:${channel.id}`,
      roomId: channel.id,
      runId: "channel-run",
      threadId: "channel-thread",
      status: "running",
    });
    const job = x.store.job("channel-job")!;
    expect(
      await hook(
        makeMessageDispatchHookContext({
          thread: { id: "channel-thread" },
          input: {
            text: "different prompt",
            blocks: [{ type: "text", text: "different prompt", mentions: [] }],
          },
        }),
      ),
    ).toMatchObject({ action: "reject" });
    expect(
      await hook(
        makeMessageDispatchHookContext({
          thread: { id: "channel-thread" },
          // A first turn carries the agent-only preamble before the prompt.
          input: {
            text: `Preamble\n\n${jobPrompt(job)}`,
            blocks: [
              { type: "text", text: "Preamble", mentions: [], visibility: "agent-only" },
              { type: "text", text: jobPrompt(job), mentions: [] },
            ],
          },
        }),
      ),
    ).toMatchObject({
      action: "wait",
      reason: "Busy with mission work",
    });

    x.store.putConversation({
      id: "fork-conversation",
      agentId: x.atlas.id,
      key: `group:${channel.id}:fork:fork-message`,
      threadId: "fork-thread",
      title: channel.name,
      kind: "group",
      createdAt: 3,
    });
    x.runtime.enqueue(x.atlas, {
      id: "fork-job",
      text: "parallel prompt",
      conversationKey: `group:${channel.id}:fork:fork-message`,
      forkSourceThreadId: "busy-thread",
      roomId: channel.id,
      runId: "fork-run",
      threadId: "fork-thread",
      status: "running",
    });
    const forkJob = x.store.job("fork-job")!;
    expect(
      await hook(
        makeMessageDispatchHookContext({
          thread: { id: "fork-thread" },
          input: {
            text: jobPrompt(forkJob),
            blocks: [{ type: "text", text: jobPrompt(forkJob), mentions: [] }],
          },
        }),
      ),
    ).toEqual({ action: "proceed" });

    await x.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "fork-thread", status: "active" }),
    });
    expect(
      await hook(
        makeMessageDispatchHookContext({
          thread: { id: "channel-thread" },
          input: {
            text: jobPrompt(job),
            blocks: [{ type: "text", text: jobPrompt(job), mentions: [] }],
          },
        }),
      ),
    ).toMatchObject({
      action: "wait",
      reason: "Busy with mission work",
    });
  });

  it("settles thread.idle only when the current job prompt matches", async () => {
    const x = await trackedSetup();
    await x.startService();
    const channel = room([x.atlas.id]);
    x.store.putRoom(channel);
    x.store.putConversation({
      id: "settle-conversation",
      agentId: x.atlas.id,
      key: `group:${channel.id}`,
      threadId: "settle-thread",
      title: channel.name,
      kind: "group",
      createdAt: 1,
    });
    x.runtime.enqueue(x.atlas, {
      id: "settle-job",
      text: "current work",
      conversationKey: `group:${channel.id}`,
      roomId: channel.id,
      runId: "settle-run",
      threadId: "settle-thread",
      status: "running",
      requiresPromptMatch: true,
    });
    const job = x.store.job("settle-job")!;
    x.statusByThread.set("settle-thread", "idle");
    x.outputByThread.set("settle-thread", "Current answer");
    x.promptByThread.set("settle-thread", "older prompt");

    await x.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "settle-thread", status: "idle" }),
      lastAssistantText: "Current answer",
    });
    expect(x.store.job(job.id)?.status).toBe("running");

    x.promptByThread.set("settle-thread", jobPrompt(job));
    await x.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "settle-thread", status: "idle" }),
      lastAssistantText: "Current answer",
    });
    expect(x.store.job(job.id)).toMatchObject({
      status: "done",
      reply: "Current answer",
    });
  });
});

describe("channel runtime", () => {
  it("keeps brief, decisions, and channel memory in the agent prompt", async () => {
    const x = await trackedSetup();
    const channel = room([x.atlas.id]);
    x.store.putRoom(channel);
    x.runtime.data.saveContext(
      channel.id,
      {
        brief: "Prefer the stable API.",
        decisions: "Use CSV for the handoff.",
        memory: "The consumer runs nightly.",
        attachmentIds: [],
      },
      0,
      "You",
    );

    const sent = x.runtime.send(channel, "@atlas prepare it", randomUUID());
    await x.runtime.drive(x.atlas);
    const prompt = x.store.requestJobs(sent.id)[0]!.text;

    expect(prompt).toContain(
      "Channel brief (owner instructions):\nPrefer the stable API.",
    );
    expect(prompt).toContain(
      "Saved channel decisions:\nUse CSV for the handoff.",
    );
    expect(prompt).toContain(
      "Channel-specific memory (conversation data):\nThe consumer runs nightly.",
    );
  });

  it("dispatches exactly the one agent Jev chooses", async () => {
    const x = await trackedSetup((input) => ({
      agentId:
        input.candidates.find((candidate) => candidate.handle === "scribe")
          ?.id ?? null,
      probability: 0.82,
      confidence: 0.74,
    }));
    const channel = room([x.atlas.id, x.scribe.id], "smart");
    x.store.putRoom(channel);

    const message = x.runtime.send(channel, "Review the API design", randomUUID());
    await expect.poll(
      () =>
        x.store.runs(channel.id).find((run) => run.id === message.id)?.routing,
    ).toBe("done");

    expect(x.store.requestJobs(message.id).map((job) => job.agentId)).toEqual([
      x.scribe.id,
    ]);
    expect(x.chooseAgent).toHaveBeenCalledTimes(1);
    expect(x.chooseAgent.mock.calls[0]?.[0]).toMatchObject({
      title: "Runtime",
      conversation: [
        expect.objectContaining({
          role: "user",
          name: "You",
          text: "Review the API design",
        }),
      ],
      candidates: expect.arrayContaining([
        expect.objectContaining({
          id: x.scribe.id,
          handle: "scribe",
          description: expect.stringContaining("Persona: Scribe persona"),
        }),
      ]),
    });
    expect(
      x.store.runs(channel.id).find((run) => run.id === message.id),
    ).toMatchObject({
      routing: "done",
      routingAgentIds: [x.scribe.id],
    });
    expect(
      x.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM routing_usage WHERE room_id = ?",
        )
        .get(channel.id),
    ).toEqual({ count: 1 });
  });

  it("falls back to the member who replied most recently when Jev fails", async () => {
    const x = await trackedSetup(() => {
      throw new Error("Jev unavailable");
    });
    const channel = room([x.atlas.id, x.scribe.id], "smart");
    x.store.putRoom(channel);
    x.store.putMessage({
      id: "previous-scribe-reply",
      roomId: channel.id,
      runId: "previous-run",
      agentId: x.scribe.id,
      speaker: x.scribe.name,
      text: "Earlier context",
      createdAt: 2,
      attachments: [],
      replyTo: null,
    });

    const message = x.runtime.send(channel, "Who should handle this?", randomUUID());
    await expect.poll(
      () =>
        x.store.runs(channel.id).find((run) => run.id === message.id)?.routing,
    ).toBe("done");

    expect(x.store.requestJobs(message.id).map((job) => job.agentId)).toEqual([
      x.scribe.id,
    ]);
    expect(
      x.store.runs(channel.id).find((run) => run.id === message.id),
    ).toMatchObject({
      routingAgentIds: [x.scribe.id],
      routingError: expect.stringContaining(
        "Automatic routing fell back to @scribe: Jev failed: Jev unavailable",
      ),
    });
  });

  it("falls back to the first member before any agent has replied", async () => {
    const x = await trackedSetup(() => {
      throw new Error("Jev is not running");
    });
    const channel = room([x.atlas.id, x.scribe.id], "smart");
    x.store.putRoom(channel);

    const message = x.runtime.send(channel, "Take this request", randomUUID());
    await expect.poll(
      () =>
        x.store.runs(channel.id).find((run) => run.id === message.id)?.routing,
    ).toBe("done");

    expect(x.store.requestJobs(message.id).map((job) => job.agentId)).toEqual([
      x.atlas.id,
    ]);
  });

  it("skips Jev for an explicit mention", async () => {
    const x = await trackedSetup();
    const channel = room([x.atlas.id, x.scribe.id], "smart");
    x.store.putRoom(channel);

    const message = x.runtime.send(channel, "@atlas review", randomUUID());
    expect(x.store.requestJobs(message.id).map((job) => job.agentId)).toEqual([
      x.atlas.id,
    ]);
    expect(x.chooseAgent).not.toHaveBeenCalled();
  });

  it("dispatches nobody for an undirected Directed message", async () => {
    const x = await trackedSetup();
    const channel = room([x.atlas.id, x.scribe.id], "directed");
    x.store.putRoom(channel);

    const message = x.runtime.send(channel, "Thanks", randomUUID());
    expect(x.store.requestJobs(message.id)).toHaveLength(0);
    expect(
      x.store.runs(channel.id).find((run) => run.id === message.id)?.status,
    ).toBe("done");
    expect(x.chooseAgent).not.toHaveBeenCalled();
  });

  it("treats @all as ordinary text instead of a fan-out target", async () => {
    const x = await trackedSetup((input) => ({
      agentId: input.candidates[1]?.id ?? null,
      probability: 0.7,
      confidence: 0.8,
    }));
    const channel = room([x.atlas.id, x.scribe.id], "smart");
    x.store.putRoom(channel);

    const message = x.runtime.send(channel, "@all review", randomUUID());
    await expect.poll(
      () =>
        x.store.runs(channel.id).find((run) => run.id === message.id)?.routing,
    ).toBe("done");

    expect(x.store.requestJobs(message.id).map((job) => job.agentId)).toEqual([
      x.scribe.id,
    ]);
    expect(x.chooseAgent).toHaveBeenCalledTimes(1);
  });

  it("does not route an agent-authored message without a target", async () => {
    const x = await trackedSetup();
    const channel = room([x.atlas.id, x.scribe.id], "smart");
    x.store.putRoom(channel);

    const message = x.runtime.send(
      channel,
      "Shared for context",
      randomUUID(),
      [],
      null,
      {
        agentId: x.atlas.id,
        speaker: x.atlas.name,
        sourceThreadId: "atlas-thread",
        depth: 1,
      },
    );
    expect(x.store.requestJobs(message.id)).toHaveLength(0);
    expect(x.chooseAgent).not.toHaveBeenCalled();
  });

  it("recovers pending Automatic routing with the first-member fallback", async () => {
    const x = await trackedSetup();
    const channel = room([x.atlas.id, x.scribe.id], "smart");
    x.store.putRoom(channel);
    const requestId = randomUUID();
    x.store.putMessage({
      id: requestId,
      roomId: channel.id,
      runId: requestId,
      agentId: null,
      speaker: "You",
      text: "Recover this route",
      createdAt: 3,
      attachments: [],
      replyTo: null,
    });
    const pending: RoomRun = {
      id: requestId,
      roomId: channel.id,
      status: "running",
      mode: "concurrent",
      pendingJobIds: [],
      settledJobIds: [],
      round: 1,
      remaining: [],
      next: [],
      jobId: null,
      createdAt: 3,
      error: null,
      routing: "pending",
      routingDepth: 0,
      routingAgentIds: [],
    };
    x.store.putRun(pending);

    await x.runtime.tick();

    expect(x.store.requestJobs(requestId).map((job) => job.agentId)).toEqual([
      x.atlas.id,
    ]);
    expect(
      x.store.runs(channel.id).find((run) => run.id === requestId),
    ).toMatchObject({
      routing: "done",
      routingAgentIds: [x.atlas.id],
      routingError: expect.stringContaining("plugin restart"),
    });
    expect(x.chooseAgent).not.toHaveBeenCalled();
  });

  it("stops a run while Automatic routing is pending", async () => {
    const x = await trackedSetup(async (input) => {
      await delay(50);
      return {
        agentId: input.candidates[0]?.id ?? null,
        probability: 1,
        confidence: 1,
      };
    });
    const channel = room([x.atlas.id, x.scribe.id], "smart");
    x.store.putRoom(channel);
    const message = x.runtime.send(channel, "Route this later", randomUUID());

    await x.runtime.stopRoom(channel);
    expect(
      x.store.runs(channel.id).find((run) => run.id === message.id),
    ).toMatchObject({
      status: "stopped",
      routing: "error",
      routingAgentIds: [],
      routingError: expect.stringContaining("archived"),
    });

    await expect.poll(() =>
      x.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM routing_usage WHERE room_id = ?",
        )
        .get(channel.id)
    ).toEqual({ count: 1 });
    expect(x.store.requestJobs(message.id)).toHaveLength(0);
  });

  it("queues busy work with its reason, follows up on the canonical thread, and suppresses PASS", async () => {
    const x = await trackedSetup();
    const channel = room([x.atlas.id]);
    x.store.putRoom(channel);
    const reports: Array<{ request: string; reply: string }> = [];
    x.runtime.reportWork = ({ request, reply }) => reports.push({ request, reply });
    const firstMessage = x.runtime.send(channel, "@atlas first", randomUUID());
    await x.runtime.drive(x.atlas);
    const first = x.store.requestJobs(firstMessage.id)[0]!;
    x.runtime.busy.set(x.atlas.id, {
      threadId: first.threadId!,
      at: Date.now(),
    });

    const secondMessage = x.runtime.send(channel, "@atlas second", randomUUID());
    const second = x.store.requestJobs(secondMessage.id)[0]!;
    const visible = await x.runtime.roomJobsWithActivity(channel.id);
    expect(visible.find((job) => job.id === second.id)).toMatchObject({
      queueReason: "Busy in #Runtime",
      busyThreadId: first.threadId,
      busyConversationTitle: "Runtime",
    });

    x.runtime.complete(first.threadId!, "First answer");
    // A full agent's channel answer goes to its DM's memory.
    expect(reports).toEqual([{ request: expect.stringContaining("@atlas first"), reply: "First answer" }]);
    await x.runtime.driveRoom(channel);
    await x.runtime.drive(x.store.get(x.atlas.id));
    expect(
      x.harness.inspection.sdk.callsTo("threads.send").at(-1)?.[0],
    ).toMatchObject({ threadId: first.threadId, mode: "queue-if-active" });

    const passMessage = x.runtime.send(channel, "@atlas no reply", randomUUID());
    const pass = x.store.requestJobs(passMessage.id)[0]!;
    x.store.putJob({ ...pass, status: "done", reply: "[PASS]" });
    await x.runtime.driveRoom(channel);
    expect(x.store.messages(channel.id).some((message) => message.id === pass.id)).toBe(
      false,
    );
  });

  it("strips a trailing [PASS] from a real answer", () => {
    expect(passReply("There are seven agents here.\n\n[PASS]")).toBe(
      "There are seven agents here.",
    );
    expect(passReply(" [PASS] ")).toBe("[PASS]");
    expect(passReply("")).toBe("[PASS]");
    expect(passReply("Use [PASS] to stay silent.")).toBe("Use [PASS] to stay silent.");
  });

  it("cancels queued input and active work, and retries failed work idempotently", async () => {
    const x = await trackedSetup();
    const channel = room([x.atlas.id]);
    x.store.putRoom(channel);
    const message = x.runtime.send(channel, "@atlas work", randomUUID());
    await x.runtime.drive(x.atlas);
    const running = x.store.requestJobs(message.id)[0]!;
    x.queuedByThread.set(running.threadId!, [
      { id: "queued-message", content: [] },
    ]);

    await x.runtime.cancel(running, "Stopped by owner");
    expect(x.queuedByThread.get(running.threadId!)).toEqual([]);
    expect(x.harness.inspection.sdk.callsTo("threads.queuedMessages.delete")).toHaveLength(1);
    expect(x.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    expect(x.store.job(running.id)?.status).toBe("cancelled");

    const retryMessage = x.runtime.send(channel, "@atlas retry", randomUUID());
    const failed = x.store.requestJobs(retryMessage.id)[0]!;
    x.store.putJob({ ...failed, status: "error", error: "Provider unavailable" });
    await x.runtime.driveRoom(channel);
    const [first, second] = await Promise.all([
      x.runtime.retryJob(failed.id),
      x.runtime.retryJob(failed.id),
    ]);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ retryOf: failed.id, status: "queued" });
    expect(x.store.work(x.atlas.id).filter((job) => job.retryOf === failed.id)).toHaveLength(1);
  });

  it("keeps an agent's mission on the shared provider and enqueues one wake in its home", async () => {
    const x = await trackedSetup();
    await x.profiles.saveProfile({
      ...snapshot(x.profiles.getProfile(x.atlas.id)),
    });
    expect(x.runtime.wake(x.atlas)).toBe(true);
    expect(x.runtime.wake(x.atlas)).toBe(false);
    expect(
      x.store.work(x.atlas.id).filter((job) => job.conversationKey === "mission"),
    ).toHaveLength(1);

    await x.runtime.drive(x.store.get(x.atlas.id));
    const spawn = x.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0] as {
      projectId?: string;
      environment?: unknown;
      serviceTier?: string;
      providerId?: string;
      permissionMode?: string;
      input?: Array<{ type: string; text?: string; visibility?: string }>;
    };
    expect(spawn.projectId).toBe("agents-project");
    expect(spawn.environment).toEqual({
      type: "host",
      hostId: "host-primary",
      workspace: { type: "unmanaged", path: x.atlas.home },
    });
    expect(spawn.serviceTier).toBe("fast");
    expect(spawn.providerId).toBe("agents");
    expect(spawn.permissionMode).toBe("full");
    expect(spawn.input?.[0]).toMatchObject({
      type: "text",
      visibility: "agent-only",
    });
    expect(spawn.input?.[0]?.text).toContain("standing mission");
  });

  it("runs fixed-project channels and missions in the project default environment", async () => {
    const x = await trackedSetup();
    const current = x.profiles.getProfile(x.atlas.id);
    await x.profiles.saveProfile(
      { ...snapshot(current), runProjectId: "fixed-project" },
      current.revision,
    );
    x.store.db
      .prepare("UPDATE profiles SET home_host_id = NULL WHERE id = ?")
      .run(x.atlas.id);
    const agent = x.store.get(x.atlas.id);
    const channel = room([agent.id]);
    const attachment: Attachment = {
      id: randomUUID(),
      roomId: channel.id,
      projectId: "agents-project",
      name: "requirements.txt",
      path: "uploads/requirements.txt",
      mimeType: "text/plain",
      type: "localFile",
      sizeBytes: 42,
    };
    x.store.putRoom(channel);
    x.store.putAttachment(attachment);

    const firstMessage = x.runtime.send(
      channel,
      "@atlas review this",
      randomUUID(),
      [attachment],
    );
    await x.runtime.drive(agent);
    const firstJob = x.store.requestJobs(firstMessage.id)[0]!;
    const channelSpawn = x.harness.inspection.sdk
      .callsTo("threads.spawn")
      .at(-1)?.[0] as {
        projectId?: string;
        environment?: unknown;
        input?: Array<{ type: string; text?: string }>;
      };
    expect(channelSpawn).toMatchObject({
      projectId: "fixed-project",
      providerId: "agents",
      model: `agent/${agent.id}`,
      pluginMetadata: { role: "channel", profileId: agent.id, schemaVersion: 1, agentId: agent.id },
      environment: { type: "project-default" },
    });
    const channelInput = channelSpawn.input
      ?.map((part) => part.text ?? "")
      .join("\n") ?? "";
    expect(channelInput).toContain("## Mission");
    expect(channelInput).not.toContain("## Memory");
    expect(channelInput).not.toContain("Read MISSION.md");
    expect(
      x.harness.inspection.sdk.callsTo("projects.attachments.copy").at(-1)?.[0],
    ).toEqual({
      projectId: "fixed-project",
      sourceProjectId: "agents-project",
      paths: ["uploads/requirements.txt"],
    });

    x.runtime.complete(firstJob.threadId!, "Reviewed");
    await x.runtime.driveRoom(channel);
    expect(x.store.messages(channel.id).some((message) => message.text === "Reviewed")).toBe(true);
    expect(x.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    const followupMessage = x.runtime.send(
      channel,
      "@atlas review the update",
      randomUUID(),
      [attachment],
    );
    await x.runtime.drive(agent);
    const followup = x.store.requestJobs(followupMessage.id)[0]!;
    expect(
      x.harness.inspection.sdk.callsTo("threads.send").at(-1)?.[0],
    ).toMatchObject({
      threadId: firstJob.threadId,
      mode: "queue-if-active",
    });
    expect(
      x.harness.inspection.sdk.callsTo("projects.attachments.copy"),
    ).toHaveLength(2);

    x.runtime.complete(followup.threadId!, "Updated");
    await x.runtime.driveRoom(channel);
    expect(x.runtime.wake(agent)).toBe(true);
    await x.runtime.drive(agent);
    expect(
      x.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0],
    ).toMatchObject({
      projectId: "fixed-project",
      environment: { type: "project-default" },
    });
  });

  it("runs thin channel work in scratch without mission or memory", async () => {
    const x = await trackedSetup();
    x.store.setMissionSchedule(x.atlas.id, 30);
    expect(x.runtime.wake(x.atlas)).toBe(true);
    await x.runtime.drive(x.atlas);
    expect(
      x.store.conversations(x.atlas.id).some((entry) => entry.kind === "mission"),
    ).toBe(true);
    const current = x.profiles.getProfile(x.atlas.id);
    x.profiles.saveProfile(
      { ...snapshot(current), kind: "thin" },
      current.revision,
    );
    const thin = x.store.get(x.atlas.id);
    expect(thin).toMatchObject({ kind: "thin", intervalMinutes: null });
    await x.runtime.drive(thin);
    expect(
      x.store.conversations(thin.id).some((entry) => entry.kind === "mission"),
    ).toBe(false);
    expect(() => x.runtime.wake(thin)).toThrow(
      "Thin agents do not have standing missions to wake.",
    );
    expect(() => x.store.setMissionSchedule(thin.id, 30)).toThrow(
      "Thin agents do not have mission schedules.",
    );

    const channel = room([thin.id]);
    x.store.putRoom(channel);
    const context = x.runtime.data.context(channel.id);
    x.runtime.data.saveContext(
      channel.id,
      {
        brief: "Keep the answer tightly scoped.",
        decisions: "Use the existing public API.",
        memory: "PRIVATE CHANNEL MEMORY",
        attachmentIds: [],
      },
      context.version,
      "You",
    );
    x.runtime.send(channel, "@atlas inspect this", randomUUID());
    await x.runtime.drive(thin);

    const spawn = x.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0] as {
      environment?: { workspace?: { path?: string } };
      input?: Array<{ type: string; text?: string }>;
    };
    expect(spawn.environment?.workspace?.path).toBe(`${x.atlas.home}/files`);
    const prompt = spawn.input?.map((part) => part.text ?? "").join("\n") ?? "";
    expect(prompt).toContain("Atlas persona");
    expect(prompt).toContain("Keep the answer tightly scoped.");
    expect(prompt).toContain("Use the existing public API.");
    expect(prompt).not.toMatch(/MISSION\.md|MEMORY\.md|PRIVATE CHANNEL MEMORY/u);
  });

  it("runs one due wake without replaying missed intervals", async () => {
    const x = await trackedSetup();
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    x.store.setMissionSchedule(x.atlas.id, 30);
    x.store.put({
      ...x.store.get(x.atlas.id),
      lastWakeAt: now - 3 * 60 * 60_000,
    });
    vi.spyOn(x.runtime, "drive").mockResolvedValue(undefined);

    await x.runtime.tick();
    const first = x.store
      .jobs(x.atlas.id)
      .find((job) => job.conversationKey === "mission");
    expect(first).toBeDefined();
    expect(x.store.get(x.atlas.id).lastWakeAt).toBe(now);

    x.store.putJob({ ...first!, status: "done" });
    clock.mockReturnValue(now + 29 * 60_000);
    await x.runtime.tick();
    expect(
      x.store.jobs(x.atlas.id).filter((job) => job.conversationKey === "mission"),
    ).toHaveLength(1);

    clock.mockReturnValue(now + 30 * 60_000);
    await x.runtime.tick();
    expect(
      x.store.jobs(x.atlas.id).filter((job) => job.conversationKey === "mission"),
    ).toHaveLength(2);
  });

  it("skips due wakes for paused, retired, and busy agents", async () => {
    const x = await trackedSetup();
    x.store.setMissionSchedule(x.atlas.id, 30);

    await x.store.setPaused(x.atlas.id, true);
    x.store.put({
      ...x.store.get(x.atlas.id),
      lastWakeAt: Date.now() - 31 * 60_000,
    });
    await x.runtime.tick();
    expect(x.store.jobs(x.atlas.id)).toHaveLength(0);

    await x.store.setPaused(x.atlas.id, false);
    x.store.put({ ...x.store.get(x.atlas.id), retired: true });
    x.store.put({
      ...x.store.get(x.atlas.id),
      lastWakeAt: Date.now() - 31 * 60_000,
    });
    await x.runtime.tick();
    expect(x.store.jobs(x.atlas.id)).toHaveLength(0);

    x.store.put({ ...x.store.get(x.atlas.id), retired: false });
    x.store.put({
      ...x.store.get(x.atlas.id),
      lastWakeAt: Date.now() - 31 * 60_000,
    });
    x.runtime.busy.set(x.atlas.id, {
      threadId: "previous-mission",
      at: Date.now(),
    });
    await x.runtime.tick();
    expect(x.store.jobs(x.atlas.id)).toHaveLength(0);
  });

  it("validates schedules and starts a changed interval from now", async () => {
    const x = await trackedSetup();
    await expect(
      x.harness.behavior.callRpc("setMissionSchedule", {
        id: x.atlas.id,
        intervalMinutes: 14,
      }),
    ).rejects.toThrow();
    await expect(
      x.harness.behavior.callRpc("setMissionSchedule", {
        id: x.atlas.id,
        intervalMinutes: 10_081,
      }),
    ).rejects.toThrow();

    const before = x.profiles.getProfile(x.atlas.id);
    const scheduled = await x.harness.behavior.callRpc("setMissionSchedule", {
      id: x.atlas.id,
      intervalMinutes: 30,
    }) as { intervalMinutes: number; lastWakeAt: number };
    expect(scheduled.intervalMinutes).toBe(30);
    expect(scheduled.lastWakeAt).toBeGreaterThanOrEqual(Date.now() - 1_000);
    expect(x.profiles.getProfile(x.atlas.id)).toMatchObject({
      revision: before.revision,
      intervalMinutes: 30,
    });
    expect(
      x.store.db
        .prepare("SELECT COUNT(*) AS count FROM profile_revisions WHERE profile_id = ?")
        .get(x.atlas.id),
    ).toEqual({ count: 1 });

    await x.runtime.tick();
    expect(
      x.store.jobs(x.atlas.id).filter((job) => job.conversationKey === "mission"),
    ).toHaveLength(0);
  });

  it("recovers a dispatching job through threads.list metadata", async () => {
    const x = await trackedSetup();
    x.runtime.enqueue(x.atlas, {
      id: "recover-job",
      text: "recover",
      conversationKey: "mission",
      status: "dispatching",
    });
    x.setListedThreads([
      makeThreadResponse({ id: "recovered-thread", visibility: "hidden" }),
    ]);
    x.metadataByThread.set("recovered-thread", {
      agentId: x.atlas.id,
      conversationKey: "mission",
    });

    await x.runtime.tick();
    expect(x.harness.inspection.sdk.callsTo("threads.list").length).toBeGreaterThan(0);
    expect(
      x.harness.inspection.sdk.callsTo("threads.getPluginMetadata").length,
    ).toBeGreaterThan(0);
    expect(x.store.job("recover-job")?.threadId).toBe("recovered-thread");
    expect(x.store.byThread("recovered-thread")).toMatchObject({
      agentId: x.atlas.id,
      key: "mission",
    });
  });
});
