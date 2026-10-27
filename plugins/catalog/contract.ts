import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { assignmentId, assignmentReceiptSchema, assignmentReverseSchema, localAssignmentStatusSchema, transferIdentitySchema } from "./assignment-contract.js";

export const updatePolicies = ["automatic", "review"] as const;
export const updatePolicySchema = z.enum(updatePolicies);
export const assignmentKinds = ["global", "project", "project-environment", "agent-profile"] as const;
export const assignmentKindSchema = z.enum(assignmentKinds);
export const harnessIds = ["bb", "claude-code", "codex", "omp", "pi", "prime-agent", "exo", "fx"] as const;
export const harnessIdSchema = z.enum(harnessIds);

export const sourceInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  repositoryUrl: z.string().url().max(2_000).refine((value) => value.startsWith("https://"), "Use an HTTPS Git repository URL"),
  gitRef: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u).max(200).default("main"),
  subdirectory: z.string().trim().max(500).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "Use a repository-relative subdirectory"),
  updatePolicy: updatePolicySchema,
  enabled: z.boolean(),
}).strict();

export const sourceSchema = sourceInputSchema.extend({
  id: z.string().uuid(),
  approvedRevision: z.string().nullable(),
  pendingRevision: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const skillSchema = z.object({
  id: z.string(),
  sourceId: z.string().uuid(),
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

export const bundleInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500),
  skillIds: z.array(z.string().min(1)).max(500),
}).strict();

export const bundleSchema = bundleInputSchema.extend({
  id: z.string().uuid(),
  sourceId: z.string().uuid().nullable(),
  nativeCapability: nativeCapabilitySchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const assignmentSchema = z.object({
  bundleId: assignmentId,
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
  sources: z.array(sourceSchema),
  skills: z.array(skillSchema),
  bundles: z.array(bundleSchema),
  assignments: z.array(assignmentSchema),
  targets: z.array(targetSchema),
  harnesses: z.array(harnessSchema),
});

export const preferencesSchema = z.object({ agentsIntegration: z.boolean() }).strict();
export const catalogOverviewSchema = snapshotSchema.omit({ assignments: true }).extend({
  assignments: z.array(assignmentSchema).nullable(),
  assignmentState: localAssignmentStatusSchema,
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

/** A plugin's own id, self-declared: plugin RPC carries no caller identity. The toolkit map is the check. */
export const pluginCallerSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/u);
const toolkitSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
/** A write paused for a person's approval. `args` is the call's arguments as bounded JSON text. */
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
/** Every Executor toolkit, where Catalog assigns it, and what looks out of sync. */
export const executorOverviewSchema = z.object({
  configured: z.boolean(),
  url: z.string().nullable(),
  error: z.string().nullable(),
  toolkits: z.array(z.object({
    slug: z.string(),
    name: z.string(),
    integrations: z.array(z.string()),
    assignedTo: z.array(z.string()),
    tools: z.number().int().nonnegative(),
    rules: z.object({ approve: z.number().int().nonnegative(), requireApproval: z.number().int().nonnegative(), block: z.number().int().nonnegative() }),
  })),
  warnings: z.array(z.string()),
});

/** Executor connections that need attention, from Catalog's last ten-minute check. */
export const executorConnectionsSchema = z.object({
  url: z.string().nullable(),
  broken: z.array(z.object({ address: z.string(), name: z.string(), problem: z.string(), since: z.number() })),
});

const toolkitScopeSchema = z.enum(["global", "project", "agent", "plugin"]);
const toolkitMappingSchema = z.object({ scope: toolkitScopeSchema, targetId: assignmentId, toolkits: z.array(toolkitSlugSchema) }).strict();
export const executorConfigurationSchema = z.object({
  configured: z.boolean(), url: z.string().nullable(), mappings: z.array(toolkitMappingSchema),
});

export const rpcContract = defineRpcContract({
  catalogOverview: { input: z.null(), output: catalogOverviewSchema },
  preferences: { input: z.null(), output: preferencesSchema },
  updatePreferences: { input: preferencesSchema.partial().strict(), output: preferencesSchema },
  executorConfiguration: { input: z.null(), output: executorConfigurationSchema },
  setExecutorToolkits: { input: toolkitMappingSchema.extend({ expectedToolkits: z.array(toolkitSlugSchema) }).strict(), output: z.object({ ok: z.literal(true) }) },
  assignmentStatus: { input: z.null(), output: localAssignmentStatusSchema },
  initializeAssignmentsV1: { input: z.object({ confirmation: z.literal("no-legacy-assignments") }).strict(), output: z.object({ ok: z.literal(true) }) },
  stageAssignmentsV1: { input: transferIdentitySchema, output: assignmentReceiptSchema },
  activateAssignmentsV1: { input: transferIdentitySchema, output: z.object({ ok: z.literal(true) }) },
  assignmentReceiptV1: { input: transferIdentitySchema, output: assignmentReceiptSchema },
  assignmentAbortV1: { input: transferIdentitySchema, output: z.object({ ok: z.literal(true) }) },
  assignmentReadV1: { input: transferIdentitySchema.extend({ method: z.string(), input: z.unknown() }).strict(), output: z.unknown() },
  assignmentWriteV1: { input: transferIdentitySchema.extend({ method: z.enum(["setGlobalBundle", "setProjectBundle", "removeBundle"]), input: z.unknown() }).strict(), output: z.object({ ok: z.literal(true) }) },
  assignmentReverseExportV1: { input: transferIdentitySchema.extend({ cursor: z.number().int().nonnegative(), reverseGeneration: assignmentId.nullable() }).strict(), output: assignmentReverseSchema },
  getSandboxSkills: { input: z.object({ hostId: z.string().min(1) }).strict(), output: z.object({ skillIds: z.array(z.string()).nullable() }) },
  setSandboxSkills: { input: z.object({ hostId: z.string().min(1), skillIds: z.array(z.string()).max(1000) }).strict(), output: z.object({ ok: z.literal(true) }) },
  snapshot: { input: z.null(), output: snapshotSchema },
  listBundles: { input: z.null(), output: z.object({ bundles: z.array(bundleSchema) }) },
  legacyAssignments: { input: z.null(), output: z.object({ assignments: z.array(assignmentSchema) }) },
  registerNativeCapability: { input: nativeCapabilityInputSchema, output: bundleSchema },
  saveSource: { input: sourceInputSchema.extend({ expected: sourceInputSchema.omit({ id: true }).optional() }).strict(), output: sourceSchema },
  deleteSource: { input: z.object({ id: z.string().uuid() }).strict(), output: z.object({ ok: z.literal(true) }) },
  syncSource: { input: z.object({ id: z.string().uuid() }).strict(), output: sourceSchema },
  syncAll: { input: z.null(), output: z.object({ checked: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }) },
  approveSource: { input: z.object({ id: z.string().uuid() }).strict(), output: sourceSchema },
  saveBundle: { input: bundleInputSchema.extend({ expected: bundleInputSchema.omit({ id: true }).optional() }).strict(), output: bundleSchema },
  deleteBundle: { input: z.object({ id: z.string().uuid() }).strict(), output: z.object({ ok: z.literal(true) }) },
  setAssignment: {
    input: z.object({ bundleId: z.string().uuid(), kind: assignmentKindSchema, targetId: z.string(), enabled: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setSkillsEnabled: {
    input: z.object({ skillIds: z.array(z.string().min(1)).min(1).max(1_000), enabled: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  materialize: { input: materializeInputSchema, output: materializeOutputSchema },
  startMaterialize: {
    input: materializeInputSchema,
    output: z.object({ jobId: z.string().uuid() }),
  },
  materializationStatus: {
    input: z.object({ jobId: z.string().uuid() }).strict(),
    output: materializeJobStatusSchema,
  },
  refreshAvailability: {
    input: z.object({ projectId: z.string().min(1).nullable() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Toolkits mapped to the verified matching plugin caller with `bb catalog executor use <toolkit> --plugin <id>`. */
  executorToolkits: {
    input: z.object({ caller: pluginCallerSchema }).strict(),
    output: z.object({
      configured: z.boolean(),
      toolkits: z.array(z.object({ slug: z.string(), integrations: z.array(z.string()) })),
    }),
  },
  /**
   * Runs Executor code for a verified matching plugin caller in its mapped toolkits.
   * `read` never waits: a call that pauses for approval is declined at once
   * and fails. `write` returns the paused call for the plugin to show.
   * Acceptance requires the native owner interaction; `executorDecide` only declines.
   */
  executorCall: {
    input: z.object({
      caller: pluginCallerSchema,
      toolkit: toolkitSlugSchema,
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
});

export type AssignmentKind = z.infer<typeof assignmentKindSchema>;
export type BundleInput = z.infer<typeof bundleInputSchema>;
export type NativeCapabilityInput = z.infer<typeof nativeCapabilityInputSchema>;
export type HarnessId = z.infer<typeof harnessIdSchema>;
export type SourceInput = z.infer<typeof sourceInputSchema>;
