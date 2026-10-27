import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import {
  channelAutomationCreateSchema,
  channelAutomationListSchema,
  channelAutomationRunPageSchema,
  channelAutomationRunSchema,
  channelAutomationRunsSchema,
  channelAutomationTargetSchema,
  channelAutomationUpdateSchema,
  channelAutomationViewSchema,
} from "./channels/automation-contract";
import {
  attachmentSchema,
  channelAgentSchema,
  channelFileEntrySchema,
  conversationSchema,
  emojiSchema,
  jobSchema,
  messageSchema,
  reactionSchema,
  responseBehaviorSchema,
  sendModeSchema,
  roomSchema,
  runSchema,
} from "./channels/contract";
import {
  channelContext,
  contextContent,
  revisionSchema,
  usageLimits,
  usageSummary,
} from "./channels/workspace-contract";
import { modelLevels, modelModes } from "./model-levels";
import {
  permissionModes,
  profileKinds,
  profileSlugPattern,
  reasoningLevels,
} from "./profile-options";

export { permissionModes, profileKinds, reasoningLevels };
export const profileSlugSchema = z
  .string()
  .trim()
  .regex(profileSlugPattern)
  .max(60);
export const missionScheduleIntervalSchema = z
  .number()
  .int()
  .min(15)
  .max(10_080)
  .nullable();

export const profileInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  slug: profileSlugSchema,
  kind: z.enum(profileKinds).default("full"),
  description: z.string().trim().max(240),
  avatar: z.string().max(16).default("🤖"),
  modelMode: z.enum(modelModes).default("level"),
  level: z.enum(modelLevels).default("medium"),
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: z.enum(reasoningLevels),
  serviceTier: z.string().trim().min(1),
  permissionMode: z.enum(permissionModes),
  instructions: z.string().trim().max(32_000),
  skillIds: z.array(z.string().trim().min(1).max(200)).max(100),
  mcpServerIds: z.array(z.string().trim().min(1).max(200)).max(100),
  runProjectId: z.string().min(1).nullable().default(null),
  runHostId: z.string().min(1).nullable().default(null),
  // Reuse the run project's checkout instead of a new worktree per thread.
  runInCheckout: z.boolean().default(false),
  // Hidden agents still work through mentions, delegation and plugins; they only leave the Bots list.
  showInSidebar: z.boolean().default(true),
  isDefault: z.boolean(),
}).strict();
const saveProfileInputSchema = profileInputSchema.extend({
  expectedRevision: z.number().int().positive().optional(),
});

export const profileSchema = profileInputSchema.extend({
  id: z.string().uuid(),
  memoryKey: z.string().regex(/^agent-[a-z0-9-]+$/u),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  homeReady: z.boolean(),
  intervalMinutes: missionScheduleIntervalSchema,
});

export const environmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reuse"), environmentId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("project-default") }).strict(),
  z.object({
    type: z.literal("host"),
    hostId: z.string().min(1).optional(),
    workspace: z.discriminatedUnion("type", [
      z.object({ type: z.literal("personal") }).strict(),
      z.object({
        type: z.literal("unmanaged"),
        path: z.string().nullable(),
        branch: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("existing"), name: z.string().min(1) }).strict(),
          z.object({ kind: z.literal("new"), baseBranch: z.string().min(1) }).strict(),
        ]).optional(),
      }).strict(),
      z.object({
        type: z.literal("managed-worktree"),
        baseBranch: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("default") }).strict(),
          z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
        ]),
      }).strict(),
    ]),
  }).strict(),
]);

const historicalProfileSchema = profileInputSchema.extend({ piHarness: z.boolean().optional() });
const v1ExportProfileSchema = historicalProfileSchema.omit({
  id: true,
  avatar: true,
  modelMode: true,
  level: true,
  kind: true,
});
const v2ExportProfileSchema = historicalProfileSchema.omit({
  kind: true,
}).extend({
  mission: z.string().max(64_000).optional(),
});
const v3ExportProfileSchema = historicalProfileSchema.omit({ id: true }).extend({
  mission: z.string().max(64_000).optional(),
});
export const exportSchema = z.union([
  z.object({
    schemaVersion: z.literal(1),
    profiles: z.array(v1ExportProfileSchema),
  }),
  z.object({
    schemaVersion: z.literal(2),
    profiles: z.array(v2ExportProfileSchema),
  }),
  z.object({
    schemaVersion: z.literal(3),
    profiles: z.array(v3ExportProfileSchema),
  }),
  z.object({
    schemaVersion: z.literal(4),
    profiles: z.array(profileInputSchema.omit({ id: true }).extend({
      mission: z.string().max(64_000).optional(),
    })),
  }),
]);
export const spawnInputSchema = z.object({
  profileId: z.string().uuid().nullable().optional(),
  projectId: z.string().min(1).optional(),
  environment: environmentSchema.optional(),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
  parentThreadId: z.string().min(1).optional(),
  visibility: z.enum(["visible", "hidden"]).optional(),
}).strict();
export const builtInProfileRoleSchema = z.enum(["pinpoint-review", "text-edit", "pr-review"]);
export const spawnBuiltInProfileInputSchema = spawnInputSchema
  .omit({ profileId: true })
  .extend({ profile: builtInProfileRoleSchema });

