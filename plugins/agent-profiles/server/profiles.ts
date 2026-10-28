import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { avatarIconName } from "../shared/avatar";
import {
  agentAssignmentsSchema,
  okSchema,
  rpcContract,
  profileInputSchema,
  sandboxAgentIdsSchema,
  type BuiltInProfileRole,
  type DelegationEnvironment,
  type ExportData,
  type Profile,
  type ProfileEnvironment,
  type ProfileInput,
  type SpawnBuiltInProfileInput,
  type SpawnInput,
  DELEGATION_HEADER_END,
} from "./contract";
import { cleanupProfileResources } from "./cleanup";
import { AgentHomes, document } from "./homes";
import type { Store } from "./channels/store";
import { missingThread, type Runtime } from "./channels/runtime";
import {
  allChannelToolNames,
  ordinaryChannelToolNames,
} from "./channels/agent-channels";
import { channelAutomationToolNames } from "./channels/channel-automations";
import type { ChannelRpcHandlers } from "./channels/rpc";
import { assembleInstructions, spawnPreamble } from "./instructions";
import type { ExecutionResolver, ModelLevelPreview } from "./execution-resolver";
import { isReasoningLevel, type ModelLevel, type ResolvedExecution } from "./model-levels";
import { AGENTS_PROVIDER_ID, agentModelId } from "./provider-ids";
import type { AgentProviders } from "./providers";
import type { AgentDms } from "./dms";
import { assertNoAssignmentOwner, membershipRetired } from "./assignment-store";
type AutomationRpcHandlers = Pick<
  PluginRpcHandlers<typeof rpcContract>,
  | "automationList"
  | "automationCreate"
  | "automationUpdate"
  | "automationDelete"
  | "automationPause"
  | "automationResume"
  | "automationRun"
  | "automationRuns"
>;


