import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { resolveHostThreadStatuses } from "./lib/host-status";
import { DEFAULT_INTEGRATIONS, integrationsPatchSchema, integrationsViewSchema, loadIntegrations } from "./integrations";
import { createFreshnessCache } from "./lib/freshness-cache";
import {
  AGENTS_CHANGED_CHANNEL,
  type AgentSidebarSnapshot,
  CHANNELS_CHANGED_CHANNEL,
  DEFAULT_WORKSPACE_ID,
  type ChannelSummary,
  type ChannelsChangedSignal,
  LATER_CHANNEL,
  SHORTCUT_SLOTS_CHANNEL,
  THREAD_ORDER_CHANNEL,
  WORKSPACES_CHANNEL,
  shortcutSlotStatusValues,
  workspaceColorValues,
  type ShortcutSlot,
} from "./shared";

const migrations = [
  `CREATE TABLE IF NOT EXISTS later_threads (
     thread_id TEXT PRIMARY KEY,
     placed_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS thread_order (
     thread_id TEXT PRIMARY KEY,
     position INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS project_order (
     project_id TEXT PRIMARY KEY,
     position INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     color TEXT NOT NULL,
     position INTEGER NOT NULL,
     is_default INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS workspace_projects (
     project_id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL
   )`,
  `INSERT OR IGNORE INTO workspaces (id, name, color, position, is_default)
   VALUES ('ws_personal', 'Personal', 'amber', 0, 1)`,
  `INSERT OR IGNORE INTO workspaces (id, name, color, position, is_default)
   VALUES ('ws_work', 'Work', 'blue', 1, 0)`,
  `ALTER TABLE thread_order
   ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws_personal'`,
  `ALTER TABLE project_order
   ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'ws_personal'`,
  `CREATE TABLE IF NOT EXISTS workspace_threads (
     thread_id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sidebar_preferences (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE thread_order_scoped (
     workspace_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     PRIMARY KEY (workspace_id, thread_id)
   );
   INSERT OR IGNORE INTO thread_order_scoped (workspace_id, thread_id, position)
   SELECT workspace_id, thread_id, position FROM thread_order;
   DROP TABLE thread_order;
   ALTER TABLE thread_order_scoped RENAME TO thread_order`,
];

