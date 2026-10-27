import { attachmentChangeSchema, attachmentsViewSchema } from "./attachment-contract.js";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { sandboxIntegrationsSchema, sandboxIntegrationPatchSchema, integrationImportSchema } from "./preferences.js";
import { nativeProjectPreparationSchema } from "./provider/project-env.js";
import { imageBuildRepositoryImportSchema, imageBuildRepositorySchema, imageBuildRepositoryViewSchema } from "./image-build-repository.js";
import { sandboxPreferencesPatchSchema, sandboxPreferencesViewSchema } from "./settings-preferences.js";
import {
  sandboxProviderValues,
  sandboxResizeCapabilityValues,
} from "./backend.js";
import { sandboxImageProviders } from "./config.js";
import { modelRouteSchema } from "./model-route.js";
import { sandboxSshIdentitySchema } from "./ssh-contract.js";
import { sandboxThreadStatusValues } from "./manager.js";
import {
  sandboxImageStatusValues,
  sandboxRuntimeStateValues,
  sandboxSizeProfileSourceValues,
  sandboxStatusValues,
} from "./store.js";
import { sandboxSizeTierValues } from "./size-tiers.js";
import { sandboxSizingStateValues } from "./resource-sizing.js";

const authSelectionSchema = z.object({
  copyGitHubCliAuth: z.boolean(),
});

const sandboxThreadStatusViewSchema = z.object({
  threadId: z.string(),
  sandboxId: z.string(),
  provider: z.enum(sandboxProviderValues),
  status: z.enum(sandboxThreadStatusValues),
  label: z.string(),
});

/**
 * A thread to resolve against the sandbox records. `hostId` lets a caller that
 * already knows the thread's machine — the sidebar does, for every row it
 * paints — skip the environment lookup, which is what makes forked and
 * plugin-spawned threads resolvable at list scale.
 */
const sandboxThreadRefSchema = z.object({
  threadId: z.string().min(1),
  hostId: z.string().min(1).nullable().optional(),
  environmentId: z.string().min(1).nullable().optional(),
});

