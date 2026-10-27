import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { configureReturnDecision } from "../../server";
import type { Profile } from "../contract";
import { createProfiles } from "../profiles";
import { agentAuthor } from "./rpc";
import type { Job, Room } from "./contract";
import { Runtime } from "./runtime";
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

type ReturnInput = {
  request: { agentName: string; handle: string; text: string };
  results: Array<{
    agentName: string;
    handle: string;
    status: string;
    text: string;
  }>;
  conversationTitle: string;
};

type ReturnResult = {
  shouldReturn: boolean;
  probability: number;
  confidence: number;
};

type SetupOptions = {
  initialText?: string;
  decide?: (input: ReturnInput) => ReturnResult | Promise<ReturnResult>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function setup(options: SetupOptions = {}) {
  const shouldReturn = vi.fn(
    options.decide ?? (() => ({
      shouldReturn: true,
      probability: 0.9,
      confidence: 0.8,
    })),
  );
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
          throw new Error(`Unexpected plugin RPC: ${method}`);
        },
      },
      system: {
        config: async () => ({ primaryHostId: "host-primary" }) as never,
      },
      projects: {
        create: async () => ({ id: "agents-project" }) as never,
      },
      threads: {
        stop: async () => ({ ok: true }),
        queuedMessages: {
          list: async () => [],
          delete: async () => ({ ok: true }),
        },
      },
    },
  });
  await plugin(host.bb);
  const store = await Store.create(host.bb, host.bb.storage.database());
  await store.ensureProject();
  const profiles = await createProfiles(
    host.bb,
    host.bb.storage.database(),
    store,
  );
  const saved = await Promise.all(
    ["Atlas", "Scribe", "Scout"].map((name) =>
      host.harness.behavior.callRpc("saveProfile", profileInput(name)) as Promise<Profile>
    ),
  );
  for (const profile of saved) await store.setPaused(profile.id, false);
  const agents = saved.map((profile) => store.get(profile.id));
  const room: Room = {
    id: randomUUID(),
    name: "Research",
    memberIds: agents.map((agent) => agent.id),
    responseBehavior: "directed",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  };
  store.putRoom(room);
  const runtime = new Runtime(
    host.bb,
    store,
    profiles,
    { delegationReturns: true },
  );
  configureReturnDecision(host.bb, store, runtime, async (input) =>
    shouldReturn(input),
  );
  const request = runtime.send(
    room,
    options.initialText ?? "@atlas Investigate and summarize",
    randomUUID(),
  );
  const source = store.requestJobs(request.id)[0]!;

  async function collect() {
    await runtime.driveRoom(store.room(room.id));
    await nextTurn();
  }

  async function finish(
    job: Job,
    reply: string,
    status: Job["status"] = "done",
    error: string | null = null,
  ) {
    store.putJob({ ...job, status, reply, error });
    await collect();
  }

  const returns = () =>
    store.requestJobs(request.id).filter((job) => job.returnOf);

  return {
    ...host,
    store,
    profiles,
    runtime,
    agents,
    room,
    request,
    source,
    shouldReturn,
    collect,
    finish,
    returns,
    close: async () => {
      await runtime.dispose();
      await host.harness.lifecycle.dispose();
    },
  };
}

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((entry) => entry.close()));
});

async function trackedSetup(options?: SetupOptions) {
  const value = await setup(options);
  open.push(value);
  return value;
}