export const agentAssignmentsSchema = z.object({ global: z.boolean(), projectIds: z.array(z.string()) });
export const okSchema = z.object({ ok: z.literal(true) });
export const retainedMembershipSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("agentPreferences"), state: z.literal("retained-only"),
}).strict();
const threadVisibilitySchema = z.enum(["visible", "hidden"]);
export const threadMemberSchema = z.object({
  profileId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  avatar: z.string(),
  childThreadId: z.string().nullable(),
  status: z.string(),
  visibility: threadVisibilitySchema.nullable(),
});
/** Last line of the fixed header the delegate tool puts before the task. */
export const DELEGATION_HEADER_END =
  "Complete the bounded task below, report concrete results back to the parent thread, and do not broaden the scope without identifying the blocker.";

export const delegationStatusSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  visibility: threadVisibilitySchema,
  profile: z.string(),
  profileId: z.string().uuid(),
  profileName: z.string(),
  avatar: z.string(),
  task: z.string().nullable(),
});
export const sandboxAgentIdsSchema = z.array(z.string());
export const delegateAgentProfileParametersSchema = z.object({
  profileId: z.string().uuid(),
  task: z.string().trim().min(1).max(100_000),
  why: z.string().trim().min(1).max(1_000),
  title: z.string().trim().min(1).max(160).optional(),
  mode: z.enum(["auto", "fresh", "continue"]).default("auto"),
}).strict();
export const agentDocumentFileSchema = z.enum(["MISSION.md", "PERSONA.md"]);
export const agentDocumentReadParametersSchema = z.object({
  file: agentDocumentFileSchema,
}).strict();
export const agentPersonaUpdateParametersSchema = z.object({
  text: z.string().trim().min(1).max(32_000),
  version: z.string().length(64),
}).strict();
const agentDocumentSchema = z.object({
  text: z.string(),
  version: z.string().length(64),
});
const documentRevisionSchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
  actor: z.string(),
  createdAt: z.number().int().nonnegative(),
});
export const phase2ResponseBehaviorSchema = responseBehaviorSchema;
export const channelSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  pinned: z.boolean(),
  unread: z.boolean(),
  active: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  updatedAt: z.number(),
}).strict();
const roomInputSchema = z.object({
  responseBehavior: phase2ResponseBehaviorSchema.optional(),
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(z.string().uuid()).max(16),
});
const transcriptPageSchema = z.object({
  messages: z.array(messageSchema),
  parents: z.array(messageSchema),
  reactions: z.array(reactionSchema),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
});
const delegationWaitSchema = z.object({
  requesterAgentId: z.string().uuid(),
  delegateAgentIds: z.array(z.string().uuid()).min(1),
}).strict();
const transcriptInputSchema = z.object({
  id: z.string().uuid(),
  before: z.string().optional(),
  after: z.string().optional(),
  around: z.string().optional(),
}).strict().refine(
  (input) =>
    [input.before, input.after, input.around].filter(
      (value) => value !== undefined,
    ).length <= 1,
  "Choose one transcript cursor.",
);

export const artifactReferenceSchema = z.object({
  id: z.string().uuid(),
  revision: z.string().uuid(),
}).strict();
export const artifactSummarySchema = z.discriminatedUnion("available", [
  artifactReferenceSchema.extend({
    available: z.literal(true),
    title: z.string(),
    kind: z.enum(["report", "pr-review"]),
    sequence: z.number().int().positive(),
    revisionCreatedAt: z.string(),
  }).strict(),
  artifactReferenceSchema.extend({
    available: z.literal(false),
  }).strict(),
]);
export const channelArtifactReferenceSchema = artifactReferenceSchema.extend({
  messageId: z.string(),
  publisher: z.string(),
  createdAt: z.number(),
}).strict();


