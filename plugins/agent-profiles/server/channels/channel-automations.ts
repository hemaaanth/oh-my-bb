import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isExecuting, isUnfinished } from "./job-state";
import type { Runtime } from "./runtime";
import type { Store } from "./store";
import {
  channelAutomationCreateSchema,
  channelAutomationListSchema,
  channelAutomationRunPageSchema,
  channelAutomationRunSchema,
  channelAutomationRunsSchema,
  channelAutomationTargetSchema,
  channelAutomationUpdateSchema,
  channelAutomationViewSchema,
  channelScheduleSchema,
} from "./automation-contract";

export const dispatchScript = `#!/bin/sh
set -eu
unset BB_THREAD_ID BB_ENVIRONMENT_ID
exec bb agents automation fire "$BB_AUTOMATION_ID" --project "$BB_PROJECT_ID" --run "$BB_AUTOMATION_RUN_ID" --json
`;
export const channelAutomationToolNames = [
  "channel_automation_create",
  "channel_automation_list",
  "channel_automation_update",
  "channel_automation_delete",
  "channel_automation_run",
] as const;

const metadataKey = "BB_AGENTS_CHANNEL_AUTOMATION";
const metadataSchema = z.object({
  version: z.literal(1),
  channelId: z.string().uuid(),
  agentId: z.string().uuid(),
  title: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8_000),
  requestId: z.string().uuid(),
  creationHash: z.string(),
});
type Metadata = z.infer<typeof metadataSchema>;

const scriptExecutionSchema = z.object({
  mode: z.literal("script"),
  script: z.string().optional(),
  scriptFile: z.string().optional(),
  storedScriptPath: z.string().optional(),
  interpreter: z.string().optional(),
  timeoutMs: z.number(),
  env: z.record(z.string(), z.string()).optional(),
});
const automationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: channelScheduleSchema,
  execution: scriptExecutionSchema,
  origin: z.enum(["human", "app", "agent"]),
  createdByThreadId: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  runCount: z.number().int().min(0),
  lastRunStatus: z.string().nullable(),
  lastRunThreadId: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
type Automation = z.infer<typeof automationSchema>;

const runIdentitySchema = z.object({
  id: z.string(),
  status: z.string(),
});

function metadata(automation: Automation): Metadata | null {
  try {
    return metadataSchema.parse(
      JSON.parse(automation.execution.env?.[metadataKey] ?? ""),
    );
  } catch {
    return null;
  }
}

function view(automation: Automation) {
  const stored = metadata(automation);
  if (!stored) throw new Error("This is not a channel automation.");
  return channelAutomationViewSchema.parse({
    ...automation,
    ...stored,
    name: stored.title,
  });
}


function automationName(channel: string, agent: string, title: string) {
  return `#${channel.slice(0, 36)} · @${agent.slice(0, 24)} · ${title}`.slice(
    0,
    120,
  );
}


export class ChannelAutomations {
  private loggedUnavailable = false;

  constructor(
    readonly bb: BbPluginApi,
    readonly store: Store,
    readonly runtime: Runtime,
  ) {}

