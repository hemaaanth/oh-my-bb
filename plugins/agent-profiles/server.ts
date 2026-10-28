import { loadAgentPreferences } from "./server/preferences";
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerAgentTools } from "./server/agent-tools";
import { registerCli } from "./server/cli";
import { registerChannelTools } from "./server/channels/agent-channels";
import { ChannelAutomations } from "./server/channels/channel-automations";
import { Store } from "./server/channels/store";
import { registerChannelEvents, registerChannelHooks } from "./server/channels/hooks";
import {
  channelSummaries,
  createChannelRpc,
  registerAttachmentRoute,
} from "./server/channels/rpc";
import { okSchema, phase2ResponseBehaviorSchema } from "./server/contract";
import { createJev, type Jev } from "./server/channels/jev";
import { errorText, Runtime } from "./server/channels/runtime";
import { sweepOrphanedProfileResources } from "./server/cleanup";
import { registerEmojiDataRoute } from "./server/emoji-data";
import { createAgentDms } from "./server/dms";
import { migrateAgentHistory } from "./server/dm-migration";
import { createExecutionResolver } from "./server/execution-resolver";
import { createAgentProviders } from "./server/providers";
import { createAgentInbox } from "./server/inbox";
import {
  agentsSidebarSnapshot,
  createProfiles,
  registerProfileConfiguration,
  registerProfileEvents,
  registerProfileMentionProvider,
  registerProfileRpc,
} from "./server/profiles";
import { assertNoAssignmentOwner, assignmentMigration } from "./server/assignment-store";

const CHANNELS_NUDGE_DELAY_MS = 500;

