import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { projectGroupColors } from "./group-colors.js";
import { assignmentKindSchema, assignmentStatusSchema, exportPageSchema, handoffInputSchema } from "./assignments.js";

export { projectGroupColors };
export const projectGroupColorSchema = z.union([z.enum(projectGroupColors), z.string().regex(/^#[0-9a-fA-F]{6}$/)]);

export const groupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: projectGroupColorSchema,
  position: z.number().int().nonnegative(),
  isDefault: z.boolean(),
});

export const routingProfileSourceSchema = z.enum(["none", "generated", "manual"]);

export const routingProfileSchema = z.object({
  description: z.string().max(1_200),
  keywords: z.array(z.string().max(80)).max(24),
  aliases: z.array(z.string().max(100)).max(16),
  repositories: z.array(z.string().max(240)).max(16),
  notFor: z.array(z.string().max(240)).max(8),
  source: routingProfileSourceSchema,
  updatedAt: z.string().nullable(),
  learnedFor: z.array(z.string()),
  learnedNotFor: z.array(z.string()),
  learnedAt: z.string().nullable(),
});

export const projectConfigurationSchema = z.object({
  id: z.string(),
  name: z.string(),
  gitRemoteUrl: z.string().nullable(),
  localPath: z.string().nullable(),
  groupId: z.string().uuid().nullable(),
  position: z.number().int().nonnegative(),
  icon: z.string(),
  credentialId: z.string().nullable(),
  agentIds: z.array(z.string()),
  bundleIds: z.array(z.string()),
  routingProfile: routingProfileSchema,
});

export const referenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  detail: z.string().nullable(),
});

export const snapshotSchema = z.object({
  groups: z.array(groupSchema),
  projects: z.array(projectConfigurationSchema),
  credentials: z.array(referenceSchema),
  agents: z.array(referenceSchema),
  bundles: z.array(referenceSchema),
  globalAgentIds: z.array(z.string()),
  globalBundleIds: z.array(z.string()),
  routingConfigured: z.boolean(),
  routingModel: z.string(),
});

export const projectContextSchema = z.object({
  projectId: z.string(),
  credentialId: z.string().nullable(),
  agentIds: z.array(z.string()),
  bundleIds: z.array(z.string()),
  groupId: z.string().uuid().nullable(),
});

export const globalContextSchema = z.object({
  agentIds: z.array(z.string()),
  bundleIds: z.array(z.string()),
});

export const groupsSnapshotSchema = z.object({
  groups: z.array(groupSchema.extend({ projectIds: z.array(z.string()) })),
});

export const bundleAssignmentSnapshotSchema = z.object({
  globalBundleIds: z.array(z.string()),
  projects: z.array(z.object({ projectId: z.string(), bundleIds: z.array(z.string()) })),
});

export const routingProfilesSnapshotSchema = z.object({
  configured: z.boolean(),
  model: z.string(),
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    gitRemoteUrl: z.string().nullable(),
    profile: routingProfileSchema,
  })),
});

const suggestedProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repository: z.string().nullable(),
  summary: z.string(),
  probability: z.number().min(0).max(1),
});

export const projectSuggestionSchema = z.object({
  suggestion: suggestedProjectSchema.nullable(),
  alternatives: z.array(suggestedProjectSchema).max(3),
  noProject: z.object({ probability: z.number().min(0).max(1) }).nullable(),
  confidence: z.number().min(0).max(1),
  autoApply: z.boolean(),
});

const toggleSchema = z.object({
  targetId: z.string().min(1).max(1_024),
  enabled: z.boolean(),
}).strict();

