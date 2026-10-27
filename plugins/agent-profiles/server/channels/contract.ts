import { z } from "zod";
import { usageLimits } from "./workspace-contract";

export const agentIdSchema = z.string().uuid();
export const sendModeSchema = z.enum(["auto", "steer", "followup", "fork"]);
export type SendMode = z.infer<typeof sendModeSchema>;

export const channelAgentSchema = z.object({
  id: agentIdSchema,
  kind: z.enum(["full", "thin"]),
  handle: z.string(),
  name: z.string(),
  avatar: z.string(),
  description: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.enum([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "ultracode",
    "max",
    "ultra",
  ]),
  serviceTier: z.string().trim().min(1),
  permissionMode: z.enum(["auto", "accept-edits", "full"]),
  home: z.string(),
  hostId: z.string().nullable(),
  projectId: z.string(),
  paused: z.boolean(),
  retired: z.boolean(),
  limits: usageLimits.optional(),
  intervalMinutes: z.number().int().min(15).max(10_080).nullable(),
  lastWakeAt: z.number(),
  nextWakeAt: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChannelAgent = z.infer<typeof channelAgentSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  agentKind: z.enum(["full", "thin"]).optional(),
  agentId: agentIdSchema,
  key: z.string(),
  threadId: z.string(),
  title: z.string(),
  kind: z.enum(["admin", "group", "mission"]),
  createdAt: z.number(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const attachmentSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  mimeType: z.string().optional(),
  type: z.enum(["localFile", "localImage"]),
  sizeBytes: z.number(),
  alt: z.string().max(500).optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const jobSchema = z.object({
  agentKind: z.enum(["full", "thin"]).optional(),
  delegationId: z.string().optional(),
  returnOf: z.string().optional(),
  timedOut: z.boolean().optional(),
  taskTitle: z.string().optional(),
  queueReason: z.string().optional(),
  queuePosition: z.number().optional(),
  busyThreadId: z.string().optional(),
  busyConversationTitle: z.string().optional(),
  dispatchAction: z.enum(["steer", "followup", "fork"]).optional(),
  forkSourceThreadId: z.string().optional(),
  queueCanSteer: z.boolean().optional(),
  queueCanFork: z.boolean().optional(),
  requiresPromptMatch: z.boolean().optional(),
  pendingSteer: z
    .object({ priorPrompt: z.string(), attemptedAt: z.number().optional() })
    .optional(),
  automationId: z.string().optional(),
  id: z.string(),
  agentId: agentIdSchema,
  conversationKey: z.string(),
  threadId: z.string().nullable(),
  text: z.string(),
  status: z.enum([
    "queued",
    "dispatching",
    "running",
    "done",
    "error",
    "cancelled",
  ]),
  cancellationPending: z.boolean().optional(),
  activitySnippet: z.string().max(240).optional(),
  retryOf: z.string().optional(),
  reply: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  dispatchStartedAt: z.number().nullable().default(null),
  roomId: z.string().nullable(),
  runId: z.string().nullable(),
  triggerMessageId: z.string().nullable().default(null),
  depth: z.number().int().default(0),
  attachments: z.array(attachmentSchema).default([]),
  outputAttachments: z.array(attachmentSchema).default([]),
});
export type Job = z.infer<typeof jobSchema>;

export const emojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine(
    (value) =>
      Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          value,
        ),
      ).length === 1 &&
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value),
    "Choose one emoji.",
  );

export const reactionSchema = z.object({
  messageId: z.string(),
  emoji: emojiSchema,
  actorId: z.string(),
  actorName: z.string(),
  createdAt: z.number(),
});
export type Reaction = z.infer<typeof reactionSchema>;

export const responseBehaviorSchema = z.enum(["smart", "directed"]);
export const roomSchema = z.object({
  limits: usageLimits.optional(),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(agentIdSchema).max(16),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  lastReadAt: z.number().optional(),
  responseBehavior: responseBehaviorSchema,
  paused: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Room = z.infer<typeof roomSchema>;

export const messageSchema = z.object({
  saved: z.boolean().optional(),
  editedAt: z.number().optional(),
  sentText: z.string().optional(),
  sendMode: sendModeSchema.optional(),
  conversationKey: z.string().optional(),
  forkSourceThreadId: z.string().optional(),
  automationId: z.string().optional(),
  id: z.string(),
  roomId: z.string().uuid(),
  runId: z.string(),
  agentId: agentIdSchema.nullable(),
  speaker: z.string(),
  system: z.enum(["bot_joined"]).optional(),
  sourceThreadId: z.string().optional(),
  sourceJobId: z.string().optional(),
  replyTo: z.string().nullable().default(null),
  attachments: z.array(attachmentSchema).default([]),
  text: z.string(),
  createdAt: z.number(),
});
export type RoomMessage = z.infer<typeof messageSchema>;

export const channelFileEntrySchema = z.object({
  attachment: attachmentSchema,
  messageId: z.string(),
  agentId: agentIdSchema.nullable(),
  publisher: z.string(),
  createdAt: z.number(),
});
export type ChannelFileEntry = z.infer<typeof channelFileEntrySchema>;

export const isAutomationTrigger = (
  message: Pick<RoomMessage, "automationId" | "agentId">,
) => !!message.automationId && message.agentId === null;

export const runSchema = z.object({
  id: z.string(),
  roomId: z.string().uuid(),
  status: z.enum(["queued", "running", "done", "stopped"]),
  mode: z.literal("concurrent").optional(),
  pendingJobIds: z.array(z.string()).default([]),
  settledJobIds: z.array(z.string()).default([]),
  round: z.number(),
  remaining: z.array(agentIdSchema),
  next: z.array(agentIdSchema),
  jobId: z.string().nullable(),
  createdAt: z.number(),
  error: z.string().nullable(),
  routing: z.enum(["pending", "done", "error"]).optional(),
  routingError: z.string().optional(),
  routingDepth: z.number().optional(),
  routingAgentIds: z.array(agentIdSchema).optional(),
});
export type RoomRun = z.infer<typeof runSchema>;
