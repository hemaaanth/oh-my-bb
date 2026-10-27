import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Profiles } from "../profiles";
import { PLACEHOLDER_DELAY_MS, type AgentDms } from "../dms";
import { AGENTS_PROVIDER_ID, agentModelId } from "../provider-ids";
import type { AgentInbox } from "../inbox";
import { jobPrompt, timelineRows, type Runtime } from "./runtime";
import type { Store } from "./store";

export function registerChannelHooks(
  bb: BbPluginApi,
  store: Store,
  runtime: Runtime,
  profiles: Profiles,
  dms: AgentDms,
) {
  bb.experimental_hooks.on("message.dispatch", async (context) => {
    const dm = store.db.prepare("SELECT profile_id AS profileId FROM agent_dms WHERE thread_id = ?")
      .get(context.thread.id) as { profileId: string } | undefined;
    if (dm && (context.requestedExecution.providerId !== AGENTS_PROVIDER_ID
      || context.requestedExecution.model !== agentModelId(dm.profileId)))
      return { action: "reject", message: "This DM is locked to its agent. Open this agent's DM." };
    if (context.thread.providerId === AGENTS_PROVIDER_ID) {
      const bound = store.db.prepare("SELECT profile_id AS profileId FROM thread_bindings WHERE thread_id = ?")
        .get(context.thread.id) as { profileId: string } | undefined;
      const conversation = store.byThread(context.thread.id);
      let id = dm?.profileId ?? bound?.profileId ?? conversation?.agentId;
      if (!id && context.thread.originPluginId === bb.pluginId) {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: context.thread.id, pluginId: bb.pluginId });
        // The DM allocator spawns with a held placeholder and deletes it once bound; keep holding it until then.
        if (metadata.role === "dm" && store.db.prepare(`SELECT 1 FROM agent_dms
          WHERE profile_id = ? AND creation_token = ? AND thread_id IS NULL`).get(metadata.profileId, metadata.creationToken))
          return { action: "wait", reason: "Opening agent DM.", sendAt: Date.now() + PLACEHOLDER_DELAY_MS };
        // A spawned task or channel conversation dispatches its first turn before spawn returns
        // and its binding or conversation row is written.
        if ((metadata.role === "task" || metadata.role === "channel") && typeof metadata.profileId === "string") id = metadata.profileId;
      }
      if (!id || context.requestedExecution.providerId !== AGENTS_PROVIDER_ID
        || context.requestedExecution.model !== agentModelId(id))
        return { action: "reject", message: "Open this agent's DM: this thread has no matching agent identity." };
    }

    const binding = store.db
      .prepare("SELECT 1 FROM thread_bindings WHERE thread_id = ?")
      .get(context.thread.id);
    if (binding) return { action: "proceed" };

    const conversation = store.byThread(context.thread.id);
    if (!conversation)
      return context.thread.originPluginId === bb.pluginId
        ? {
            action: "wait",
            reason: "Registering agent conversation.",
            sendAt: Date.now() + 1_500,
          }
        : { action: "proceed" };

    const agent = store.get(conversation.agentId);
    if (agent.retired)
      return {
        action: "reject",
        message: "This agent is retired. Restore it in Agents settings.",
      };
    if (agent.paused && conversation.kind !== "group")
      return {
        action: "wait",
        reason: "This agent is paused. Resume it in Agents settings.",
      };

    const job =
      conversation.kind === "admin"
        ? undefined
        : store
            .work(agent.id)
            .find(
              (candidate) =>
                candidate.threadId === context.thread.id &&
                ["dispatching", "running"].includes(candidate.status),
            );
    if (conversation.kind !== "admin") {
      // The first turn also carries the agent-only spawn preamble, so match
      // the job prompt against each text block rather than the joined text.
      const expected = job
        ? [jobPrompt(job), job.pendingSteer?.priorPrompt]
        : [];
      if (
        !job ||
        !context.input.blocks.some(
          (block) => block.type === "text" && expected.includes(block.text),
        )
      )
        return {
          action: "reject",
          message:
            "Send a message from the channel or this agent's canonical chat.",
        };

      if (conversation.kind === "group") {
        const room = job.roomId ? store.findRoom(job.roomId) : null;
        if (!room || room.archived)
          return { action: "reject", message: "This channel is archived." };
        if (!room.memberIds.includes(agent.id))
          return {
            action: "reject",
            message: "This agent is no longer a member of this channel.",
          };
      }
    }

    if (!job?.forkSourceThreadId) {
      const busy = runtime.busyDetails(agent.id);
      if (busy && busy.threadId !== context.thread.id)
        return {
          action: "wait",
          reason: busy.reason,
          sendAt: Date.now() + 3_000,
        };
      runtime.busy.set(agent.id, {
        threadId: context.thread.id,
        at: Date.now(),
      });
    }
    return { action: "proceed" };
  });
}

