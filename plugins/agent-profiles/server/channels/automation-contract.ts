import { z } from "zod";
import { agentIdSchema } from "./contract";

export const channelScheduleSchema = z.discriminatedUnion("triggerType", [
  z
    .object({
      triggerType: z.literal("schedule"),
      cron: z.string().trim().min(1).max(256),
      timezone: z.string().trim().min(1).max(100),
    })
    .strict(),
  z
    .object({
      triggerType: z.literal("once"),
      runAt: z.number().int().positive(),
    })
    .strict(),
]);

const channel = { channelId: z.string().uuid().optional() };
const fields = {
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8_000),
  trigger: channelScheduleSchema,
};

export const channelAutomationCreateSchema = z
  .object({
    ...channel,
    ...fields,
    agentId: agentIdSchema.optional(),
    requestId: z.string().uuid(),
    enabled: z.boolean().default(true),
  })
  .strict();

export const channelAutomationListSchema = z
  .object({
    ...channel,
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const channelAutomationUpdateSchema = z
  .object({
    ...channel,
    automationId: z.string().min(1),
    name: fields.name.optional(),
    prompt: fields.prompt.optional(),
    trigger: fields.trigger.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.prompt !== undefined ||
      value.trigger !== undefined,
    "Provide a name, prompt, or schedule to update.",
  );

export const channelAutomationTargetSchema = z
  .object({
    ...channel,
    automationId: z.string().min(1),
  })
  .strict();

export const channelAutomationRunSchema = channelAutomationTargetSchema
  .extend({ requestId: z.string().uuid() })
  .strict();

export const channelAutomationViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  channelId: z.string().uuid(),
  agentId: agentIdSchema,
  name: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  trigger: channelScheduleSchema,
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  runCount: z.number().int().min(0),
  lastRunStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChannelAutomation = z.infer<typeof channelAutomationViewSchema>;

export const channelAutomationRunsSchema = z
  .object({
    ...channel,
    automationId: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const channelAutomationRunPageSchema = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      automationId: z.string(),
      runMode: z.enum(["agent", "script"]),
      threadId: z.string().nullable(),
      status: z.string(),
      trigger: z.enum(["schedule", "manual"]),
      scheduledFor: z.number(),
      startedAt: z.number(),
      finishedAt: z.number().nullable(),
      error: z.string().nullable(),
      skipReason: z.string().nullable(),
      output: z.string().nullable(),
      exitCode: z.number().int().nullable(),
      responseStatus: z.string().optional(),
      responseThreadId: z.string().optional(),
      responseMessageId: z.string().optional(),
      responseError: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type ChannelAutomationRunPage = z.infer<
  typeof channelAutomationRunPageSchema
>;
