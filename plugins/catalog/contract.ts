import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const assignmentKinds = ["global", "project", "project-environment", "agent-profile"] as const;
export const assignmentKindSchema = z.enum(assignmentKinds);
export const harnessIds = ["bb", "claude-code", "codex", "omp", "pi", "prime-agent", "exo", "fx"] as const;
export const harnessIdSchema = z.enum(harnessIds);
const targetIdSchema = z.string().min(1).max(200);

/**
 * A skill an Executor app ships, as BB projects it. `sourceId` is the app slug,
 * `sourceName` the app name, and `revision` and `digest` the skill's revision.
 */
export const skillSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  name: z.string(),
  description: z.string(),
  relativePath: z.string(),
  revision: z.string(),
  fileCount: z.number().int().nonnegative(),
  digest: z.string(),
  enabled: z.boolean(),
});

export const nativeCapabilityInputSchema = z.object({
  id: z.string().uuid(),
  pluginId: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  toolIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).max(256),
  skillIds: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(64),
  setup: z.array(z.object({
    key: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().trim().min(1).max(100),
    description: z.string().trim().max(300),
    secret: z.boolean(),
    required: z.boolean(),
  }).strict()).max(64),
  assignmentChangedRpc: z.string().regex(/^[a-zA-Z0-9_-]+$/).nullable().default(null),
}).strict();

export const nativeCapabilitySchema = nativeCapabilityInputSchema;

/** A plugin's native capability. Projects owns where it is available. */
export const bundleSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  skillIds: z.array(z.string()),
  sourceId: z.string().nullable(),
  nativeCapability: nativeCapabilitySchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const assignmentSchema = z.object({
  bundleId: targetIdSchema,
  kind: assignmentKindSchema,
  targetId: z.string(),
});

export const targetSchema = z.object({
  kind: assignmentKindSchema.exclude(["global"]),
  id: z.string(),
  name: z.string(),
  detail: z.string().nullable(),
});

export const harnessSchema = z.object({
  id: harnessIdSchema,
  name: z.string(),
  mode: z.enum(["native", "shared-skills", "executor"]),
  detail: z.string(),
});

export const snapshotSchema = z.object({
  skills: z.array(skillSchema),
  bundles: z.array(bundleSchema),
  assignments: z.array(assignmentSchema),
  targets: z.array(targetSchema),
  harnesses: z.array(harnessSchema),
});

export const preferencesSchema = z.object({ agentsIntegration: z.boolean() }).strict();
export const catalogOverviewSchema = snapshotSchema.omit({ assignments: true }).extend({ skillsError: z.string().nullable() });

/** Catalog no longer holds assignments. Projects reads this and finds nothing to move. */
export const assignmentStatusSchema = z.object({
  state: z.literal("uninitialized"),
  transfer: z.null(),
  destinationRevision: z.null(),
  conflicts: z.literal(0),
});

export const materializeInputSchema = z.object({
  hostId: z.string().min(1),
  homePath: z.string().min(1),
  projectId: z.string().min(1).nullable().default(null),
  workspacePath: z.string().min(1).nullable().default(null),
}).strict();

export const materializeOutputSchema = z.object({
  ready: z.boolean(),
  digest: z.string(),
  skillCount: z.number().int().nonnegative(),
  roots: z.array(z.string()),
  detail: z.string(),
});
const materializeJobStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("running") }),
  z.object({ state: z.literal("complete"), result: materializeOutputSchema }),
  z.object({ state: z.literal("failed"), error: z.string() }),
]);

/** A plugin's own id, self-declared: plugin RPC carries no caller identity. The connection map is the check. */
export const pluginCallerSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/u);
/** An Executor connection ID. The field keeps its old name, `toolkit`, for callers. */
const connectionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
/** A write paused for a person's approval. `executionId` is Executor's request ID; `args` is bounded JSON text. */
export const executorPausedSchema = z.object({
  executionId: z.string(),
  approvalUrl: z.string(),
  address: z.string(),
  message: z.string(),
  args: z.string(),
});
const executorResultSchema = z.object({ text: z.string(), paused: executorPausedSchema.nullable() });

/** Calls waiting for approval in one thread, oldest first. Only the open one has a card. */
export const executorApprovalsSchema = z.object({
  pending: z.array(z.object({ approvalId: z.string(), name: z.string(), summary: z.string(), open: z.boolean() })),
});

/** Every connection Catalog maps, whether BB holds a grant for it, and where it is used. */
export const executorOverviewSchema = z.object({
  configured: z.boolean(),
  url: z.string().nullable(),
  error: z.string().nullable(),
  connections: z.array(z.object({
    id: z.string(),
    url: z.string(),
    connected: z.boolean(),
    assignedTo: z.array(z.string()),
  })),
});

