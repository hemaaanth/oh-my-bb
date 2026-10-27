import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi, ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { preferencesSchema, rpcContract } from "./contract.js";
import { AssignmentStore } from "./assignment-store.js";
import { createAssignmentRuntime } from "./assignment-runtime.js";
import { AssignmentError, assignmentKinds, requireOwnerClient } from "./assignments.js";
import {
  DEFAULT_ROUTING_MODEL,
  generateRoutingProfile as generateRoutingProfileWithModel,
  normalizeGeneratedRoutingProfile,
  routingEvidenceFingerprint,
  type RoutingProfileEvidence,
} from "./routing-profile.js";
import {
  generateRoutingLearning,
  hasRoutingEvidence,
  projectRoutingEvidence,
  routingLearningFingerprint,
  routingLearningPrompt,
} from "./routing-learning.js";
import { createJevRouting } from "./jev-routing.js";
import { projectSummary, type ProjectRoutingCandidate } from "./project-router.js";
import { migrations, ProjectsStore } from "./store.js";

const credentialSnapshotSchema = z.object({
  profiles: z.array(z.object({ id: z.string(), name: z.string(), environmentName: z.string().optional() }).passthrough()),
  projects: z.array(z.object({ id: z.string(), profileId: z.string().nullable() }).passthrough()),
}).passthrough();

const credentialDefinitionsSchema = z.object({
  credentials: z.array(z.object({ id: z.string(), name: z.string(), environmentName: z.string().optional() }).passthrough()),
}).passthrough();

const agentProfilesSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  isDefault: z.boolean(),
}).passthrough());

const legacyAssignmentsSchema = z.object({
  assignments: z.array(z.object({
    bundleId: z.string(),
    kind: z.enum(["global", "project", "project-environment", "agent-profile"]),
    targetId: z.string(),
  })),
}).passthrough();

const bundleDefinitionsSchema = z.object({
  bundles: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }).passthrough()),
}).passthrough();

const okSchema = z.object({ ok: z.literal(true) });
const remapLegacyGroupsSchema = z.object({ ok: z.literal(true) });

const taskProjectMappingsSchema = z.object({
  sources: z.array(z.object({
    key: z.string(), label: z.string(), provider: z.enum(["akiflow", "linear", "github"]),
    bbProjectId: z.string().nullable(), automatic: z.boolean(),
  })),
}).passthrough();

const taskListSchema = z.object({
  tasks: z.array(z.object({
    title: z.string(),
    projectId: z.string().nullable(),
  }).passthrough()),
}).passthrough();

const sidebarWorkspaceSnapshotSchema = z.object({
  workspaces: z.array(z.object({
    id: z.string(),
    name: z.string(),
    color: z.enum(["amber", "blue", "violet", "green", "rose", "gray"]),
    isDefault: z.boolean(),
    projectIds: z.array(z.string()),
  })),
}).passthrough();

const MAX_ROUTER_PROJECTS = 254;