describe("channel delegation returns", () => {
  it("returns a direct delegate result to its requester exactly once", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review the query performance");
    const delegate = x.store.work(x.agents[1]!.id)[0]!;
    expect(x.returns()).toHaveLength(0);
    expect(x.runtime.delegations.waits(x.room.id)).toEqual([{
      requesterAgentId: x.agents[0]!.id,
      delegateAgentIds: [x.agents[1]!.id],
    }]);
    expect(
      x.store.runs(x.room.id).find((run) => run.id === x.request.id)?.status,
    ).toBe("running");

    await x.finish(delegate, "The query needs an index on room_id.");

    expect(x.returns()).toHaveLength(1);
    expect(x.returns()[0]).toMatchObject({
      agentId: x.agents[0]!.id,
      conversationKey: x.source.conversationKey,
      returnOf: `job:${x.source.id}`,
    });
    expect(x.returns()[0]!.text).toContain("index on room_id");
    expect(x.returns()[0]!.text).toContain('"status":"success"');
    await x.collect();
    expect(x.returns()).toHaveLength(1);
  });

  it("waits for every directly mentioned delegate and returns all outcomes once", async () => {
    const x = await trackedSetup();
    await x.finish(
      x.source,
      "@scribe Check storage. @scout Check the UI.",
    );
    const scribe = x.store.work(x.agents[1]!.id)[0]!;
    const scout = x.store.work(x.agents[2]!.id)[0]!;

    await x.finish(scribe, "Storage looks correct.");
    expect(x.returns()).toHaveLength(0);
    await x.finish(scout, "The empty state is broken.");

    expect(x.returns()).toHaveLength(1);
    expect(x.returns()[0]!.text).toContain("Storage looks correct");
    expect(x.returns()[0]!.text).toContain("empty state is broken");
  });

  it("includes delegate failures and cancellations after all settle", async () => {
    const x = await trackedSetup();
    await x.finish(
      x.source,
      "@scribe Check storage. @scout Check the UI.",
    );
    await x.finish(
      x.store.work(x.agents[1]!.id)[0]!,
      "",
      "error",
      "Provider unavailable",
    );
    expect(x.returns()).toHaveLength(0);
    await x.finish(
      x.store.work(x.agents[2]!.id)[0]!,
      "",
      "cancelled",
      "Stopped by the owner",
    );

    expect(x.returns()[0]!.text).toContain('"status":"failure"');
    expect(x.returns()[0]!.text).toContain('"status":"cancelled"');
    expect(x.returns()[0]!.text).toContain("Provider unavailable");
  });

  it("times out a delegate that cannot start and reports the timeout", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review storage");
    const group = x.runtime.delegations.pending(x.room.id)[0]!;
    x.runtime.delegations.put({ ...group, deadlineAt: Date.now() - 1 });

    await x.collect();

    expect(x.returns()).toHaveLength(1);
    expect(x.returns()[0]!.text).toContain('"status":"timeout"');
    expect(
      x.store.requestJobs(x.request.id).find((job) => job.delegationId),
    ).toMatchObject({ status: "cancelled", timedOut: true });
  });

  it("does not let unrelated replies settle a delegation", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review storage");
    const unrelated = x.runtime.send(
      x.store.room(x.room.id),
      "@scout An unrelated question",
      randomUUID(),
    );
    await x.finish(
      x.store.requestJobs(unrelated.id)[0]!,
      "Unrelated result",
    );
    expect(x.returns()).toHaveLength(0);

    await x.finish(
      x.store.work(x.agents[1]!.id)[0]!,
      "Storage is ready.",
    );

    expect(x.returns()).toHaveLength(1);
    expect(x.returns()[0]!.text).not.toContain("Unrelated result");
  });

  it("settles silently when Jev decides no follow-up is useful", async () => {
    const x = await trackedSetup({
      decide: () => ({
        shouldReturn: false,
        probability: 0.15,
        confidence: 0.7,
      }),
    });
    await x.finish(x.source, "Thanks @scribe!");
    await x.finish(
      x.store.work(x.agents[1]!.id)[0]!,
      "You're welcome, @atlas.",
    );
    await x.collect();

    expect(x.returns()).toHaveLength(0);
    expect(x.store.work(x.agents[0]!.id)).toHaveLength(0);
    expect(x.runtime.delegations.get(`job:${x.source.id}`)?.status).toBe(
      "ignored",
    );
    expect(x.store.runs(x.room.id)[0]!.status).toBe("done");
  });

  it("does not create loops from explicit return or synthesis mentions", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review storage");
    await x.finish(
      x.store.work(x.agents[1]!.id)[0]!,
      "@atlas The report is ready.",
    );
    const returned = x.returns()[0]!;
    expect(returned.depth).toBe(2);

    await x.finish(returned, "Thanks @scribe. Here is the final synthesis.");
    await x.collect();

    expect(x.store.work(x.agents[0]!.id)).toHaveLength(0);
    expect(x.store.work(x.agents[1]!.id)).toHaveLength(0);
    expect(x.returns()).toHaveLength(1);
  });

  it("recovers an interrupted return decision after restart without duplication", async () => {
    const x = await trackedSetup();
    x.runtime.returnDecision = async () => {
      throw new Error("offline");
    };
    await x.finish(x.source, "@scribe Review storage");
    await x.finish(x.store.work(x.agents[1]!.id)[0]!, "Ready");
    const group = x.runtime.delegations.pending(x.room.id)[0]!;
    expect(group.error).toContain("offline");
    x.runtime.delegations.put({ ...group, retryAt: 0 });

    const restarted = new Runtime(
      x.bb,
      x.store,
      x.profiles,
      { delegationReturns: true },
    );
    configureReturnDecision(x.bb, x.store, restarted, async (input) =>
      x.shouldReturn(input),
    );
    try {
      await restarted.driveRoom(x.store.room(x.room.id));
      await nextTurn();
      await restarted.driveRoom(x.store.room(x.room.id));
      expect(x.returns()).toHaveLength(1);
    } finally {
      await restarted.dispose();
    }
  });

  it("suppresses a return when the channel is archived during classification", async () => {
    const decision = deferred<ReturnResult>();
    const x = await trackedSetup({
      decide: () => decision.promise,
    });
    await x.finish(x.source, "@scribe Review storage");
    await x.finish(x.store.work(x.agents[1]!.id)[0]!, "Ready");
    x.store.putRoom({ ...x.store.room(x.room.id), archived: true });

    decision.resolve({ shouldReturn: true, probability: 1, confidence: 1 });
    await nextTurn();

    expect(x.returns()).toHaveLength(0);
  });

  it("prevents a return turn from starting another cross-channel delegation", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review storage");
    await x.finish(x.store.work(x.agents[1]!.id)[0]!, "Ready");
    const returned = {
      ...x.returns()[0]!,
      status: "running" as const,
      threadId: "return-thread",
    };
    x.store.putJob(returned);
    x.store.putConversation({
      id: "return-conversation",
      agentId: returned.agentId,
      key: returned.conversationKey,
      threadId: "return-thread",
      title: "Research",
      kind: "group",
      createdAt: 1,
    });
    const other = { ...x.room, id: randomUUID(), name: "Other" };
    x.store.putRoom(other);

    expect(() =>
      x.runtime.send(
        other,
        "@scribe More work",
        randomUUID(),
        [],
        null,
        agentAuthor(x.store, "return-thread"),
      )
    ).toThrow("handoff limit");
  });

  it("joins separate cross-channel sends into one return to the original session", async () => {
    const x = await trackedSetup();
    const source = {
      ...x.source,
      status: "running" as const,
      threadId: "source-thread",
    };
    x.store.putJob(source);
    x.store.putConversation({
      id: "source-conversation",
      agentId: source.agentId,
      key: source.conversationKey,
      threadId: source.threadId,
      title: "Research",
      kind: "group",
      createdAt: 1,
    });
    const other = { ...x.room, id: randomUUID(), name: "Consultation" };
    x.store.putRoom(other);
    x.store.putMessage({
      id: "prior-scribe",
      roomId: other.id,
      runId: "prior",
      agentId: x.agents[1]!.id,
      speaker: "Scribe",
      text: "Ready for a question.",
      createdAt: 1,
      attachments: [],
      replyTo: null,
    });
    const author = agentAuthor(x.store, source.threadId, other.id);
    const storageRequest = x.runtime.send(
      other,
      "Review the database.",
      randomUUID(),
      [],
      "prior-scribe",
      author,
    );
    const uiRequest = x.runtime.send(
      x.store.room(other.id),
      "@scout Review the UI.",
      randomUUID(),
      [],
      null,
      author,
    );
    expect(x.runtime.delegations.pending(x.room.id)).toHaveLength(1);

    await x.finish(
      x.store.requestJobs(storageRequest.id)[0]!,
      "Database is ready.",
    );
    await x.finish(source, "[PASS]");
    expect(x.returns()).toHaveLength(0);
    await x.finish(
      x.store.requestJobs(uiRequest.id)[0]!,
      "UI needs a fix.",
    );

    expect(x.returns()).toHaveLength(1);
    expect(x.returns()[0]).toMatchObject({
      roomId: x.room.id,
      conversationKey: source.conversationKey,
    });
    expect(x.returns()[0]!.text).toContain("Database is ready");
    expect(x.returns()[0]!.text).toContain("UI needs a fix");
  });

  it("finishes a nested delegate synthesis before returning to the root requester", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review the implementation.");
    const scribe = x.store.work(x.agents[1]!.id)[0]!;
    await x.finish(scribe, "@scout Check the UI for me.");
    const scout = x.store.work(x.agents[2]!.id)[0]!;
    expect(scout.depth).toBe(2);
    expect(x.returns()).toHaveLength(0);

    await x.finish(scout, "The UI is correct.");
    const nestedReturn = x.returns().find(
      (job) => job.agentId === x.agents[1]!.id,
    )!;
    expect(nestedReturn).toBeTruthy();
    expect(
      x.returns().filter((job) => job.agentId === x.agents[0]!.id),
    ).toHaveLength(0);

    await x.finish(
      nestedReturn,
      "The implementation is correct, including the UI.",
    );

    const rootReturn = x.returns().find(
      (job) => job.agentId === x.agents[0]!.id,
    )!;
    expect(rootReturn.text).toContain("including the UI");
  });

  it("does not wake an ancestor early from a delegate cross-channel mention", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review storage.");
    const child = {
      ...x.store.work(x.agents[1]!.id)[0]!,
      status: "running" as const,
      threadId: "child-thread",
    };
    x.store.putJob(child);
    x.store.putConversation({
      id: "child-conversation",
      agentId: child.agentId,
      key: child.conversationKey,
      threadId: child.threadId,
      title: "Research",
      kind: "group",
      createdAt: 1,
    });
    const other = { ...x.room, id: randomUUID(), name: "Other" };
    x.store.putRoom(other);

    const progress = x.runtime.send(
      other,
      "@atlas Here is a progress acknowledgment.",
      randomUUID(),
      [],
      null,
      agentAuthor(x.store, child.threadId, other.id),
    );
    expect(x.store.requestJobs(progress.runId)).toHaveLength(0);
    expect(x.store.work(x.agents[0]!.id)).toHaveLength(0);

    await x.finish(child, "The report is ready.");
    expect(x.store.work(x.agents[0]!.id)).toHaveLength(1);
  });

  it("retains ancestry across delegate retries, renews the deadline, and returns once", async () => {
    const x = await trackedSetup();
    const decision = deferred<boolean>();
    x.runtime.returnDecision = () => decision.promise;
    await x.finish(x.source, "@scribe Review storage.");
    const delegate = x.store.work(x.agents[1]!.id)[0]!;
    await x.finish(delegate, "", "error", "Temporary failure");
    const group = x.runtime.delegations.pending(x.room.id)[0]!;
    x.runtime.delegations.put({ ...group, deadlineAt: Date.now() - 1 });

    const retry = await x.runtime.retryJob(delegate.id);
    expect(retry.delegationId).toBe(delegate.delegationId);
    expect(x.runtime.delegations.get(group.id)!.deadlineAt).toBeGreaterThan(
      Date.now(),
    );
    decision.resolve(true);
    await nextTurn();
    expect(x.returns()).toHaveLength(0);

    x.runtime.returnDecision = async () => true;
    await x.finish(retry, "@atlas The retry succeeded.");
    expect(x.returns()).toHaveLength(1);
  });

  it("keeps cross-channel synthesis reply targets inside the destination channel", async () => {
    const x = await trackedSetup();
    const source = {
      ...x.source,
      status: "running" as const,
      threadId: "origin-thread",
    };
    x.store.putJob(source);
    x.store.putConversation({
      id: "origin-conversation",
      agentId: source.agentId,
      key: source.conversationKey,
      threadId: source.threadId,
      title: "Origin",
      kind: "group",
      createdAt: 1,
    });
    const other = { ...x.room, id: randomUUID(), name: "Delegates" };
    x.store.putRoom(other);
    const delegated = x.runtime.send(
      other,
      "@scribe Review storage",
      randomUUID(),
      [],
      null,
      agentAuthor(x.store, source.threadId, other.id),
    );

    await x.finish(source, "[PASS]");
    await x.finish(
      x.store.requestJobs(delegated.runId)[0]!,
      "Ready.",
    );
    const returned = x.returns()[0]!;
    expect(x.store.message(returned.triggerMessageId!)!.roomId).toBe(x.room.id);

    await x.finish(returned, "Final synthesis.");
    const reply = x.store.message(returned.id)!;
    expect(x.store.message(reply.replyTo!)!.roomId).toBe(reply.roomId);
  });

  it("stops nested descendants when the root delegation times out", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review storage.");
    const scribe = x.store.work(x.agents[1]!.id)[0]!;
    await x.finish(scribe, "@scout Check the details.");
    const group = x.runtime.delegations.get(`job:${x.source.id}`)!;
    x.runtime.delegations.put({ ...group, deadlineAt: Date.now() - 1 });

    await x.collect();
    await x.collect();

    const returned = x.returns().find(
      (job) => job.agentId === x.agents[0]!.id,
    )!;
    expect(returned.text).toContain('"status":"timeout"');
    expect(x.store.work(x.agents[2]!.id)).toHaveLength(0);
  });

  it("invalidates an in-flight return after requester retry and stays quiet on cancellation", async () => {
    const x = await trackedSetup();
    const source = { ...x.source, status: "running" as const };
    x.store.putJob(source);
    const delegated = x.runtime.send(
      x.room,
      "@scribe Review storage.",
      randomUUID(),
      [],
      null,
      {
        agentId: source.agentId,
        jobId: source.id,
        depth: source.depth + 1,
        speaker: x.agents[0]!.name,
        sourceThreadId: "requester-thread",
      },
    );
    await x.finish(source, "", "error", "Temporary failure");
    const decision = deferred<boolean>();
    x.runtime.returnDecision = () => decision.promise;
    await x.finish(
      x.store.requestJobs(delegated.runId)[0]!,
      "Storage is ready.",
    );

    const retry = await x.runtime.retryJob(source.id);
    decision.resolve(true);
    await nextTurn();
    expect(x.returns()).toHaveLength(0);
    expect(x.runtime.delegations.get(`job:${source.id}`)?.status).toBe(
      "waiting",
    );

    x.runtime.returnDecision = async () => {
      throw new Error("A cancelled requester must not need classification");
    };
    await x.finish(retry, "", "cancelled", "Stopped by the owner");
    expect(x.returns()).toHaveLength(0);
    expect(x.runtime.delegations.get(`job:${source.id}`)?.status).toBe(
      "ignored",
    );
  });

  it("allows a cancelled requester to retry and receive one return", async () => {
    const x = await trackedSetup();
    const source = { ...x.source, status: "running" as const };
    x.store.putJob(source);
    const delegated = x.runtime.send(
      x.room,
      "@scribe Review storage.",
      randomUUID(),
      [],
      null,
      {
        agentId: source.agentId,
        jobId: source.id,
        depth: source.depth + 1,
        speaker: x.agents[0]!.name,
        sourceThreadId: "requester-thread",
      },
    );
    await x.finish(source, "", "cancelled", "Stopped by the owner");
    const retry = await x.runtime.retryJob(source.id);
    await x.finish(retry, "[PASS]");
    await x.finish(
      x.store.requestJobs(delegated.runId)[0]!,
      "Storage is ready.",
    );

    expect(x.returns()).toHaveLength(1);
    expect(x.returns()[0]!.text).toContain("Storage is ready");
    await x.collect();
    expect(x.returns()).toHaveLength(1);
  });

  it("caps request and result text before calling Jev", async () => {
    const x = await trackedSetup({
      initialText: `@atlas ${"r".repeat(5_000)}`,
    });
    await x.finish(x.source, `@scribe ${"d".repeat(5_000)}`);
    await x.finish(
      x.store.work(x.agents[1]!.id)[0]!,
      "x".repeat(5_000),
    );

    expect(x.shouldReturn).toHaveBeenCalledTimes(1);
    const input = x.shouldReturn.mock.calls[0]![0];
    expect(input.request.text).toHaveLength(4_000);
    expect(input.results).toHaveLength(1);
    expect(input.results[0]!.text).toHaveLength(4_000);
    expect(input).toMatchObject({
      request: { agentName: "Atlas", handle: "atlas" },
      results: [{ agentName: "Scribe", handle: "scribe", status: "success" }],
      conversationTitle: "Research",
    });
  });

  it("falls back to a return and logs a warning when Jev fails", async () => {
    const x = await trackedSetup({
      decide: () => {
        throw new Error("Jev unavailable");
      },
    });
    await x.finish(x.source, "@scribe Review storage.");
    await x.finish(x.store.work(x.agents[1]!.id)[0]!, "Storage is ready.");

    expect(x.returns()).toHaveLength(1);
    expect(
      x.harness.inspection.logEntries.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("returning by default") &&
          entry.message.includes("Jev unavailable"),
      ),
    ).toBe(true);
  });

  it("records route and return Jev usage separately", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review storage.");
    await x.finish(x.store.work(x.agents[1]!.id)[0]!, "Storage is ready.");

    expect(
      x.store.db
        .prepare(
          "SELECT purpose, COUNT(*) AS count FROM routing_usage WHERE room_id = ? GROUP BY purpose",
        )
        .all(x.room.id),
    ).toEqual([{ purpose: "return", count: 1 }]);
  });

  it("marks stale waiting delegations timed out on plugin startup without posting", async () => {
    const x = await trackedSetup();
    await x.finish(x.source, "@scribe Review storage.");
    const group = x.runtime.delegations.pending(x.room.id)[0]!;
    x.runtime.delegations.put({ ...group, deadlineAt: Date.now() - 1 });
    expect(x.runtime.delegations.expireStale(Date.now())).toBe(1);

    expect(x.runtime.delegations.get(group.id)).toMatchObject({
      status: "timed_out",
      error: "Delegation expired before return processing resumed.",
    });
    expect(x.shouldReturn).not.toHaveBeenCalled();
    expect(x.returns()).toHaveLength(0);
  });
});