export const preferencesSchema = z.object({
  routingModel: z.string().trim().min(1).max(200),
  catalogIntegration: z.boolean(), credentialsIntegration: z.boolean(),
  agentsIntegration: z.boolean(), sidebarIntegration: z.boolean(), tasksIntegration: z.boolean(),
}).strict();
export const organizationProjectSchema = projectConfigurationSchema.omit({ credentialId: true, agentIds: true, bundleIds: true }).extend({machineCount: z.number().int().nonnegative().default(0)});
export const organizationSnapshotSchema = z.object({
  groups: z.array(groupSchema), projects: z.array(organizationProjectSchema),
  assignmentStatus: z.array(assignmentStatusSchema),
  routingConfigured: z.boolean(), routingModel: z.string(),
});
export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  organizationSnapshot: { input: z.null(), output: organizationSnapshotSchema },
  assignmentStatusV1: { input: z.object({ kind: assignmentKindSchema }).strict(), output: assignmentStatusSchema },
  assignmentExportV1: {
    input: z.object({ kind: assignmentKindSchema, generation: z.string().min(1), cursor: z.number().int().nonnegative().default(0) }).strict(),
    output: exportPageSchema,
  },
  assignmentHandoffV1: { input: handoffInputSchema, output: assignmentStatusSchema },
  initializeFreshV1: { input: z.object({ confirmation: z.literal("no-legacy-assignments") }).strict(), output: z.object({ ok: z.literal(true) }) },
  importLegacyFromSourcesV1: { input: z.null(), output: z.object({ ok: z.literal(true) }) },
  preferences: { input: z.null(), output: preferencesSchema },
  updatePreferences: { input: preferencesSchema.partial().strict(), output: preferencesSchema },
  assignmentOptionsV1: {
    input: z.object({ kind: assignmentKindSchema }).strict(),
    output: z.object({ references: z.array(referenceSchema) }),
  },
  groupsSnapshot: { input: z.null(), output: groupsSnapshotSchema },
  projectContext: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: projectContextSchema,
  },
  projectContexts: {
    input: z.object({ projectIds: z.array(z.string().min(1)).max(5_000) }).strict(),
    output: z.object({ projects: z.array(projectContextSchema) }),
  },
  globalContext: { input: z.null(), output: globalContextSchema },
  bundleAssignmentSnapshot: { input: z.null(), output: bundleAssignmentSnapshotSchema },
  routingProfiles: { input: z.null(), output: routingProfilesSnapshotSchema },
  updateRoutingProfile: {
    input: z.object({
      projectId: z.string().min(1),
      description: z.string().trim().min(1).max(1_200),
      keywords: z.array(z.string().trim().min(1).max(80)).max(24),
      aliases: z.array(z.string().trim().min(1).max(100)).max(16),
      repositories: z.array(z.string().trim().min(1).max(240)).max(16),
      notFor: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
    }).strict(),
    output: routingProfileSchema,
  },
  generateRoutingProfile: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: routingProfileSchema,
  },
  suggestProject: {
    input: z.object({ prompt: z.string().trim().min(10).max(20_000) }).strict(),
    output: projectSuggestionSchema,
  },
  generateMissingRoutingProfiles: {
    input: z.null(),
    output: z.object({ generated: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
  },
  saveGroup: {
    input: z.object({
      id: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(80),
      color: projectGroupColorSchema,
    }).strict(),
    output: groupSchema,
  },
  patchGroup: {
    input: z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80).optional(), color: projectGroupColorSchema.optional() }).strict().refine(value => value.name !== undefined || value.color !== undefined, "Choose a group field to change"),
    output: groupSchema,
  },
  deleteGroup: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setGroupOrder: {
    input: z.object({ groupIds: z.array(z.string().uuid()).min(1).max(100) }).strict()
      .refine(({ groupIds }) => new Set(groupIds).size === groupIds.length, "Group order cannot contain duplicates"),
    output: z.object({ ok: z.literal(true) }),
  },
  setProjectGroup: {
    input: z.object({ projectId: z.string().min(1), groupId: z.string().uuid() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setProjectOrder: {
    input: z.object({ groupId: z.string().uuid(), projectIds: z.array(z.string().min(1)).max(5_000) }).strict()
      .refine(({ projectIds }) => new Set(projectIds).size === projectIds.length, "Project order cannot contain duplicates"),
    output: z.object({ ok: z.literal(true) }),
  },
  updateProject: {
    input: z.object({
      projectId: z.string().min(1),
      icon: z.string().trim().max(80).optional(),
      credentialId: z.string().min(1).max(1_024).nullable().optional(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setProjectAgent: { input: toggleSchema.extend({ projectId: z.string().min(1) }), output: z.object({ ok: z.literal(true) }) },
  setGlobalAgent: { input: toggleSchema, output: z.object({ ok: z.literal(true) }) },
  setProjectBundle: { input: toggleSchema.extend({ projectId: z.string().min(1) }), output: z.object({ ok: z.literal(true) }) },
  setGlobalBundle: { input: toggleSchema, output: z.object({ ok: z.literal(true) }) },
  agentAssignments: {
    input: z.object({ agentId: z.string().min(1).max(1_024) }).strict(),
    output: z.object({ global: z.boolean(), projectIds: z.array(z.string()) }),
  },
  bundleAssignments: {
    input: z.object({ bundleId: z.string().min(1).max(1_024) }).strict(),
    output: z.object({ global: z.boolean(), projectIds: z.array(z.string()) }),
  },
  credentialAssignments: {
    input: z.object({ credentialId: z.string().min(1).max(1_024) }).strict(),
    output: z.object({ projectIds: z.array(z.string()) }),
  },
  removeAgent: { input: z.object({ agentId: z.string().min(1).max(1_024) }).strict(), output: z.object({ ok: z.literal(true) }) },
  removeBundle: { input: z.object({ bundleId: z.string().min(1).max(1_024) }).strict(), output: z.object({ ok: z.literal(true) }) },
  removeCredential: { input: z.object({ credentialId: z.string().min(1).max(1_024) }).strict(), output: z.object({ ok: z.literal(true) }) },
  importLegacy: {
    input: z.object({
      groups: z.array(z.object({ id: z.string(), name: z.string(), color: projectGroupColorSchema, isDefault: z.boolean(), projectIds: z.array(z.string()) })).default([]),
      credentialBindings: z.array(z.object({ projectId: z.string(), credentialId: z.string().nullable() })).default([]),
      catalogAssignments: z.array(z.object({ bundleId: z.string(), kind: z.enum(["global", "project", "project-environment", "agent-profile"]), targetId: z.string() })).default([]),
    }).strict(),
    output: z.object({
      groups: z.number().int(), projects: z.number().int(), credentials: z.number().int(), bundles: z.number().int(),
      groupMappings: z.array(z.object({ legacyId: z.string(), groupId: z.string().uuid() })),
    }),
  },
});

export type ProjectGroupColor = z.infer<typeof projectGroupColorSchema>;
export type ProjectGroup = z.infer<typeof groupSchema>;
