import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import plugin from "../../server";
import { createProfiles } from "../profiles";
import {
  channelAutomationCreateSchema,
  channelAutomationRunSchema,
  channelAutomationTargetSchema,
  channelAutomationUpdateSchema,
} from "./automation-contract";
import {
  ChannelAutomations,
  dispatchScript,
} from "./channel-automations";
import { roomSchema, type ChannelAgent, type Room } from "./contract";
import { Runtime } from "./runtime";
import { Store } from "./store";

type AutomationRecord = Record<string, unknown>;
type RunRecord = {
  id: string;
  automationId: string;
  runMode: "script";
  threadId: null;
  status: string;
  trigger: "schedule" | "manual";
  skipReason: string | null;
  error: string | null;
  output: string | null;
  exitCode: number | null;
  scheduledFor: number;
  startedAt: number;
  finishedAt: number | null;
};

type TestContext = FakePluginHost & {
  records: Map<string, AutomationRecord>;
  runs: Map<string, RunRecord[]>;
  calls: Array<{
    pluginId: string;
    method: string;
    input: Record<string, unknown>;
  }>;
  store: Store;
  runtime: Runtime;
  service: ChannelAutomations;
  room: Room;
  agents: ChannelAgent[];
  input: (
    patch?: Partial<z.input<typeof channelAutomationCreateSchema>>,
  ) => z.output<typeof channelAutomationCreateSchema>;
  active: (agent: ChannelAgent, automationId?: string) => string;
};