  private async rpc<T>(
    method: string,
    input: Record<string, unknown>,
    outputSchema: z.ZodType<T>,
  ) {
    try {
      return await this.bb.sdk.plugins.callRpc({
        pluginId: "automations",
        method: `automations_${method}`,
        input: input as never,
        outputSchema,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        /(?:plugin[^\n]*automations|automations[^\n]*plugin)[^\n]*(?:not found|not loaded|unavailable|disabled|missing)/i.test(
          detail,
        )
      ) {
        if (!this.loggedUnavailable) {
          this.loggedUnavailable = true;
          this.bb.log.warn(
            "The built-in Automations plugin is unavailable; channel automations are disabled.",
          );
        }
        throw new Error(
          "Channel automations require BB's built-in Automations plugin. Enable the Automations plugin and try again.",
        );
      }
      throw error;
    }
  }

  private async context(channelId: string | undefined, threadId?: string) {
    const conversation = threadId ? this.store.byThread(threadId) : null;
    const job = conversation
      ? this.store
          .work(conversation.agentId)
          .find(
            (candidate) =>
              candidate.threadId === threadId && isExecuting(candidate),
          )
      : undefined;
    const id = channelId ?? job?.roomId ?? undefined;
    if (!id) throw new Error("Choose a channel for this automation.");
    const room = this.store.room(id);
    let author: { agentId: string | null } | undefined;
    if (threadId) {
      if (!conversation) {
        author = { agentId: null };
      } else {
        const agent = this.store.get(conversation.agentId);
        if (agent.retired) throw new Error("This agent is retired.");
        if (conversation.kind !== "admin" && !job)
          throw new Error("This agent's response is no longer active.");
        if (!room.memberIds.includes(agent.id))
          throw new Error(
            "This agent must be invited to the channel before accessing it.",
          );
        author = { agentId: agent.id };
      }
    }
    const projectId = await this.store.ensureProject();
    return { room, projectId, author };
  }

  private preventRecursion(threadId?: string) {
    if (!threadId) return;
    const conversation = this.store.byThread(threadId);
    if (
      conversation &&
      this.store
        .work(conversation.agentId)
        .some(
          (job) =>
            job.threadId === threadId && isExecuting(job) && job.automationId,
        )
    ) {
      throw new Error(
        "Scheduled channel work cannot create, update, delete, resume, or run automations. Ask the owner in a normal channel response.",
      );
    }
  }

  private async all(projectId: string) {
    const rows = await this.rpc("list", { projectId }, z.array(z.unknown()));
    return rows.flatMap((row) => {
      const result = automationSchema.safeParse(row);
      return result.success && metadata(result.data) ? [result.data] : [];
    });
  }

  async list(
    input: z.output<typeof channelAutomationListSchema>,
    threadId?: string,
  ) {
    const { room, projectId } = await this.context(input.channelId, threadId);
    const rows = (await this.all(projectId)).filter(
      (automation) => metadata(automation)!.channelId === room.id,
    );
    return {
      automations: rows
        .slice(input.offset, input.offset + input.limit)
        .map(view),
      nextOffset:
        input.offset + input.limit < rows.length
          ? input.offset + input.limit
          : null,
    };
  }

  async create(
    input: z.output<typeof channelAutomationCreateSchema>,
    threadId?: string,
  ) {
    this.preventRecursion(threadId);
    const context = await this.context(input.channelId, threadId);
    return this.runtime.locked(
      `automation-create:${context.projectId}`,
      async () => {
        const { room, projectId, author } = await this.context(
          context.room.id,
          threadId,
        );
        const agentId = input.agentId ?? author?.agentId ?? undefined;
        if (!agentId)
          throw new Error("Choose the agent that will perform this automation.");
        if (author?.agentId && author.agentId !== agentId)
          throw new Error("An agent can only schedule its own channel work.");
        const agent = this.store.get(agentId);
        if (room.archived || agent.retired || !room.memberIds.includes(agentId))
          throw new Error("Choose an active agent that belongs to this channel.");
        const creationHash = createHash("sha256")
          .update(
            JSON.stringify([
              room.id,
              agentId,
              input.name,
              input.prompt,
              input.trigger,
              input.enabled,
              threadId ?? null,
            ]),
          )
          .digest("hex");
        const existing = (await this.all(projectId)).find(
          (automation) => metadata(automation)!.requestId === input.requestId,
        );
        if (existing) {
          if (metadata(existing)!.creationHash !== creationHash)
            throw new Error(
              "This requestId was already used for another automation.",
            );
          return view(existing);
        }
        const stored: Metadata = {
          version: 1,
          channelId: room.id,
          agentId,
          title: input.name,
          prompt: input.prompt,
          requestId: input.requestId,
          creationHash,
        };
        const automation = await this.rpc(
          "create",
          {
            projectId,
            name: automationName(room.name, agent.handle, input.name),
            enabled: input.enabled,
            trigger: input.trigger,
            origin: threadId ? "agent" : "app",
            ...(threadId ? { createdByThreadId: threadId } : {}),
            execution: this.execution(stored),
          },
          automationSchema,
        );
        this.runtime.changed();
        return view(automation);
      },
    );
  }

  private execution(stored: Metadata) {
    return {
      mode: "script" as const,
      interpreter: "sh",
      script: dispatchScript,
      timeoutMs: 60_000,
      env: { [metadataKey]: JSON.stringify(stored) },
    };
  }

  private async target(
    channelId: string | undefined,
    automationId: string,
    threadId?: string,
  ) {
    const { room, projectId, author } = await this.context(channelId, threadId);
    const automation = await this.rpc(
      "get",
      { projectId, automationId },
      automationSchema,
    );
    const stored = metadata(automation);
    if (!stored || stored.channelId !== room.id)
      throw new Error("Automation not found in this channel.");
    if (author?.agentId && author.agentId !== stored.agentId)
      throw new Error("An agent can only manage its own channel automations.");
    return {
      automation,
      stored,
      room,
      agent: this.store.get(stored.agentId),
      projectId,
    };
  }

  async update(
    input: z.output<typeof channelAutomationUpdateSchema>,
    threadId?: string,
  ) {
    this.preventRecursion(threadId);
    return this.runtime.locked(`automation:${input.automationId}`, async () => {
      const { stored, room, agent, projectId } = await this.target(
        input.channelId,
        input.automationId,
        threadId,
      );
      const next = {
        ...stored,
        ...(input.name !== undefined ? { title: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      };
      const result = await this.rpc(
        "update",
        {
          projectId,
          automationId: input.automationId,
          ...(input.name !== undefined
            ? { name: automationName(room.name, agent.handle, input.name) }
            : {}),
          ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
          ...(input.name !== undefined || input.prompt !== undefined
            ? { execution: this.execution(next) }
            : {}),
        },
        automationSchema,
      );
      this.runtime.changed();
      return view(result);
    });
  }

  private async action(
    action: "delete" | "pause" | "resume" | "run",
    input: z.output<typeof channelAutomationTargetSchema> & {
      requestId?: string;
    },
    threadId?: string,
  ) {
    if (action === "delete" || action === "resume" || action === "run")
      this.preventRecursion(threadId);
    const { stored, room, agent, projectId } = await this.target(
      input.channelId,
      input.automationId,
      threadId,
    );
    if (
      (action === "resume" || action === "run") &&
      (room.archived || agent.retired || !room.memberIds.includes(stored.agentId))
    ) {
      throw new Error(
        "Restore the channel and invite its agent before running this automation.",
      );
    }
    const result = await this.rpc(
      action,
      {
        projectId,
        automationId: input.automationId,
        ...(action === "run" ? { idempotencyKey: input.requestId } : {}),
      },
      z.unknown(),
    );
    this.runtime.changed();
    return result;
  }

  async delete(
    input: z.output<typeof channelAutomationTargetSchema>,
    threadId?: string,
  ) {
    await this.action("delete", input, threadId);
    return { ok: true as const };
  }

  async pause(
    input: z.output<typeof channelAutomationTargetSchema>,
    threadId?: string,
  ) {
    await this.action("pause", input, threadId);
    return { ok: true as const };
  }

  async resume(
    input: z.output<typeof channelAutomationTargetSchema>,
    threadId?: string,
  ) {
    await this.action("resume", input, threadId);
    return { ok: true as const };
  }

  async run(
    input: z.output<typeof channelAutomationRunSchema>,
    threadId?: string,
  ) {
    const result = (await this.action("run", input, threadId)) as
      | { run?: { id?: unknown } }
      | null;
    return {
      ok: true as const,
      runId: typeof result?.run?.id === "string" ? result.run.id : null,
    };
  }

  async runs(
    input: z.output<typeof channelAutomationRunsSchema>,
    threadId?: string,
  ) {
    const { projectId } = await this.target(
      input.channelId,
      input.automationId,
      threadId,
    );
    const page = await this.rpc(
      "runs",
      {
        projectId,
        automationId: input.automationId,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      channelAutomationRunPageSchema,
    );
    return {
      ...page,
      runs: page.runs.map((run) => {
        const jobs = this.store.requestJobs(
          `automation:${input.automationId}:${run.id}`,
        );
        const current = jobs.filter(
          (job) => !jobs.some((retry) => retry.retryOf === job.id),
        );
        const pending = current.find(isUnfinished);
        const failed = current.find((job) => job.status === "error");
        const last = current.at(-1);
        const response = current.find((job) => !!this.store.message(job.id));
        return {
          ...run,
          ...(last
            ? {
                responseStatus:
                  pending?.status ?? failed?.status ?? last.status,
                ...(last.threadId
                  ? { responseThreadId: last.threadId }
                  : {}),
                ...(response ? { responseMessageId: response.id } : {}),
                ...(failed?.error ? { responseError: failed.error } : {}),
              }
            : {}),
          output: run.output?.slice(0, 2_000) ?? null,
          error: run.error?.slice(0, 2_000) ?? null,
        };
      }),
    };
  }

  async fire(
    projectId: string,
    automationId: string,
    runId: string,
    threadId?: string,
    signal?: AbortSignal,
  ) {
    if (threadId)
      throw new Error(
        "Only the automation runner can fire scheduled channel work. Use Run now instead.",
      );
    const automation = await this.rpc(
      "get",
      { projectId, automationId },
      automationSchema,
    );
    const stored = metadata(automation);
    if (!stored || automation.execution.script !== dispatchScript)
      throw new Error("This automation is not a channel dispatcher.");
    return this.runtime.locked(`room:${stored.channelId}`, async () => {
      signal?.throwIfAborted();
      const { runs } = await this.rpc(
        "runs",
        { projectId, automationId, limit: 100 },
        z.object({ runs: z.array(runIdentitySchema) }),
      );
      signal?.throwIfAborted();
      if (!runs.some((run) => run.id === runId && run.status === "running"))
        throw new Error("Automation run is no longer active.");
      const room = this.store.findRoom(stored.channelId);
      const agent = this.store.all().find((candidate) => candidate.id === stored.agentId);
      if (
        !room ||
        room.archived ||
        !agent ||
        agent.retired ||
        !room.memberIds.includes(agent.id)
      ) {
        return {
          wakeAgent: false,
          reason: "Channel or agent is no longer active.",
        };
      }
      if (agent.projectId !== projectId)
        throw new Error("Automation belongs to a different project.");
      const requestId = `automation:${automationId}:${runId}`;
      const existing = this.store.message(requestId);
      if (existing) return { requestId: existing.id, channelId: room.id };
      if (
        this.store
          .roomJobs(room.id, -1)
          .some(
            (job) =>
              job.automationId === automationId && isUnfinished(job),
          )
      ) {
        return {
          wakeAgent: false,
          reason: "The previous channel response is still unfinished.",
        };
      }
      this.runtime.sendScheduled(
        room,
        agent.id,
        automationId,
        stored.title,
        stored.prompt,
        requestId,
      );
      return { requestId, channelId: room.id };
    });
  }

  registerTools() {
    const names: string[] = [];
    const register = <Schema extends z.ZodType>(
      name: string,
      description: string,
      parameters: Schema,
      execute: (
        input: z.output<Schema>,
        threadId: string,
      ) => Promise<unknown>,
    ) => {
      names.push(name);
      this.bb.agents.registerTool({
        name,
        description,
        parameters,
        execute: async (input, context) =>
          JSON.stringify(await execute(input, context.threadId)),
      });
    };
    register(
      "channel_automation_create",
      "Schedule your own work in your current channel. Use cron with an IANA timezone or a one-time runAt in Unix milliseconds. Reuse requestId after an uncertain result. The schedule is enabled unless enabled is false.",
      channelAutomationCreateSchema,
      (input, threadId) => this.create(input, threadId),
    );
    register(
      "channel_automation_list",
      "List automations in your current channel. Page with offset.",
      channelAutomationListSchema,
      (input, threadId) => this.list(input, threadId),
    );
    register(
      "channel_automation_update",
      "Update your own channel automation's name, prompt, or schedule. Omitted fields stay unchanged.",
      channelAutomationUpdateSchema,
      (input, threadId) => this.update(input, threadId),
    );
    register(
      "channel_automation_delete",
      "Delete one of your channel automations.",
      channelAutomationTargetSchema,
      (input, threadId) => this.delete(input, threadId),
    );
    register(
      "channel_automation_run",
      "Run one of your channel automations now. Reuse requestId after an uncertain result.",
      channelAutomationRunSchema,
      (input, threadId) => this.run(input, threadId),
    );
    return names;
  }
}
