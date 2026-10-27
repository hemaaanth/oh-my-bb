import type { BbPluginApi, ExperimentalPluginRpcHandlerContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { capabilityCatalog } from "./capabilities.js";
import { rpcContract, type CapabilityId } from "./contract.js";
import { credentialVariablePrefix, readDotenvValues, resolveHostPath } from "./credential-import.js";
import { hostClient, runCommand } from "./host-contract.js";
import { clickhouseQueryInputSchema, runClickhouseQuery } from "./clickhouse-tool.js";
import { cleanupWorkspace, prepareWorkspace, ServiceAccountTokenStore } from "./runtime.js";
import { PreparationObservation } from "./preparation-outcome.js";
import { setupRecipeForProject } from "./setup-recipes.js";
import { migrations, ProjectEnvironmentStore, type Preparation, type ProfileInput } from "./store.js";
import { z } from "zod";

const catalogMaterializationSchema = z.object({
  ready: z.boolean(),
  digest: z.string(),
  skillCount: z.number().int().nonnegative(),
  roots: z.array(z.string()),
  detail: z.string(),
});
const catalogMaterializationStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("running") }),
  z.object({ state: z.literal("complete"), result: catalogMaterializationSchema }),
  z.object({ state: z.literal("failed"), error: z.string() }),
]);

const projectContextSchema = z.object({
  projectId: z.string(),
  credentialId: z.string().uuid().nullable(),
  groupId: z.string().uuid().nullable(),
  agentIds: z.array(z.string().uuid()),
  bundleIds: z.array(z.string().uuid()),
});
const projectContextsSchema = z.object({ projects: z.array(projectContextSchema) });

const okSchema = z.object({ ok: z.literal(true) });

interface ProjectView {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  profileId: string | null;
  localHostId: string | null;
  localPath: string | null;
}