const threadIdInput = z.object({ threadId: z.string().trim().min(1) }).strict();
const orderedThreadIdsInput = z
  .object({
    threadIds: z.array(z.string().trim().min(1)).max(5000),
    workspaceId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    ({ threadIds }) => new Set(threadIds).size === threadIds.length,
    "Thread order cannot contain duplicate IDs",
  );
const orderedProjectIdsInput = z
  .object({
    projectIds: z.array(z.string().trim().min(1)).max(5000),
    workspaceId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    ({ projectIds }) => new Set(projectIds).size === projectIds.length,
    "Project order cannot contain duplicate IDs",
  );
const workspaceIdInput = z.object({
  workspaceId: z.string().trim().min(1),
}).strict();
const groupIdSchema = z.string().trim().min(1);
const workspaceOrderScopeInput = z.union([z.null(), workspaceIdInput]);
const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.union([z.enum(workspaceColorValues), z.string().regex(/^#[0-9a-fA-F]{6}$/)]),
  isDefault: z.boolean(),
  projectIds: z.array(z.string()),
  threadIds: z.array(z.string()),
}).strict();
const projectGroupSchema = z.object({
  id: z.string().uuid(), name: z.string(), color: z.union([z.enum(workspaceColorValues), z.string().regex(/^#[0-9a-fA-F]{6}$/)]),
  position: z.number().int().nonnegative(), isDefault: z.boolean(),
});
const projectGroupsSchema = z.object({
  groups: z.array(projectGroupSchema.extend({ projectIds: z.array(z.string()) })),
});
const okSchema = z.object({ ok: z.literal(true) });
const taskSourceSchema = z.literal("task-workspaces");
const taskCandidateSchema = z.object({
  source: taskSourceSchema,
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  status: z.string(),
  attachedThreadId: z.string().nullable(),
  attachedToCurrentThread: z.boolean(),
}).strict();

const taskWorkspaceCandidatesSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    status: z.string(),
    attachedThreadId: z.string().nullable(),
    attachedToCurrentThread: z.boolean(),
  })),
});
/**
 * The Sandboxes plugin owns these vocabularies and extends them over time, so
 * an unfamiliar provider or lifecycle value must degrade to neutral rendering
 * on one row instead of failing validation for the whole batch.
 */
const sandboxThreadStatusSchema = z.object({
  threadId: z.string(),
  sandboxId: z.string(),
  provider: z.string().min(1),
  status: z.string().min(1),
  label: z.string(),
}).strict();
const sandboxThreadStatusesSchema = z.object({
  statuses: z.array(sandboxThreadStatusSchema),
}).strict();
/**
 * A row the sidebar wants a sandbox status for. The host id comes straight off
 * the sidebar thread, which is what lets the sandboxes plugin recognize forked
 * and plugin-spawned threads without an environment lookup per row.
 */
const sandboxThreadRefSchema = z.object({
  threadId: z.string().min(1),
  hostId: z.string().min(1).nullable(),
}).strict();
const channelSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  pinned: z.boolean(),
  unread: z.boolean(),
  active: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  updatedAt: z.number(),
}).strict();
const agentSidebarSnapshotSchema = z.object({
  agents: z.array(z.object({
    id: z.string().uuid(), name: z.string(), avatar: z.string(),
    dmThreadId: z.string().nullable(),
  }).strict()),
  excludedThreadIds: z.array(z.string()),
}).strict();
const shortcutSlotSchema = z.object({
  threadId: z.string().trim().min(1),
  title: z.string(),
  status: z.enum(shortcutSlotStatusValues),
}).strict();
const shortcutSlotsSchema = z.object({
  slots: z.array(shortcutSlotSchema).max(10),
}).strict();
const publishShortcutSlotsInput = shortcutSlotsSchema.extend({
  publisherId: z.string().uuid(),
  focusEpoch: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
}).strict().refine(
  ({ slots }) => new Set(slots.map((slot) => slot.threadId)).size === slots.length,
  "Shortcut slots cannot contain duplicate thread IDs",
);