interface ProjectRow {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  localPath: string | null;
  hostId: string | null;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    openRouterApiKey: {
      type: "string",
      label: "OpenRouter API key",
      description: "For explicit profile generation and learning.",
      secret: true,
    },
    jevApiKey: {
      type: "string",
      label: "Jev API key",
      description: "For project suggestions in the composer.",
      secret: true,
    },
  });
  const storedPreferences = await bb.storage.kv.get<unknown>("projects.preferences.v1");
  const legacyModel = storedPreferences === undefined ? bb.settings.define({
    routingModel: { type: "string", label: "Project profile model", default: DEFAULT_ROUTING_MODEL },
  }) : null;
  let preferences = preferencesSchema.parse(storedPreferences === undefined ? {
    routingModel: (await legacyModel!.get()).routingModel.trim() || DEFAULT_ROUTING_MODEL,
    catalogIntegration: false, credentialsIntegration: false, agentsIntegration: false,
    sidebarIntegration: false, tasksIntegration: false,
  } : storedPreferences);
  if (storedPreferences === undefined) await bb.storage.kv.set("projects.preferences.v1", preferences);
  let preferenceWrite: Promise<unknown> = Promise.resolve();
  function updatePreferences(patch: Partial<z.infer<typeof preferencesSchema>>) {
    const work = preferenceWrite.then(async () => {
      const next = preferencesSchema.parse({ ...preferences, ...patch });
      await bb.storage.kv.set("projects.preferences.v1", next);
      preferences = next;
      publish("preferences-changed");
      return next;
    });
    preferenceWrite = work.catch(() => {});
    return work;
  }
  legacyModel?.onChange((next) => {
    void updatePreferences({ routingModel: next.routingModel.trim() || DEFAULT_ROUTING_MODEL }).catch(() => bb.log.error("Could not preserve the profile model preference. Retry before reloading Projects."));
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  db.pragma("foreign_keys = ON");
  const store = new ProjectsStore(db);
  let preserveNativeOrganization = store.listGroups().length > 0;
  store.defaultGroup();
  const assignments = new AssignmentStore(db);
  const authority = createAssignmentRuntime(bb, assignments);
  let migrationPromise: Promise<void> | null = null;

  async function projectRows(): Promise<ProjectRow[]> {
    return (await bb.sdk.projects.list()).filter((project) => project.kind === "standard").map((project) => {
      const source = project.sources.find((candidate) => candidate.type === "local_path" && candidate.isDefault)
        ?? project.sources.find((candidate) => candidate.type === "local_path")
        ?? null;
      return {
        id: project.id,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
        localPath: source?.path ?? null,
        hostId: source?.hostId ?? null,
      };
    });
  }

  function publish(reason: string) {
    bb.realtime.publish("projects-configuration-changed", { reason });
  }

  function publicRoutingProfile(profile: ReturnType<ProjectsStore["getConfiguration"]>["routingProfile"]) {
    const { fingerprint: _fingerprint, learnedFingerprint: _learnedFingerprint, ...visible } = profile;
    return visible;
  }

  function normalizedValues(values: readonly string[], max: number): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
      const normalized = value.replace(/\s+/gu, " ").trim();
      const key = normalized.toLocaleLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
      if (output.length >= max) break;
    }
    return output;
  }

  function repositoryLabel(remote: string | null): string | null {
    if (!remote) return null;
    return remote
      .replace(/^https?:\/\/[^/]+\//u, "")
      .replace(/^ssh:\/\/git@[^/]+\//u, "")
      .replace(/^git@[^:]+:/u, "")
      .replace(/\.git$/u, "") || null;
  }

  async function readProjectFile(project: ProjectRow, paths: readonly string[]): Promise<string | null> {
    for (const path of paths) {
      try {
        const file = await bb.sdk.projects.fileContent(project.hostId
          ? { projectId: project.id, hostId: project.hostId, path }
          : { projectId: project.id, path });
        const content = file.contentEncoding === "base64"
          ? Buffer.from(file.content, "base64").toString("utf8")
          : file.content;
        if (content.trim()) return content.slice(0, 30_000);
      } catch {
        // A project can be remote-only or may not have this optional file.
      }
    }
    return null;
  }

  async function taskRoutingEvidence(): Promise<{
    sourcesByProject: Map<string, string[]>;
    taskTitlesByProject: Map<string, string[]>;
  }> {
    const sourcesByProject = new Map<string, string[]>();
    const taskTitlesByProject = new Map<string, string[]>();
    if (!preferences.tasksIntegration) return { sourcesByProject, taskTitlesByProject };
    try {
      const [mappings, tasks] = await Promise.all([
        bb.sdk.plugins.callRpc({ pluginId: "task-workspaces", method: "projectMappings", input: null, outputSchema: taskProjectMappingsSchema }),
        bb.sdk.plugins.callRpc({ pluginId: "task-workspaces", method: "listTasks", input: null, outputSchema: taskListSchema }),
      ]);
      for (const source of mappings.sources) {
        if (!source.bbProjectId) continue;
        sourcesByProject.set(source.bbProjectId, [...(sourcesByProject.get(source.bbProjectId) ?? []), source.label]);
      }
      for (const task of tasks.tasks) {
        if (!task.projectId) continue;
        taskTitlesByProject.set(task.projectId, [...(taskTitlesByProject.get(task.projectId) ?? []), task.title]);
      }
    } catch (error) {
      bb.log.debug(`Task routing evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { sourcesByProject, taskTitlesByProject };
  }

  async function routingEvidence(project: ProjectRow, taskEvidence: Awaited<ReturnType<typeof taskRoutingEvidence>>): Promise<RoutingProfileEvidence> {
    const [packageJson, readme] = await Promise.all([
      readProjectFile(project, ["package.json"]),
      readProjectFile(project, ["README.md", "README.mdx", "README"]),
    ]);
    return {
      name: project.name,
      gitRemoteUrl: project.gitRemoteUrl,
      packageJson,
      readme,
      mappedSources: normalizedValues(taskEvidence.sourcesByProject.get(project.id) ?? [], 30),
      taskTitles: normalizedValues(taskEvidence.taskTitlesByProject.get(project.id) ?? [], 20),
    };
  }

  // Projects and their routing profiles, as Jev sees them when it suggests a project.
  async function routingCatalog(): Promise<ProjectRoutingCandidate[]> {
    const projects = (await projectRows()).slice(0, MAX_ROUTER_PROJECTS);
    const configurations = store.getConfigurations(projects.map((project) => project.id));
    const candidates: ProjectRoutingCandidate[] = new Array(projects.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, projects.length) }, async () => {
      while (next < projects.length) {
        const index = next++;
        const project = projects[index]!;
        const profile = configurations.get(project.id)!.routingProfile;
        const [packageJson, readme] = profile.description
          ? [null, null]
          : await Promise.all([
            readProjectFile(project, ["package.json"]),
            readProjectFile(project, ["README.md", "README.mdx", "README"]),
          ]);
        const repository = repositoryLabel(project.gitRemoteUrl);
        candidates[index] = {
          id: project.id,
          name: project.name,
          repository,
          summary: profile.description || projectSummary({ name: project.name, repository, packageJson, readme }),
          keywords: profile.keywords,
          aliases: profile.aliases,
          notFor: profile.notFor,
          learnedFor: profile.learnedFor,
          learnedNotFor: profile.learnedNotFor,
          repositories: [...new Set([...(repository ? [repository] : []), ...profile.repositories])],
        };
      }
    }));
    return candidates;
  }

  const jevRouting = createJevRouting(bb, {
    apiKey: async () => (await settings.get()).jevApiKey,
    loadCatalog: routingCatalog,
  });

  const profileGeneration = new Map<string, Promise<{ changed: boolean }>>();

  async function generateProjectRoutingProfile(project: ProjectRow, options: {
    force: boolean;
    taskEvidence: Awaited<ReturnType<typeof taskRoutingEvidence>>;
  }): Promise<{ changed: boolean }> {
    const running = profileGeneration.get(project.id);
    if (running) return running;
    const work = (async () => {
      const evidence = await routingEvidence(project, options.taskEvidence);
      const fingerprint = routingEvidenceFingerprint(evidence);
      const current = store.getConfiguration(project.id).routingProfile;
      if (!options.force) {
        if (current.source === "manual") return { changed: false };
        if (current.source === "generated" && current.fingerprint === fingerprint) return { changed: false };
      }
      const currentSettings = await settings.get();
      const apiKey = currentSettings.openRouterApiKey?.trim();
      if (!apiKey) throw new Error("OpenRouter API key missing. Add it in Projects settings.");
      const generated = normalizeGeneratedRoutingProfile(await generateRoutingProfileWithModel({
        apiKey,
        model: preferences.routingModel,
        evidence,
      }));
      const remoteRepository = repositoryLabel(project.gitRemoteUrl);
      const mappedRepositories = evidence.mappedSources.flatMap((source) => {
        const match = source.match(/^GitHub\s*·\s*(.+)$/iu);
        return match?.[1] ? [match[1]] : [];
      });
      store.saveRoutingProfile(project.id, {
        ...generated,
        repositories: normalizedValues([
          ...(remoteRepository ? [remoteRepository] : []),
          ...mappedRepositories,
          ...generated.repositories,
        ], 16),
        source: "generated",
        fingerprint,
      });
      publish("routing-profile-generated");
      jevRouting.resetCatalog();
      return { changed: true };
    })().finally(() => profileGeneration.delete(project.id));
    profileGeneration.set(project.id, work);
    return work;
  }

  async function reconcileRoutingProfiles(): Promise<{ generated: number; skipped: number; failed: number }> {
    const currentSettings = await settings.get();
    if (!currentSettings.openRouterApiKey?.trim()) {
      const count = (await projectRows()).length;
      return { generated: 0, skipped: count, failed: 0 };
    }
    const [projects, taskEvidence] = await Promise.all([projectRows(), taskRoutingEvidence()]);
    let next = 0;
    let generated = 0;
    let skipped = 0;
    let failed = 0;
    await Promise.all(Array.from({ length: Math.min(2, projects.length) }, async () => {
      while (next < projects.length) {
        const project = projects[next++];
        if (!project) continue;
        try {
          const result = await generateProjectRoutingProfile(project, { force: false, taskEvidence });
          if (result.changed) generated += 1;
          else skipped += 1;
        } catch (error) {
          failed += 1;
          bb.log.warn(`Could not generate the routing profile for ${project.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }));
    return { generated, skipped, failed };
  }

  let routingLearningRun: Promise<{ learned: number; skipped: number; failed: number }> | null = null;

  // Turns Jev routing traces into machine-owned learnedFor/learnedNotFor guidance per project.
  function learnFromRoutingHistory() {
    routingLearningRun ??= (async () => {
      const currentSettings = await settings.get();
      const apiKey = currentSettings.openRouterApiKey?.trim();
      if (!apiKey) return { learned: 0, skipped: 0, failed: 0 };
      const [traces, projects] = await Promise.all([jevRouting.readTraces(), projectRows()]);
      const names = new Map(projects.map((project) => [project.id, project.name]));
      const configurations = store.getConfigurations(projects.map((project) => project.id));
      let learned = 0;
      let skipped = 0;
      let failed = 0;
      for (const project of projects) {
        const profile = configurations.get(project.id)!.routingProfile;
        const evidence = projectRoutingEvidence(project.id, traces, names);
        const fingerprint = routingLearningFingerprint(evidence);
        if (!hasRoutingEvidence(evidence) || profile.learnedFingerprint === fingerprint) {
          skipped += 1;
          continue;
        }
        try {
          const result = await generateRoutingLearning({
            apiKey,
            model: preferences.routingModel,
            prompt: routingLearningPrompt({ projectName: project.name, description: profile.description, notFor: profile.notFor, evidence }),
          });
          store.saveRoutingLearning(project.id, { ...result, fingerprint });
          learned += 1;
        } catch (error) {
          failed += 1;
          bb.log.warn(`Could not learn routing guidance for ${project.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (learned) {
        publish("routing-learning-updated");
        jevRouting.resetCatalog();
        bb.log.info(`Learned routing guidance for ${learned} projects from ${traces.length} routing traces`);
      }
      return { learned, skipped, failed };
    })().finally(() => { routingLearningRun = null; });
    return routingLearningRun;
  }

  async function routingHistory() {
    const [traces, projects] = await Promise.all([jevRouting.readTraces(), projectRows()]);
    const names = new Map(projects.map((project) => [project.id, project.name]));
    const label = (projectId: string | null) => projectId ? names.get(projectId) ?? projectId : "no project";
    const count = (outcome: string) => traces.filter((trace) => trace.outcome === outcome).length;
    const hits = count("hit");
    const misses = count("miss");
    return {
      traces: traces.length,
      hits,
      misses,
      unguided: count("unguided"),
      hitRate: hits + misses ? Math.round((hits / (hits + misses)) * 100) / 100 : null,
      recentMisses: traces.filter((trace) => trace.outcome === "miss").slice(0, 10).map((trace) => ({
        at: new Date(trace.createdAt).toISOString(),
        request: trace.message.slice(0, 120),
        suggested: trace.suggested.kind === "no_project" ? "no project" : label(trace.suggested.projectId),
        startedIn: label(trace.finalProjectId),
      })),
    };
  }

  async function routingProfilesSnapshot() {
    const [projects, currentSettings] = await Promise.all([projectRows(), settings.get()]);
    const configurations = store.getConfigurations(projects.map((project) => project.id));
    return {
      configured: Boolean(currentSettings.openRouterApiKey?.trim()),
      model: preferences.routingModel,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
        profile: publicRoutingProfile(configurations.get(project.id)!.routingProfile),
      })),
    };
  }

  async function notify(pluginId: string, method: string, input: null | Record<string, string | null>) {
    let lastError: unknown;
    for (const retryDelay of [0, 250, 1_000]) {
      if (retryDelay) await delay(retryDelay);
      try {
        await bb.sdk.plugins.callRpc({ pluginId, method, input, outputSchema: okSchema });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    bb.log.warn(`Could not refresh ${pluginId} after a Projects change: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  const notifySidebar = () => preferences.sidebarIntegration ? notify("status-sidebar", "refreshProjectGroups", null) : Promise.resolve();
  const notifyAgents = () => preferences.agentsIntegration ? notify("agent-profiles", "refreshAvailability", null) : Promise.resolve();
  const notifyCatalog = (projectId: string | null) => preferences.catalogIntegration ? notify("catalog", "refreshAvailability", { projectId }) : Promise.resolve();
  const notifyCredentials = (projectId: string) => preferences.credentialsIntegration ? notify("project-environments", "refreshProject", { projectId }) : Promise.resolve();

  async function credentialDefinitions() {
    return bb.sdk.plugins.callRpc({
      pluginId: "project-environments", method: "listCredentials", input: null, outputSchema: credentialDefinitionsSchema,
    }).then(({ credentials }) => credentials.map((profile) => ({ id: profile.id, name: profile.name, detail: profile.environmentName ?? null })));
  }

  async function agentDefinitions() {
    return bb.sdk.plugins.callRpc({
      pluginId: "agent-profiles", method: "listProfiles", input: null, outputSchema: agentProfilesSchema,
    }).then((profiles) => profiles.map((profile) => ({ id: profile.id, name: profile.name, detail: `@${profile.slug}` })));
  }

  async function bundleDefinitions() {
    return bb.sdk.plugins.callRpc({
      pluginId: "catalog", method: "listBundles", input: null, outputSchema: bundleDefinitionsSchema,
    }).then(({ bundles }) => bundles.map((bundle) => ({ id: bundle.id, name: bundle.name, detail: bundle.description || null })));
  }

  async function organizationSnapshot() {
    const [projects, currentSettings] = await Promise.all([projectRows(), settings.get()]);
    const configurations = store.getConfigurations(projects.map((project) => project.id));
    return {
      groups: store.listGroups(),
      assignmentStatus: assignmentKinds.map((kind) => assignments.status(kind)),
      routingConfigured: Boolean(currentSettings.openRouterApiKey?.trim()),
      routingModel: preferences.routingModel,
      projects: projects.map((project) => {
        const config = configurations.get(project.id)!;
        return { id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl, localPath: project.localPath,
          groupId: config.groupId, position: config.position, icon: config.icon, routingProfile: publicRoutingProfile(config.routingProfile) };
      }).sort((left, right) => left.position - right.position || left.name.localeCompare(right.name)),
    };
  }

  async function projectContext(projectId: string, context?: ExperimentalPluginRpcHandlerContext) {
    assignments.requireReady();
    const config = store.getConfiguration(projectId);
    const input = { projectId };
    const [credential, agents, bundles] = await Promise.all([
      authority.read("applicationBindings", "projectContext", input, z.object({ credentialId: z.string().nullable() }), () => ({ credentialId: config.credentialId }), context),
      authority.read("agentPreferences", "projectContext", input, z.object({ agentIds: z.array(z.string()) }), () => ({ agentIds: [...new Set([...store.globalAgentIds(), ...config.agentIds])] }), context),
      authority.read("bundles", "projectContext", input, z.object({ bundleIds: z.array(z.string()) }), () => ({ bundleIds: [...new Set([...store.globalBundleIds(), ...config.bundleIds])] }), context),
    ]);
    return { projectId, groupId: config.groupId, ...credential, ...agents, ...bundles };
  }

  async function projectContexts(projectIds: string[], context?: ExperimentalPluginRpcHandlerContext) {
    assignments.requireReady();
    const configurations = store.getConfigurations(projectIds);
    const globalAgentIds = store.globalAgentIds();
    const globalBundleIds = store.globalBundleIds();
    const local = projectIds.map((projectId) => {
      const config = configurations.get(projectId)!;
      return { projectId, credentialId: config.credentialId, groupId: config.groupId,
        agentIds: [...new Set([...globalAgentIds, ...config.agentIds])],
        bundleIds: [...new Set([...globalBundleIds, ...config.bundleIds])] };
    });
    const states = assignmentKinds.map((kind) => assignments.status(kind).state);
    if (states.includes("reverse-frozen")) throw new AssignmentError("assignment-frozen", "Reverse reconciliation is pending.");
    if (!states.includes("destination-owned")) return { projects: local };
    const wanted = new Set(projectIds);
    const input = { projectIds: [...wanted] };
    const unique = [...new Map(local.map((project) => [project.projectId, project])).values()];
    const [credentials, agents, bundles] = await Promise.all([
      authority.read("applicationBindings", "projectContexts", input, z.object({ projects: z.array(z.object({ projectId: z.string(), credentialId: z.string().nullable() })).max(5_000) }),
        () => ({ projects: unique.map(({ projectId, credentialId }) => ({ projectId, credentialId })) }), context),
      authority.read("agentPreferences", "projectContexts", input, z.object({ projects: z.array(z.object({ projectId: z.string(), agentIds: z.array(z.string()) })).max(5_000) }),
        () => ({ projects: unique.map(({ projectId, agentIds }) => ({ projectId, agentIds })) }), context),
      authority.read("bundles", "projectContexts", input, z.object({ projects: z.array(z.object({ projectId: z.string(), bundleIds: z.array(z.string()) })).max(5_000) }),
        () => ({ projects: unique.map(({ projectId, bundleIds }) => ({ projectId, bundleIds })) }), context),
    ]);
    function indexProjection<T extends { projectId: string }>(rows: T[]) {
      const indexed = new Map(rows.map((row) => [row.projectId, row]));
      if (rows.length !== wanted.size || indexed.size !== wanted.size || rows.some((row) => !wanted.has(row.projectId))) throw new AssignmentError("owner-unavailable", "Owner batch projection is incomplete or contains duplicate/unknown projects.");
      return indexed;
    }
    const credentialsById = indexProjection(credentials.projects);
    const agentsById = indexProjection(agents.projects);
    const bundlesById = indexProjection(bundles.projects);
    return { projects: local.map((project) => ({ ...project, credentialId: credentialsById.get(project.projectId)!.credentialId,
      agentIds: agentsById.get(project.projectId)!.agentIds, bundleIds: bundlesById.get(project.projectId)!.bundleIds })) };
  }

  async function globalContext(context?: ExperimentalPluginRpcHandlerContext) {
    const [agents, bundles] = await Promise.all([
      authority.read("agentPreferences", "globalContext", null, z.object({ agentIds: z.array(z.string()) }), () => ({ agentIds: store.globalAgentIds() }), context),
      authority.read("bundles", "globalContext", null, z.object({ bundleIds: z.array(z.string()) }), () => ({ bundleIds: store.globalBundleIds() }), context),
    ]);
    return { ...agents, ...bundles };
  }

  async function snapshot(context?: ExperimentalPluginRpcHandlerContext) {
    assignments.requireReady();
    const native = await organizationSnapshot();
    const global = await globalContext(context);
    const contexts: Array<z.infer<typeof rpcContract.projectContext.output>> = [];
    for (let offset = 0; offset < native.projects.length; offset += 5_000) {
      contexts.push(...(await projectContexts(native.projects.slice(offset, offset + 5_000).map((project) => project.id), context)).projects);
    }
    const byId = new Map(contexts.map((project) => [project.projectId, project]));
    const projects = native.projects.map((project) => ({ ...project, ...byId.get(project.id)!, id: project.id }));
    const unresolved = (ids: string[]) => [...new Set(ids)].map((id) => ({ id, name: id, detail: "Not loaded" }));
    return { ...native, projects, globalAgentIds: global.agentIds, globalBundleIds: global.bundleIds,
      agents: unresolved([...global.agentIds, ...projects.flatMap((project) => project.agentIds)]),
      bundles: unresolved([...global.bundleIds, ...projects.flatMap((project) => project.bundleIds)]),
      credentials: unresolved(projects.flatMap((project) => project.credentialId === null ? [] : [project.credentialId])) };
  }

  async function groupsSnapshot() {
    const projects = await projectRows();
    const configurations = store.getConfigurations(projects.map((project) => project.id));
    const idsByGroup = new Map<string, Array<{ id: string; position: number }>>();
    for (const project of projects) {
      const config = configurations.get(project.id)!;
      if (!config.groupId) continue;
      idsByGroup.set(config.groupId, [...(idsByGroup.get(config.groupId) ?? []), { id: project.id, position: config.position }]);
    }
    return {
      groups: store.listGroups().map((group) => ({
        ...group,
        projectIds: (idsByGroup.get(group.id) ?? []).sort((a, b) => a.position - b.position).map(({ id }) => id),
      })),
    };
  }

  function applyLegacy(input: {
    groups: Array<{ id: string; name: string; color: "amber" | "blue" | "violet" | "green" | "rose" | "gray"; isDefault: boolean; projectIds: string[] }>;
    credentialBindings: Array<{ projectId: string; credentialId: string | null }>;
    catalogAssignments: Array<{ bundleId: string; kind: "global" | "project" | "project-environment" | "agent-profile"; targetId: string }>;
  }) {
    let groupCount = 0;
    let projectCount = 0;
    let credentialCount = 0;
    let bundleCount = 0;
    let conflicts = 0;
    const groupMappings: Array<{ legacyId: string; groupId: string }> = [];
    const importedProjectIds = new Set<string>();
    const configured = db.prepare("SELECT project_id, group_id, credential_id FROM project_configuration").all() as Array<{ project_id: string; group_id: string | null; credential_id: string | null }>;
    const nativePlacements = new Set(configured.filter((row) => row.group_id !== null).map((row) => row.project_id));
    const effectiveCredentials = new Map(configured.map((row) => [row.project_id, row.credential_id]));
    const keepDefault = preserveNativeOrganization || nativePlacements.size > 0 || store.listGroups().length > 1;
    for (const legacy of input.groups) {
      const duplicate = store.listGroups().some((group) => group.name.toLowerCase() === legacy.name.toLowerCase());
      const group = store.saveGroup({ name: duplicate ? `${legacy.name} (imported ${legacy.id})` : legacy.name, color: legacy.color, makeDefault: legacy.isDefault && !keepDefault });
      groupMappings.push({ legacyId: legacy.id, groupId: group.id });
      groupCount += 1;
      const unconfigured = legacy.projectIds.filter((projectId) => !nativePlacements.has(projectId));
      conflicts += legacy.projectIds.length - unconfigured.length + (legacy.isDefault && keepDefault ? 1 : 0);
      store.setProjectOrder(group.id, unconfigured);
      legacy.projectIds.forEach((projectId) => importedProjectIds.add(projectId));
    }
    projectCount = importedProjectIds.size;
    assignments.rememberLegacy("applicationBindings", input.credentialBindings.map((binding) => ({ type: "legacyBinding", ...binding })));
    assignments.rememberLegacy("bundles", input.catalogAssignments.map((assignment) => ({ type: "legacyBundle", ...assignment })));
    for (const binding of input.credentialBindings) {
      const current = effectiveCredentials.get(binding.projectId) ?? null;
      if (current === null) {
        store.updateProject(binding.projectId, { credentialId: binding.credentialId });
        effectiveCredentials.set(binding.projectId, binding.credentialId);
      }
      if (current !== null && current !== binding.credentialId) conflicts++;
      credentialCount += 1;
    }
    const projectIdsByCredential = new Map<string, string[]>();
    for (const binding of input.credentialBindings) {
      if (binding.credentialId !== null && effectiveCredentials.get(binding.projectId) === binding.credentialId) projectIdsByCredential.set(binding.credentialId, [...(projectIdsByCredential.get(binding.credentialId) ?? []), binding.projectId]);
    }
    for (const assignment of input.catalogAssignments) {
      if (assignment.kind === "global") {
        store.toggleGlobalReference("bundle", assignment.bundleId, true);
        bundleCount += 1;
      } else if (assignment.kind === "project") {
        store.toggleProjectReference("bundle", assignment.targetId, assignment.bundleId, true);
        bundleCount += 1;
      } else if (assignment.kind === "project-environment") {
        for (const projectId of projectIdsByCredential.get(assignment.targetId) ?? []) {
          store.toggleProjectReference("bundle", projectId, assignment.bundleId, true);
          bundleCount += 1;
        }
      } else if (assignment.kind === "agent-profile") {
        // Existing profiles are promoted to global availability during this
        // migration, so their old skills must be available globally too.
        store.toggleGlobalReference("bundle", assignment.bundleId, true);
        bundleCount += 1;
      }
    }
    return { groups: groupCount, projects: projectCount, credentials: credentialCount, bundles: bundleCount, groupMappings, conflicts };
  }

  const importReceiptSchema = z.object({ input_json: z.string(), result_json: z.string() });
  function importReceipt(name: string) {
    const row = db.prepare("SELECT input_json, result_json FROM assignment_import_receipts WHERE name = ?").get(name);
    return row ? importReceiptSchema.parse(row) : null;
  }

  const importAuditSchema = z.object({
    schemaVersion: z.literal(1), sourcePluginId: z.literal("projects"),
    sourceGeneration: z.string(), sourceSemanticDigest: z.string(), destinationRevision: z.string(),
    countByKind: z.object({ bundles: z.number(), applicationBindings: z.number(), agentPreferences: z.number() }),
    conflicts: z.number(), phase: z.enum(["imported-awaiting-sources", "imported-awaiting-remap", "source-owned"]), completedAt: z.string(),
  });
  const auditedImportResultSchema = rpcContract.importLegacy.output.extend({ receipt: importAuditSchema });
  function saveImportReceipt(name: string, input: z.infer<typeof rpcContract.importLegacy.input>, result: z.infer<typeof rpcContract.importLegacy.output> & { conflicts: number }, agentIds: string[], phase: z.infer<typeof importAuditSchema>["phase"]) {
    const encoded = JSON.stringify(agentIds.length ? { ...input, agentIds } : input);
    const digest = createHash("sha256").update(encoded).digest("hex");
    const receipt = importAuditSchema.parse({
      schemaVersion: 1, sourcePluginId: "projects", sourceGeneration: `legacy-v1:${digest}`, sourceSemanticDigest: digest,
      destinationRevision: randomUUID(), countByKind: { bundles: input.catalogAssignments.length, applicationBindings: input.credentialBindings.length, agentPreferences: agentIds.length },
      conflicts: result.conflicts, phase, completedAt: new Date().toISOString(),
    });
    db.prepare("INSERT INTO assignment_import_receipts VALUES (?, ?, ?)").run(name, encoded, JSON.stringify({ ...result, receipt }));
  }

  function importLegacy(input: z.infer<typeof rpcContract.importLegacy.input>, context: ExperimentalPluginRpcHandlerContext) {
    requireOwnerClient(context);
    const previous = importReceipt("legacy-payload");
    const encoded = JSON.stringify(input);
    if (previous) {
      if (previous.input_json !== encoded) throw new AssignmentError("handoff-mismatch", "The legacy import input changed.");
      return rpcContract.importLegacy.output.parse(JSON.parse(previous.result_json));
    }
    if (migrationPromise || importReceipt("legacy-sources")) throw new AssignmentError("assignment-frozen", "Resume the pending source import.");
    if (store.hasMigration("suite-v1")) throw new AssignmentError("handoff-mismatch", "Assignments are already initialized.");
    if (!input.groups.length && !input.credentialBindings.length && !input.catalogAssignments.length) throw new AssignmentError("not-migrated", "Use explicit no-legacy initialization for a new installation, or import from all named legacy sources.");
    const result = db.transaction(() => {
      const result = applyLegacy(input);
      saveImportReceipt("legacy-payload", input, result, [], "imported-awaiting-sources");
      return result;
    })();
    publish("legacy-imported");
    return result;
  }

  function requireNoPendingAssignments() {
    if (migrationPromise || importReceipt("legacy-sources") || importReceipt("legacy-payload") || assignmentKinds.some((kind) => assignments.records(kind).some((record) => record.type !== "binding" || record.credentialId !== null))) throw new AssignmentError("not-migrated", "Existing or pending assignments require legacy import; initialization cannot clear them.");
  }

  bb.rpc.register(rpcContract, {
    snapshot: (_input, context) => snapshot(context),
    organizationSnapshot,
    assignmentStatusV1: ({ kind }) => assignments.status(kind),
    assignmentExportV1: ({ kind, generation, cursor }, context) => {
      const status = assignments.status(kind);
      if (context.experimental_caller.kind !== "client" && !(context.experimental_caller.kind === "plugin" && context.experimental_caller.pluginId === status.transfer?.destination)) throw new AssignmentError("owner-client-required", "Only the native client or named destination may export assignments.");
      return assignments.page(kind, generation, cursor);
    },
    assignmentHandoffV1: async (input, context) => {
      const result = await authority.handoff(input, context);
      publish("assignment-handoff");
      return result;
    },
    initializeFreshV1: async (_input, context) => {
      requireOwnerClient(context);
      if (store.hasMigration("suite-v1")) return { ok: true as const };
      requireNoPendingAssignments();
      await authority.requireSetupAuthority();
      if (store.hasMigration("suite-v1")) return { ok: true as const };
      requireNoPendingAssignments();
      store.markMigration("suite-v1");
      publish("fresh-initialized");
      return { ok: true as const };
    },
    importLegacyFromSourcesV1: async (_input, context) => {
      requireOwnerClient(context);
      migrationPromise ??= migrateLegacy().finally(() => { migrationPromise = null; });
      await migrationPromise;
      return { ok: true as const };
    },
    preferences: () => preferences,
    updatePreferences: (input, context) => { requireOwnerClient(context); return updatePreferences(input); },
    assignmentOptionsV1: async ({ kind }) => {
      const enabled = kind === "bundles" ? preferences.catalogIntegration : kind === "applicationBindings" ? preferences.credentialsIntegration : preferences.agentsIntegration;
      if (!enabled) throw new Error("Enable the source under Oh My BB before loading choices.");
      return { references: await (kind === "bundles" ? bundleDefinitions() : kind === "applicationBindings" ? credentialDefinitions() : agentDefinitions()) };
    },
    groupsSnapshot,
    projectContext: ({ projectId }, context) => projectContext(projectId, context),
    projectContexts: ({ projectIds }, context) => projectContexts(projectIds, context),
    globalContext: (_input, context) => globalContext(context),
    bundleAssignmentSnapshot: (_input, context) => authority.read("bundles", "bundleAssignmentSnapshot", null, rpcContract.bundleAssignmentSnapshot.output, () => store.bundleAssignmentSnapshot(), context),
    routingProfiles: routingProfilesSnapshot,
    updateRoutingProfile: async ({ projectId, description, keywords, aliases, repositories, notFor }) => {
      const profile = store.saveRoutingProfile(projectId, {
        description,
        keywords: normalizedValues(keywords, 24),
        aliases: normalizedValues(aliases, 16),
        repositories: normalizedValues(repositories, 16),
        notFor: normalizedValues(notFor, 8),
        source: "manual",
        fingerprint: null,
      });
      publish("routing-profile-updated");
      jevRouting.resetCatalog();
      return publicRoutingProfile(profile);
    },
    generateRoutingProfile: async ({ projectId }, context) => {
      requireOwnerClient(context);
      const project = (await projectRows()).find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      const taskEvidence = await taskRoutingEvidence();
      await generateProjectRoutingProfile(project, { force: true, taskEvidence });
      return publicRoutingProfile(store.getConfiguration(projectId).routingProfile);
    },
    suggestProject: ({ prompt }) => jevRouting.suggestProject(prompt),
    generateMissingRoutingProfiles: async (_input, context) => {
      requireOwnerClient(context);
      const currentSettings = await settings.get();
      if (!currentSettings.openRouterApiKey?.trim()) throw new Error("OpenRouter API key missing. Add it in Projects settings.");
      return reconcileRoutingProfiles();
    },
    saveGroup: (input) => { const group = store.saveGroup(input); preserveNativeOrganization = true; publish("group-saved"); void notifySidebar(); return group; },
    deleteGroup: ({ id }) => { store.deleteGroup(id); preserveNativeOrganization = true; publish("group-deleted"); void notifySidebar(); return { ok: true as const }; },
    setGroupOrder: ({ groupIds }) => { store.setGroupOrder(groupIds); preserveNativeOrganization = true; publish("group-order-changed"); void notifySidebar(); return { ok: true as const }; },
    setProjectGroup: ({ projectId, groupId }) => { store.setProjectGroup(projectId, groupId); preserveNativeOrganization = true; publish("project-group-changed"); void notifySidebar(); return { ok: true as const }; },
    setProjectOrder: ({ groupId, projectIds }) => { store.setProjectOrder(groupId, projectIds); preserveNativeOrganization = true; publish("project-order-changed"); void notifySidebar(); return { ok: true as const }; },
    updateProject: async ({ projectId, ...input }, context) => {
      if (input.credentialId !== undefined) await authority.write("applicationBindings", "updateProject", { projectId, credentialId: input.credentialId }, context, () => {
        store.updateProject(projectId, { credentialId: input.credentialId });
        void notifyCredentials(projectId);
      });
      if (input.icon !== undefined) store.updateProject(projectId, { icon: input.icon });
      publish("project-updated");
      void notifySidebar();
      return { ok: true as const };
    },
    setProjectAgent: (input, context) => authority.write("agentPreferences", "setProjectAgent", input, context, () => { store.toggleProjectReference("agent", input.projectId, input.targetId, input.enabled); publish("project-agent-changed"); void notifyAgents(); }),
    setGlobalAgent: (input, context) => authority.write("agentPreferences", "setGlobalAgent", input, context, async () => {
      if (!input.enabled) {
        const profiles = await bb.sdk.plugins.callRpc({ pluginId: "agent-profiles", method: "listProfiles", input: null, outputSchema: agentProfilesSchema });
        if (profiles.some((profile) => profile.id === input.targetId && profile.isDefault)) throw new Error("The default agent must be available in every project. Choose a different default first.");
      }
      assignments.requireWritable("agentPreferences");
      store.toggleGlobalReference("agent", input.targetId, input.enabled);
      publish("global-agent-changed");
      void notifyAgents();
    }),
    setProjectBundle: (input, context) => authority.write("bundles", "setProjectBundle", input, context, () => { store.toggleProjectReference("bundle", input.projectId, input.targetId, input.enabled); publish("project-bundle-changed"); void notifyCatalog(input.projectId); }),
    setGlobalBundle: (input, context) => authority.write("bundles", "setGlobalBundle", input, context, () => { store.toggleGlobalReference("bundle", input.targetId, input.enabled); publish("global-bundle-changed"); void notifyCatalog(null); }),
    agentAssignments: (input, context) => authority.read("agentPreferences", "agentAssignments", input, rpcContract.agentAssignments.output, () => ({ global: store.globalAgentIds().includes(input.agentId), projectIds: store.assignments("agent", input.agentId) }), context),
    bundleAssignments: (input, context) => authority.read("bundles", "bundleAssignments", input, rpcContract.bundleAssignments.output, () => ({ global: store.globalBundleIds().includes(input.bundleId), projectIds: store.assignments("bundle", input.bundleId) }), context),
    credentialAssignments: (input, context) => authority.read("applicationBindings", "credentialAssignments", input, rpcContract.credentialAssignments.output, () => ({ projectIds: store.credentialAssignments(input.credentialId) }), context),
    removeAgent: (input, context) => authority.write("agentPreferences", "removeAgent", input, context, () => { store.removeReference("agent", input.agentId); publish("agent-removed"); }),
    removeBundle: (input, context) => authority.write("bundles", "removeBundle", input, context, () => { store.removeReference("bundle", input.bundleId); publish("bundle-removed"); }),
    removeCredential: (input, context) => authority.write("applicationBindings", "removeCredential", input, context, () => { store.removeReference("credential", input.credentialId); publish("credential-removed"); }),
    importLegacy,
  });

  bb.cli.register({
    name: "project-routing",
    summary: "Inspect and refresh intelligent project routing profiles",
    commands: [
      { name: "status", summary: "Show profile coverage", usage: "bb project-routing status" },
      { name: "backfill", summary: "Refresh stale generated profiles and create missing ones; replaces generated content", usage: "bb project-routing backfill" },
      { name: "regenerate", summary: "Regenerate one project profile", usage: "bb project-routing regenerate --project <id>" },
      { name: "history", summary: "Show Jev routing hits and misses from new threads", usage: "bb project-routing history" },
      { name: "learn", summary: "Learn routing guidance from routing history now", usage: "bb project-routing learn" },
    ],
    async run(argv, context) {
      const command = argv[0] ?? "status";
      if (command === "status") {
        const snapshot = await routingProfilesSnapshot();
        const generated = snapshot.projects.filter((project) => project.profile.source === "generated").length;
        const manual = snapshot.projects.filter((project) => project.profile.source === "manual").length;
        const missing = snapshot.projects.length - generated - manual;
        return { exitCode: 0, stdout: `${JSON.stringify({ configured: snapshot.configured, model: snapshot.model, projects: snapshot.projects.length, generated, manual, missing }, null, 2)}\n` };
      }
      if (command === "backfill") {
        const result = await reconcileRoutingProfiles();
        return { exitCode: result.failed ? 1 : 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
      }
      if (command === "regenerate") {
        const index = argv.indexOf("--project");
        const projectId = index >= 0 ? argv[index + 1] : context.projectId;
        if (!projectId) return { exitCode: 2, stderr: "Usage: bb project-routing regenerate --project <id>" };
        const project = (await projectRows()).find((candidate) => candidate.id === projectId);
        if (!project) return { exitCode: 2, stderr: `Unknown project: ${projectId}` };
        await generateProjectRoutingProfile(project, { force: true, taskEvidence: await taskRoutingEvidence() });
        return { exitCode: 0, stdout: `${JSON.stringify(publicRoutingProfile(store.getConfiguration(project.id).routingProfile), null, 2)}\n` };
      }
      if (command === "history") {
        return { exitCode: 0, stdout: `${JSON.stringify(await routingHistory(), null, 2)}\n` };
      }
      if (command === "learn") {
        const result = await learnFromRoutingHistory();
        return { exitCode: result.failed ? 1 : 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
      }
      return { exitCode: 2, stderr: "Usage: bb project-routing <status|backfill|regenerate|history|learn>" };
    },
  });

  async function migrateLegacy() {
    if (store.hasMigration("suite-v1")) return;
    await authority.requireSetupAuthority();
    if (store.hasMigration("suite-v1")) return;
    let saved = importReceipt("legacy-sources");
    if (!saved) {
      const [sidebar, credentials, catalog, agents] = await Promise.all([
        bb.sdk.plugins.callRpc({ pluginId: "status-sidebar", method: "legacyWorkspaceSnapshot", input: null, outputSchema: sidebarWorkspaceSnapshotSchema }),
        bb.sdk.plugins.callRpc({ pluginId: "project-environments", method: "legacySnapshot", input: null, outputSchema: credentialSnapshotSchema }),
        bb.sdk.plugins.callRpc({ pluginId: "catalog", method: "legacyAssignments", input: null, outputSchema: legacyAssignmentsSchema }),
        bb.sdk.plugins.callRpc({ pluginId: "agent-profiles", method: "listProfiles", input: null, outputSchema: agentProfilesSchema }),
      ]);
      const input = rpcContract.importLegacy.input.parse({
        groups: sidebar.workspaces,
        credentialBindings: credentials.projects.map((project) => ({ projectId: project.id, credentialId: project.profileId })),
        catalogAssignments: catalog.assignments,
      });
      db.transaction(() => {
        const imported = applyLegacy(input);
        for (const agent of agents) store.toggleGlobalReference("agent", agent.id, true);
        saveImportReceipt("legacy-sources", input, imported, agents.map((agent) => agent.id), "imported-awaiting-remap");
      })();
      saved = importReceipt("legacy-sources")!;
    }
    const imported = rpcContract.importLegacy.output.parse(JSON.parse(saved.result_json));
    await bb.sdk.plugins.callRpc({
      pluginId: "status-sidebar", method: "remapLegacyProjectGroups",
      input: { mappings: imported.groupMappings }, outputSchema: remapLegacyGroupsSchema,
    });
    db.transaction(() => {
      store.markMigration("suite-v1");
      const completedAt = new Date().toISOString();
      for (const name of ["legacy-sources", "legacy-payload"]) {
        const saved = importReceipt(name);
        if (!saved) continue;
        const audited = auditedImportResultSchema.parse(JSON.parse(saved.result_json));
        db.prepare("UPDATE assignment_import_receipts SET result_json = ? WHERE name = ?").run(JSON.stringify({ ...audited, receipt: { ...audited.receipt, phase: "source-owned", completedAt } }), name);
      }
    })();
    publish("suite-migrated");
  }

  const unsubscribeProjects = bb.sdk.subscribe({
    event: "project:changed",
    callback() {
      jevRouting.resetCatalog();
    },
  });
  bb.onDispose(async () => {
    unsubscribeProjects();
    await preferenceWrite;
  });
}