// Project-specific presets are private project files, never public plugin defaults.
const suggestions: Array<{ name: string; projectNames: string[]; capabilities: CapabilityId[]; setupScript?: string }> = [];

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function options(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function json(value: unknown): PluginCliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` };
}

function errorResult(error: unknown): PluginCliResult {
  return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
}

function requirePreparationCaller(context: ExperimentalPluginRpcHandlerContext | undefined) {
  const caller = context?.experimental_caller;
  if (caller?.kind === "client" || (caller?.kind === "plugin" && (caller.pluginId === "sandboxes" || caller.pluginId === "project-environments"))) return;
  throw new Error("Preparation requires a client or the Sandboxes plugin");
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  db.pragma("foreign_keys = ON");
  const store = new ProjectEnvironmentStore(db);
  const tokenStore = new ServiceAccountTokenStore(db.name);
  const profileCache = new Map<string, ReturnType<ProjectEnvironmentStore["requireProfile"]> | null>();

  async function projectCredentialId(projectId: string): Promise<string | null> {
    const context = await bb.sdk.plugins.callRpc({
      pluginId: "projects",
      method: "projectContext",
      input: { projectId },
      outputSchema: projectContextSchema,
    });
    return context.credentialId;
  }

  async function profileForProject(projectId: string) {
    const credentialId = await projectCredentialId(projectId);
    const profile = credentialId ? store.getProfile(credentialId) ?? null : null;
    profileCache.set(projectId, profile);
    return profile;
  }

  async function setProjectCredential(projectId: string, credentialId: string | null) {
    return bb.sdk.plugins.callRpc({
      pluginId: "projects",
      method: "updateProject",
      input: { projectId, credentialId },
      outputSchema: okSchema,
    });
  }

  async function projects(): Promise<ProjectView[]> {
    const rows = (await bb.sdk.projects.list()).filter((project) => project.kind === "standard");
    const contexts = await bb.sdk.plugins.callRpc({
      pluginId: "projects",
      method: "projectContexts",
      input: { projectIds: rows.map((project) => project.id) },
      outputSchema: projectContextsSchema,
    });
    const credentialIdByProject = new Map(contexts.projects.map((project) => [project.projectId, project.credentialId]));
    return rows.map((project) => {
      const source = project.sources.find((candidate) => candidate.type === "local_path" && candidate.isDefault)
        ?? project.sources.find((candidate) => candidate.type === "local_path")
        ?? null;
      const profileId = credentialIdByProject.get(project.id) ?? null;
      profileCache.set(project.id, profileId ? store.getProfile(profileId) ?? null : null);
      return {
        id: project.id,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
        profileId,
        localHostId: source?.hostId ?? null,
        localPath: source?.path ?? null,
      };
    });
  }

  async function profileDto(profile: ReturnType<ProjectEnvironmentStore["requireProfile"]>) {
    return { ...profile, tokenConfigured: await tokenStore.configured(profile.id) };
  }

  async function snapshot() {
    const [profileRows, projectRows] = await Promise.all([
      Promise.all(store.listProfiles().map(profileDto)),
      projects(),
    ]);
    return { profiles: profileRows, projects: projectRows, capabilities: [...capabilityCatalog], preparations: store.listPreparations() };
  }

  async function listCredentials() {
    return { credentials: store.listProfiles().map(({ id, name, environmentName }) => ({ id, name, environmentName })) };
  }

  async function legacySnapshot() {
    const bindings = new Map(store.listBindings().map((binding) => [binding.projectId, binding.profileId]));
    const rows = await bb.sdk.projects.list();
    return {
      profiles: await Promise.all(store.listProfiles().map(profileDto)),
      projects: rows.filter((project) => project.kind === "standard").map((project) => {
        const source = project.sources.find((candidate) => candidate.type === "local_path" && candidate.isDefault)
          ?? project.sources.find((candidate) => candidate.type === "local_path")
          ?? null;
        return {
          id: project.id,
          name: project.name,
          gitRemoteUrl: project.gitRemoteUrl,
          profileId: bindings.get(project.id) ?? null,
          localHostId: source?.hostId ?? null,
          localPath: source?.path ?? null,
        };
      }),
    };
  }

  const workspaceCredentials = new Map(await Promise.all((await bb.storage.kv.list("sandbox-credential:")).map(async (key) => [key.slice("sandbox-credential:".length), z.object({ id: z.string().nullable() }).parse(await bb.storage.kv.get(key)).id] as const)));
  const workspaceTools = new Map(await Promise.all((await bb.storage.kv.list("sandbox-tools:")).map(async (key) => [key.slice("sandbox-tools:".length), z.array(z.string()).parse(await bb.storage.kv.get(key)) as CapabilityId[]] as const)));
  function effectiveProfile(projectId: string, hostId: string, path: string | null) {
    const key = `${hostId}:${path}`;
    const id = workspaceCredentials.get(key);
    const profile = id === undefined ? profileCache.get(projectId) ?? null : id === null ? null : store.getProfile(id);
    return profile && workspaceTools.has(key) ? { ...profile, capabilities: workspaceTools.get(key)! } : profile;
  }

  async function prepare(input: { projectId: string; hostId: string; workspacePath: string; credentialProfileId?: string | null; toolIds?: CapabilityId[]; strict: boolean; skipWorkspaceSetup?: boolean }, observation?: PreparationObservation) {
    const plugins = await bb.sdk.plugins.list();
    const catalogAvailable = plugins.plugins.some((candidate) => candidate.id === "catalog" && candidate.enabled && candidate.status === "running");
    const project = (await projects()).find((candidate) => candidate.id === input.projectId);
    const key = `sandbox-tools:${input.hostId}:${input.workspacePath}`;
    if (input.toolIds !== undefined) { await bb.storage.kv.set(key, input.toolIds); workspaceTools.set(`${input.hostId}:${input.workspacePath}`, input.toolIds); }
    const toolIds = input.toolIds ?? await bb.storage.kv.get(key) as import("./contract.js").CapabilityId[] | undefined;
    const credentialKey = `sandbox-credential:${input.hostId}:${input.workspacePath}`;
    const savedCredential = await bb.storage.kv.get(credentialKey) as { id: string | null } | undefined;
    const credentialId = input.credentialProfileId !== undefined ? input.credentialProfileId : savedCredential?.id;
    const profile = credentialId === undefined ? await profileForProject(input.projectId) : credentialId === null ? null : store.requireProfile(credentialId);
    const previous = store.preparationsForProject(input.projectId).find((item) => item.hostId === input.hostId && item.workspacePath === input.workspacePath);
    if (previous?.profileId && previous.profileId !== profile?.id) {
      await cleanupWorkspace({ bb, hostId: input.hostId, workspacePath: input.workspacePath, profileId: previous.profileId, preserveSharedToken: store.listPreparations().some((item) => item.hostId === input.hostId && item.profileId === previous.profileId && item.workspacePath !== input.workspacePath), observation });
    }
    // Persist explicit detachment too, so wake/reconciliation cannot reattach defaults.
    if (input.credentialProfileId !== undefined) { await bb.storage.kv.set(credentialKey, { id: input.credentialProfileId }); workspaceCredentials.set(`${input.hostId}:${input.workspacePath}`, input.credentialProfileId); }
    const projectRecipe = setupRecipeForProject(project?.localPath ?? null);
    const result = await prepareWorkspace({
      toolIds,
      skipWorkspaceSetup: input.skipWorkspaceSetup,
      bb,
      projectId: input.projectId,
      hostId: input.hostId,
      workspacePath: input.workspacePath,
      profile: profile && projectRecipe?.machineSetupScript ? { ...profile, setupScript: projectRecipe.machineSetupScript } : profile,
      workspaceSetupScript: projectRecipe?.workspaceSetupScript,
      tokenStore,
      observation,
      materializeCatalog: catalogAvailable ? async ({ homePath }) => {
        observation?.catalogWork();
        const started = await bb.sdk.plugins.callRpc({
          pluginId: "catalog",
          method: "startMaterialize",
          input: { hostId: input.hostId, homePath, projectId: input.projectId, workspacePath: input.workspacePath },
          outputSchema: z.object({ jobId: z.string().uuid() }),
        });
        for (;;) {
          const status = await bb.sdk.plugins.callRpc({
            pluginId: "catalog",
            method: "materializationStatus",
            input: { jobId: started.jobId },
            outputSchema: catalogMaterializationStatusSchema,
          });
          if (status.state === "complete") return status.result;
          if (status.state === "failed") throw new Error(status.error);
          await delay(1_000);
        }
      } : undefined,
    });
    store.savePreparation(result);
    bb.realtime.publish("project-environments-changed", { projectId: input.projectId, hostId: input.hostId });
    if (input.strict && credentialId !== null && !result.ready) {
      const missing = result.checks.filter((check) => check.status === "missing").map((check) => check.label).join(", ");
      observation?.notReady();
      throw new Error(`Project credentials are not ready: ${missing}`);
    }
    return result;
  }

  type PreparationJob =
    | { state: "running" }
    | { state: "complete"; result: Preparation }
    | { state: "failed"; error: string };
  const preparationJobs = new Map<string, { status: PreparationJob; observation: PreparationObservation }>();
  const runningPreparationByTarget = new Map<string, string>();

  function startPrepare(input: { projectId: string; hostId: string; workspacePath: string; credentialProfileId?: string | null; toolIds?: import("./contract.js").CapabilityId[]; strict: boolean; skipWorkspaceSetup?: boolean }) {
    const target = JSON.stringify([input.projectId, input.hostId, input.workspacePath, input.credentialProfileId, input.toolIds, input.skipWorkspaceSetup, input.strict]);
    const currentId = runningPreparationByTarget.get(target);
    if (currentId && preparationJobs.get(currentId)?.status.state === "running") return { jobId: currentId };
    const jobId = randomUUID();
    const job: { status: PreparationJob; observation: PreparationObservation } = { status: { state: "running" }, observation: new PreparationObservation() };
    preparationJobs.set(jobId, job);
    runningPreparationByTarget.set(target, jobId);
    void prepare(input, job.observation).then(
      (result) => { job.status = { state: "complete", result }; },
      (error) => { job.status = { state: "failed", error: error instanceof Error ? error.message : String(error) }; },
    ).finally(() => {
      if (runningPreparationByTarget.get(target) === jobId) runningPreparationByTarget.delete(target);
      const expiry = setTimeout(() => preparationJobs.delete(jobId), 60 * 60_000);
      expiry.unref();
    });
    return { jobId };
  }

  async function prepareLocalProject(project: ProjectView, strict: boolean) {
    if (!project.localHostId || !project.localPath) throw new Error(`${project.name} has no local checkout`);
    return prepare({ projectId: project.id, hostId: project.localHostId, workspacePath: project.localPath, strict });
  }

  async function prepareLocal(projectId: string, strict: boolean) {
    const project = (await projects()).find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return prepareLocalProject(project, strict);
  }

  const localReconciliations = new Map<string, Promise<Awaited<ReturnType<typeof prepareLocal>> | null>>();

  function reconcileLocal(projectId: string, resolvedProject?: ProjectView) {
    const previous = localReconciliations.get(projectId) ?? Promise.resolve(null);
    const next = previous.catch(() => null).then(async () => {
      const project = resolvedProject ?? (await projects()).find((candidate) => candidate.id === projectId);
      if (!project?.profileId || !project.localHostId || !project.localPath) return null;
      try {
        return await prepareLocalProject(project, false);
      } catch (error) {
        bb.log.warn(`Could not automatically reconcile ${project.name}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }).finally(() => {
      if (localReconciliations.get(projectId) === next) localReconciliations.delete(projectId);
    });
    localReconciliations.set(projectId, next);
    return next;
  }

  async function reconcileProfileLocals(profileId: string) {
    const projectRows = await projects();
    return Promise.all(projectRows.filter((project) => project.profileId === profileId).map((project) => reconcileLocal(project.id, project)));
  }

  async function refreshProject(projectId: string) {
    profileCache.delete(projectId);
    const nextProfile = await profileForProject(projectId);
    const stale = defaultPreparationsForProject(projectId).filter((preparation) => preparation.profileId && preparation.profileId !== nextProfile?.id);
    for (const profileId of new Set(stale.map((preparation) => preparation.profileId).filter((id): id is string => Boolean(id)))) {
      await cleanupPreparations(stale.filter((preparation) => preparation.profileId === profileId), profileId);
    }
    bb.realtime.publish("project-environments-changed", { projectId, reason: "project-configuration-changed" });
    if (nextProfile) await reconcileLocal(projectId);
    return { ok: true as const };
  }

  function defaultPreparationsForProject(projectId: string) {
    return store.preparationsForProject(projectId).filter((item) => !workspaceCredentials.has(`${item.hostId}:${item.workspacePath}`));
  }

  async function cleanupPreparations(preparations: ReturnType<ProjectEnvironmentStore["listPreparations"]>, profileId: string) {
    await Promise.all(preparations.map(async (preparation) => {
      await cleanupWorkspace({ bb, hostId: preparation.hostId, workspacePath: preparation.workspacePath, profileId, preserveSharedToken: store.listPreparations().some((item) => item.hostId === preparation.hostId && item.profileId === profileId && !preparations.some((removed) => removed.hostId === item.hostId && removed.workspacePath === item.workspacePath)) }).catch((error) => {
        bb.log.warn(`Could not clean project credential metadata on ${preparation.hostId}: ${error instanceof Error ? error.message : String(error)}`);
      });
      store.deletePreparation(preparation.projectId, preparation.hostId, preparation.workspacePath);
    }));
  }

  async function cleanupPreparation(input: { projectId: string; hostId: string; workspacePath: string }) {
    const preparation = store.preparationsForProject(input.projectId).find((candidate) =>
      candidate.hostId === input.hostId && candidate.workspacePath === input.workspacePath,
    );
    if (preparation?.profileId) {
      await cleanupWorkspace({ bb, hostId: input.hostId, workspacePath: input.workspacePath, profileId: preparation.profileId, preserveSharedToken: store.listPreparations().some((item) => item.hostId === input.hostId && item.profileId === preparation.profileId && item.workspacePath !== input.workspacePath) }).catch((error) => {
        bb.log.warn(`Could not remove project credential files from ${input.hostId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    store.deletePreparation(input.projectId, input.hostId, input.workspacePath);
    bb.realtime.publish("project-environments-changed", { ...input, reason: "preparation-cleaned" });
    return { ok: true } as const;
  }

  async function seedSuggestedProfiles() {
    let created = 0;
    const profileByName = new Map(store.listProfiles().map((profile) => [profile.name.toLowerCase(), profile]));
    for (const suggestion of suggestions) {
      const existing = profileByName.get(suggestion.name.toLowerCase());
      if (existing) {
        if (!existing.setupScript && suggestion.setupScript) {
          profileByName.set(existing.name.toLowerCase(), store.saveProfile({
            ...existing,
            setupScript: suggestion.setupScript,
          }));
        }
        continue;
      }
      const serviceAccountName = suggestion.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
      const profile = store.saveProfile({
        name: suggestion.name,
        environmentName: suggestion.name,
        environmentId: "",
        account: "",
        serviceAccountName,
        capabilities: suggestion.capabilities,
        setupScript: suggestion.setupScript ?? "",
        instructions: "",
      });
      profileByName.set(suggestion.name.toLowerCase(), profile);
      created += 1;
    }
    let bound = 0;
    const projectRows = await projects();
    for (const suggestion of suggestions) {
      const profile = profileByName.get(suggestion.name.toLowerCase());
      if (!profile) continue;
      for (const project of projectRows.filter((candidate) => suggestion.projectNames.includes(candidate.name.toLowerCase()))) {
        if (project.profileId) continue;
        await setProjectCredential(project.id, profile.id);
        bound += 1;
      }
    }
    bb.realtime.publish("project-environments-changed", { reason: "suggestions-seeded" });
    return { created, bound };
  }

  bb.rpc.register(rpcContract, {
    workspaceSelection: async ({ projectId, hostId, workspacePath }) => {
      const saved = await bb.storage.kv.get(`sandbox-credential:${hostId}:${workspacePath}`) as { id: string | null } | undefined;
      const preparation = store.preparationsForProject(projectId).find((item) => item.hostId === hostId && item.workspacePath === workspacePath);
      return { credentialProfileId: saved ? saved.id : preparation ? preparation.profileId : (await profileForProject(projectId))?.id ?? null, toolIds: await bb.storage.kv.get(`sandbox-tools:${hostId}:${workspacePath}`) as CapabilityId[] | null ?? null };
    },
    snapshot: () => snapshot(),
    listCredentials: () => listCredentials(),
    legacySnapshot: () => legacySnapshot(),
    saveProfile: async (input) => {
      const saved = store.saveProfile(input as ProfileInput);
      bb.realtime.publish("project-environments-changed", { profileId: saved.id });
      void reconcileProfileLocals(saved.id);
      return profileDto(saved);
    },
    deleteProfile: async ({ id }) => {
      await cleanupPreparations(store.preparationsForProfile(id), id);
      await tokenStore.remove(id);
      await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "removeCredential", input: { credentialId: id }, outputSchema: okSchema });
      store.deleteProfile(id);
      bb.realtime.publish("project-environments-changed", { profileId: id });
      return { ok: true } as const;
    },
    bindProject: async ({ projectId, profileId }) => {
      if (profileId) store.requireProfile(profileId);
      const previous = await profileForProject(projectId);
      if (previous && previous.id !== profileId) {
        await cleanupPreparations(defaultPreparationsForProject(projectId), previous.id);
      }
      await setProjectCredential(projectId, profileId);
      bb.realtime.publish("project-environments-changed", { projectId });
      if (profileId) void reconcileLocal(projectId);
      return { ok: true } as const;
    },
    setServiceAccountToken: async ({ profileId, token }) => {
      store.requireProfile(profileId);
      await tokenStore.write(profileId, token);
      bb.realtime.publish("project-environments-changed", { profileId });
      void reconcileProfileLocals(profileId);
      return { configured: true } as const;
    },
    prepare: (input, context) => {
      requirePreparationCaller(context);
      return prepare(input);
    },
    startPrepare: (input, context) => {
      requirePreparationCaller(context);
      return startPrepare(input);
    },
    preparationStatus: ({ jobId }) => preparationJobs.get(jobId)?.status ?? { state: "failed" as const, error: "Preparation job is no longer available" },
    preparationOutcomeV1: ({ jobId }, context) => {
      requirePreparationCaller(context);
      const job = preparationJobs.get(jobId);
      return job
        ? job.observation.snapshot(jobId, job.status)
        : { schemaVersion: 1 as const, jobId, state: "unknown" as const, retryable: false as const, reason: "job_unavailable" as const };
    },
    cleanupPreparation: (input, context) => {
      requirePreparationCaller(context);
      return cleanupPreparation(input);
    },
    prepareLocal: ({ projectId, strict }) => prepareLocal(projectId, strict),
    seedSuggestedProfiles: () => seedSuggestedProfiles(),
    refreshProject: ({ projectId }) => refreshProject(projectId),
  });

  // Resolves the calling thread's ready workspace and prepares it before a tool
  // that needs one credential capability runs there.
  async function preparedToolWorkspace(context: { threadId: string; projectId: string }, capability: CapabilityId, label: string) {
    const thread = await bb.sdk.threads.get({ threadId: context.threadId });
    if (!thread.environmentId) throw new Error("This thread has no execution environment");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.projectId !== context.projectId) throw new Error("Thread environment does not belong to this project");
    if (!environment.path || environment.status !== "ready") throw new Error(`Thread environment is ${environment.status}, not ready`);
    const profile = effectiveProfile(context.projectId, environment.hostId, environment.path);
    if (!profile?.capabilities.includes(capability)) throw new Error(`This workspace's attached credentials do not provide ${label}`);
    await prepare({ projectId: context.projectId, hostId: environment.hostId, workspacePath: environment.path, strict: true });
    return { hostId: environment.hostId, workspacePath: environment.path };
  }

  bb.agents.registerTool({
    name: "query_clickhouse",
    description: "Run one guarded, read-only ClickHouse SELECT when the current project's credentials provide ClickHouse.",
    instructions: "Use only when the current project's credential set provides ClickHouse. Query before claiming analytical results; never use Bash or a general shell as a substitute.",
    presentation: {
      label: {
        pending: "Querying ClickHouse",
        completed: "Queried ClickHouse",
      },
      icon: { glyph: "ChartColumn" },
    },
    parameters: clickhouseQueryInputSchema,
    async execute({ sql }, context) {
      const workspace = await preparedToolWorkspace(context, "clickhouse", "ClickHouse");
      return JSON.stringify(await runClickhouseQuery(bb, { ...workspace, sql, signal: context.signal }));
    },
  });

  bb.cli.register({
    name: "project-env",
    summary: "Manage project-scoped tools and credentials",
    commands: [
      { name: "list", summary: "List credential sets and project assignments", usage: "bb project-env list [--json]" },
      { name: "prepare", summary: "Reconcile a project's local or explicit machine checkout", usage: "bb project-env prepare [--project <id>] [--host <id> --workspace <path>] [--strict] [--json]" },
      { name: "import-credential", summary: "Consume a native bb Secrets handoff for one credential set", usage: "bb project-env import-credential --profile <id-or-name> --file <path> [--environment-id-var <name>] [--token-var <name>]" },
      { name: "import-credentials", summary: "Consume one native bb Secrets handoff for selected credential sets", usage: "bb project-env import-credentials --file <path> --profile <id-or-name> [--profile <id-or-name> ...]" },
      { name: "bind", summary: "Assign a credential set to a BB project", usage: "bb project-env bind --project <id-or-name> --profile <id-or-name>" },
      { name: "unbind", summary: "Remove a BB project's credential assignment", usage: "bb project-env unbind --project <id-or-name>" },
      { name: "set-setup", summary: "Set a credential set's non-secret machine setup script", usage: "bb project-env set-setup --profile <id-or-name> --file <path>" },
      { name: "enable-tool", summary: "Enable a project-scoped tool on a credential set", usage: "bb project-env enable-tool --profile <id-or-name> --tool <capability>" },
      { name: "cleanup", summary: "Remove staged credential data and readiness bookkeeping", usage: "bb project-env cleanup --project <id> --host <id> --workspace <path>" },
      { name: "seed", summary: "Create the suggested starter credential sets", usage: "bb project-env seed [--json]" },
      { name: "run", summary: "Run a command with the current project's scoped 1Password Environment", usage: "bb project-env run -- <command> [args...]" },
    ],
    async run(argv, ctx) {
      try {
        const command = argv[0] ?? "list";
        if (command === "list") return json(await snapshot());
        if (command === "seed") {
          const result = await seedSuggestedProfiles();
          return json(result);
        }
        if (command === "prepare") {
          const projectId = option(argv, "--project") ?? ctx.projectId;
          if (!projectId) throw new Error("Choose a project or pass --project <id>");
          const hostId = option(argv, "--host");
          const workspacePath = option(argv, "--workspace");
          if (hostId || workspacePath) {
            if (!hostId || !workspacePath) throw new Error("--host and --workspace must be provided together");
            return json(await prepare({ projectId, hostId, workspacePath, strict: argv.includes("--strict") }));
          }
          return json(await prepareLocal(projectId, argv.includes("--strict")));
        }
        if (command === "import-credential") {
          if (!ctx.threadId || !ctx.cwd) throw new Error("Credential import must run from a bb thread with a working directory");
          const profileRef = option(argv, "--profile");
          const handoff = option(argv, "--file");
          if (!profileRef || !handoff) throw new Error("Usage: bb project-env import-credential --profile <id-or-name> --file <path>");
          const profile = store.getProfile(profileRef) ?? store.findProfileByName(profileRef);
          if (!profile) throw new Error(`Unknown credential set: ${profileRef}`);
          const environmentIdVariable = option(argv, "--environment-id-var") ?? "OP_ENVIRONMENT_ID";
          const tokenVariable = option(argv, "--token-var") ?? "OP_SERVICE_ACCOUNT_TOKEN";
          const thread = await bb.sdk.threads.get({ threadId: ctx.threadId, include: "host" });
          const hostId = "host" in thread
            && typeof thread.host === "object"
            && thread.host !== null
            && "id" in thread.host
            && typeof thread.host.id === "string"
            ? thread.host.id
            : null;
          if (!hostId) throw new Error("The current thread needs a live host");
          const handoffPath = resolveHostPath(ctx.cwd, handoff);
          const file = await bb.sdk.files.read({ hostId, path: handoffPath });
          if (file.contentEncoding !== "utf8") throw new Error("Credential handoff must be a UTF-8 dotenv file");
          const values = readDotenvValues(file.content, [environmentIdVariable, tokenVariable]);
          store.saveProfile({ ...profile, environmentId: values[environmentIdVariable] });
          await tokenStore.write(profile.id, values[tokenVariable]);
          await bb.sdk.files.remove({ hostId, path: handoffPath });
          bb.realtime.publish("project-environments-changed", { profileId: profile.id, reason: "credential-imported" });
          const preparations = await reconcileProfileLocals(profile.id);
          return json({
            profileId: profile.id,
            environmentIdConfigured: true,
            credentialConfigured: true,
            handoffRemoved: true,
            localPreparations: preparations.filter(Boolean).map((preparation) => ({
              projectId: preparation!.projectId,
              ready: preparation!.ready,
              missing: preparation!.checks.filter((check) => check.status === "missing").map((check) => check.id),
            })),
          });
        }
        if (command === "import-credentials") {
          if (!ctx.threadId || !ctx.cwd) throw new Error("Credential import must run from a bb thread with a working directory");
          const handoff = option(argv, "--file");
          const profileRefs = options(argv, "--profile");
          if (!handoff || profileRefs.length === 0) throw new Error("Usage: bb project-env import-credentials --file <path> --profile <id-or-name> [--profile <id-or-name> ...]");
          const selectedProfiles = profileRefs.map((reference) => {
            const profile = store.getProfile(reference) ?? store.findProfileByName(reference);
            if (!profile) throw new Error(`Unknown credential set: ${reference}`);
            return profile;
          });
          if (new Set(selectedProfiles.map((profile) => profile.id)).size !== selectedProfiles.length) {
            throw new Error("Each credential set may appear only once");
          }
          const requestedVariables = selectedProfiles.flatMap((profile) => {
            const prefix = credentialVariablePrefix(profile.name);
            return [`${prefix}_OP_ENVIRONMENT_ID`, `${prefix}_OP_SERVICE_ACCOUNT_TOKEN`];
          });
          const thread = await bb.sdk.threads.get({ threadId: ctx.threadId, include: "host" });
          const hostId = "host" in thread
            && typeof thread.host === "object"
            && thread.host !== null
            && "id" in thread.host
            && typeof thread.host.id === "string"
            ? thread.host.id
            : null;
          if (!hostId) throw new Error("The current thread needs a live host");
          const handoffPath = resolveHostPath(ctx.cwd, handoff);
          const file = await bb.sdk.files.read({ hostId, path: handoffPath });
          if (file.contentEncoding !== "utf8") throw new Error("Credential handoff must be a UTF-8 dotenv file");
          const values = readDotenvValues(file.content, requestedVariables);
          for (const profile of selectedProfiles) {
            const prefix = credentialVariablePrefix(profile.name);
            store.saveProfile({ ...profile, environmentId: values[`${prefix}_OP_ENVIRONMENT_ID`] });
            await tokenStore.write(profile.id, values[`${prefix}_OP_SERVICE_ACCOUNT_TOKEN`]);
          }
          await bb.sdk.files.remove({ hostId, path: handoffPath });
          bb.realtime.publish("project-environments-changed", { reason: "credential-bundle-imported" });
          for (const profile of selectedProfiles) void reconcileProfileLocals(profile.id);
          return json({
            configuredProfiles: selectedProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
            handoffRemoved: true,
            localReconciliationQueued: true,
          });
        }
        if (command === "bind") {
          const projectRef = option(argv, "--project");
          const profileRef = option(argv, "--profile");
          if (!projectRef || !profileRef) throw new Error("Usage: bb project-env bind --project <id-or-name> --profile <id-or-name>");
          const project = (await projects()).find((candidate) => candidate.id === projectRef || candidate.name.toLowerCase() === projectRef.toLowerCase());
          if (!project) throw new Error(`Unknown project: ${projectRef}`);
          const profile = store.getProfile(profileRef) ?? store.findProfileByName(profileRef);
          if (!profile) throw new Error(`Unknown credential set: ${profileRef}`);
          const previous = await profileForProject(project.id);
          if (previous && previous.id !== profile.id) await cleanupPreparations(defaultPreparationsForProject(project.id), previous.id);
          await setProjectCredential(project.id, profile.id);
          bb.realtime.publish("project-environments-changed", { projectId: project.id, reason: "project-bound" });
          void reconcileLocal(project.id);
          return json({ projectId: project.id, projectName: project.name, profileId: profile.id, profileName: profile.name, localReconciliationQueued: true });
        }
        if (command === "unbind") {
          const projectRef = option(argv, "--project");
          if (!projectRef) throw new Error("Usage: bb project-env unbind --project <id-or-name>");
          const project = (await projects()).find((candidate) => candidate.id === projectRef || candidate.name.toLowerCase() === projectRef.toLowerCase());
          if (!project) throw new Error(`Unknown project: ${projectRef}`);
          const previous = await profileForProject(project.id);
          if (previous) await cleanupPreparations(defaultPreparationsForProject(project.id), previous.id);
          await setProjectCredential(project.id, null);
          bb.realtime.publish("project-environments-changed", { projectId: project.id, reason: "project-unbound" });
          return json({ projectId: project.id, projectName: project.name, previousProfileId: previous?.id ?? null, previousProfileName: previous?.name ?? null, unbound: true });
        }
        if (command === "set-setup") {
          if (!ctx.threadId || !ctx.cwd) throw new Error("Setup import must run from a bb thread with a working directory");
          const profileRef = option(argv, "--profile");
          const source = option(argv, "--file");
          if (!profileRef || !source) throw new Error("Usage: bb project-env set-setup --profile <id-or-name> --file <path>");
          const profile = store.getProfile(profileRef) ?? store.findProfileByName(profileRef);
          if (!profile) throw new Error(`Unknown credential set: ${profileRef}`);
          const thread = await bb.sdk.threads.get({ threadId: ctx.threadId, include: "host" });
          const hostId = "host" in thread
            && typeof thread.host === "object"
            && thread.host !== null
            && "id" in thread.host
            && typeof thread.host.id === "string"
            ? thread.host.id
            : null;
          if (!hostId) throw new Error("The current thread needs a live host");
          const sourcePath = resolveHostPath(ctx.cwd, source);
          const file = await bb.sdk.files.read({ hostId, path: sourcePath });
          if (file.contentEncoding !== "utf8") throw new Error("Setup script must be a UTF-8 text file");
          const setupScript = file.content.trim();
          if (setupScript.length > 20_000) throw new Error("Setup script must be at most 20,000 characters");
          const saved = store.saveProfile({ ...profile, setupScript });
          bb.realtime.publish("project-environments-changed", { profileId: saved.id, reason: "setup-script-updated" });
          const preparations = await reconcileProfileLocals(saved.id);
          return json({
            profileId: saved.id,
            setupConfigured: Boolean(setupScript),
            localPreparations: preparations.filter(Boolean).map((preparation) => ({
              projectId: preparation!.projectId,
              ready: preparation!.ready,
              missing: preparation!.checks.filter((check) => check.status === "missing").map((check) => check.id),
            })),
          });
        }
        if (command === "enable-tool") {
          const profileRef = option(argv, "--profile");
          const toolId = option(argv, "--tool");
          if (!profileRef || !toolId) throw new Error("Usage: bb project-env enable-tool --profile <id-or-name> --tool <capability>");
          const capability = capabilityCatalog.find((candidate) => candidate.id === toolId);
          if (!capability) throw new Error(`Unknown project tool: ${toolId}`);
          const profile = store.getProfile(profileRef) ?? store.findProfileByName(profileRef);
          if (!profile) throw new Error(`Unknown credential set: ${profileRef}`);
          const capabilities = profile.capabilities.includes(capability.id)
            ? profile.capabilities
            : [...profile.capabilities, capability.id];
          const saved = store.saveProfile({ ...profile, capabilities });
          bb.realtime.publish("project-environments-changed", { profileId: saved.id, reason: "tool-enabled" });
          const preparations = await reconcileProfileLocals(saved.id);
          return json({
            profileId: saved.id,
            profileName: saved.name,
            enabledTool: capability.id,
            capabilities: saved.capabilities,
            localPreparations: preparations.filter(Boolean).map((preparation) => ({
              projectId: preparation!.projectId,
              ready: preparation!.ready,
              missing: preparation!.checks.filter((check) => check.status === "missing").map((check) => check.id),
            })),
          });
        }
        if (command === "cleanup") {
          const projectId = option(argv, "--project");
          const hostId = option(argv, "--host");
          const workspacePath = option(argv, "--workspace");
          if (!projectId || !hostId || !workspacePath) throw new Error("Usage: bb project-env cleanup --project <id> --host <id> --workspace <path>");
          return json(await cleanupPreparation({ projectId, hostId, workspacePath }));
        }
        if (command === "run") {
          const separator = argv.indexOf("--");
          const commandArgs = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
          if (!commandArgs.length) throw new Error("Usage: bb project-env run -- <command> [args...]");
          const projectRows = await projects();
          const project = projectRows.find((candidate) => candidate.localPath && ctx.cwd?.startsWith(candidate.localPath))
            ?? projectRows.find((candidate) => candidate.id === ctx.projectId);
          if (!project?.localHostId || !project.localPath) throw new Error("Could not resolve a local project checkout");
          await prepareLocal(project.id, true);
          const result = await runCommand(hostClient(bb), project.localHostId, {
            cwd: ctx.cwd ?? project.localPath,
            command: "~/.local/bin/bb-project-env-run",
            args: commandArgs,
            timeoutMs: 2 * 60_000,
          });
          return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        }
        throw new Error(`Unknown project-env command: ${command}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  bb.background.service("local-reconciliation", {
    async start(signal) {
      try { await projects(); }
      catch (error) {
        // A fresh Projects installation has no assignments yet. No cache or
        // agent instructions are populated until explicit initialization.
        if (!(error && typeof error === "object" && "reasonCode" in error && error.reasonCode === "not-migrated")) throw error;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  // Agents are pointed at the `bb-project-env-run` wrapper through this
  // instruction rather than through `bb.providers.experimental_contributeEnv`
  // (BB 0.42+). contributeEnv injects pre-resolved static env values server-side
  // and cannot wrap the command in `op run`, so adopting it would route resolved
  // 1Password secrets through plugin-server memory and the core→host channel and
  // downgrade live per-command resolution to a per-turn snapshot under a 5s
  // budget. The wrapper's on-host, per-invocation, zero-transit resolution is
  // strictly better for secret handling. See README "Why not contributeEnv".
  bb.agents.configure(({ project, host, environment }) => {
    const profile = effectiveProfile(project.id, host.id, environment.path);
    if (!profile) return { tools: [], skills: [] };
    const capabilityNames = profile.capabilities.map((id) => capabilityCatalog.find((capability) => capability.id === id)?.name).filter(Boolean).join(", ");
    const clickhouse = profile.capabilities.includes("clickhouse")
      ? "For ClickHouse analytics, use the native `query_clickhouse` tool. It enforces read-only SQL and returns structured rows plus the executed SQL. Never use Bash or a general shell to query the database."
      : "";
    const selectedTools = profile.capabilities.includes("clickhouse") ? ["query_clickhouse"] : [];
    return { tools: selectedTools, skills: [], instructions: [
      `This workspace uses the credential set “${profile.name}”.`,
      capabilityNames ? `Expected project-scoped tools: ${capabilityNames}.` : "",
      clickhouse,
      "Run other credentialed project commands through `bb-project-env-run <command> [args...]` (or `bb project-env run -- <command> [args...]` from the local checkout). Do not export, print, copy, or persist the injected environment variables.",
      profile.instructions,
    ].filter(Boolean).join("\n\n") };
  });
  return { refreshCache(projectId: string, profileId: string) {
    const profile = store.getProfile(profileId) ?? null;
    for (const [id, cached] of profileCache) if (id === projectId || cached?.id === profileId) profileCache.set(id, profile);
    profileCache.set(projectId, profile);
  } };
}