async function setup(): Promise<TestContext> {
  const records = new Map<string, AutomationRecord>();
  const runs = new Map<string, RunRecord[]>();
  const calls: Array<{
    pluginId: string;
    method: string;
    input: Record<string, unknown>;
  }> = [];
  let sequence = 0;
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "host-primary" }) as never,
      },
      projects: {
        create: async () => ({ id: "proj_agents" }) as never,
      },
      plugins: {
        callRpc: async <T>(args: {
          pluginId: string;
          method: string;
          input?: unknown;
          outputSchema: z.ZodType<T>;
        }) => {
          const input = z
            .record(z.string(), z.unknown())
            .parse(args.input ?? {});
          calls.push({ pluginId: args.pluginId, method: args.method, input });
          if (args.pluginId === "projects") {
            const result = args.method === "agentAssignments"
              ? { global: true, projectIds: [] }
              : { ok: true };
            return args.outputSchema.parse(result);
          }
          if (args.pluginId === "status-sidebar")
            return args.outputSchema.parse({ ok: true });
          if (args.pluginId !== "automations")
            throw new Error(`Unexpected plugin RPC: ${args.pluginId}/${args.method}`);
          const automationId =
            typeof input.automationId === "string" ? input.automationId : "";
          const row = records.get(automationId);
          let result: unknown;
          switch (args.method) {
            case "automations_list":
              result = [...records.values()].filter(
                (automation) => automation.projectId === input.projectId,
              );
              break;
            case "automations_create": {
              const now = Date.now();
              const id = `auto_${++sequence}`;
              const automation = {
                ...input,
                id,
                createdByThreadId: input.createdByThreadId ?? null,
                nextRunAt: input.enabled ? now + 60_000 : null,
                lastRunAt: null,
                runCount: 0,
                lastRunStatus: null,
                lastRunThreadId: null,
                lastError: null,
                createdAt: now,
                updatedAt: now,
              };
              records.set(id, automation);
              result = automation;
              break;
            }
            case "automations_get":
              result = row;
              break;
            case "automations_update":
              Object.assign(row!, input, { updatedAt: Date.now() });
              result = row;
              break;
            case "automations_pause":
              Object.assign(row!, { enabled: false, nextRunAt: null });
              result = row;
              break;
            case "automations_resume":
              Object.assign(row!, {
                enabled: true,
                nextRunAt: Date.now() + 60_000,
              });
              result = row;
              break;
            case "automations_delete":
              records.delete(automationId);
              result = { ok: true };
              break;
            case "automations_run": {
              const run = createRun(
                automationId,
                `run_manual_${++sequence}`,
                "manual",
              );
              runs.set(automationId, [
                ...(runs.get(automationId) ?? []),
                run,
              ]);
              result = { run };
              break;
            }
            case "automations_runs":
              result = {
                runs: runs.get(automationId) ?? [],
                nextCursor: null,
              };
              break;
            default:
              throw new Error(`Unexpected Automations RPC: ${args.method}`);
          }
          return args.outputSchema.parse(result);
        },
      },
    },
  });
  await plugin(host.bb);
  const store = await Store.create(host.bb, host.bb.storage.database());
  await store.ensureProject();
  const profiles = await createProfiles(host.bb, store.db, store);
  const runtime = new Runtime(host.bb, store, profiles);
  const service = new ChannelAutomations(host.bb, store, runtime);
  const agents = store.all().slice(0, 2);
  const room = roomSchema.parse({
    id: randomUUID(),
    name: "Research",
    memberIds: agents.map((agent) => agent.id),
    paused: false,
    responseBehavior: "smart",
    createdAt: 1,
    updatedAt: 1,
  });
  store.putRoom(room);

  const input = (
    patch: Partial<z.input<typeof channelAutomationCreateSchema>> = {},
  ) =>
    channelAutomationCreateSchema.parse({
      channelId: room.id,
      agentId: agents[0]!.id,
      name: "Daily questions",
      prompt: "Summarize open questions.",
      requestId: randomUUID(),
      trigger: {
        triggerType: "schedule",
        cron: "0 9 * * 1-5",
        timezone: "America/New_York",
      },
      ...patch,
    });

  const active = (agent: ChannelAgent, automationId?: string) => {
    const threadId = `thr_${randomUUID()}`;
    const jobId = randomUUID();
    runtime.enqueue(agent, {
      id: jobId,
      text: "Active channel work",
      conversationKey: `group:${room.id}:${jobId}`,
      roomId: room.id,
      runId: jobId,
      status: "running",
      threadId,
      ...(automationId ? { automationId } : {}),
    });
    store.putConversation({
      id: randomUUID(),
      agentId: agent.id,
      key: `group:${room.id}:${jobId}`,
      kind: "group",
      title: room.name,
      threadId,
      createdAt: 1,
    });
    return threadId;
  };

  return {
    ...host,
    records,
    runs,
    calls,
    store,
    runtime,
    service,
    room,
    agents,
    input,
    active,
  };
}

function createRun(
  automationId: string,
  id: string,
  trigger: "schedule" | "manual" = "schedule",
): RunRecord {
  return {
    id,
    automationId,
    runMode: "script",
    threadId: null,
    status: "running",
    trigger,
    skipReason: null,
    error: null,
    output: null,
    exitCode: null,
    scheduledFor: 1,
    startedAt: 1,
    finishedAt: null,
  };
}

async function dispose(test: TestContext) {
  test.runtime.dispose();
  await test.harness.lifecycle.dispose();
}

