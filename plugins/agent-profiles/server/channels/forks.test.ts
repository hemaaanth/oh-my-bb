import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../../server";
import type { Profile } from "../contract";
import { createExecutionResolver } from "../execution-resolver";
import { createProfiles } from "../profiles";
import type { Room } from "./contract";
import { jobPrompt, Runtime } from "./runtime";
import { Store } from "./store";

const profileInput = {
  name: "Atlas",
  slug: "atlas",
  description: "Fork test agent",
  avatar: "🤖",
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "medium" as const,
  serviceTier: "default" as const,
  permissionMode: "auto" as const,
  instructions: "Atlas persona",
  skillIds: [],
  mcpServerIds: [],
  isDefault: false,
};

type TestThread = {
  status: "active" | "idle";
  prompt: string;
  output: string | null;
  metadata: Record<string, unknown>;
};

async function setup() {
  let sequence = 0;
  const threads = new Map<string, TestThread>();
  let store: Store;
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
      providers: {
        list: async () =>
          [{
            id: "agents",
            available: true,
            capabilities: { supportsFork: true },
          }] as never,
        models: async () => ({ models: [
          { model: "openai-codex/gpt-5.6-sol", displayName: "GPT 5.6 Sol",
            supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
            defaultReasoningEffort: "medium", isDefault: true },
        ] }) as never,
      },
      threads: {
        spawn: async (args) => {
          const id = `thread-main-${++sequence}`;
          threads.set(id, {
            status: "active",
            prompt: args.input?.find((part) => part.type === "text")?.text ?? "",
            output: null,
            metadata: args.pluginMetadata ?? {},
          });
          return makeThreadResponse({ id, status: "active", providerId: "agents" });
        },
        fork: async (args) => {
          const id = `thread-fork-${++sequence}`;
          expect(threads.has(args.sourceThreadId)).toBe(true);
          threads.set(id, {
            status: "active",
            prompt: args.input?.find((part) => part.type === "text")?.text ?? "",
            output: null,
            metadata: args.pluginMetadata ?? {},
          });
          return makeThreadResponse({ id, status: "active", providerId: "agents" });
        },
        send: async (args) => {
          expect(
            store
              .work(profile.id)
              .some(
                (job) =>
                  job.threadId === args.threadId &&
                  (job.status === "dispatching" || job.status === "running"),
              ),
          ).toBe(true);
          const thread = threads.get(args.threadId)!;
          thread.prompt = args.input.find((part) => part.type === "text")?.text ?? "";
          thread.status = "active";
          return { ok: true, delivery: "sent" } as never;
        },
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            providerId: "agents",
            status: threads.get(threadId)?.status ?? "idle",
          }),
        list: async () =>
          [...threads].map(([id, thread]) =>
            makeThreadResponse({ id, status: thread.status })
          ),
        getPluginMetadata: async ({ threadId }) =>
          threads.get(threadId)?.metadata as never,
        output: async ({ threadId }) => ({
          output: threads.get(threadId)?.output ?? null,
        }),
        timeline: async ({ threadId }) => ({
          rows: [{
            kind: "conversation",
            role: "user",
            text: threads.get(threadId)?.prompt ?? "",
          }],
          hasOlder: false,
        }) as never,
        stop: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (thread) thread.status = "idle";
          return { ok: true };
        },
        queuedMessages: {
          list: async () => [],
          delete: async () => ({ ok: true }),
        },
      },
    },
  });
  await plugin(host.bb);
  store = await Store.create(host.bb, host.bb.storage.database());
  await store.ensureProject();
  const profiles = await createProfiles(
    host.bb,
    host.bb.storage.database(),
    store,
    createExecutionResolver(host.bb),
  );
  const saved = await host.harness.behavior.callRpc(
    "saveProfile",
    profileInput,
  ) as Profile;
  await store.setPaused(saved.id, false);
  const profile = store.get(saved.id);
  const room: Room = {
    id: randomUUID(),
    name: "Fork QA",
    memberIds: [profile.id],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    responseBehavior: "directed",
  };
  store.putRoom(room);
  const runtime = new Runtime(host.bb, store, profiles);
  const send = (
    text: string,
    mode: "auto" | "fork" | "steer" | "followup" = "auto",
    replyTo: string | null = null,
  ) =>
    runtime.send(
      store.room(room.id),
      text,
      randomUUID(),
      [],
      replyTo,
      undefined,
      undefined,
      mode,
    );
  const main = async () => {
    const message = send("@atlas Implement the migration");
    await runtime.drive(profile);
    const job = store.job(`${message.id}:${profile.id}`)!;
    runtime.busy.set(profile.id, { threadId: job.threadId!, at: Date.now() });
    return job;
  };
  const finish = async (threadId: string, output: string) => {
    Object.assign(threads.get(threadId)!, { status: "idle", output });
    await runtime.settleFromEvent(threadId, output);
    await runtime.driveRoom(store.room(room.id));
  };
  return {
    ...host,
    store,
    runtime,
    profiles,
    profile,
    room,
    threads,
    send,
    main,
    finish,
    close: async () => {
      await runtime.dispose();
      await host.harness.lifecycle.dispose();
    },
  };
}