const sandboxImageSchema = z.object({
  id: z.string(),
  provider: z.enum(sandboxProviderValues),
  name: z.string(),
  status: z.enum(sandboxImageStatusValues),
  isDefault: z.boolean(),
  extraPackages: z.array(z.string()),
  error: z.string().nullable(),
  regionId: z.string().nullable(),
  sandboxClass: z.string().nullable(),
  bbAppVersion: z.string().nullable(),
  sizeTier: z.enum(sandboxSizeTierValues).nullable(),
  imageVersion: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const providerSettingsSchema = z.object({
  provider: z.enum(sandboxProviderValues),
  enabled: z.boolean(),
  configured: z.boolean(),
  credentialsConfigured: z.boolean(),
  apiUrl: z.string(),
  target: z.string(),
  sandboxClass: z.string(),
  appName: z.string(),
  vmRuntime: z.boolean(),
  machineClass: z.string(),
  environment: z.string(),
  cpu: z.string(),
  memory: z.string(),
  storage: z.string(),
  persistence: z.string(),
  snapshotId: z.string(),
  supportsImages: z.boolean(),
  artifactName: z.string().nullable(),
});

const imageSettingsSchema = z.object({
  repository: z.string(),
  platform: z.string(),
  registryUsernameConfigured: z.boolean(),
  registryTokenConfigured: z.boolean(),
  extraPackages: z.array(z.string()),
  components: z.array(
    z.object({ category: z.string(), items: z.array(z.string()) }),
  ),
  providers: z.array(
    z.object({
      provider: z.enum(sandboxImageProviders),
      credentialsConfigured: z.boolean(),
      activeName: z.string().nullable(),
      images: z.array(sandboxImageSchema.extend({ browserProvenance: z.enum(["verified", "unknown", "incompatible"]) })),
    }),
  ),
});
const daytonaCapacityPoolSchema = z.object({
  regionId: z.string().min(1),
  regionName: z.string().min(1),
  regionType: z.string().min(1),
  sandboxClass: z.enum(["container", "linux-vm", "windows"]),
  totalCpu: z.number().nonnegative(),
  usedCpu: z.number().nonnegative(),
  totalMemoryGiB: z.number().nonnegative(),
  usedMemoryGiB: z.number().nonnegative(),
  totalDiskGiB: z.number().nonnegative(),
  usedDiskGiB: z.number().nonnegative(),
  maxCpuPerSandbox: z.number().positive().nullable(),
  maxMemoryGiBPerSandbox: z.number().positive().nullable(),
  maxDiskGiBPerSandbox: z.number().positive().nullable(),
  maxLifespanMinutes: z.number().nonnegative().nullable(),
});

const daytonaCapacitySchema = z.object({
  organizationId: z.string().min(1),
  pools: z.array(daytonaCapacityPoolSchema),
  refreshedAt: z.number(),
});


const imageBuildSchema = z.object({
  version: z.string(),
  reference: z.string(),
  digest: z.string(),
  pinnedReference: z.string(),
  extraPackages: z.array(z.string()),
  registrations: z.array(
    z.object({
      provider: z.enum(sandboxImageProviders),
      status: z.enum(["registered", "skipped", "error"]),
      name: z.string().nullable(),
      imageId: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
});

const provisionedResourcesSchema = z.object({
  cpuCores: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  diskBytes: z.number().nullable(),
});

const resourceSampleSchema = provisionedResourcesSchema.extend({
  sampledAt: z.number(),
  cpuUsagePercent: z.number().nullable(),
  memoryUsageBytes: z.number().nullable(),
  diskUsageBytes: z.number().nullable(),
  loadAverage1m: z.number().nullable(),
  oomEvents: z.number().nullable(),
  oomKills: z.number().nullable(),
  memoryPeakBytes: z.number().nullable(),
  memoryAnonBytes: z.number().nullable(),
  memoryFileBytes: z.number().nullable(),
  memorySlabReclaimableBytes: z.number().nullable(),
  cpuThrottledPeriods: z.number().nullable(),
  cpuThrottledUsec: z.number().nullable(),
  memoryPressureSomeAvg10: z.number().nullable(),
  memoryPressureSomeAvg60: z.number().nullable(),
  memoryPressureFullAvg10: z.number().nullable(),
  memoryPressureFullAvg60: z.number().nullable(),
  cpuPressureSomeAvg10: z.number().nullable(),
  cpuPressureSomeAvg60: z.number().nullable(),
  cpuPressureFullAvg10: z.number().nullable(),
  cpuPressureFullAvg60: z.number().nullable(),
});

const resourceAssessmentSchema = z.object({
  state: z.enum(sandboxSizingStateValues),
  sampleCount: z.number().int().nonnegative(),
  observedMs: z.number().nonnegative(),
  cpuP95Percent: z.number().nullable(),
  memoryP95Percent: z.number().nullable(),
  diskLatestPercent: z.number().nullable(),
  oomEvents: z.number().int().nullable(),
  oomKills: z.number().int().nullable(),
  memoryPressureP95: z.number().nullable(),
  cpuThrottledPeriods: z.number().int().nullable(),
  cpuThrottledMs: z.number().nullable(),
  provisioned: provisionedResourcesSchema.nullable(),
  reasons: z.array(z.string()),
});

const sizeTierSchema = z.enum(sandboxSizeTierValues);

const sizeProfileSchema = z.object({
  projectId: z.string(),
  provider: z.enum(sandboxProviderValues),
  cpuCores: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  diskBytes: z.number().nullable(),
  tier: sizeTierSchema.nullable(),
  regionId: z.string().nullable(),
  source: z.enum(sandboxSizeProfileSourceValues),
  updatedAt: z.number(),
});

const resourceRequestSchema = z.object({
  cpuCores: z.number().positive().optional(),
  memoryBytes: z.number().int().positive().optional(),
  diskBytes: z.number().int().positive().optional(),
});

const sizeTierViewSchema = z.object({
  tier: sizeTierSchema,
  label: z.string(),
  cpuCores: z.number(),
  memoryBytes: z.number(),
  diskBytes: z.number(),
  isDefault: z.boolean(),
  images: z.array(
    z.object({
      provider: z.enum(sandboxProviderValues),
      image: sandboxImageSchema.nullable(),
    }),
  ),
  pools: z.array(
    z.object({
      regionId: z.string(),
      sandboxClass: z.string(),
      fits: z.boolean(),
      reasons: z.array(z.string()),
      imageName: z.string().nullable(),
    }),
  ),
});

const versionStateSchema = z.enum(["current", "behind", "unknown"]);

export const versionAuditSchema = z.object({
  serverVersion: z.string(),
  previousServerVersion: z.string().nullable(),
  images: z.array(
    z.object({
      provider: z.enum(sandboxProviderValues),
      imageId: z.string(),
      name: z.string(),
      bbAppVersion: z.string().nullable(),
      state: versionStateSchema,
      sizeTier: z.enum(sandboxSizeTierValues).nullable(),
    }),
  ),
  sizeTiers: z.array(
    z.object({
      provider: z.enum(sandboxProviderValues),
      tier: z.enum(sandboxSizeTierValues),
      required: z.boolean(),
      imageId: z.string().nullable(),
      imageName: z.string().nullable(),
      bbAppVersion: z.string().nullable(),
      state: z.enum(["current", "behind", "unknown", "missing"]),
    }),
  ),
  pins: z.array(
    z.object({
      projectId: z.string(),
      provider: z.enum(sandboxProviderValues),
      imageId: z.string(),
      imageName: z.string(),
      bbAppVersion: z.string().nullable(),
      state: versionStateSchema,
    }),
  ),
  sandboxes: z.array(
    z.object({
      id: z.string(),
      provider: z.enum(sandboxProviderValues),
      projectId: z.string(),
      projectName: z.string(),
      status: z.enum(sandboxStatusValues),
      bbAppVersion: z.string().nullable(),
      state: versionStateSchema,
      busy: z.boolean(),
      upgradeable: z.boolean(),
      upgradePending: z.boolean(),
      rejectedProtocol: z.number().nullable(),
    }),
  ),
  findings: z.array(
    z.object({
      severity: z.enum(["error", "warning"]),
      code: z.string(),
      message: z.string(),
      fix: z.string().nullable(),
      provider: z.enum(sandboxProviderValues),
      sandboxId: z.string().optional(),
      projectId: z.string().optional(),
    }),
  ),
  checkedAt: z.number(),
});
export type VersionAuditView = z.infer<typeof versionAuditSchema>;

const carriedVersionsSchema = z.object({
  bb: z.string().nullable(),
  harness: z.object({
    "claude-code": z.string().nullable(),
    codex: z.string().nullable(),
    omp: z.string().nullable(),
    fx: z.string().nullable(),
    pi: z.string().nullable(),
    "prime-agent": z.string().nullable(),
    "fx-acp": z.string().nullable(),
    "nanocodex-acp": z.string().nullable(),
    "prime-agent-acp": z.string().nullable(),
  }),
  setupRevision: z.string().nullable().optional(),
});

export const sandboxUpgradeJobSchema = z.object({
  id: z.string(),
  state: z.enum(["running", "ready", "error"]),
  error: z.string().nullable(),
  progress: z.array(z.string()),
  cursor: z.number(),
  report: z
    .object({
      check: z.boolean(),
      target: z.object({
        bb: z.string(),
        harness: z.object({
          "claude-code": z.string(),
          codex: z.string(),
          omp: z.string(),
          fx: z.string(),
          pi: z.string(),
          "prime-agent": z.string(),
          "fx-acp": z.string(),
          "nanocodex-acp": z.string(),
          "prime-agent-acp": z.string(),
        }),
      }),
      image: z.object({
        before: carriedVersionsSchema.nullable(),
        reference: z.string().nullable(),
        action: z.enum(["current", "would-build", "built", "skipped"]),
        tag: z.string().nullable(),
        runUrl: z.string().nullable(),
      }),
      machines: z.array(
        z.object({
          hostId: z.string(),
          name: z.string(),
          action: z.enum(["current", "would-heal", "healed", "skipped", "failed", "unknown"]),
          versions: carriedVersionsSchema.nullable(),
          setup: z.object({
            revision: z.string(),
            current: z.boolean(),
            files: z.array(z.object({ path: z.string(), status: z.enum(["current", "missing", "stale"]) })),
          }).optional(),
          message: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
});
export type SandboxUpgradeJobView = z.infer<typeof sandboxUpgradeJobSchema>;

export const sandboxRpcContract = defineRpcContract({
  preferences: { input: z.null(), output: sandboxPreferencesViewSchema },
  updatePreferences: { input: sandboxPreferencesPatchSchema, output: sandboxPreferencesViewSchema },
  integrations: { input: z.null(), output: sandboxIntegrationsSchema },
  importIntegrations: { input: integrationImportSchema, output: sandboxIntegrationsSchema },
  projectPreparationStatus: { input: z.object({ threadId: z.string().min(1) }).strict(), output: nativeProjectPreparationSchema },
  retryProjectPreparation: { input: z.object({ threadId: z.string().min(1) }).strict(), output: nativeProjectPreparationSchema },
  reconcileProjectPreparation: { input: z.object({ threadId: z.string().min(1) }).strict(), output: nativeProjectPreparationSchema },
  updateIntegrations: { input: sandboxIntegrationPatchSchema, output: sandboxIntegrationsSchema },
  imageBuildRepository: { input: z.null(), output: imageBuildRepositoryViewSchema },
  saveImageBuildRepository: { input: z.object({ repository: imageBuildRepositorySchema.or(z.literal("")) }).strict(), output: imageBuildRepositoryViewSchema },
  importImageBuildRepository: { input: imageBuildRepositoryImportSchema, output: imageBuildRepositoryViewSchema },
  prepareSsh: {
    input: z.object({ hostId: z.string().regex(/^host_[a-z0-9_]+$/) }).strict(),
    output: sandboxSshIdentitySchema,
  },
  projects: {
    input: z.null(),
    output: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        kind: z.enum(["standard", "personal"]),
        detail: z.string().nullable(),
        defaultCredentialProfileId: z.string().uuid().nullable(),
        setup: z.object({
          kind: z.literal("long"),
          detail: z.string().min(1),
        }).nullable(),
      }),
    ),
  },
  credentialProfiles: {
    input: z.null(),
    output: z.array(z.object({
      id: z.string().uuid(),
      name: z.string(),
      environmentName: z.string(),
      tokenConfigured: z.boolean(),
    })),
  },
  launchPreview: {
    input: z.object({
      projectId: z.string().min(1),
      credentialProfileId: z.string().uuid().nullable(),
      auth: authSelectionSchema.optional(),
    }).strict(),
    output: z.object({
      credentialProfile: z.object({
        id: z.string().uuid(),
        name: z.string(),
        environmentName: z.string(),
        tokenConfigured: z.boolean(),
      }).nullable(),
      auth: authSelectionSchema,
      baseAuthentication: z.array(z.string()),
      tools: z.array(z.object({
        id: z.string(),
        name: z.string(),
        command: z.string(),
        description: z.string(),
      })),
      skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), sourceId: z.string().optional(), sourceName: z.string().optional() })),
      agents: z.array(z.object({ id: z.string(), name: z.string(), detail: z.string().nullable() })),
      availableTools: z.array(z.object({ id: z.string(), name: z.string(), command: z.string(), description: z.string() })),
      availableSkills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), sourceId: z.string().optional(), sourceName: z.string().optional() })),
      availableAgents: z.array(z.object({ id: z.string(), name: z.string(), detail: z.string().nullable() })),
      imageComponents: z.array(z.object({ category: z.string(), items: z.array(z.string()) })),
    }),
  },
  providers: {
    input: z.null(),
    output: z.array(
      z.object({
        provider: z.enum(sandboxProviderValues),
        configured: z.boolean(),
        enabled: z.boolean(),
      }),
    ),
  },
  providerSettings: {
    input: z.null(),
    output: z.object({ providers: z.array(providerSettingsSchema) }),
  },
  imageSettings: { input: z.null(), output: imageSettingsSchema },
  daytonaCapacity: { input: z.null(), output: daytonaCapacitySchema },
  updateImageConfiguration: {
    input: z.object({
      repository: z.string().max(2_000),
      platform: z.string().max(100),
      registryUsername: z.string().max(10_000).optional(),
      registryToken: z.string().max(10_000).optional(),
      packages: z.array(z.string()).max(100),
    }),
    output: imageSettingsSchema,
  },
  setProviderEnabled: {
    input: z.object({
      provider: z.enum(sandboxProviderValues),
      enabled: z.boolean(),
    }),
    output: providerSettingsSchema,
  },
  updateProviderConfiguration: {
    input: z.discriminatedUnion("provider", [
      z.object({
        provider: z.literal("daytona"),
        apiKey: z.string().max(10_000).optional(),
        apiUrl: z.string().max(2_000),
        target: z.string().max(500),
        sandboxClass: z.enum(["container", "linux-vm", "windows"]),
      }),
      z.object({
        provider: z.literal("modal"),
        tokenId: z.string().max(10_000).optional(),
        tokenSecret: z.string().max(10_000).optional(),
        appName: z.string().min(1).max(500),
        vmRuntime: z.boolean(),
      }),
      z.object({
        provider: z.literal("e2b"),
        apiKey: z.string().max(10_000).optional(),
      }),
      z.object({
        provider: z.literal("box"),
        apiKey: z.string().max(10_000).optional(),
        machineClass: z.enum(["small", "default", "large"]),
        environment: z.string().min(1).max(500),
      }),
      z.object({
        provider: z.literal("freestyle"),
        apiKey: z.string().max(10_000).optional(),
        cpu: z.string().min(1).max(20),
        memory: z.string().min(1).max(20),
        storage: z.string().min(1).max(20),
        persistence: z.enum(["sticky", "persistent"]),
        snapshotId: z.string().max(500),
      }),
    ]),
    output: providerSettingsSchema,
  },
  buildImage: {
    input: z.object({
      provider: z.enum(sandboxImageProviders).optional(),
      name: z.string().min(1).max(100).optional(),
    }),
    output: imageBuildSchema,
  },
  branches: {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({
      branches: z.array(z.string().min(1)),
      defaultBranch: z.string().min(1).nullable(),
    }),
  },
  updateAuthDefaults: {
    input: authSelectionSchema,
    output: authSelectionSchema,
  },
  threadStatuses: {
    input: z.object({
      threads: z.array(sandboxThreadRefSchema).max(500),
    }),
    output: z.object({ statuses: z.array(sandboxThreadStatusViewSchema) }),
  },
  sandboxAlwaysOn: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  setSandboxAlwaysOn: {
    input: z.object({ threadId: z.string().min(1), enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  threadAttachments: { input: z.object({ threadId: z.string().min(1) }).strict(), output: attachmentsViewSchema },
  updateThreadAttachments: { input: z.object({ threadId: z.string().min(1), change: attachmentChangeSchema }).strict(), output: z.object({ accepted: z.literal(true) }) },
  threadResources: {
    input: sandboxThreadRefSchema.extend({ refresh: z.boolean().optional() }),
    output: z.object({
      managed: z.boolean(),
      sandboxId: z.string().nullable(),
      provider: z.enum(sandboxProviderValues).nullable(),
      state: z.enum(sandboxRuntimeStateValues).nullable(),
      capability: z.enum(sandboxResizeCapabilityValues),
      capabilityReason: z.string().nullable(),
      latest: resourceSampleSchema.nullable(),
      provisioned: provisionedResourcesSchema.nullable(),
      target: provisionedResourcesSchema.nullable(),
      assessment: resourceAssessmentSchema.nullable(),
      stale: z.boolean(),
      sampleError: z.string().nullable(),
    }),
  },
  /** The thread's Model Gateway route for the machine popover; null without one. */
  threadModelRoute: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: modelRouteSchema.nullable(),
  },
  sizeProfiles: {
    input: z.object({ projectId: z.string().min(1).optional() }),
    output: z.object({ profiles: z.array(sizeProfileSchema) }),
  },
  setSizeProfile: {
    input: resourceRequestSchema.extend({
      projectId: z.string().min(1),
      provider: z.enum(sandboxProviderValues),
      tier: sizeTierSchema.optional(),
      regionId: z.string().min(1).nullable().optional(),
    }),
    output: sizeProfileSchema,
  },
  sizeTiers: {
    input: z.null(),
    output: z.object({ tiers: z.array(sizeTierViewSchema) }),
  },
  clearSizeProfile: {
    input: z.object({
      projectId: z.string().min(1),
      provider: z.enum(sandboxProviderValues),
    }),
    output: z.object({ removed: z.boolean() }),
  },
  resizeSandbox: {
    input: resourceRequestSchema.extend({ sandboxId: z.string().min(1) }),
    output: z.object({
      sandboxId: z.string(),
      supported: z.boolean(),
      reason: z.string().nullable(),
      target: provisionedResourcesSchema,
      provisioned: provisionedResourcesSchema.nullable(),
      restarted: z.boolean(),
    }),
  },
  versionAudit: { input: z.null(), output: versionAuditSchema },
  /** Run `bb sandbox upgrade` as a job; one runs at a time. */
  startSandboxUpgrade: {
    input: z.object({ check: z.boolean().optional() }),
    output: z.object({ id: z.string() }),
  },
  /** An upgrade job's progress after `cursor`; no id reads the running or latest one. */
  sandboxUpgradeJob: {
    input: z.object({ id: z.string().nullable(), cursor: z.number().int().min(0) }),
    output: sandboxUpgradeJobSchema.nullable(),
  },
});