describe("channel automations", () => {
  it("maps channel creation to the current Automations script input", async () => {
    const test = await setup();
    try {
      const created = await test.service.create(
        test.input({ enabled: false }),
      );
      const call = test.calls.find(
        ({ pluginId, method }) =>
          pluginId === "automations" && method === "automations_create",
      );
      expect(call?.input).toMatchObject({
        projectId: test.agents[0]!.projectId,
        name: "#Research · @pinpoint-fix · Daily questions",
        enabled: false,
        origin: "app",
        trigger: {
          triggerType: "schedule",
          cron: "0 9 * * 1-5",
          timezone: "America/New_York",
        },
        execution: {
          mode: "script",
          interpreter: "sh",
          script: dispatchScript,
          timeoutMs: 60_000,
        },
      });
      expect(created).toMatchObject({
        channelId: test.room.id,
        agentId: test.agents[0]!.id,
        name: "Daily questions",
        enabled: false,
      });
    } finally {
      await dispose(test);
    }
  });

  it("fires once and enqueues one job carrying the automation ID", async () => {
    const test = await setup();
    try {
      const automation = await test.service.create(test.input());
      test.runs.set(automation.id, [createRun(automation.id, "run_1")]);

      const first = await test.service.fire(
        automation.projectId,
        automation.id,
        "run_1",
      );
      const second = await test.service.fire(
        automation.projectId,
        automation.id,
        "run_1",
      );

      expect(second).toEqual(first);
      expect(test.store.roomJobs(test.room.id)).toHaveLength(1);
      expect(test.store.roomJobs(test.room.id)[0]).toMatchObject({
        automationId: automation.id,
        agentId: automation.agentId,
      });
    } finally {
      await dispose(test);
    }
  });

  it("skips a tick while the previous response remains unfinished", async () => {
    const test = await setup();
    try {
      const automation = await test.service.create(test.input());
      test.runs.set(automation.id, [
        createRun(automation.id, "run_1"),
        createRun(automation.id, "run_2"),
      ]);
      await test.service.fire(automation.projectId, automation.id, "run_1");

      await expect(
        test.service.fire(automation.projectId, automation.id, "run_2"),
      ).resolves.toEqual({
        wakeAgent: false,
        reason: "The previous channel response is still unfinished.",
      });
      expect(test.store.roomJobs(test.room.id)).toHaveLength(1);
    } finally {
      await dispose(test);
    }
  });

  it("does not fire for an archived channel or retired agent", async () => {
    const test = await setup();
    try {
      const automation = await test.service.create(test.input());
      test.runs.set(automation.id, [
        createRun(automation.id, "archived"),
        createRun(automation.id, "retired"),
      ]);
      test.store.putRoom({ ...test.room, archived: true });
      await expect(
        test.service.fire(automation.projectId, automation.id, "archived"),
      ).resolves.toMatchObject({ wakeAgent: false });

      test.store.putRoom(test.room);
      test.store.put({ ...test.agents[0]!, retired: true });
      await expect(
        test.service.fire(automation.projectId, automation.id, "retired"),
      ).resolves.toMatchObject({ wakeAgent: false });
      expect(test.store.roomJobs(test.room.id)).toHaveLength(0);
    } finally {
      await dispose(test);
    }
  });

  it("refuses recursive automation changes from scheduled work", async () => {
    const test = await setup();
    try {
      const automation = await test.service.create(test.input());
      const threadId = test.active(test.agents[0]!, automation.id);
      await expect(
        test.service.create(
          test.input({ channelId: undefined, agentId: undefined }),
          threadId,
        ),
      ).rejects.toThrow("Scheduled channel work");
      await expect(
        test.service.update(
          channelAutomationUpdateSchema.parse({
            automationId: automation.id,
            name: "Recursive change",
          }),
          threadId,
        ),
      ).rejects.toThrow("Scheduled channel work");
      await expect(
        test.service.delete(
          channelAutomationTargetSchema.parse({
            automationId: automation.id,
          }),
          threadId,
        ),
      ).rejects.toThrow("Scheduled channel work");
      await expect(
        test.service.run(
          channelAutomationRunSchema.parse({
            automationId: automation.id,
            requestId: randomUUID(),
          }),
          threadId,
        ),
      ).rejects.toThrow("Scheduled channel work");
    } finally {
      await dispose(test);
    }
  });

  it("refuses an agent managing another agent's automation", async () => {
    const test = await setup();
    try {
      const automation = await test.service.create(
        test.input({ agentId: test.agents[1]!.id }),
      );
      const threadId = test.active(test.agents[0]!);
      await expect(
        test.service.update(
          channelAutomationUpdateSchema.parse({
            automationId: automation.id,
            name: "Not mine",
          }),
          threadId,
        ),
      ).rejects.toThrow("only manage its own");
    } finally {
      await dispose(test);
    }
  });
});