describe("channel forks", () => {
  it("answers alongside the primary and reuses the fork for replies", async () => {
    const test = await setup();
    try {
      const primary = await test.main();
      const question = test.send("@atlas Why SQLite?", "fork");
      await test.runtime.driveForks(test.profile);
      const fork = test.store.job(`${question.id}:${test.profile.id}`)!;

      expect(test.store.job(primary.id)?.status).toBe("running");
      expect(fork.threadId).not.toBe(primary.threadId);
      expect(fork.forkSourceThreadId).toBe(primary.threadId);
      expect(
        test.harness.inspection.sdk.callsTo("threads.fork")[0]?.[0],
      ).toMatchObject({
        sourceThreadId: primary.threadId,
        pluginMetadata: { role: "channel", profileId: test.profile.id, schemaVersion: 1, agentId: test.profile.id },
      });
      expect(jobPrompt(fork)).toMatch(/do not resume inherited work/);

      await test.finish(fork.threadId!, "SQLite suits this local workload.");
      const answer = test.store.message(fork.id)!;
      expect(answer).toMatchObject({
        replyTo: question.id,
        conversationKey: fork.conversationKey,
        forkSourceThreadId: primary.threadId,
      });

      const followup = test.send("What about backups?", "followup", answer.id);
      await test.runtime.driveForks(test.profile);
      expect(test.store.job(`${followup.id}:${test.profile.id}`)?.threadId).toBe(
        fork.threadId,
      );
      expect(test.harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(1);
      expect(test.store.job(primary.id)?.status).toBe("running");
    } finally {
      await test.close();
    }
  });

  it("replaces a history-only channel thread instead of continuing or forking it", async () => {
    const test = await setup();
    try {
      const primary = await test.main();
      test.runtime.complete(primary.threadId!, "Initial result");
      await test.runtime.driveRoom(test.room);
      test.harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, providerId: threadId === primary.threadId ? `agent-${test.profile.id}` : "agents" }));
      const spawned = test.harness.inspection.sdk.callsTo("threads.spawn").length;
      const followup = test.send("@atlas Continue", "followup");
      await test.runtime.driveRoom(test.room);
      await test.runtime.drive(test.profile);
      expect(test.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
      expect(test.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(spawned + 1);
      const job = test.store.job(`${followup.id}:${test.profile.id}`)!;
      expect(job.error ?? null).toBeNull();
      expect(job.threadId).not.toBe(primary.threadId);

      test.runtime.complete(job.threadId!, "Fresh result");
      await test.runtime.driveRoom(test.room);
      test.harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, providerId: `agent-${test.profile.id}` }));
      const beforeFork = test.harness.inspection.sdk.callsTo("threads.spawn").length;
      const fork = test.send("@atlas Start a fork", "fork");
      await test.runtime.driveForks(test.profile);
      expect(test.harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(0);
      expect(test.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(beforeFork + 1);
      expect(test.store.job(`${fork.id}:${test.profile.id}`)?.error ?? null).toBeNull();
    } finally {
      await test.close();
    }
  });

  it("stops a fork without stopping the primary", async () => {
    const test = await setup();
    try {
      const primary = await test.main();
      const question = test.send("@atlas Side question", "fork");
      await test.runtime.driveForks(test.profile);
      const fork = test.store.job(`${question.id}:${test.profile.id}`)!;

      await test.runtime.cancel(fork, "Stopped fork");
      expect(test.store.job(primary.id)?.status).toBe("running");
      expect(test.threads.get(primary.threadId!)?.status).toBe("active");
      expect(test.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
      expect(
        test.harness.inspection.sdk.callsTo("threads.stop")[0]?.[0],
      ).toMatchObject({ threadId: fork.threadId });
    } finally {
      await test.close();
    }
  });

  it("bounds fork concurrency without blocking the primary", async () => {
    const test = await setup();
    try {
      const primary = await test.main();
      const questions = Array.from({ length: 3 }, (_, index) =>
        test.send(`@atlas question ${index}`, "fork")
      );
      await test.runtime.driveForks(test.profile);

      expect(test.harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(2);
      expect(
        test.store.job(`${questions[2]!.id}:${test.profile.id}`)?.status,
      ).toBe("queued");
      const first = test.store.job(`${questions[0]!.id}:${test.profile.id}`)!;
      await test.finish(first.threadId!, "Answer");
      await test.runtime.driveForks(test.profile);
      expect(test.harness.inspection.sdk.callsTo("threads.fork")).toHaveLength(3);
      expect(test.store.job(primary.id)?.status).toBe("running");
    } finally {
      await test.close();
    }
  });

  it("fails unsupported forks independently and preserves their retry source", async () => {
    const test = await setup();
    try {
      const primary = await test.main();
      test.harness.inspection.sdk.stub("providers.list", async () =>
        [{ id: "codex", capabilities: { supportsFork: false } }] as never
      );
      const question = test.send("@atlas Side question", "fork");
      await test.runtime.driveForks(test.profile);
      const fork = test.store.job(`${question.id}:${test.profile.id}`)!;

      expect(fork.status).toBe("error");
      expect(fork.error).toMatch(/does not support/);
      expect(test.store.job(primary.id)?.status).toBe("running");
      const retry = await test.runtime.retryJob(fork.id);
      expect(retry.forkSourceThreadId).toBe(primary.threadId);
      expect(retry.conversationKey).toBe(fork.conversationKey);
    } finally {
      await test.close();
    }
  });

  it("keeps request retries idempotent and rejects mode changes", async () => {
    const test = await setup();
    try {
      await test.main();
      const requestId = randomUUID();
      test.runtime.send(test.room, "@atlas Why?", requestId, [], null, undefined, undefined, "fork");
      test.runtime.send(test.room, "@atlas Why?", requestId, [], null, undefined, undefined, "fork");
      expect(test.store.work(test.profile.id)).toHaveLength(2);
      expect(() =>
        test.runtime.send(test.room, "@atlas Why?", requestId)
      ).toThrow(/different content/);
    } finally {
      await test.close();
    }
  });

  it("persists a steer that arrives while the first thread is spawning", async () => {
    const test = await setup();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      test.harness.inspection.sdk.stub(
        "threads.spawn",
        async (args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) => {
          await gate;
          test.threads.set("thread-delayed", {
            status: "active",
            prompt: args.input?.find((part) => part.type === "text")?.text ?? "",
            output: null,
            metadata: args.pluginMetadata ?? {},
          });
          return makeThreadResponse({ id: "thread-delayed", status: "active" });
        },
      );
      const original = test.send("@atlas Implement the migration");
      const driving = test.runtime.drive(test.profile);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const correction = test.send("@atlas Use WAL", "steer");
      const current = test.store.job(`${original.id}:${test.profile.id}`)!;
      expect(current).toMatchObject({
        triggerMessageId: correction.id,
        requiresPromptMatch: true,
      });
      expect(current.pendingSteer).toBeDefined();

      release();
      await driving;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(test.store.job(current.id)?.pendingSteer).toBeUndefined();
      expect(
        test.harness.inspection.sdk.callsTo("threads.send")[0]?.[0],
      ).toMatchObject({ mode: "steer" });
    } finally {
      await test.close();
    }
  });

  it("recovers a persisted correction without publishing inherited output", async () => {
    const test = await setup();
    let restarted: Runtime | undefined;
    try {
      const primary = await test.main();
      const corrected = {
        ...test.store.job(primary.id)!,
        text: "Corrected task",
        requiresPromptMatch: true,
        pendingSteer: { priorPrompt: jobPrompt(primary) },
      };
      test.store.putJob(corrected);
      restarted = new Runtime(test.bb, test.store, test.profiles);
      Object.assign(test.threads.get(primary.threadId!)!, {
        status: "idle",
        output: "Old answer",
      });

      await restarted.settleFromEvent(primary.threadId!, "Old answer");
      expect(test.store.job(primary.id)?.status).toBe("running");
      await restarted.drive(test.profile);
      expect(test.store.job(primary.id)?.pendingSteer).toBeUndefined();
      expect(test.store.job(primary.id)?.reply).toBeNull();
      expect(test.threads.get(primary.threadId!)?.prompt).toMatch(
        /Corrected task/,
      );
    } finally {
      await restarted?.dispose();
      await test.close();
    }
  });

  it("settles a deleted active fork and starts a later fork", async () => {
    const test = await setup();
    try {
      await test.main();
      const first = test.send("@atlas Separate question", "fork");
      await test.runtime.driveForks(test.profile);
      const lost = test.store.job(`${first.id}:${test.profile.id}`)!;
      test.harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
        if (threadId === lost.threadId) throw new Error("Thread not found");
        return makeThreadResponse({ id: threadId, status: "active", providerId: "agents" });
      });
      const second = test.send("@atlas Another question", "fork");

      await test.runtime.tick();
      expect(test.store.job(lost.id)?.status).toBe("error");
      expect(test.store.byThread(lost.threadId!)).toBeNull();
      expect(
        test.store.job(`${second.id}:${test.profile.id}`)?.status,
      ).toBe("running");
    } finally {
      await test.close();
    }
  });

  it("cleans up a deleted fork while primary work is rate limited", async () => {
    const test = await setup();
    try {
      const primary = await test.main();
      const message = test.send("@atlas Parallel check", "fork");
      await test.runtime.driveForks(test.profile);
      const fork = test.store.job(`${message.id}:${test.profile.id}`)!;
      await test.finish(primary.threadId!, "Primary finished");
      test.runtime.busy.clear();
      test.store.put({
        ...test.store.get(test.profile.id),
        limits: {
          turnsPerHour: 1,
          turnsPerDay: 1,
          minutesPerTurn: 20,
          concurrentForks: 2,
        },
      });
      const queued = test.send("@atlas Queued after budget", "followup");
      test.harness.inspection.sdk.stub("threads.get", async ({ threadId }) => {
        if (threadId === fork.threadId) throw new Error("Thread not found");
        return makeThreadResponse({ id: threadId, status: "idle" });
      });

      await test.runtime.tick();
      expect(test.store.job(fork.id)?.status).toBe("error");
      expect(
        test.store.job(`${queued.id}:${test.profile.id}`)?.status,
      ).toBe("queued");
    } finally {
      await test.close();
    }
  });
});