type DbProfile = {
  id: string;
  slug: string;
  memory_key: string;
  kind: Profile["kind"];
  name: string;
  description: string;
  avatar: string;
  model_mode: Profile["modelMode"];
  level: Profile["level"];
  pi_harness: number;
  provider_id: string;
  model: string;
  reasoning_level: Profile["reasoningLevel"];
  service_tier: Profile["serviceTier"];
  permission_mode: Profile["permissionMode"];
  instructions: string;
  skill_ids: string;
  mcp_server_ids: string;
  run_project_id: string | null;
  run_host_id: string | null;
  run_in_checkout: number;
  show_in_sidebar: number;
  is_default: number;
  home_host_id: string | null;
  home_ready: number;
  interval_minutes: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type JoinedThreadMember = {
  profileId: string;
  slug: string;
  name: string;
  avatar: string;
};

export type ThreadMemberState = JoinedThreadMember & {
  childThreadId: string | null;
  status: string;
  visibility: "visible" | "hidden" | null;
};

const BUILT_IN_PROFILE_BY_ROLE: Record<Exclude<BuiltInProfileRole, "pr-review">, ProfileInput> = {
  "pinpoint-review": {
    name: "Pinpoint Fixes",
    kind: "thin",
    slug: "pinpoint-fix",
    description:
      "Implements pinned visual feedback and returns it for review; copy-only pins go to @pinpoint-copy.",
    avatar: "🤖",
    modelMode: "level",
    level: "medium",
    providerId: "hempi",
    model: "openai-codex/gpt-5.6-sol",
    reasoningLevel: "low",
    serviceTier: "default",
    permissionMode: "full",
    instructions:
      "Implement pinned Pinpoint visual feedback. Use the supplied screenshot and captured context to locate the affected interface, implement the requested change with the existing design system, verify the real UI, and return the item through Pinpoint's ready-for-review flow. Keep the change bounded to the feedback; exact copy-only pins belong to @pinpoint-copy.",
    skillIds: ["pinpoint"],
    mcpServerIds: [],
    runProjectId: null,
    runHostId: null,
    runInCheckout: false,
    showInSidebar: false,
    isDefault: false,
  },
  "text-edit": {
    name: "Pinpoint Copy Edits",
    kind: "thin",
    slug: "pinpoint-copy",
    description: "Makes exact copy edits from Pinpoint pins, fast.",
    avatar: "🤖",
    modelMode: "pinned",
    level: "medium",
    providerId: "hempi",
    model: "openai-codex/gpt-5.6-terra",
    reasoningLevel: "low",
    serviceTier: "default",
    permissionMode: "full",
    instructions:
      "Handle only Pinpoint text-edit feedback. Find the source of the exact rendered copy, make the smallest permanent text change, preserve markup and behavior, verify the changed surface, and return the item through Pinpoint's ready-for-review flow. Do not redesign or refactor adjacent code.",
    skillIds: ["pinpoint"],
    mcpServerIds: [],
    runProjectId: null,
    runHostId: null,
    runInCheckout: false,
    showInSidebar: false,
    isDefault: false,
  },
};
const BUILT_IN_PROFILE_ID_KEY_BY_ROLE: Record<BuiltInProfileRole, string> = {
  "pinpoint-review": "built-in-profile-id:v2:pinpoint-review",
  "text-edit": "built-in-profile-id:v2:text-edit",
  "pr-review": "built-in-profile-id:v3:pr-review",
};
const BUILT_IN_PROFILE_SEED_KEY = "built-in-profiles:v4";
const LEGACY_BUILT_IN_PROFILE_SEED_KEYS = [
  "built-in-profiles:v3",
  "built-in-profiles:v2",
] as const;

function now() {
  return new Date().toISOString();
}

function profileDto(row: DbProfile): Profile {
  return {
    id: row.id,
    memoryKey: row.memory_key,
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    description: row.description,
    avatar: row.avatar,
    modelMode: row.model_mode,
    level: row.level,
    providerId: row.provider_id,
    model: row.model,
    reasoningLevel: row.reasoning_level,
    serviceTier: row.service_tier,
    permissionMode: row.permission_mode,
    instructions: row.instructions,
    skillIds: JSON.parse(row.skill_ids) as string[],
    mcpServerIds: JSON.parse(row.mcp_server_ids) as string[],
    runProjectId: row.run_project_id,
    runHostId: row.run_host_id,
    runInCheckout: Boolean(row.run_in_checkout),
    showInSidebar: Boolean(row.show_in_sidebar),
    isDefault: Boolean(row.is_default),
    homeReady: Boolean(row.home_ready),
    intervalMinutes: row.interval_minutes,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function snapshot(profile: Profile): ProfileInput {
  const {
    memoryKey: _memoryKey,
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    homeReady: _homeReady,
    intervalMinutes: _intervalMinutes,
    ...input
  } = profile;
  return input;
}


function delegationInstructions(profile: Profile) {
  return [
    `The user mentioned the saved agent profile @${profile.slug} (${profile.name}).`,
    `That agent joins this thread and stays joined for later follow-ups until the owner removes it.`,
    `Treat this as a request to delegate the relevant part of the surrounding message, not as instructions for you to impersonate that profile.`,
    `Call delegate_agent_profile with profileId ${profile.id}, a self-contained task, and a short explanation of why this profile is appropriate. Use mode continue for a follow-up to prior work by this profile in the current thread, mode fresh for a distinct task, and mode auto when either behavior is acceptable.`,
    `Continue as the coordinating parent agent and use the child thread's report in your response.`,
    `Copy the delegation directive returned by the tool into your response exactly once so the child result and follow-up composer render inline.`,
    `If the child report contains another exact BB directive such as ::page, copy that directive separately into the parent response so its page also renders natively.`,
  ].join(" ");
}
export type SpawnResult = {
  threadId: string;
  environmentId: string | null;
  profileId: string;
  revision: number;
};
export type ResolvedAgent = {
  profile: Profile;
  source: "conversation" | "binding" | "default";
  context?: "channel" | "mission";
};


export interface Profiles {
  db: Database.Database;
  homes: AgentHomes;
  listProfiles(): Profile[];
  getProfile(id?: string | null): Profile;
  saveProfile(input: ProfileInput, expectedRevision?: number): Promise<Profile>;
  fixedProjectEnvironment(profile: Profile): Promise<{
    projectId: string;
    environment: ProfileEnvironment;
  }>;
  deleteProfile(id: string, channels: Store, runtime: Runtime): Promise<{ ok: true }>;
  importProfiles(data: ExportData): Promise<{ imported: number }>;
  exportProfiles(): Promise<ExportData>;
  resolveExecution(profile: Profile, caller?: { providerId: string; model: string }): Promise<ResolvedExecution>;
  modelLevelPreview(level: ModelLevel): Promise<ModelLevelPreview>;
  spawnProfile(input: SpawnInput): Promise<SpawnResult>;
  spawnBuiltInProfile(input: SpawnBuiltInProfileInput): Promise<SpawnResult>;
  delegationEnvironment(projectId: string, threadId: string): Promise<DelegationEnvironment>;
  latestDelegationThread(profileId: string, parentThreadId: string): { threadId: string } | undefined;
  delegationBinding(childThreadId: string, parentThreadId: string): { threadId: string; profileId: string };
  joinThread(parentThreadId: string, profileId: string): void;
  removeThreadMember(parentThreadId: string, profileId: string): Promise<{ ok: true }>;
  threadMembers(parentThreadId: string): JoinedThreadMember[];
  threadMemberStates(parentThreadId: string): Promise<ThreadMemberState[]>;
  promoteDelegation(childThreadId: string, parentThreadId: string): Promise<{ ok: true }>;
  delegationBindingForChild(childThreadId: string): { threadId: string; profileId: string; parentThreadId: string };
  boundProfile(threadId: string): Profile | null;
  resolveAgentForThread(threadId: string): ResolvedAgent;
  publishDelegationChange(threadId: string, status: string): void;
  deleteThreadBinding(threadId: string): void;
}


export async function createProfiles(
  bb: BbPluginApi,
  db: Database.Database,
  channels?: Pick<Store, "byThread">,
  executionResolver?: ExecutionResolver,
  onProfilesChanged?: (profiles: Profile[]) => void,
): Promise<Profiles> {
  const homes = new AgentHomes(bb, db, async (id, instructions) => {
    const profile = getProfile(id);
    const saved = await saveProfile({ ...snapshot(profile), instructions }, profile.revision);
    bb.realtime.publish("profiles-changed", { reason: "saved", profileId: id });
    return saved;
  });
  async function resolveProfileExecution(profile: Profile): Promise<ResolvedExecution> {
    if (!executionResolver) throw new Error("Pi agents require the plugin execution resolver.");
    const execution = await executionResolver.resolveAgent(profile);
    return { ...execution, providerId: AGENTS_PROVIDER_ID, model: agentModelId(profile.id) };
  }
  const resolveThreadExecution = resolveProfileExecution;
  function modelLevelPreview(level: ModelLevel) {
    if (!executionResolver)
      throw new Error("Model level previews require the plugin execution resolver.");
    return executionResolver.preview(level);
  }

  function listProfiles() {
    return (db.prepare("SELECT * FROM profiles ORDER BY is_default DESC, name COLLATE NOCASE").all() as DbProfile[]).map(profileDto);
  }

  function getProfile(id?: string | null) {
    const row = id
      ? db.prepare("SELECT * FROM profiles WHERE id = ?").get(id)
      : db.prepare("SELECT * FROM profiles WHERE is_default = 1 LIMIT 1").get();
    if (!row) throw new Error(id ? `Unknown agent profile: ${id}` : "Choose an agent profile or set a default before starting one");
    return profileDto(row as DbProfile);
  }
  async function validateRunProject(slug: string, projectId: string) {
    try {
      return await bb.sdk.projects.get({ projectId });
    } catch {
      throw new Error(
        `@${slug} runs in project ${projectId}, which does not exist. Set Runs in to Caller's environment or another project.`,
      );
    }
  }

  async function fixedProjectEnvironment(profile: Profile): Promise<{
    projectId: string;
    environment: ProfileEnvironment;
  }> {
    if (!profile.runProjectId)
      throw new Error(`@${profile.slug} is configured to run in the caller's project.`);
    const project = await validateRunProject(profile.slug, profile.runProjectId);
    if (profile.runHostId) {
      let host;
      try {
        host = await bb.sdk.hosts.get({ hostId: profile.runHostId });
      } catch {
        throw new Error(`@${profile.slug} runs on machine ${profile.runHostId}, which does not exist.`);
      }
      if (host.status !== "connected")
        throw new Error(`@${profile.slug} runs on machine ${host.name}, which is offline.`);
      if (project.kind === "personal")
        return { projectId: project.id, environment: { type: "host", hostId: host.id, workspace: { type: "personal" } } };
      const environments = await bb.sdk.environments.list({
        projectId: project.id,
        hostId: host.id,
        environmentProviderId: "project-checkout",
        status: "ready",
      });
      const checkout = environments.find((environment) =>
        environment.projectId === project.id && environment.hostId === host.id
      );
      return {
        projectId: project.id,
        environment: checkout
          ? { type: "reuse", environmentId: checkout.id }
          : {
              type: "provider",
              environmentProviderId: "project-checkout",
              machine: { type: "existing", hostId: host.id },
              inputs: {},
            },
      };
    }
    if (project.kind === "personal")
      return { projectId: project.id, environment: { type: "host", workspace: { type: "personal" } } };
    if (!profile.runInCheckout)
      return { projectId: project.id, environment: { type: "project-default" } };
    const [environments, hosts] = await Promise.all([
      bb.sdk.environments.list({
        projectId: project.id,
        environmentProviderId: "project-checkout",
        status: "ready",
      }),
      bb.sdk.hosts.list(),
    ]);
    // A checkout on a connected machine, preferring the BB server's own machine (the one with no machine provider).
    const connected = new Map(hosts.filter((host) => host.status === "connected").map((host) => [host.id, host]));
    const usable = environments.filter((environment) => environment.projectId === project.id && connected.has(environment.hostId));
    const checkout = usable.find((environment) => !connected.get(environment.hostId)!.machineProviderId) ?? usable[0];
    if (!checkout)
      throw new Error(`@${profile.slug} runs in ${project.name}'s checkout, but that project has no ready checkout environment on a connected machine.`);
    return { projectId: project.id, environment: { type: "reuse", environmentId: checkout.id } };
  }

  function boundProfile(threadId: string) {
    const binding = db.prepare(
      "SELECT profile_id AS profileId FROM thread_bindings WHERE thread_id = ?",
    ).get(threadId) as { profileId: string } | undefined;
    return binding ? getProfile(binding.profileId) : null;
  }


  function resolveAgentForThread(threadId: string): ResolvedAgent {
    const conversation = channels?.byThread(threadId);
    if (conversation)
      return {
        profile: getProfile(conversation.agentId),
        source: "conversation",
        context: conversation.kind === "group" ? "channel" : "mission",
      };
    const bound = boundProfile(threadId);
    if (bound) return { profile: bound, source: "binding" };
    return { profile: getProfile(), source: "default" };
  }


  async function builtInRoleForProfile(profileId: string): Promise<BuiltInProfileRole | null> {
    for (const role of Object.keys(BUILT_IN_PROFILE_ID_KEY_BY_ROLE) as BuiltInProfileRole[]) {
      if (await bb.storage.kv.get<string>(BUILT_IN_PROFILE_ID_KEY_BY_ROLE[role]) === profileId) return role;
    }
    return null;
  }

  async function spawnedTitle(profile: Profile, title: string) {
    return `${await builtInRoleForProfile(profile.id) === "pr-review" ? "@pr-review" : `@${profile.slug}`} · ${title}`;
  }

  async function registerCompanionThread(profile: Profile, threadId: string) {
    if (await builtInRoleForProfile(profile.id) !== "pr-review") return;
    try {
      await bb.sdk.plugins.callRpc({
        pluginId: "pr-review",
        method: "registerReviewThread",
        input: { threadId },
        outputSchema: okSchema,
      });
    } catch (error) {
      bb.log.warn(`could not register PR Review companion thread: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function delegationBinding(childThreadId: string, parentThreadId: string) {
    const binding = db.prepare(`SELECT thread_id AS threadId, profile_id AS profileId
      FROM thread_bindings WHERE thread_id = ? AND parent_thread_id = ?`)
      .get(childThreadId, parentThreadId) as { threadId: string; profileId: string } | undefined;
    if (!binding) throw new Error("That delegated agent does not belong to this parent thread.");
    return binding;
  }

  function joinThread(parentThreadId: string, profileId: string) {
    getProfile(profileId);
    const result = db.prepare(`INSERT INTO thread_members
      (parent_thread_id, profile_id, joined_at, removed_at)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(parent_thread_id, profile_id) DO UPDATE SET
        joined_at = excluded.joined_at,
        removed_at = NULL
      WHERE thread_members.removed_at IS NOT NULL`)
      .run(parentThreadId, profileId, now());
    if (result.changes)
      bb.realtime.publish("thread-members-changed", { threadId: parentThreadId });
  }

  function threadMembers(parentThreadId: string): JoinedThreadMember[] {
    return db.prepare(`SELECT
        members.profile_id AS profileId,
        profiles.slug,
        profiles.name,
        profiles.avatar
      FROM thread_members AS members
      JOIN profiles ON profiles.id = members.profile_id
      WHERE members.parent_thread_id = ? AND members.removed_at IS NULL
      ORDER BY members.joined_at, profiles.name COLLATE NOCASE`)
      .all(parentThreadId) as JoinedThreadMember[];
  }

  function delegationBindingForChild(childThreadId: string) {
    const binding = db.prepare(`SELECT
        thread_id AS threadId,
        profile_id AS profileId,
        parent_thread_id AS parentThreadId
      FROM thread_bindings
      WHERE thread_id = ? AND parent_thread_id IS NOT NULL`)
      .get(childThreadId) as {
        threadId: string;
        profileId: string;
        parentThreadId: string;
      } | undefined;
    if (!binding) throw new Error("That thread is not a delegated agent child.");
    return binding;
  }

  async function threadMemberStates(parentThreadId: string): Promise<ThreadMemberState[]> {
    return Promise.all(threadMembers(parentThreadId).map(async (member) => {
      const child = latestDelegationThread(member.profileId, parentThreadId);
      if (!child)
        return { ...member, childThreadId: null, status: "idle", visibility: null };
      try {
        const thread = await bb.sdk.threads.get({ threadId: child.threadId });
        return {
          ...member,
          childThreadId: child.threadId,
          status: thread.status,
          visibility: thread.visibility,
        };
      } catch (cause) {
        if (!missingThread(cause)) throw cause;
        return { ...member, childThreadId: null, status: "idle", visibility: null };
      }
    }));
  }

  async function removeThreadMember(parentThreadId: string, profileId: string) {
    getProfile(profileId);
    const result = db.prepare(`UPDATE thread_members
      SET removed_at = ?
      WHERE parent_thread_id = ? AND profile_id = ? AND removed_at IS NULL`)
      .run(now(), parentThreadId, profileId);
    if (!result.changes) return { ok: true as const };
    const children = db.prepare(`SELECT thread_id AS threadId
      FROM thread_bindings
      WHERE parent_thread_id = ? AND profile_id = ?`)
      .all(parentThreadId, profileId) as Array<{ threadId: string }>;
    await Promise.all(children.map(async ({ threadId }) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.status === "pending" || thread.status === "starting" || thread.status === "active")
          await bb.sdk.threads.stop({ threadId });
      } catch (error) {
        bb.log.warn(`could not stop removed thread member child ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    bb.realtime.publish("thread-members-changed", { threadId: parentThreadId });
    return { ok: true as const };
  }

  async function promoteDelegation(childThreadId: string, parentThreadId: string) {
    delegationBinding(childThreadId, parentThreadId);
    await bb.sdk.threads.update({
      threadId: childThreadId,
      visibility: "visible",
    });
    publishDelegationChange(childThreadId, "promoted");
    return { ok: true as const };
  }

  async function saveProfile(input: ProfileInput, expectedRevision?: number) {
    const existing = input.id ? db.prepare("SELECT * FROM profiles WHERE id = ?").get(input.id) as DbProfile | undefined : undefined;
    if (input.id && !existing) throw new Error(`Unknown agent profile: ${input.id}`);
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision)
      throw new Error("This profile changed. Reload it before saving your edits.");
    const runHostId = input.runProjectId && input.runInCheckout ? input.runHostId : null;
    if (existing && (existing.run_project_id !== input.runProjectId
      || Boolean(existing.run_in_checkout) !== input.runInCheckout)
      && db.prepare("SELECT 1 FROM agent_dms WHERE profile_id = ?").get(existing.id))
      throw new Error("Runs in is locked after this agent's permanent DM has been reserved.");
    if (input.runProjectId)
      await validateRunProject(input.slug, input.runProjectId);
    const id = existing?.id ?? input.id ?? randomUUID();
    const timestamp = now();
    const revision = (existing?.revision ?? 0) + 1;
    const makeDefault = input.isDefault;
    const save = db.transaction(() => {
      if (makeDefault) db.prepare("UPDATE profiles SET is_default = 0").run();
      db.prepare(`INSERT INTO profiles (
        id, slug, memory_key, kind, name, description, avatar, model_mode, level, pi_harness, provider_id,
        model, reasoning_level, service_tier, permission_mode, instructions,
        skill_ids, mcp_server_ids, run_project_id, run_host_id, run_in_checkout, show_in_sidebar, is_default,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug, kind = excluded.kind, name = excluded.name,
        description = excluded.description, avatar = excluded.avatar,
        model_mode = excluded.model_mode, level = excluded.level,
        pi_harness = 1,
        provider_id = excluded.provider_id, model = excluded.model,
        reasoning_level = excluded.reasoning_level, service_tier = excluded.service_tier,
        permission_mode = excluded.permission_mode, instructions = excluded.instructions,
        skill_ids = excluded.skill_ids, mcp_server_ids = excluded.mcp_server_ids,
        run_project_id = excluded.run_project_id,
        run_host_id = excluded.run_host_id,
        run_in_checkout = excluded.run_in_checkout,
        show_in_sidebar = excluded.show_in_sidebar,
        is_default = excluded.is_default, revision = excluded.revision,
        home_ready = CASE
          WHEN profiles.kind = 'thin' AND excluded.kind = 'full'
          THEN 0 ELSE profiles.home_ready END,
        interval_minutes = CASE
          WHEN excluded.kind = 'thin' THEN NULL ELSE profiles.interval_minutes END,
        updated_at = excluded.updated_at`)
        .run(id, input.slug, existing?.memory_key ?? `agent-${id}`, input.kind, input.name, input.description, input.avatar,
          input.modelMode, input.level, 1, input.providerId, input.model,
          input.reasoningLevel, input.serviceTier, input.permissionMode,
          input.instructions, JSON.stringify([...new Set(input.skillIds)]),
          JSON.stringify([...new Set(input.mcpServerIds)]), input.runProjectId, runHostId,
          input.runProjectId && input.runInCheckout ? 1 : 0, input.showInSidebar ? 1 : 0,
          makeDefault ? 1 : 0, revision, existing?.created_at ?? timestamp,
          timestamp);
      const saved = getProfile(id);
      db.prepare("INSERT INTO profile_revisions (profile_id, revision, snapshot, created_at) VALUES (?, ?, ?, ?)")
        .run(id, revision, JSON.stringify(snapshot(saved)), timestamp);
      return saved;
    });
    const saved = save();
    onProfilesChanged?.(listProfiles());
    return saved;
  }

  function availableBuiltInSlug(base: string): string {
    let slug = base;
    let suffix = 2;
    while (db.prepare("SELECT 1 FROM profiles WHERE slug = ? COLLATE NOCASE").get(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
    return slug;
  }

  async function ensureBuiltInProfiles() {
    if (await bb.storage.kv.get<boolean>(BUILT_IN_PROFILE_SEED_KEY)) return;
    const legacySeeded = (await Promise.all(
      LEGACY_BUILT_IN_PROFILE_SEED_KEYS.map((key) =>
        bb.storage.kv.get<boolean>(key),
      ),
    )).some(Boolean);
    for (const role of Object.keys(BUILT_IN_PROFILE_ID_KEY_BY_ROLE) as BuiltInProfileRole[]) {
      const input = role === "pr-review" ? undefined : BUILT_IN_PROFILE_BY_ROLE[role];
      const mappedId = await bb.storage.kv.get<string>(BUILT_IN_PROFILE_ID_KEY_BY_ROLE[role]);
      const mapped = mappedId
        ? (db.prepare("SELECT * FROM profiles WHERE id = ?").get(mappedId) as DbProfile | undefined)
        : undefined;
      const slugMatch = db.prepare("SELECT * FROM profiles WHERE slug = ? COLLATE NOCASE").get(input?.slug ?? "pr-review") as DbProfile | undefined;
      const legacy = legacySeeded && slugMatch?.name === (input?.name ?? "PR Review") ? slugMatch : undefined;
      const existing = mapped ?? legacy;
      if (!input) {
        if (existing) await bb.storage.kv.set(BUILT_IN_PROFILE_ID_KEY_BY_ROLE[role], existing.id);
        continue;
      }
      const existingProfile = existing ? profileDto(existing) : undefined;
      const profile = existingProfile
        ? role === "text-edit" && existingProfile.kind !== "thin"
          ? await saveProfile({ ...snapshot(existingProfile), kind: "thin" })
          : existingProfile
        : await saveProfile({ ...input, slug: availableBuiltInSlug(input.slug) });
      await bb.storage.kv.set(BUILT_IN_PROFILE_ID_KEY_BY_ROLE[role], profile.id);
    }
    await bb.storage.kv.set(BUILT_IN_PROFILE_SEED_KEY, true);
  }

  let builtInProfileReconciliation: Promise<void> | null = null;
  function reconcileBuiltInProfiles(): Promise<void> {
    if (!builtInProfileReconciliation) {
      builtInProfileReconciliation = ensureBuiltInProfiles().finally(() => {
        builtInProfileReconciliation = null;
      });
    }
    return builtInProfileReconciliation;
  }

  async function deleteProfile(
    id: string,
    cleanupChannels: Store,
    runtime: Runtime,
  ) {
    if (db.prepare("SELECT 1 FROM agent_dms WHERE profile_id = ?").get(id))
      throw new Error("This agent has a permanent DM. Delete it only through an explicit DM migration.");
    await cleanupProfileResources(
      {
        bb,
        db,
        channels: cleanupChannels,
        runtime,
        homesRoot: homes.root,
      },
      id,
      { deleteProfile: true, guardChannelMessages: true },
    );
    onProfilesChanged?.(listProfiles());
    bb.realtime.publish("profiles-changed", {
      reason: "deleted",
      profileId: id,
    });
    return { ok: true as const };
  }

  async function importProfiles(data: ExportData) {
    const importProfile = async (
      input: Omit<ProfileInput, "id">,
      mission?: string,
    ) => {
      const existing = db.prepare(
        "SELECT id FROM profiles WHERE slug = ? COLLATE NOCASE",
      ).get(input.slug) as { id: string } | undefined;
      const saved = await saveProfile({ ...input, id: existing?.id });
      if (mission !== undefined && !saved.homeReady)
        await homes.ensureHome(saved, mission);
    };
    if (data.schemaVersion === 1) {
      for (const { piHarness: _legacyHarness, ...input } of data.profiles)
        await importProfile({ ...input, avatar: "🤖", modelMode: "level", level: "medium", kind: "full" });
    } else {
      for (const profile of data.profiles) {
        const { mission, ...rest } = profile;
        const { piHarness: _legacyHarness, ...input } = rest as typeof rest & { piHarness?: boolean };
        await importProfile({ ...input, kind: "kind" in input ? input.kind : "full" }, mission);
      }
    }
    bb.realtime.publish("profiles-changed", { reason: "imported" });
    return { imported: data.profiles.length };
  }

  async function exportProfiles(): Promise<ExportData> {
    const profiles = await Promise.all(listProfiles().map(async (profile) => {
      const { id: _id, ...input } = snapshot(profile);
      if (profile.kind === "thin" || !profile.homeReady) return input;
      const mission = await document(homes.path(profile.id), "MISSION.md");
      return { ...input, mission: mission.text };
    }));
    return { schemaVersion: 4, profiles };
  }


  async function spawnResolvedProfile(profile: Profile, input: SpawnInput) {
    if (!input.projectId && input.environment) throw new Error("Choose a project with an explicit task environment.");
    if (!input.projectId && !profile.runProjectId) throw new Error("Choose a project for this task or save a default project.");
    const target = input.projectId
      ? { projectId: input.projectId, environment: input.environment ?? { type: "project-default" as const } }
      : await fixedProjectEnvironment(profile);
    const docs = profile.kind === "thin"
      ? { mission: "", legacyMemory: false }
      : await homes.spawnDocuments(profile);
    const execution = await resolveThreadExecution(profile);
    const thread = await bb.sdk.threads.spawn({
      projectId: target.projectId,
      environment: target.environment,
      parentThreadId: input.parentThreadId,
      title: await spawnedTitle(profile, input.title),
      visibility: input.visibility,
      providerId: execution.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      serviceTier: profile.serviceTier,
      permissionMode: "full",
      pluginMetadata: { role: "task", profileId: profile.id, schemaVersion: 1 },
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
        permissionMode: "explicit",
      },
      input: [
        { type: "text", text: spawnPreamble(profile, docs, input.parentThreadId ? "delegation" : "direct"), mentions: [], visibility: "agent-only" },
        { type: "text", text: input.prompt, mentions: [] },
      ],
    });
    db.prepare(`INSERT OR REPLACE INTO thread_bindings
      (thread_id, profile_id, revision, parent_thread_id, environment_id, created_at, task)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(thread.id, profile.id, profile.revision, input.parentThreadId ?? null, thread.environmentId, now(),
        // The DM's report shows the task itself, not the delegation header.
        profile.kind === "full" ? input.prompt.split(DELEGATION_HEADER_END).at(-1)!.trim() || input.prompt : null);
    publishDelegationChange(thread.id, thread.status);
    await registerCompanionThread(profile, thread.id);
    return { threadId: thread.id, environmentId: thread.environmentId, profileId: profile.id, revision: profile.revision };
  }

  function spawnProfile(input: SpawnInput) {
    return spawnResolvedProfile(getProfile(input.profileId), input);
  }

  async function spawnBuiltInProfile(input: SpawnBuiltInProfileInput) {
    await reconcileBuiltInProfiles();
    const { profile, ...spawnInput } = input;
    const profileId = await bb.storage.kv.get<string>(BUILT_IN_PROFILE_ID_KEY_BY_ROLE[profile]);
    if (!profileId) throw new Error(`Built-in agent profile is unavailable: ${profile}`);
    return spawnResolvedProfile(getProfile(profileId), spawnInput);
  }

  async function delegationEnvironment(projectId: string, threadId: string) {
    const parent = await bb.sdk.threads.get({ threadId });
    if (parent.environmentId) return { type: "reuse" as const, environmentId: parent.environmentId };
    const project = await bb.sdk.projects.get({ projectId });
    return project.kind === "personal"
      ? { type: "host" as const, workspace: { type: "personal" as const } }
      : { type: "project-default" as const };
  }

  function latestDelegationThread(profileId: string, parentThreadId: string) {
    return db.prepare(`SELECT thread_id AS threadId FROM thread_bindings
      WHERE profile_id = ? AND parent_thread_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(profileId, parentThreadId) as { threadId: string } | undefined;
  }

  function publishDelegationChange(threadId: string, status: string) {
    const binding = db.prepare("SELECT parent_thread_id AS parentThreadId FROM thread_bindings WHERE thread_id = ?")
      .get(threadId) as { parentThreadId: string | null } | undefined;
    if (binding?.parentThreadId) {
      bb.realtime.publish("delegation-changed", { threadId, parentThreadId: binding.parentThreadId, status });
    }
  }

  function deleteThreadBinding(threadId: string) {
    db.prepare("DELETE FROM thread_bindings WHERE thread_id = ?").run(threadId);
  }

  await reconcileBuiltInProfiles();
  for (const profile of listProfiles())
    if (profile.homeReady)
      await homes.retireMemory(profile.id).catch((error: unknown) =>
        bb.log.warn(`Could not retire MEMORY.md for @${profile.slug}: ${String(error)}`));

  return {
    db,
    homes,
    listProfiles,
    getProfile,
    saveProfile,
    fixedProjectEnvironment,
    deleteProfile,
    importProfiles,
    exportProfiles,
    spawnProfile,
    spawnBuiltInProfile,
    resolveExecution: resolveProfileExecution,
    modelLevelPreview,
    delegationEnvironment,
    latestDelegationThread,
    delegationBinding,
    joinThread,
    removeThreadMember,
    threadMembers,
    threadMemberStates,
    promoteDelegation,
    delegationBindingForChild,
    boundProfile,
    resolveAgentForThread,
    publishDelegationChange,
    deleteThreadBinding,
  };
}

// Agent model IDs stay stable; the bridge reads the current level or pin on each turn.
export async function refreshConversations(
  _bb: BbPluginApi,
  channels: Store,
  runtime: Runtime,
  previous: Profile,
  saved: Profile,
) {
  const runProjectChanged = previous.runProjectId !== saved.runProjectId
    || previous.runInCheckout !== saved.runInCheckout;
  if (runProjectChanged) {
    for (const job of channels.work(saved.id))
      await runtime.cancel(job, "Agent run project changed.");
    for (const conversation of channels.conversations(saved.id))
      channels.deleteConversation(conversation.threadId);
    runtime.changed();
  } else if (previous.kind !== saved.kind) {
    for (const job of channels.work(saved.id))
      await runtime.cancel(job, "Agent kind changed.");
    runtime.changed();
  }
}

export function agentsSidebarSnapshot(db: Database.Database, profiles: readonly Profile[]) {
  const dms = db.prepare("SELECT profile_id AS profileId, thread_id AS threadId FROM agent_dms").all() as Array<{ profileId: string; threadId: string | null }>;
  const dmByProfile = new Map(dms.map((row) => [row.profileId, row.threadId]));
  const excluded = db.prepare(`SELECT thread_id AS threadId FROM agent_dms WHERE thread_id IS NOT NULL
    UNION SELECT thread_id FROM channel_thread_ids UNION SELECT thread_id FROM dm_migration`).all() as Array<{ threadId: string }>;
  return {
    agents: profiles.filter((profile) => profile.showInSidebar).map(({ id, name, avatar }) => ({ id, name, avatar, dmThreadId: dmByProfile.get(id) ?? null })),
    excludedThreadIds: excluded.map(({ threadId }) => threadId),
  };
}

export function registerProfileRpc(
  bb: BbPluginApi,
  profiles: Profiles,
  channels: Store,
  runtime: Runtime,
  channelHandlers: ChannelRpcHandlers,
  automationHandlers: AutomationRpcHandlers,
  agentProviders: AgentProviders,
  dms: AgentDms,
  sidebarChanged: () => void = () => {},
) {
  bb.rpc.register(rpcContract, {
    getLongMemory: agentProviders.getLongMemory,
    setLongMemory: agentProviders.setLongMemory,
    assignmentStatus: () => {
      assertNoAssignmentOwner(profiles.db);
      return { schemaVersion: 1 as const, kind: "agentPreferences" as const, state: "retained-only" as const };
    },
    getSandboxAgents: async ({ hostId }) => {
      const retained = await bb.storage.kv.get<unknown>(`sandbox-agents:${hostId}`);
      return {
        schemaVersion: 1 as const, kind: "agentPreferences" as const, state: "retained-only" as const,
        agentIds: retained === undefined ? null : sandboxAgentIdsSchema.parse(retained),
      };
    },
    setSandboxAgents: membershipRetired,
    listProfiles: profiles.listProfiles,
    agentsSidebar: () => agentsSidebarSnapshot(profiles.db, profiles.listProfiles()),
    profilesForProject: () => profiles.listProfiles(),
    saveProfile: async (input) => {
      const { expectedRevision, ...profileInput } = input;
      const previous = profileInput.id ? profiles.getProfile(profileInput.id) : null;
      const saved = await profiles.saveProfile(profileInput, expectedRevision);
      if (previous) await refreshConversations(bb, channels, runtime, previous, saved);
      bb.realtime.publish("profiles-changed", { reason: "saved", profileId: saved.id });
      return saved;
    },
    deleteProfile: ({ id }) => profiles.deleteProfile(id, channels, runtime),
    retireAgent: async ({ id, retired }) => {
      await channels.ensureProject();
      const agent = await runtime.retire(id, retired);
      bb.realtime.publish("profiles-changed", {
        reason: retired ? "retired" : "restored",
        profileId: id,
      });
      return agent;
    },
    profileHistory: ({ id }) => (profiles.db.prepare("SELECT * FROM profile_revisions WHERE profile_id = ? ORDER BY revision DESC").all(id) as Array<{ revision: number; snapshot: string; created_at: string }>)
      .map((row) => ({ revision: row.revision, snapshot: JSON.parse(row.snapshot), createdAt: row.created_at })),
    agentDocument: ({ id, file }) =>
      profiles.homes.agentDocument(profiles.getProfile(id), file),
    saveAgentDocument: ({ id, file, text, version }) =>
      profiles.homes.saveAgentDocument(
        profiles.getProfile(id),
        file,
        text,
        version,
        "You",
      ),
    documentHistory: ({ id, file, before }) =>
      profiles.homes.documentHistory(profiles.getProfile(id), file, before),
    agentDetail: ({ id }) => ({
      profile: profiles.getProfile(id),
      home: profiles.homes.detail(id),
      runsInLocked: Boolean(profiles.db.prepare("SELECT 1 FROM agent_dms WHERE profile_id = ?").get(id)),
    }),
    providers: async () => (await bb.sdk.providers.list()).filter((provider) => provider.available).map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      supportsServiceTier: provider.capabilities.supportsServiceTier,
      permissionModes: provider.capabilities.permissionModes,
    })),
    models: async ({ providerId }) => (await bb.sdk.providers.models({ providerId })).models.map((model) => {
      const reasoningLevels = model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort).filter(isReasoningLevel);
      return {
        model: model.model,
        displayName: model.displayName,
        reasoningLevels,
        defaultReasoningLevel: isReasoningLevel(model.defaultReasoningEffort)
          ? model.defaultReasoningEffort
          : reasoningLevels[0] ?? "medium",
      };
    }),
    modelLevelPreview: ({ level }) => profiles.modelLevelPreview(level),
    ensureAgentDm: async ({ profileId }) => {
      const result = await dms.ensureAgentDm(profileId);
      sidebarChanged();
      return result;
    },
    spawnBuiltInProfile: profiles.spawnBuiltInProfile,
    spawnProfile: profiles.spawnProfile,
    exportProfiles: profiles.exportProfiles,
    importProfiles: profiles.importProfiles,
    catalogContextForThread: ({ threadId }) => {
      try {
        const resolved = profiles.resolveAgentForThread(threadId);
        return { profileId: resolved.profile.id, bound: resolved.source !== "default" };
      } catch {
        return { profileId: null, bound: false };
      }
    },
    agentAvailability: async ({ agentId }) => {
      if (!agentId) {
        const projects = await bb.sdk.projects.list();
        return {
          schemaVersion: 1 as const, kind: "agentPreferences" as const, state: "retained-only" as const,
          global: false,
          projectIds: [],
          projects: projects
            .filter((project) => project.kind === "standard")
            .map((project) => ({ id: project.id, name: project.name, enabled: false })),
        };
      }
      const [assignments, projects] = await Promise.all([
        bb.sdk.plugins.callRpc({ pluginId: "projects", method: "agentAssignments", input: { agentId }, outputSchema: agentAssignmentsSchema }),
        bb.sdk.projects.list(),
      ]);
      const enabled = new Set(assignments.projectIds);
      return {
        schemaVersion: 1 as const, kind: "agentPreferences" as const, state: "retained-only" as const,
        global: assignments.global,
        projectIds: assignments.projectIds,
        projects: projects.filter((project) => project.kind === "standard").map((project) => ({ id: project.id, name: project.name, enabled: enabled.has(project.id) })),
      };
    },
    setAgentAvailability: membershipRetired,
    refreshAvailability: membershipRetired,
    delegationStatus: async ({ childThreadId, parentThreadId }) => {
      const binding = profiles.delegationBinding(childThreadId, parentThreadId);
      const profile = profiles.getProfile(binding.profileId);
      const [thread, timeline] = await Promise.all([
        bb.sdk.threads.get({ threadId: childThreadId }),
        bb.sdk.threads.timeline({ threadId: childThreadId, includeNestedRows: "false", segmentLimit: "100" }),
      ]);
      // The instruction is the first user message, after the fixed delegation header.
      const prompt = timeline.rows.find((row) => row.kind === "conversation" && row.role === "user")?.text ?? null;
      const task = prompt?.split(DELEGATION_HEADER_END).at(-1)?.trim() || prompt;
      return {
        threadId: childThreadId,
        title: thread.title,
        status: thread.status,
        visibility: thread.visibility,
        profile: `@${profile.slug}`,
        profileId: profile.id,
        profileName: profile.name,
        avatar: profile.avatar,
        task,
      };
    },
    threadMembers: ({ threadId }) => profiles.threadMemberStates(threadId),
    removeThreadMember: ({ threadId, profileId }) =>
      profiles.removeThreadMember(threadId, profileId),
    promoteDelegation: ({ childThreadId, parentThreadId }) =>
      profiles.promoteDelegation(childThreadId, parentThreadId),
    ...channelHandlers,
    ...automationHandlers,
  });
}


export function registerProfileConfiguration(bb: BbPluginApi, profiles: Profiles) {
  bb.agents.configure((context) => {
    const ordinaryTools = [
      ...ordinaryChannelToolNames,
      "delegate_agent_profile",
      "agent_document_read",
      "agent_persona_update",
    ];
    const thinOrdinaryTools = [
      ...ordinaryChannelToolNames,
      "delegate_agent_profile",
    ];
    let resolved: ResolvedAgent | null = null;
    try {
      resolved = profiles.resolveAgentForThread(context.thread.id);
    } catch {
      // No profiles configured yet.
    }
    if (resolved?.source === "conversation") {
      const profile = resolved.profile;
      return {
        tools: [
          ...(profile.kind === "thin"
            ? allChannelToolNames.filter((name) => name !== "channel_context")
            : allChannelToolNames),
          ...channelAutomationToolNames,
          ...(profile.kind === "full"
            ? ["agent_document_read", "agent_persona_update"]
            : []),
        ],
        skills: profile.kind === "full" ? ["agents"] : [],
        instructions: assembleInstructions(
          profile,
          resolved.context ?? "mission",
          profiles.homes.instructionDocuments(profile),
        ),
      };
    }
    const members = profiles.threadMembers(context.thread.id);
    const joinedInstructions = members.length
      ? [
          `Agents joined to this thread: ${members.map((member) => `@${member.slug} (profileId ${member.profileId})`).join(", ")}.`,
          "When the user addresses a joined agent by name or continues its work, call delegate_agent_profile for it with mode continue.",
          "Otherwise answer yourself.",
          "Do not bring in agents that are not joined unless the user @mentions them.",
        ].join(" ") + "\n\n"
      : "";
    if (resolved?.source === "binding") {
      const profile = resolved.profile;
      if (profile.kind === "thin")
        return {
          tools: thinOrdinaryTools,
          skills: [],
          instructions: assembleInstructions(
            profile,
            "delegation",
            profiles.homes.instructionDocuments(profile),
          ),
        };
      return {
        tools: ordinaryTools,
        skills: [],
        instructions: `${joinedInstructions}You are @${profile.slug} (revision ${profile.revision}). Your persona and conversation memory load on every turn. Use agent_document_read for the latest MISSION.md or PERSONA.md, and agent_persona_update to record a lasting lesson about how you work.`.slice(0, 4_096),
      };
    }
    const profile = resolved?.profile ?? null;
    if (profile?.kind === "thin")
      return {
        tools: thinOrdinaryTools,
        skills: [],
        instructions: assembleInstructions(
          profile,
          "default",
          profiles.homes.instructionDocuments(profile),
        ),
      };
    const instructions = profile
      ? assembleInstructions(profile, "default", profiles.homes.instructionDocuments(profile))
      : "Agents is available for @mention delegation.";
    return {
      tools: ordinaryTools,
      skills: [],
      instructions: `${joinedInstructions}${instructions}`.slice(0, 4_096),
    };
  });
}

export function registerProfileEvents(bb: BbPluginApi, profiles: Profiles) {
  bb.events.on("thread.active", ({ thread }) => profiles.publishDelegationChange(thread.id, "active"));
  bb.events.on("thread.idle", async ({ thread }) => {
    profiles.publishDelegationChange(thread.id, "idle");
  });
  bb.events.on("thread.failed", ({ thread }) => profiles.publishDelegationChange(thread.id, "error"));
  bb.events.on("thread.deleted", ({ thread }) => {
    profiles.deleteThreadBinding(thread.id);
    const removed = profiles.db.prepare(
      "DELETE FROM thread_members WHERE parent_thread_id = ?",
    ).run(thread.id);
    if (removed.changes)
      bb.realtime.publish("thread-members-changed", { threadId: thread.id });
  });
}

export function registerProfileMentionProvider(bb: BbPluginApi, profiles: Profiles) {
  bb.ui.registerMentionProvider({
    id: "agent-profile",
    label: "Agents",
    triggers: ["@"],
    async search({ query }) {
      const needle = query.toLowerCase();
      return profiles.listProfiles().filter((profile) => `${profile.name} ${profile.slug} ${profile.description}`.toLowerCase().includes(needle))
        .slice(0, 20).map((profile) => ({
          id: profile.id,
          icon: avatarIconName(profile.avatar),
          title: `@${profile.slug}`,
          subtitle: profile.description || profile.name,
        }));
    },
    async resolve(itemId) {
      return { context: delegationInstructions(profiles.getProfile(itemId)) };
    },
  });
}