export const agentsSidebarSchema = z.object({
  agents: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    avatar: z.string(),
    dmThreadId: z.string().nullable(),
  }).strict()),
  excludedThreadIds: z.array(z.string()),
}).strict();


export const rpcContract = defineRpcContract({
  assignmentStatus: { input: z.null(), output: retainedMembershipSchema },
  // Historical saved selection only; never an access decision.
  getSandboxAgents: { input: z.object({ hostId: z.string().min(1) }).strict(), output: retainedMembershipSchema.extend({ agentIds: z.array(z.string()).nullable() }) },
  setSandboxAgents: { input: z.object({ hostId: z.string().min(1), agentIds: z.array(z.string().uuid()).max(100) }).strict(), output: okSchema },
  listProfiles: { input: z.null(), output: z.array(profileSchema) },
  agentsSidebar: { input: z.null(), output: agentsSidebarSchema },
  getLongMemory: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  setLongMemory: {
    input: z.object({ threadId: z.string().min(1), enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  profilesForProject: { input: z.object({ projectId: z.string().min(1) }).strict(), output: z.array(profileSchema) },
  saveProfile: { input: saveProfileInputSchema, output: profileSchema },
  deleteProfile: { input: z.object({ id: z.string().uuid() }).strict(), output: z.object({ ok: z.literal(true) }) },
  retireAgent: {
    input: z.object({
      id: z.string().uuid(),
      retired: z.boolean(),
    }).strict(),
    output: channelAgentSchema,
  },
  profileHistory: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.array(z.object({ revision: z.number().int().positive(), snapshot: historicalProfileSchema, createdAt: z.string() })),
  },
  agentDocument: {
    input: z.object({
      id: z.string().uuid(),
      file: agentDocumentFileSchema,
    }).strict(),
    output: agentDocumentSchema,
  },
  saveAgentDocument: {
    input: z.object({
      id: z.string().uuid(),
      file: agentDocumentFileSchema,
      text: z.string().max(64_000),
      version: z.string().length(64),
    }).strict(),
    output: agentDocumentSchema,
  },
  documentHistory: {
    input: z.object({
      id: z.string().uuid(),
      file: agentDocumentFileSchema,
      before: z.number().int().positive().optional(),
    }).strict(),
    output: z.array(documentRevisionSchema),
  },
  agentDetail: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({
      profile: profileSchema,
      runsInLocked: z.boolean(),
      home: z.object({
        path: z.string(),
        hostId: z.string().nullable(),
        ready: z.boolean(),
      }),
    }),
  },
  providers: {
    input: z.null(),
    output: z.array(z.object({
      id: z.string(),
      displayName: z.string(),
      supportsServiceTier: z.boolean(),
      permissionModes: z.array(z.enum(permissionModes)),
    })),
  },
  models: {
    input: z.object({ providerId: z.string().min(1) }).strict(),
    output: z.array(z.object({
      model: z.string(),
      displayName: z.string(),
      reasoningLevels: z.array(z.enum(reasoningLevels)),
      defaultReasoningLevel: z.enum(reasoningLevels),
    })),
  },
  modelLevelPreview: {
    input: z.object({ level: z.enum(modelLevels) }).strict(),
    output: z.object({
      codex: z.object({
        providerId: z.string(),
        model: z.string(),
        displayName: z.string(),
        reasoningLevel: z.enum(reasoningLevels),
        family: z.literal("codex"),
        reason: z.string(),
      }),
    }),
  },
  ensureAgentDm: {
    input: z.object({ profileId: z.string().uuid() }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  spawnProfile: {
    input: spawnInputSchema,
    output: z.object({
      threadId: z.string(),
      environmentId: z.string().nullable(),
      profileId: z.string().uuid(),
      revision: z.number().int().positive(),
    }),
  },
  spawnBuiltInProfile: {
    input: spawnBuiltInProfileInputSchema,
    output: z.object({
      threadId: z.string(),
      environmentId: z.string().nullable(),
      profileId: z.string().uuid(),
      revision: z.number().int().positive(),
    }),
  },
  exportProfiles: { input: z.null(), output: exportSchema },
  importProfiles: { input: exportSchema, output: z.object({ imported: z.number().int().nonnegative() }) },
  catalogContextForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    // `bound` is false when the thread only falls back to the default agent.
    output: z.object({ profileId: z.string().uuid().nullable(), bound: z.boolean() }),
  },
  agentAvailability: {
    input: z.object({ agentId: z.string().uuid().nullable() }).strict(),
    output: retainedMembershipSchema.extend({
      global: z.boolean(),
      projectIds: z.array(z.string()),
      projects: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
    }),
  },
  setAgentAvailability: {
    input: z.object({ agentId: z.string().uuid(), projectId: z.string().nullable(), enabled: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  refreshAvailability: {
    input: z.null(),
    output: z.object({ ok: z.literal(true) }),
  },
  delegationStatus: {
    input: z.object({ childThreadId: z.string().min(1), parentThreadId: z.string().min(1) }).strict(),
    output: delegationStatusSchema,
  },
  threadMembers: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.array(threadMemberSchema),
  },
  removeThreadMember: {
    input: z.object({ threadId: z.string().min(1), profileId: z.string().uuid() }).strict(),
    output: okSchema,
  },
  promoteDelegation: {
    input: z.object({ childThreadId: z.string().min(1), parentThreadId: z.string().min(1) }).strict(),
    output: okSchema,
  },
  channelsList: {
    input: z.null(),
    output: z.object({
      agents: z.array(channelAgentSchema),
      rooms: z.array(roomSchema),
      activeRoomIds: z.array(z.string()),
    }),
  },
  channelSummaries: {
    input: z.null(),
    output: z.array(channelSummarySchema),
  },
  createRoom: {
    input: roomInputSchema.extend({
      name: roomInputSchema.shape.name.optional(),
      requestId: z.string().uuid().optional(),
    }).strict(),
    output: roomSchema,
  },
  updateRoom: {
    input: roomInputSchema.extend({
      id: z.string().uuid(),
      memberIds: roomInputSchema.shape.memberIds.optional(),
    }).strict(),
    output: roomSchema,
  },
  deleteRoom: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  room: {
    input: z.object({
      id: z.string().uuid(),
      start: z.string().optional(),
      limit: z.number().int().min(1).max(150).default(50),
    }).strict(),
    output: z.union([
      transcriptPageSchema.extend({
        room: roomSchema,
        runs: z.array(runSchema),
        jobs: z.array(jobSchema),
        delegationWaits: z.array(delegationWaitSchema),
      }),
      z.object({ missing: z.literal("channel") }).strict(),
    ]),
  },
  transcript: {
    input: transcriptInputSchema,
    output: z.union([
      transcriptPageSchema,
      z.object({ missing: z.enum(["channel", "message"]) }).strict(),
    ]),
  },
  history: {
    input: z.object({
      id: z.string().uuid(),
      before: z.string().optional(),
      query: z.string().trim().max(500).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    output: z.object({
      messages: z.array(messageSchema),
      parents: z.array(messageSchema),
      nextBefore: z.string().nullable(),
    }),
  },
  send: {
    input: z.object({
      sendMode: sendModeSchema.optional(),
      id: z.string().uuid(),
      text: z.string().trim().max(16_000),
      attachmentIds: z.array(z.string().uuid()).max(10).default([]),
      replyTo: z.string().nullable().default(null),
      requestId: z.string().uuid(),
    }).strict(),
    output: messageSchema,
  },
  member: {
    input: z.object({
      id: z.string().uuid(),
      agentId: z.string().uuid(),
      present: z.boolean(),
    }).strict(),
    output: roomSchema,
  },
  channelState: {
    input: z.object({
      id: z.string().uuid(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      lastReadAt: z.number().optional(),
      rememberDefault: z.boolean().optional(),
      responseBehavior: phase2ResponseBehaviorSchema.optional(),
    }).strict(),
    output: roomSchema,
  },
  reaction: {
    input: z.object({
      id: z.string().uuid(),
      messageId: z.string(),
      emoji: emojiSchema,
      active: z.boolean(),
    }).strict(),
    output: z.array(reactionSchema),
  },
  upload: {
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(255),
      mimeType: z.string().max(150),
      data: z.string().max(12_000_000),
    }).strict(),
    output: attachmentSchema,
  },
  discardAttachment: {
    input: z.object({
      id: z.string().uuid(),
      attachmentId: z.string().uuid(),
    }).strict(),
    output: okSchema,
  },
  composer: {
    input: z.null(),
    output: z.object({ voiceEnabled: z.boolean() }),
  },
  transcribe: {
    input: z.object({
      data: z.string().max(12_000_000),
      mimeType: z.string().max(150),
      prompt: z.string().max(16_000).optional(),
    }).strict(),
    output: z.object({ text: z.string() }),
  },
  cancelJob: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ cancelled: z.boolean() }),
  },
  queuedJobAction: {
    input: z.object({
      jobId: z.string(),
      action: z.enum(["steer", "fork"]),
    }).strict(),
    output: z.object({
      status: z.enum(["steered", "forked", "sent"]),
      jobId: z.string(),
    }).strict(),
  },
  retryJob: {
    input: z.object({ id: z.string() }).strict(),
    output: jobSchema,
  },
  stopRoom: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: roomSchema,
  },
  resumeRoom: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: roomSchema,
  },
  channelContext: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: channelContext,
  },
  saveChannelContext: {
    input: contextContent.extend({
      id: z.string().uuid(),
      version: z.number().int(),
    }).strict(),
    output: channelContext,
  },
  contextHistory: {
    input: z.object({
      id: z.string().uuid(),
      before: z.number().optional(),
    }).strict(),
    output: z.array(revisionSchema),
  },
  channelFiles: {
    input: z.object({
      id: z.string().uuid(),
      before: z.string().uuid().optional(),
    }).strict(),
    output: z.object({
      files: z.array(channelFileEntrySchema),
      nextBefore: z.string().nullable(),
    }),
  },
  artifactSummaries: {
    input: z.object({
      references: z.array(artifactReferenceSchema).max(100),
    }).strict(),
    output: z.array(artifactSummarySchema),
  },
  channelArtifactReferences: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.array(channelArtifactReferenceSchema).max(100),
  },
  usage: {
    input: z.object({
      id: z.string(),
      kind: z.enum(["agent", "channel"]),
    }).strict(),
    output: usageSummary,
  },
  saveLimits: {
    input: z.object({
      id: z.string(),
      kind: z.enum(["agent", "channel"]),
      limits: usageLimits,
    }).strict(),
    output: usageSummary,
  },
  editMessage: {
    input: z.object({
      id: z.string().uuid(),
      messageId: z.string(),
      text: z.string().trim().min(1).max(16_000),
      expectedText: z.string(),
    }).strict(),
    output: messageSchema,
  },
  saveMessage: {
    input: z.object({
      id: z.string().uuid(),
      messageId: z.string(),
      saved: z.boolean(),
    }).strict(),
    output: messageSchema,
  },
  savedMessages: {
    input: z.object({
      id: z.string().uuid(),
      before: z.string().optional(),
    }).strict(),
    output: z.array(messageSchema),
  },
  agentActivity: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({
      agent: channelAgentSchema,
      conversations: z.array(conversationSchema),
      jobs: z.array(jobSchema),
    }),
  },
  setMissionSchedule: {
    input: z.object({
      id: z.string().uuid(),
      intervalMinutes: missionScheduleIntervalSchema,
    }).strict(),
    output: channelAgentSchema,
  },
  wake: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({ queued: z.boolean() }),
  },
  pause: {
    input: z.object({
      id: z.string().uuid(),
      paused: z.boolean(),
    }).strict(),
    output: channelAgentSchema,
  },
  retire: {
    input: z.object({
      id: z.string().uuid(),
      retired: z.boolean(),
    }).strict(),
    output: channelAgentSchema,
  },
  automationList: {
    input: channelAutomationListSchema,
    output: z.object({
      automations: z.array(channelAutomationViewSchema),
      nextOffset: z.number().int().nullable(),
    }),
  },
  automationCreate: {
    input: channelAutomationCreateSchema,
    output: channelAutomationViewSchema,
  },
  automationUpdate: {
    input: channelAutomationUpdateSchema,
    output: channelAutomationViewSchema,
  },
  automationDelete: {
    input: channelAutomationTargetSchema,
    output: okSchema,
  },
  automationPause: {
    input: channelAutomationTargetSchema,
    output: okSchema,
  },
  automationResume: {
    input: channelAutomationTargetSchema,
    output: okSchema,
  },
  automationRun: {
    input: channelAutomationRunSchema,
    output: z.object({
      ok: z.literal(true),
      runId: z.string().nullable(),
    }),
  },
  automationRuns: {
    input: channelAutomationRunsSchema,
    output: channelAutomationRunPageSchema,
  },
});

export type ProfileInput = z.infer<typeof profileInputSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type ProfileEnvironment = z.infer<typeof environmentSchema> | NewThreadRequest["environment"];
export type DelegationEnvironment = z.infer<typeof environmentSchema>;
export type BuiltInProfileRole = z.infer<typeof builtInProfileRoleSchema>;
export type SpawnInput = z.infer<typeof spawnInputSchema>;
export type SpawnBuiltInProfileInput = z.infer<typeof spawnBuiltInProfileInputSchema>;
export type ExportData = z.infer<typeof exportSchema>;
export type AgentDocumentFile = z.infer<typeof agentDocumentFileSchema>;
