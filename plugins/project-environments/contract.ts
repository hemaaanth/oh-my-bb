import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const capabilityIds = [
  "hubspot",
  "clickhouse",
  "doppler",
] as const;

export const capabilityIdSchema = z.enum(capabilityIds);
export type CapabilityId = z.infer<typeof capabilityIdSchema>;

export const capabilitySchema = z.object({
  id: capabilityIdSchema,
  name: z.string(),
  command: z.string(),
  description: z.string(),
  installHint: z.string(),
  credentialAlternatives: z.array(z.array(z.string().min(1))).min(1),
});

export const profileInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  environmentName: z.string().trim().max(120),
  environmentId: z.string().trim().max(200),
  account: z.string().trim().max(200),
  serviceAccountName: z.string().trim().regex(/^[a-zA-Z0-9._-]*$/u).max(120),
  capabilities: z.array(capabilityIdSchema).max(capabilityIds.length),
  setupScript: z.string().max(20_000),
  instructions: z.string().trim().max(8_000),
}).strict();

export const profileSchema = profileInputSchema.extend({
  id: z.string().uuid(),
  tokenConfigured: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const bindingSchema = z.object({
  projectId: z.string(),
  profileId: z.string().uuid(),
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  gitRemoteUrl: z.string().nullable(),
  profileId: z.string().uuid().nullable(),
  localHostId: z.string().nullable(),
  localPath: z.string().nullable(),
});

export const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["ready", "missing", "warning", "skipped"]),
  detail: z.string(),
});

export const preparationSchema = z.object({
  projectId: z.string(),
  profileId: z.string().uuid().nullable(),
  hostId: z.string(),
  workspacePath: z.string(),
  ready: z.boolean(),
  preparedAt: z.string(),
  checks: z.array(checkSchema),
});

const prepareInputSchema = z.object({
  projectId: z.string().min(1),
  hostId: z.string().min(1),
  workspacePath: z.string().min(1),
  credentialProfileId: z.string().uuid().nullable().optional(),
  toolIds: z.array(capabilityIdSchema).optional(),
  skipWorkspaceSetup: z.boolean().optional(),
  strict: z.boolean().default(false),
}).strict();

const preparationJobStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("running") }),
  z.object({ state: z.literal("complete"), result: preparationSchema }),
  z.object({ state: z.literal("failed"), error: z.string() }),
]);

const preparationOutcomeBaseV1 = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string().uuid(),
}).strict();

export const preparationOutcomeV1Schema = z.union([
  preparationOutcomeBaseV1.extend({
    state: z.literal("running"), retryable: z.literal(false), reason: z.literal("in_progress"),
  }),
  preparationOutcomeBaseV1.extend({
    state: z.literal("unknown"), retryable: z.literal(false),
    reason: z.enum(["job_unavailable", "completion_unconfirmed"]),
  }),
  preparationOutcomeBaseV1.extend({
    state: z.literal("complete"), ready: z.literal(true),
    retryable: z.literal(false), reason: z.literal("ready"),
  }),
  preparationOutcomeBaseV1.extend({
    state: z.literal("complete"), ready: z.literal(false),
    retryable: z.literal(true), reason: z.literal("not_ready"),
  }),
  preparationOutcomeBaseV1.extend({
    state: z.literal("failed"), retryable: z.literal(true),
    reason: z.enum(["before_remote_work", "not_ready"]),
  }),
]);

export type PreparationOutcomeV1 = z.infer<typeof preparationOutcomeV1Schema>;

export const snapshotSchema = z.object({
  profiles: z.array(profileSchema),
  projects: z.array(projectSchema),
  capabilities: z.array(capabilitySchema),
  preparations: z.array(preparationSchema),
});

export const credentialDefinitionsSchema = z.object({
  credentials: z.array(profileSchema.pick({ id: true, name: true, environmentName: true })),
});

export const legacySnapshotSchema = z.object({
  profiles: z.array(profileSchema),
  projects: z.array(projectSchema),
});

export const rpcContract = defineRpcContract({
  workspaceSelection: { input: z.object({ projectId: z.string(), hostId: z.string(), workspacePath: z.string() }), output: z.object({ credentialProfileId: z.string().nullable(), toolIds: z.array(capabilityIdSchema).nullable() }) },
  snapshot: { input: z.null(), output: snapshotSchema },
  listCredentials: { input: z.null(), output: credentialDefinitionsSchema },
  legacySnapshot: { input: z.null(), output: legacySnapshotSchema },
  saveProfile: { input: profileInputSchema, output: profileSchema },
  deleteProfile: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  bindProject: {
    input: z.object({ projectId: z.string().min(1), profileId: z.string().uuid().nullable() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setServiceAccountToken: {
    input: z.object({ profileId: z.string().uuid(), token: z.string().trim().min(1).max(20_000) }).strict(),
    output: z.object({ configured: z.literal(true) }),
  },
  prepare: {
    input: prepareInputSchema,
    output: preparationSchema,
  },
  startPrepare: {
    input: prepareInputSchema,
    output: z.object({ jobId: z.string().uuid() }),
  },
  preparationStatus: {
    input: z.object({ jobId: z.string().uuid() }).strict(),
    output: preparationJobStatusSchema,
  },
  preparationOutcomeV1: {
    input: z.object({ jobId: z.string().uuid() }).strict(),
    output: preparationOutcomeV1Schema,
  },
  cleanupPreparation: {
    input: z.object({
      projectId: z.string().min(1),
      hostId: z.string().min(1),
      workspacePath: z.string().min(1),
    }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  prepareLocal: {
    input: z.object({ projectId: z.string().min(1), strict: z.boolean().default(false) }).strict(),
    output: preparationSchema,
  },
  seedSuggestedProfiles: {
    input: z.null(),
    output: z.object({ created: z.number().int().nonnegative(), bound: z.number().int().nonnegative() }),
  },
  refreshProject: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});