export const rpcContract = defineRpcContract({
  getIntegrations: { input: z.null(), output: integrationsViewSchema },
  setIntegrations: { input: integrationsPatchSchema, output: integrationsViewSchema },
  listLater: {
    input: z.null(),
    output: z.object({
      rows: z.array(
        z.object({
          threadId: z.string(),
          placedAt: z.number().int(),
        }),
      ),
    }),
  },
  setLater: {
    input: threadIdInput.extend({ later: z.boolean() }),
    output: z.object({ ok: z.literal(true) }),
  },
  listThreadOrder: {
    input: workspaceOrderScopeInput,
    output: z.object({ threadIds: z.array(z.string()) }).strict(),
  },
  setThreadOrder: {
    input: orderedThreadIdsInput,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  listProjectOrder: {
    input: workspaceOrderScopeInput,
    output: z.object({ projectIds: z.array(z.string()) }).strict(),
  },
  setProjectOrder: {
    input: orderedProjectIdsInput,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  listWorkspaces: {
    input: z.null(),
    output: z.object({
      workspaces: z.array(workspaceSchema),
    }).strict(),
  },
  createWorkspace: {
    input: z.object({ name: z.string().trim().min(1).max(80) }).strict(),
    output: z.object({ workspaceId: groupIdSchema }).strict(),
  },
  renameWorkspace: {
    input: z.object({ workspaceId: groupIdSchema, name: z.string().trim().min(1).max(80) }).strict(),
    output: okSchema,
  },
  deleteWorkspace: {
    input: z.object({ workspaceId: groupIdSchema }).strict(),
    output: okSchema,
  },
  setWorkspaceOrder: {
    input: z.object({ workspaceIds: z.array(groupIdSchema).min(1).max(100) }).strict()
      .refine(({ workspaceIds }) => new Set(workspaceIds).size === workspaceIds.length, "Workspace order cannot contain duplicates"),
    output: okSchema,
  },
  legacyWorkspaceSnapshot: {
    input: z.null(),
    output: z.object({ workspaces: z.array(workspaceSchema) }).strict(),
  },
  remapLegacyProjectGroups: {
    input: z.object({ mappings: z.array(z.object({ legacyId: z.string().min(1), groupId: z.string().uuid() })) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setProjectWorkspace: {
    input: workspaceIdInput.extend({
      projectId: z.string().trim().min(1),
    }),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  refreshProjectGroups: {
    input: z.null(),
    output: z.object({ ok: z.literal(true) }),
  },
  setThreadWorkspace: {
    input: workspaceIdInput.extend({
      threadId: z.string().trim().min(1),
    }),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  clearThreadWorkspace: {
    input: threadIdInput,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  listAttachableTasks: {
    input: threadIdInput.extend({ query: z.string().trim().min(1).max(500) }),
    output: z.object({ tasks: z.array(taskCandidateSchema) }).strict(),
  },
  attachThreadToTask: {
    input: threadIdInput.extend({ source: taskSourceSchema, taskId: z.string().min(1) }),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  listSandboxStatuses: {
    input: z.object({
      threads: z.array(sandboxThreadRefSchema).max(500),
    }).strict(),
    output: sandboxThreadStatusesSchema,
  },
  listChannels: {
    input: z.null(),
    // null when Agents is unavailable; [] when it has no channels yet.
    output: z.array(channelSummarySchema).nullable(),
  },
  channelsChanged: {
    // Agents may send the rows it just computed, sparing the callback.
    input: z.object({ channels: z.array(channelSummarySchema) }).strict().nullable(),
    output: okSchema,
  },
  listAgents: {
    input: z.object({ fresh: z.boolean() }).strict(),
    output: agentSidebarSnapshotSchema.nullable(),
  },
  agentsChanged: {
    input: z.object({ snapshot: agentSidebarSnapshotSchema }).strict(),
    output: okSchema,
  },
  openAgent: {
    input: z.object({ profileId: z.string().uuid() }).strict(),
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  listShortcutSlots: {
    input: z.null(),
    output: shortcutSlotsSchema,
  },
  publishShortcutSlots: {
    input: publishShortcutSlotsInput,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

interface LaterRow {
  thread_id: string;
  placed_at: number;
}

interface ThreadOrderRow {
  thread_id: string;
}

interface ProjectOrderRow {
  project_id: string;
  workspace_id: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  color: string;
  is_default: number;
}

interface WorkspaceProjectRow {
  project_id: string;
  workspace_id: string;
}

interface WorkspaceThreadRow {
  thread_id: string;
  workspace_id: string;
}

export default async function plugin(bb: BbPluginApi) {
  let integrations = DEFAULT_INTEGRATIONS;
  let integrationGeneration = 0;
  const requireIntegration = (key: keyof typeof integrations, name: string) => {
    if (!integrations[key]) throw new Error(`Enable ${name} under Oh My BB in Status Sidebar settings first.`);
  };
  const db = bb.storage.database();
  // Keep shipped migrations and IDs intact; only a new database gets neutral group defaults.
  const freshDatabase = !db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get();
  bb.storage.migrate(db, migrations);
  if (freshDatabase) {
    db.prepare("UPDATE workspaces SET name = 'General' WHERE id = ?").run(DEFAULT_WORKSPACE_ID);
    db.prepare("DELETE FROM workspaces WHERE id = 'ws_work'").run();
  }

  const publish = (threadId: string) => {
    bb.realtime.publish(LATER_CHANNEL, { threadId });
  };
  const publishThreadOrder = () => {
    bb.realtime.publish(THREAD_ORDER_CHANNEL, null);
  };
  const publishWorkspaces = () => {
    bb.realtime.publish(WORKSPACES_CHANNEL, null);
  };

  function legacyWorkspaces() {
    const rows = db.prepare(`SELECT id, name, color, is_default FROM workspaces ORDER BY position ASC`).all() as WorkspaceRow[];
    const assignments = db.prepare(`SELECT project_id, workspace_id FROM workspace_projects`).all() as WorkspaceProjectRow[];
    const orderedProjects = db.prepare(`SELECT project_id, workspace_id FROM project_order ORDER BY workspace_id, position`).all() as ProjectOrderRow[];
    const threadAssignments = db.prepare(`SELECT thread_id, workspace_id FROM workspace_threads`).all() as WorkspaceThreadRow[];
    const projectIdsByWorkspace = new Map<string, string[]>();
    for (const ordered of orderedProjects) {
      const ids = projectIdsByWorkspace.get(ordered.workspace_id) ?? [];
      ids.push(ordered.project_id);
      projectIdsByWorkspace.set(ordered.workspace_id, ids);
    }
    for (const assignment of assignments) {
      const ids = projectIdsByWorkspace.get(assignment.workspace_id) ?? [];
      if (!ids.includes(assignment.project_id)) ids.push(assignment.project_id);
      projectIdsByWorkspace.set(assignment.workspace_id, ids);
    }
    const threadIdsByWorkspace = new Map<string, string[]>();
    for (const assignment of threadAssignments) threadIdsByWorkspace.set(assignment.workspace_id, [...(threadIdsByWorkspace.get(assignment.workspace_id) ?? []), assignment.thread_id]);
    return rows.map((row) => ({
      id: row.id, name: row.name, color: row.color, isDefault: row.is_default === 1,
      projectIds: projectIdsByWorkspace.get(row.id) ?? [], threadIds: threadIdsByWorkspace.get(row.id) ?? [],
    }));
  }

  async function canonicalWorkspaces() {
    if (!integrations.projectsIntegration) return { workspaces: legacyWorkspaces() };
    const snapshot = await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "groupsSnapshot", input: null, outputSchema: projectGroupsSchema });
    if (!integrations.projectsIntegration) throw new Error("Group source changed. Try again.");
    const threadAssignments = db.prepare(`SELECT thread_id, workspace_id FROM workspace_threads`).all() as WorkspaceThreadRow[];
    const threadIdsByWorkspace = new Map<string, string[]>();
    for (const assignment of threadAssignments) {
      threadIdsByWorkspace.set(assignment.workspace_id, [...(threadIdsByWorkspace.get(assignment.workspace_id) ?? []), assignment.thread_id]);
    }
    const workspaces = snapshot.groups.map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      isDefault: group.isDefault,
      projectIds: group.projectIds,
      threadIds: threadIdsByWorkspace.get(group.id) ?? [],
    }));
    return { workspaces };
  }

  async function defaultProjectGroupId() {
    const { workspaces } = await canonicalWorkspaces();
    return workspaces.find((group) => group.isDefault)?.id ?? workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID;
  }
  let shortcutSlots: ShortcutSlot[] = [];
  let shortcutPublisher: {
    publisherId: string;
    focusEpoch: number;
    sequence: number;
  } | null = null;

  async function listAttachableTasks(threadId: string, query: string) {
    requireIntegration("tasksIntegration", "Tasks");
    const { tasks } = await bb.sdk.plugins.callRpc({
      pluginId: "task-workspaces",
      method: "listAttachmentCandidates",
      input: { threadId, query },
      outputSchema: taskWorkspaceCandidatesSchema,
    });
    return {
      tasks: tasks.map((task) => ({
        source: "task-workspaces" as const,
        ...task,
      })),
    };
  }

  async function attachThreadToTask(taskId: string, threadId: string) {
    requireIntegration("tasksIntegration", "Tasks");
    await bb.sdk.plugins.callRpc({
      pluginId: "task-workspaces",
      method: "attachExistingChat",
      input: { taskId, threadId },
      outputSchema: z.unknown(),
    });
    return { ok: true } as const;
  }

  async function listSandboxStatuses(
    threads: Array<{ threadId: string; hostId: string | null }>,
  ) {
    if (threads.length === 0) return { statuses: [] };
    // Source native machine/connection status straight from bb.sdk.hosts rather
    // than hopping into the Sandboxes plugin: one host listing resolves the
    // whole batch, and the Sandboxes plugin's own projection is now identical.
    const hosts = await bb.sdk.hosts.list().catch(() => []);
    return { statuses: resolveHostThreadStatuses(threads, hosts) };
  }

  // Channel rows are the same for every window, so one fetch from Agents is
  // shared: listChannels serves the cached rows, and a change nudge refetches
  // once and pushes the rows to every window in the realtime payload rather
  // than having each window call back for them.
  const CHANNELS_CACHE_MS = 30_000;
  const channelsCache = createFreshnessCache<ChannelSummary[] | null>();
  let channelsKey: string | null = null;
  let channelsRefresh: Promise<void> | null = null;
  let channelsRefreshPending = false;
  // Bumped by rows Agents pushes, which supersede a refetch in flight.
  let channelsGeneration = 0;

  // What the section renders; ordering is part of it. `updatedAt` only
  // drives Agents' ordering, so a message that leaves the rows as they
  // were is not news.
  const channelsViewKey = (channels: readonly ChannelSummary[] | null) =>
    JSON.stringify(
      channels?.map(({ id, name, pinned, unread, active, memberCount }) => [
        id, name, pinned, unread, active, memberCount,
      ]) ?? null,
    );

  // Without a max age, always fetches anew.
  function fetchChannels(maxAgeMs?: number) {
    if (!integrations.agentsIntegration) return Promise.resolve(null);
    const generation = integrationGeneration;
    const cached =
      maxAgeMs === undefined ? undefined : channelsCache.get("channels", maxAgeMs);
    if (cached) return cached;
    const fetched = bb.sdk.plugins.callRpc({
      pluginId: "agent-profiles",
      method: "channelSummaries",
      input: null,
      outputSchema: z.array(channelSummarySchema),
    }).then((rows) => integrations.agentsIntegration && generation === integrationGeneration ? rows : null).catch(() => null);
    channelsCache.set("channels", fetched);
    void fetched.then((channels) => {
      if (channelsCache.get("channels", Infinity) === fetched) {
        channelsKey = channelsViewKey(channels);
      }
    });
    return fetched;
  }

  function listChannels() {
    return fetchChannels(CHANNELS_CACHE_MS);
  }

  function publishChannels(channels: ChannelSummary[] | null, previousKey: string | null) {
    const nextKey = channelsViewKey(channels);
    channelsKey = nextKey;
    if (nextKey === previousKey) return;
    bb.realtime.publish(CHANNELS_CHANGED_CHANNEL, {
      channels,
    } satisfies ChannelsChangedSignal);
  }

  function acceptChannels(channels: ChannelSummary[]) {
    const previousKey = channelsKey;
    channelsGeneration += 1;
    channelsCache.set("channels", Promise.resolve(channels));
    publishChannels(channels, previousKey);
  }

  // Coalesces nudges: one refetch at a time, plus one more if nudged meanwhile.
  function refreshChannels() {
    if (channelsRefresh) {
      channelsRefreshPending = true;
      return channelsRefresh;
    }
    channelsRefresh = (async () => {
      do {
        channelsRefreshPending = false;
        const previousKey = channelsKey;
        const generation = channelsGeneration;
        const channels = await fetchChannels();
        if (generation === channelsGeneration) publishChannels(channels, previousKey);
      } while (channelsRefreshPending);
    })().finally(() => {
      channelsRefresh = null;
    });
    return channelsRefresh;
  }

  const agentsCache = createFreshnessCache<AgentSidebarSnapshot | null>();
  let agentsRefresh: Promise<AgentSidebarSnapshot | null> | null = null;
  function listAgents({ fresh }: { fresh: boolean }): Promise<AgentSidebarSnapshot | null> {
    if (!integrations.agentsIntegration) return Promise.resolve(null);
    const generation = integrationGeneration;
    if (agentsRefresh) return agentsRefresh;
    const cached = !fresh && agentsCache.get("agents", 30_000);
    if (cached) return cached;
    const fetched = bb.sdk.plugins.callRpc({
      pluginId: "agent-profiles", method: "agentsSidebar", input: null,
      outputSchema: agentSidebarSnapshotSchema,
    }).then((snapshot) => integrations.agentsIntegration && generation === integrationGeneration ? snapshot : null)
      .catch(() => null).finally(() => { if (agentsRefresh === fetched) agentsRefresh = null; });
    agentsRefresh = fetched;
    agentsCache.set("agents", fetched);
    return fetched;
  }

  const integrationPreferences = await loadIntegrations(bb, (next) => {
    integrations = next;
    integrationGeneration += 1;
    agentsRefresh = null;
    channelsGeneration += 1;
    channelsCache.prune(-1);
    agentsCache.prune(-1);
    publishWorkspaces();
    bb.realtime.publish(AGENTS_CHANGED_CHANNEL, null);
    bb.realtime.publish(CHANNELS_CHANGED_CHANNEL, null);
  });
  integrations = integrationPreferences.get();

  bb.rpc.register(rpcContract, {
    getIntegrations: () => ({ values: integrationPreferences.get(), migrationPending: integrationPreferences.migrationPending }),
    setIntegrations: async (patch) => ({ values: await integrationPreferences.update(patch), migrationPending: integrationPreferences.migrationPending }),
    listLater() {
      const rows = db
        .prepare(
          `SELECT thread_id, placed_at
             FROM later_threads
             ORDER BY placed_at DESC`,
        )
        .all() as LaterRow[];
      return {
        rows: rows.map((row) => ({
          threadId: row.thread_id,
          placedAt: row.placed_at,
        })),
      };
    },
    setLater({ threadId, later }) {
      if (later) {
        db.prepare(
          `INSERT INTO later_threads (thread_id, placed_at)
           VALUES (?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET placed_at = excluded.placed_at`,
        ).run(threadId, Date.now());
      } else {
        db.prepare(`DELETE FROM later_threads WHERE thread_id = ?`).run(threadId);
      }
      publish(threadId);
      return { ok: true } as const;
    },
    async listThreadOrder(input) {
      const workspaceId = input?.workspaceId ?? await defaultProjectGroupId();
      const rows = db
        .prepare(
          `SELECT thread_id
             FROM thread_order
            WHERE workspace_id = ?
             ORDER BY position ASC`,
        )
        .all(workspaceId) as ThreadOrderRow[];
      return { threadIds: rows.map((row) => row.thread_id) };
    },
    async setThreadOrder({ threadIds, workspaceId }) {
      const resolvedWorkspaceId = workspaceId ?? await defaultProjectGroupId();
      const replaceOrder = db.transaction((orderedIds: readonly string[]) => {
        db.prepare(`DELETE FROM thread_order WHERE workspace_id = ?`).run(
          resolvedWorkspaceId,
        );
        const insert = db.prepare(
          `INSERT INTO thread_order (thread_id, position, workspace_id)
           VALUES (?, ?, ?)
           ON CONFLICT(workspace_id, thread_id) DO UPDATE SET
             position = excluded.position`,
        );
        orderedIds.forEach((threadId, position) => {
          insert.run(threadId, position, resolvedWorkspaceId);
        });
      });
      replaceOrder(threadIds);
      publishThreadOrder();
      return { ok: true } as const;
    },
    async listProjectOrder(input) {
      const { workspaces } = await canonicalWorkspaces();
      const group = input?.workspaceId
        ? workspaces.find((candidate) => candidate.id === input.workspaceId)
        : workspaces.find((candidate) => candidate.isDefault) ?? workspaces[0];
      return { projectIds: group?.projectIds ?? [] };
    },
    async setProjectOrder({ projectIds, workspaceId }) {
      const resolvedWorkspaceId = workspaceId ?? await defaultProjectGroupId();
      if (integrations.projectsIntegration) {
        await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "setProjectOrder", input: { groupId: resolvedWorkspaceId, projectIds }, outputSchema: okSchema });
      } else {
        if (!legacyWorkspaces().some((group) => group.id === resolvedWorkspaceId)) throw new Error("Section not found");
        db.transaction(() => {
          db.prepare("DELETE FROM project_order WHERE workspace_id = ?").run(resolvedWorkspaceId);
          const insert = db.prepare("INSERT INTO project_order (project_id, position, workspace_id) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET position = excluded.position, workspace_id = excluded.workspace_id");
          projectIds.forEach((id, position) => insert.run(id, position, resolvedWorkspaceId));
        })();
      }
      publishWorkspaces();
      return { ok: true } as const;
    },
    listWorkspaces: () => canonicalWorkspaces(),
    async createWorkspace({ name }) {
      const { workspaces } = await canonicalWorkspaces();
      const color = workspaceColorValues[workspaces.length % workspaceColorValues.length]!;
      let workspaceId: string;
      if (integrations.projectsIntegration) {
        const group = await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "saveGroup", input: { name, color }, outputSchema: projectGroupSchema });
        workspaceId = group.id;
      } else {
        workspaceId = randomUUID();
        const position = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM workspaces").get() as { position: number };
        db.prepare("INSERT INTO workspaces (id, name, color, position) VALUES (?, ?, ?, ?)").run(workspaceId, name, color, position.position);
      }
      publishWorkspaces();
      return { workspaceId };
    },
    async renameWorkspace({ workspaceId, name }) {
      const { workspaces } = await canonicalWorkspaces();
      const group = workspaces.find((candidate) => candidate.id === workspaceId);
      if (!group) throw new Error("Section not found");
      if (integrations.projectsIntegration) {
        await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "saveGroup", input: { id: group.id, name, color: group.color }, outputSchema: projectGroupSchema });
      } else {
        db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, workspaceId);
      }
      publishWorkspaces();
      return { ok: true } as const;
    },
    async deleteWorkspace({ workspaceId }) {
      const { workspaces } = await canonicalWorkspaces();
      const group = workspaces.find((candidate) => candidate.id === workspaceId);
      if (!group || group.isDefault) throw new Error("Cannot delete this section");
      if (integrations.projectsIntegration) {
        await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "deleteGroup", input: { id: workspaceId }, outputSchema: okSchema });
      } else {
        const defaultId = workspaces.find((candidate) => candidate.isDefault)!.id;
        db.transaction(() => {
          db.prepare("UPDATE workspace_projects SET workspace_id = ? WHERE workspace_id = ?").run(defaultId, workspaceId);
          db.prepare("DELETE FROM project_order WHERE workspace_id = ?").run(workspaceId);
          db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
        })();
      }
      db.transaction(() => {
        db.prepare("DELETE FROM workspace_threads WHERE workspace_id = ?").run(workspaceId);
        db.prepare("DELETE FROM thread_order WHERE workspace_id = ?").run(workspaceId);
      })();
      publishWorkspaces();
      publishThreadOrder();
      return { ok: true } as const;
    },
    async setWorkspaceOrder({ workspaceIds }) {
      const { workspaces } = await canonicalWorkspaces();
      if (workspaceIds.length !== workspaces.length || workspaceIds.some((id) => !workspaces.some((group) => group.id === id))) throw new Error("Section order must include every section");
      if (integrations.projectsIntegration) {
        await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "setGroupOrder", input: { groupIds: workspaceIds }, outputSchema: okSchema });
      } else {
        db.transaction(() => {
          const update = db.prepare("UPDATE workspaces SET position = ? WHERE id = ?");
          workspaceIds.forEach((id, position) => update.run(position, id));
        })();
      }
      publishWorkspaces();
      return { ok: true } as const;
    },
    legacyWorkspaceSnapshot: () => ({ workspaces: legacyWorkspaces() }),
    remapLegacyProjectGroups: ({ mappings }) => {
      requireIntegration("projectsIntegration", "Projects");
      db.transaction(() => {
        for (const { legacyId, groupId } of mappings) {
          db.prepare("UPDATE thread_order SET workspace_id = ? WHERE workspace_id = ?").run(groupId, legacyId);
          db.prepare("UPDATE project_order SET workspace_id = ? WHERE workspace_id = ?").run(groupId, legacyId);
          db.prepare("UPDATE workspace_threads SET workspace_id = ? WHERE workspace_id = ?").run(groupId, legacyId);
          db.prepare("UPDATE workspace_projects SET workspace_id = ? WHERE workspace_id = ?").run(groupId, legacyId);
        }
      })();
      publishWorkspaces();
      publishThreadOrder();
      return { ok: true as const };
    },
    async setProjectWorkspace({ projectId, workspaceId }) {
      if (integrations.projectsIntegration) {
        await bb.sdk.plugins.callRpc({ pluginId: "projects", method: "setProjectGroup", input: { projectId, groupId: workspaceId }, outputSchema: okSchema });
      } else {
        if (!legacyWorkspaces().some((group) => group.id === workspaceId)) throw new Error("Section not found");
        db.transaction(() => {
          db.prepare("INSERT INTO workspace_projects (project_id, workspace_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET workspace_id = excluded.workspace_id").run(projectId, workspaceId);
          db.prepare("DELETE FROM project_order WHERE project_id = ?").run(projectId);
        })();
      }
      publishWorkspaces();
      return { ok: true } as const;
    },
    refreshProjectGroups() {
      publishWorkspaces();
      return { ok: true } as const;
    },
    async setThreadWorkspace({ threadId, workspaceId }) {
      const { workspaces } = await canonicalWorkspaces();
      if (!workspaces.some((group) => group.id === workspaceId)) throw new Error("Section not found");
      db.prepare(
        `INSERT INTO workspace_threads (thread_id, workspace_id)
         VALUES (?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET workspace_id = excluded.workspace_id`,
      ).run(threadId, workspaceId);
      publishWorkspaces();
      return { ok: true } as const;
    },
    clearThreadWorkspace({ threadId }) {
      db.prepare(`DELETE FROM workspace_threads WHERE thread_id = ?`).run(threadId);
      publishWorkspaces();
      return { ok: true } as const;
    },
    listAttachableTasks: ({ threadId, query }) => listAttachableTasks(threadId, query),
    attachThreadToTask: ({ taskId, threadId }) => attachThreadToTask(taskId, threadId),
    listSandboxStatuses: ({ threads }) => listSandboxStatuses(threads),
    listChannels,
    channelsChanged(input) {
      if (!integrations.agentsIntegration) return { ok: true } as const;
      if (input) acceptChannels(input.channels);
      // Answer Agents right away; it does not wait on the refetch.
      else void refreshChannels();
      return { ok: true } as const;
    },
    listAgents,
    agentsChanged({ snapshot }) {
      if (!integrations.agentsIntegration) return { ok: true } as const;
      agentsCache.set("agents", Promise.resolve(snapshot));
      bb.realtime.publish(AGENTS_CHANGED_CHANNEL, snapshot);
      return { ok: true } as const;
    },
    openAgent: ({ profileId }) => {
      requireIntegration("agentsIntegration", "Agents");
      return bb.sdk.plugins.callRpc({
        pluginId: "agent-profiles", method: "ensureAgentDm", input: { profileId },
        outputSchema: z.object({ threadId: z.string().min(1) }).strict(),
      });
    },
    listShortcutSlots() {
      return { slots: shortcutSlots };
    },
    publishShortcutSlots({ slots, publisherId, focusEpoch, sequence }) {
      if (shortcutPublisher) {
        if (focusEpoch < shortcutPublisher.focusEpoch) {
          return { ok: true } as const;
        }
        if (
          focusEpoch === shortcutPublisher.focusEpoch &&
          (publisherId !== shortcutPublisher.publisherId ||
            sequence <= shortcutPublisher.sequence)
        ) {
          return { ok: true } as const;
        }
      }
      shortcutPublisher = { publisherId, focusEpoch, sequence };
      const next = slots.map((slot) => ({ ...slot }));
      if (JSON.stringify(next) !== JSON.stringify(shortcutSlots)) {
        shortcutSlots = next;
        bb.realtime.publish(SHORTCUT_SLOTS_CHANNEL, null);
      }
      return { ok: true } as const;
    },
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    db.prepare(`DELETE FROM later_threads WHERE thread_id = ?`).run(thread.id);
    db.prepare(`DELETE FROM thread_order WHERE thread_id = ?`).run(thread.id);
    db.prepare(`DELETE FROM workspace_threads WHERE thread_id = ?`).run(
      thread.id,
    );
    publish(thread.id);
    publishThreadOrder();
    publishWorkspaces();
  });
}