/** Executor accounts that need attention, from Catalog's last ten-minute check. */
export const executorConnectionsSchema = z.object({
  url: z.string().nullable(),
  broken: z.array(z.object({ address: z.string(), name: z.string(), problem: z.string(), since: z.number() })),
});

const toolkitScopeSchema = z.enum(["global", "project", "agent", "plugin"]);
const toolkitMappingSchema = z.object({ scope: toolkitScopeSchema, targetId: targetIdSchema, toolkits: z.array(connectionIdSchema) }).strict();
export const executorConfigurationSchema = z.object({
  configured: z.boolean(), url: z.string().nullable(), mappings: z.array(toolkitMappingSchema),
});
const okSchema = z.object({ ok: z.literal(true) });

export const rpcContract = defineRpcContract({
  catalogOverview: { input: z.null(), output: catalogOverviewSchema },
  preferences: { input: z.null(), output: preferencesSchema },
  updatePreferences: { input: preferencesSchema.partial().strict(), output: preferencesSchema },
  executorConfiguration: { input: z.null(), output: executorConfigurationSchema },
  setExecutorToolkits: { input: toolkitMappingSchema.extend({ expectedToolkits: z.array(connectionIdSchema) }).strict(), output: okSchema },
  assignmentStatus: { input: z.null(), output: assignmentStatusSchema },
  getSandboxSkills: { input: z.object({ hostId: z.string().min(1) }).strict(), output: z.object({ skillIds: z.array(z.string()).nullable() }) },
  setSandboxSkills: { input: z.object({ hostId: z.string().min(1), skillIds: z.array(z.string()).max(1000) }).strict(), output: okSchema },
  snapshot: { input: z.null(), output: snapshotSchema },
  listBundles: { input: z.null(), output: z.object({ bundles: z.array(bundleSchema) }) },
  /** Always empty: Projects owns assignments now. */
  legacyAssignments: { input: z.null(), output: z.object({ assignments: z.array(assignmentSchema) }) },
  registerNativeCapability: { input: nativeCapabilityInputSchema, output: bundleSchema },
  /** Writes a native capability's availability to Projects. */
  setAssignment: {
    input: z.object({ bundleId: z.string().uuid(), kind: assignmentKindSchema, targetId: z.string(), enabled: z.boolean() }).strict(),
    output: okSchema,
  },
  materialize: { input: materializeInputSchema, output: materializeOutputSchema },
  startMaterialize: { input: materializeInputSchema, output: z.object({ jobId: z.string().uuid() }) },
  materializationStatus: { input: z.object({ jobId: z.string().uuid() }).strict(), output: materializeJobStatusSchema },
  refreshAvailability: { input: z.object({ projectId: z.string().min(1).nullable() }).strict(), output: okSchema },
  /** Connections mapped to the plugin caller with `bb catalog executor use <connection> --plugin <id>`. */
  executorToolkits: {
    input: z.object({ caller: pluginCallerSchema }).strict(),
    output: z.object({
      configured: z.boolean(),
      toolkits: z.array(z.object({ slug: z.string(), integrations: z.array(z.string()) })),
    }),
  },
  /**
   * Runs Executor code for a plugin caller at one of its mapped connections.
   * `read` never waits: a call that pauses for approval is declined at once
   * and fails. `write` returns the paused call for the plugin to show.
   * Acceptance requires the native owner interaction; `executorDecide` only declines.
   */
  executorCall: {
    input: z.object({
      caller: pluginCallerSchema,
      toolkit: connectionIdSchema,
      code: z.string().min(1).max(100_000),
      mode: z.enum(["read", "write"]),
      purpose: z.string().trim().min(1).max(200),
    }).strict(),
    output: executorResultSchema,
  },
  /** Owned plugin or SDK client decline. All RPC accept requests fail; client identity is not owner provenance. */
  executorDecide: {
    input: z.object({ caller: pluginCallerSchema, executionId: z.string().min(1).max(200), action: z.enum(["accept", "decline"]) }).strict(),
    output: executorResultSchema,
  },
  /** Read-only. Answers go through the card's own form, never through RPC. */
  executorApprovals: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: executorApprovalsSchema },
  executorOverview: { input: z.null(), output: executorOverviewSchema },
  executorConnections: { input: z.null(), output: executorConnectionsSchema },
  /** Starts a sign-in for one connection. BB's callback route finishes it. */
  connectStart: {
    input: z.object({ connection: connectionIdSchema, redirectOrigin: z.string().url().max(500) }).strict(),
    output: z.object({ url: z.string() }),
  },
  /** Forgets BB's grant for one connection. */
  disconnect: { input: z.object({ connection: connectionIdSchema }).strict(), output: okSchema },
});

export type AssignmentKind = z.infer<typeof assignmentKindSchema>;
export type NativeCapabilityInput = z.infer<typeof nativeCapabilityInputSchema>;
export type HarnessId = z.infer<typeof harnessIdSchema>;
export type Skill = z.infer<typeof skillSchema>;