function createChannelSummaryNudge(bb: BbPluginApi, store: Store, sidebarChanged: () => void) {
  // Order and every field but updatedAt: a newer message alone changes no row.
  const summaryFingerprint = () =>
    JSON.stringify(channelSummaries(store).map(({ updatedAt: _, ...row }) => row));
  let fingerprint = summaryFingerprint();
  let timer: NodeJS.Timeout | undefined;
  let loggedUnavailable = false;

  const changed = () => {
    sidebarChanged();
    const nextFingerprint = summaryFingerprint();
    if (nextFingerprint === fingerprint) return;
    fingerprint = nextFingerprint;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void bb.sdk.plugins.callRpc({
        pluginId: "status-sidebar",
        method: "channelsChanged",
        // Send the rows so status-sidebar need not call back for them.
        input: { channels: channelSummaries(store) },
        outputSchema: okSchema,
      }).catch(() => {
        if (loggedUnavailable) return;
        loggedUnavailable = true;
        bb.log.debug("status-sidebar is unavailable; channel sidebar refresh was skipped");
      });
    }, CHANNELS_NUDGE_DELAY_MS);
  };

  return {
    changed,
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function configureReturnDecision(
  bb: BbPluginApi,
  channels: Store,
  runtime: Runtime,
  decide: Jev["shouldReturn"],
) {
  runtime.returnDecision = async (group, signal) => {
    const startedAt = Date.now();
    const channelName = channels.findRoom(group.roomId)?.name ?? group.roomId;
    try {
      try {
        const result = await decide(
          runtime.delegations.returnDecisionData(group),
          signal,
        );
        bb.log.info(
          `Jev ${result.shouldReturn ? "requested" : "skipped"} a delegation follow-up in #${channelName} (${Math.round(result.probability * 100)}%, confidence ${Math.round(result.confidence * 100)}%)`,
        );
        return result.shouldReturn;
      } catch (cause) {
        bb.log.warn(
          `Jev return decision failed for #${channelName}; returning by default: ${errorText(cause)}`,
        );
        return true;
      }
    } finally {
      channels.db
        .prepare(
          "INSERT INTO routing_usage(room_id, created_at, duration_ms, purpose) VALUES (?, ?, ?, 'return')",
        )
        .run(group.roomId, startedAt, Date.now() - startedAt);
    }
  };
}


export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.pragma("foreign_keys = OFF");
  bb.storage.migrate(db, [
    `CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      service_tier TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      mcp_server_ids TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE profile_revisions (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, revision)
    );
    CREATE TABLE thread_bindings (
      thread_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      parent_thread_id TEXT,
      environment_id TEXT,
      created_at TEXT NOT NULL
    );`,
    `ALTER TABLE profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT '🤖'`,
    `ALTER TABLE profiles ADD COLUMN home_host_id TEXT`,
    `ALTER TABLE profiles ADD COLUMN home_ready INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE document_revisions (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX revisions_by_scope ON document_revisions(scope, id)`,
    `ALTER TABLE profiles ADD COLUMN retired INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE profiles ADD COLUMN limits TEXT`,
    `ALTER TABLE profiles ADD COLUMN last_wake_at INTEGER`,
    `ALTER TABLE profiles ADD COLUMN runtime_error TEXT`,
    `CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      key TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      json TEXT NOT NULL,
      UNIQUE(agent_id, key)
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX jobs_by_agent ON jobs(agent_id, status, created_at);
    CREATE INDEX jobs_by_agent_started ON jobs(
      agent_id,
      COALESCE(json_extract(json, '$.startedAt'), json_extract(json, '$.dispatchStartedAt'))
    );
    CREATE INDEX jobs_by_room_started ON jobs(
      json_extract(json, '$.roomId'),
      COALESCE(json_extract(json, '$.startedAt'), json_extract(json, '$.dispatchStartedAt'))
    );
    CREATE INDEX jobs_by_room ON jobs(json_extract(json, '$.roomId'), created_at);
    CREATE INDEX jobs_by_run ON jobs(json_extract(json, '$.runId'), created_at);
    CREATE INDEX unfinished_jobs_by_room ON jobs(json_extract(json, '$.roomId'))
      WHERE status IN ('queued', 'dispatching', 'running')
        OR json_extract(json, '$.cancellationPending') = 1;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE room_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX messages_by_room ON room_messages(room_id);
    CREATE INDEX messages_by_source_job ON room_messages(
      room_id,
      json_extract(json, '$.sourceJobId')
    );
    CREATE INDEX messages_by_source ON room_messages(
      json_extract(json, '$.sourceThreadId')
    );
    CREATE TABLE room_runs (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX runs_by_room ON room_runs(room_id);
    CREATE INDEX active_runs_by_room ON room_runs(
      room_id,
      json_extract(json, '$.status')
    );
    CREATE INDEX unfinished_runs_by_room ON room_runs(room_id)
      WHERE json_extract(json, '$.status') IN ('queued', 'running');
    CREATE TABLE reactions (
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(message_id, emoji, actor_id)
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE INDEX attachments_by_room ON attachments(
      json_extract(json, '$.roomId')
    );
    CREATE TABLE draft_uploads (
      id TEXT PRIMARY KEY,
      bytes BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE channel_context (
      room_id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE channel_notifications (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER
    );
    CREATE INDEX pending_channel_notifications ON channel_notifications(
      dispatched_at,
      created_at
    );
    CREATE TABLE routing_usage (
      id INTEGER PRIMARY KEY,
      room_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );
    CREATE INDEX routing_usage_by_room ON routing_usage(room_id, created_at);
    CREATE TABLE delegations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX delegations_by_room ON delegations(room_id, status);
    CREATE INDEX delegations_by_run ON delegations(run_id, status)`,
    `UPDATE rooms
      SET json = json_set(json, '$.responseBehavior', 'smart')
      WHERE json_extract(json, '$.responseBehavior') = 'everyone'`,
    `CREATE TABLE thread_members (
      parent_thread_id TEXT NOT NULL,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      removed_at TEXT,
      PRIMARY KEY (parent_thread_id, profile_id)
    )`,
    `ALTER TABLE routing_usage ADD COLUMN purpose TEXT NOT NULL DEFAULT 'route'`,
    `ALTER TABLE profiles ADD COLUMN interval_minutes INTEGER`,
    `ALTER TABLE profiles ADD COLUMN model_mode TEXT NOT NULL DEFAULT 'level'
      CHECK (model_mode IN ('level', 'pinned'))`,
    `ALTER TABLE profiles ADD COLUMN level TEXT NOT NULL DEFAULT 'medium'
      CHECK (level IN ('xhigh', 'high', 'medium', 'low', 'xlow'))`,
    `UPDATE profiles SET
      model_mode = CASE
        WHEN lower(model) LIKE '%-astra%' OR lower(model) LIKE '%-fable-%'
          OR lower(model) LIKE '%-sol%' OR lower(model) LIKE '%-opus-%'
          OR lower(model) LIKE '%-terra%' OR lower(model) LIKE '%-sonnet-%'
          OR lower(model) LIKE '%-luna%' OR lower(model) LIKE '%-haiku-%'
        THEN 'level' ELSE 'pinned' END,
      level = CASE
        WHEN lower(model) LIKE '%-astra%' OR lower(model) LIKE '%-fable-%' THEN 'xhigh'
        WHEN lower(model) LIKE '%-sol%' OR lower(model) LIKE '%-opus-%' THEN
          CASE WHEN reasoning_level IN ('high', 'xhigh', 'ultracode', 'max', 'ultra')
            THEN 'high' ELSE 'medium' END
        WHEN lower(model) LIKE '%-terra%' OR lower(model) LIKE '%-sonnet-%' THEN 'low'
        WHEN lower(model) LIKE '%-luna%' OR lower(model) LIKE '%-haiku-%' THEN 'xlow'
        ELSE 'medium' END;
    UPDATE profile_revisions SET snapshot = json_set(
      snapshot,
      '$.modelMode',
      CASE
        WHEN lower(json_extract(snapshot, '$.model')) LIKE '%-astra%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-fable-%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-sol%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-opus-%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-terra%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-sonnet-%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-luna%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-haiku-%'
        THEN 'level' ELSE 'pinned' END,
      '$.level',
      CASE
        WHEN lower(json_extract(snapshot, '$.model')) LIKE '%-astra%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-fable-%' THEN 'xhigh'
        WHEN lower(json_extract(snapshot, '$.model')) LIKE '%-sol%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-opus-%' THEN
          CASE WHEN json_extract(snapshot, '$.reasoningLevel') IN
            ('high', 'xhigh', 'ultracode', 'max', 'ultra')
            THEN 'high' ELSE 'medium' END
        WHEN lower(json_extract(snapshot, '$.model')) LIKE '%-terra%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-sonnet-%' THEN 'low'
        WHEN lower(json_extract(snapshot, '$.model')) LIKE '%-luna%'
          OR lower(json_extract(snapshot, '$.model')) LIKE '%-haiku-%' THEN 'xlow'
        ELSE 'medium' END
    ) WHERE json_extract(snapshot, '$.modelMode') IS NULL`,
    `ALTER TABLE profiles ADD COLUMN kind TEXT NOT NULL DEFAULT 'full'
      CHECK (kind IN ('full', 'thin'));
    UPDATE profiles SET kind = 'thin', interval_minutes = NULL
      WHERE lower(slug) = 'text-edit-agent';
    UPDATE profile_revisions SET snapshot = json_set(
      snapshot,
      '$.kind',
      CASE WHEN lower(json_extract(snapshot, '$.slug')) = 'text-edit-agent'
        THEN 'thin' ELSE 'full' END
    ) WHERE json_extract(snapshot, '$.kind') IS NULL`,
    `ALTER TABLE profiles ADD COLUMN run_project_id TEXT NULL`,
    // The copy-edit built-in was renamed from @text-edit-agent to @pinpoint-copy.
    `UPDATE profiles SET kind = 'thin', interval_minutes = NULL
      WHERE lower(slug) = 'pinpoint-copy'`,
    `ALTER TABLE profiles ADD COLUMN run_in_checkout INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE profiles ADD COLUMN pi_harness INTEGER NOT NULL DEFAULT 0;
     UPDATE profiles SET pi_harness = 1 WHERE lower(slug) = 'deckmaster'`,
    `ALTER TABLE profiles ADD COLUMN memory_key TEXT;
     UPDATE profiles SET memory_key = 'agent-' || slug;
     CREATE UNIQUE INDEX profiles_memory_key_unique ON profiles(memory_key)`,
    `CREATE TABLE agent_dms (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE RESTRICT,
      thread_id TEXT UNIQUE,
      creation_token TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'missing')),
      project_id TEXT,
      environment_id TEXT,
      spawn_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE dm_migration (
      thread_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
      provider_id TEXT NOT NULL,
      model TEXT,
      predecessor INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'history',
      new_dm_id TEXT,
      recorded_at TEXT NOT NULL
    )`,
    `CREATE TABLE channel_thread_ids (thread_id TEXT PRIMARY KEY);
     INSERT OR IGNORE INTO channel_thread_ids SELECT thread_id FROM conversations;
     INSERT OR IGNORE INTO channel_thread_ids
       SELECT json_extract(json, '$.threadId') FROM jobs
       WHERE json_extract(json, '$.threadId') IS NOT NULL;
     CREATE TRIGGER remember_channel_thread AFTER INSERT ON conversations BEGIN
       INSERT OR IGNORE INTO channel_thread_ids(thread_id) VALUES (NEW.thread_id);
     END`,
    `ALTER TABLE profiles ADD COLUMN show_in_sidebar INTEGER NOT NULL DEFAULT 1;
     UPDATE profiles SET show_in_sidebar = 0
       WHERE lower(slug) IN ('pinpoint-fix', 'pinpoint-copy', 'deckmaster', 'prospector')`,
    `ALTER TABLE thread_bindings ADD COLUMN task TEXT;
     CREATE TABLE agent_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('task', 'channel')),
      thread_id TEXT NOT NULL,
      place TEXT NOT NULL,
      request TEXT NOT NULL,
      reply TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX agent_inbox_unread ON agent_inbox(profile_id, delivered_at, id);
    CREATE INDEX agent_inbox_thread ON agent_inbox(thread_id, id)`,
    `ALTER TABLE profiles ADD COLUMN run_host_id TEXT NULL`,
    assignmentMigration,
  ]);
  db.pragma("foreign_keys = ON");
  assertNoAssignmentOwner(db);
  const requiresHistoryMigration = Boolean(db.prepare("SELECT 1 FROM profiles LIMIT 1").get())
    && await bb.storage.kv.get("agent-history-cutover:v1") !== true;

  const settings = await loadAgentPreferences(bb);
  const executionResolver = createExecutionResolver(bb);

  const channels = await Store.create(bb, db);
  const inbox = createAgentInbox(db);
  const agentProviders = await createAgentProviders(bb, db, channels, inbox);
  let sidebarChanged = () => {};
  const profiles = await createProfiles(bb, db, channels, executionResolver, (all) => {
    agentProviders.reconcile(all);
    sidebarChanged();
  });
  agentProviders.reconcile(profiles.listProfiles());
  const dms = createAgentDms(bb, db, profiles, channels);
  // Restoring pins each DM's agent model, and bb validates that against the agents
  // provider. The provider joins bb's registry only after this factory returns, so
  // awaiting here stalls the load until it times out. Services start after that.
  bb.background.service("dm-restore", { start: (signal) => dms.restoreArchived(signal) });
  
  const channelSummaryNudge = createChannelSummaryNudge(bb, channels, () => sidebarChanged());
  let sidebarTimer: NodeJS.Timeout | undefined;
  // Empty, so the first check always pushes: a migration or edit made while Agents was down changes
  // the list without any later event, and status-sidebar would keep the old rows.
  let sidebarFingerprint = "";
  sidebarChanged = () => {
    if (sidebarTimer) return;
    sidebarTimer = setTimeout(() => {
      sidebarTimer = undefined;
      const snapshot = agentsSidebarSnapshot(db, profiles.listProfiles());
      const next = JSON.stringify(snapshot);
      if (next === sidebarFingerprint) return;
      sidebarFingerprint = next;
      void bb.sdk.plugins.callRpc({
        pluginId: "status-sidebar", method: "agentsChanged", input: { snapshot },
        outputSchema: okSchema,
      }).catch(() => bb.log.debug("status-sidebar is unavailable; agent sidebar refresh was skipped"));
    }, CHANNELS_NUDGE_DELAY_MS);
  };
  sidebarChanged();
  // Host calls are unavailable during factory registration, so the memory check runs from a timer.
  let migrationTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  const migrateHistory = () => {
    if (disposed) return;
    migrationTimer = setTimeout(() => {
      void migrateAgentHistory(bb, db, profiles.listProfiles())
        .then(() => bb.storage.kv.set("agent-history-cutover:v1", true))
        .then(() => {
          bb.log.info("agent history migration complete");
          sidebarChanged();
        })
        .catch((error) => {
          bb.log.warn(`agent history migration will retry: ${error instanceof Error ? error.message : String(error)}`);
          migrateHistory();
        });
    }, migrationTimer === undefined ? 0 : 60_000);
  };
  if (requiresHistoryMigration) migrateHistory();
  const runtime = new Runtime(
    bb,
    channels,
    profiles,
    { delegationReturns: true },
    channelSummaryNudge.changed,
  );
  const orphanCleanup = await sweepOrphanedProfileResources({
    bb,
    db,
    channels,
    runtime,
    homesRoot: profiles.homes.root,
  });
  bb.log.info(`agent orphan sweep: ${JSON.stringify(orphanCleanup)}`);
  const expiredDelegations = runtime.delegations.expireStale(Date.now());
  if (expiredDelegations)
    bb.log.warn(
      `Marked ${expiredDelegations} stale delegation${expiredDelegations === 1 ? "" : "s"} as timed out without posting follow-ups`,
    );
  const jev = createJev(bb, async () => (await settings.get()).jevApiKey);
  runtime.chooseAgent = jev.chooseAgent;
  runtime.reportWork = ({ job, conversation, request, reply }) => {
    const profile = profiles.listProfiles().find((candidate) => candidate.id === job.agentId);
    if (profile?.kind !== "full" || db.prepare("SELECT 1 FROM agent_dms WHERE thread_id = ?").get(conversation.threadId)) return;
    const room = job.roomId ? channels.findRoom(job.roomId) : null;
    inbox.record({
      profileId: profile.id, threadId: conversation.threadId, request, reply,
      ...(room ? { source: "channel", place: room.name } : { source: "task", place: conversation.title }),
    });
  };
  configureReturnDecision(bb, channels, runtime, jev.shouldReturn);
  
  const channelRpc = createChannelRpc(bb, channels, runtime, profiles, {
    async defaultResponseBehavior() {
      const stored = (await settings.get()).defaultResponseBehavior;
      return phase2ResponseBehaviorSchema.parse(
        stored,
      );
    },
    async rememberDefaultResponseBehavior(value) {
      await settings.setResponseBehavior(value);
    },
  });
  const automations = new ChannelAutomations(bb, channels, runtime);
  const automationHandlers = {
    automationList: (input: Parameters<ChannelAutomations["list"]>[0]) =>
      automations.list(input),
    automationCreate: (input: Parameters<ChannelAutomations["create"]>[0]) =>
      automations.create(input),
    automationUpdate: (input: Parameters<ChannelAutomations["update"]>[0]) =>
      automations.update(input),
    automationDelete: (input: Parameters<ChannelAutomations["delete"]>[0]) =>
      automations.delete(input),
    automationPause: (input: Parameters<ChannelAutomations["pause"]>[0]) =>
      automations.pause(input),
    automationResume: (input: Parameters<ChannelAutomations["resume"]>[0]) =>
      automations.resume(input),
    automationRun: (input: Parameters<ChannelAutomations["run"]>[0]) =>
      automations.run(input),
    automationRuns: (input: Parameters<ChannelAutomations["runs"]>[0]) =>
      automations.runs(input),
  };
  registerProfileRpc(
    bb,
    profiles,
    channels,
    runtime,
    channelRpc.handlers,
    automationHandlers,
    agentProviders,
    dms,
    () => sidebarChanged(),
  );
  registerAgentTools(bb, profiles);
  automations.registerTools();
  const channelTools = registerChannelTools(
    bb,
    channels,
    runtime,
    profiles,
    channelRpc.handlers,
    channelRpc.sendMessage,
  );
  registerAttachmentRoute(bb, channels);
  registerEmojiDataRoute(bb);
  registerProfileConfiguration(bb, profiles);
  registerProfileEvents(bb, profiles);
  registerChannelHooks(bb, channels, runtime, profiles, dms);
  registerChannelEvents(bb, channels, runtime, profiles, dms, inbox);
  registerProfileMentionProvider(bb, profiles);
  registerCli(
    bb,
    profiles,
    channels,
    runtime,
    channelRpc.handlers,
    channelRpc.sendMessage,
    channelTools.publishImage,
    channelTools.publishFile,
    automations,
  );

  bb.background.service("channels", {
    async start(signal) {
      await channels.ensureProject();
      let cleanupAt = 0;
      while (!signal.aborted) {
        if (Date.now() >= cleanupAt) {
          cleanupAt = Date.now() + 60 * 60 * 1_000;
          for (const attachment of channels.expiredAttachments(
            Date.now() - 7 * 24 * 60 * 60 * 1_000,
          ))
            await runtime.locked(`room:${attachment.roomId}`, async () =>
              channels.discardAttachment(attachment.id),
            );
        }
        await runtime.tick();
        try {
          await delay(1_500, undefined, { signal });
        } catch {
          break;
        }
      }
    },
  });
  bb.onDispose(() => {
    channelSummaryNudge.dispose();
    clearTimeout(sidebarTimer);
    disposed = true;
    clearTimeout(migrationTimer);
    agentProviders.dispose();
    runtime.dispose();
  });

  bb.log.info("loaded");
}