export function registerChannelEvents(
  bb: BbPluginApi,
  store: Store,
  runtime: Runtime,
  profiles: Profiles,
  dms: AgentDms,
  inbox: AgentInbox,
) {
  const isDm = (threadId: string) =>
    Boolean(store.db.prepare("SELECT 1 FROM agent_dms WHERE thread_id = ?").get(threadId));
  const task = store.db.prepare(`SELECT profile_id AS profileId, task FROM thread_bindings
    WHERE thread_id = ? AND task IS NOT NULL`);
  /** A full agent's delegated or sequence task finished a turn. Its DM should remember it. */
  async function reportTask(thread: { id: string; title?: string | null }, reply: string | null) {
    const binding = task.get(thread.id) as { profileId: string; task: string } | undefined;
    if (!binding || !reply?.trim() || isDm(thread.id)) return;
    const profile = profiles.listProfiles().find((candidate) => candidate.id === binding.profileId);
    if (profile?.kind !== "full") return;
    let request = binding.task;
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId: thread.id, includeNestedRows: "true", segmentLimit: "100" });
      const latest = timelineRows(timeline?.rows)
        .filter((row) => row.kind === "conversation" && row.role === "user" && typeof row.text === "string")
        .at(-1)?.text as string | undefined;
      // The first turn's row starts with the spawn preamble; a follow-up is its own request.
      if (latest?.trim() && !latest.trim().endsWith(binding.task.trim())) request = latest;
    } catch (cause) {
      bb.log.debug(`Task report fell back to the spawn prompt: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    inbox.record({ profileId: profile.id, source: "task", threadId: thread.id,
      place: thread.title?.replace(/^@[\w-]+ · /u, "") || profile.name, request, reply });
  }

  bb.events.on("thread.active", ({ thread }) => {
    const conversation = store.byThread(thread.id);
    if (!conversation) return;
    const job = store
      .work(conversation.agentId)
      .find(
        (candidate) =>
          candidate.threadId === thread.id &&
          ["dispatching", "running"].includes(candidate.status),
      );
    if (!job?.forkSourceThreadId)
      runtime.busy.set(conversation.agentId, {
        threadId: thread.id,
        at: Date.now(),
      });
    if (job && !job.startedAt) {
      job.startedAt = Date.now();
      store.putJob(job);
      runtime.changed();
    }
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    inbox.settle(thread.id);
    await reportTask(thread, lastAssistantText);
    const conversation = store.byThread(thread.id);
    if (!conversation) return;
    await runtime.settleFromEvent(thread.id, lastAssistantText);
    await bb.experimental_hooks.recheck("message.dispatch");
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    inbox.release(thread.id);
    if (!store.byThread(thread.id)) return;
    await runtime.settleFromEvent(
      thread.id,
      null,
      error ?? "Agent turn failed.",
    );
    await bb.experimental_hooks.recheck("message.dispatch");
  });

  bb.events.on("thread.archived", ({ thread }) => dms.archived(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => {
    dms.deleted(thread.id);
    store.deleteConversation(thread.id);
  });
  bb.events.on("interaction.pending", () => runtime.changed());
}
