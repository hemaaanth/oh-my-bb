import { Delegations, type Delegation } from "./delegations";
import { ChannelData } from "./channel-data";
import { defaultLimits } from "./workspace-contract";
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Profiles } from "../profiles";
import { spawnPreamble } from "../instructions";
import type { Profile } from "../contract";
import { AGENTS_PROVIDER_ID } from "../provider-ids";
import type {
  Attachment,
  ChannelAgent,
  Conversation,
  Job,
  Room,
  RoomMessage,
  RoomRun,
} from "./contract";
import { isAutomationTrigger } from "./contract";
import { Store } from "./store";
import { activitySnippetFromTimeline } from "./activity";
import { isExecuting } from "./job-state";
import type { AgentChoice, AgentChoiceInput } from "./jev";
type SendMode = "auto" | "steer" | "followup" | "fork";
type DispatchAction = Exclude<SendMode, "auto">;
type RoutingTask = {
  agentId: string;
  threadId: string | null;
  busy: boolean;
  task: string;
  jobId?: string | null;
};



const isForkConversation = (key: string) => key.includes(":fork:");
export type RuntimeFeatures = {
  delegationReturns: boolean;
};

const DEFAULT_RUNTIME_FEATURES: RuntimeFeatures = {
  delegationReturns: false,
};
const chatGuidance =
  "Write like a teammate in a chatroom. Keep replies brief and direct. If the point is already covered or you have nothing useful to add, reply with only [PASS] and nothing else. Never add [PASS] to a real answer. Your final answer is shared with the channel.";
// Models sometimes append the silence marker to a real answer; keep the answer.
export const passReply = (text?: string | null) =>
  text?.replace(/(?:\s*\[PASS\])+\s*$/iu, "").trim() || "[PASS]";
export const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
export const missingThread = (cause: unknown) =>
  /(?:^|\b)(?:thread not found|thread does not exist|HTTP 404)(?:\b|$)/i.test(
    errorText(cause),
  );
const directMention = (text: string, handle: string) =>
  !/^(?:all|everyone)$/iu.test(handle) && mentioned(text, handle);

export function mentioned(text: string, handle: string) {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^a-zA-Z0-9_.-])@${escaped}(?![a-zA-Z0-9_.-])`,
    "i",
  ).test(text);
}
export function recipients(text: string, members: ChannelAgent[]) {
  return members
    .filter((agent) => directMention(text, agent.handle))
    .map((agent) => agent.id);
}
export const jobPrompt = (job: Job) => {
  const fork = isForkConversation(job.conversationKey);
  const guidance = job.agentKind === "thin"
    ? fork
      ? "This is a separate fork. Handle only the new request; do not resume inherited work."
      : ""
    : `Follow the mission and persona supplied in your agent context. Use agent_document_read if you need to refresh either document.${fork ? " This is a separate fork. Handle only the new request; do not resume inherited work. The primary session owns the persona; do not edit it from this fork. Include useful durable findings in your channel answer." : ""}`;
  return `${guidance ? `${guidance}\n\n` : ""}${job.text}\n\nRequest: ${job.id}`;
};

const jobInput = (job: Job) => [
  { type: "text" as const, text: jobPrompt(job), mentions: [] },
  ...job.attachments.map((attachment) =>
    attachment.type === "localImage"
      ? { type: "localImage" as const, path: attachment.path }
      : {
          type: "localFile" as const,
          path: attachment.path,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        },
  ),
];

export type TimelineRowLike = {
  kind?: unknown;
  role?: unknown;
  text?: unknown;
  children?: unknown;
};

export function timelineRows(rows: unknown): TimelineRowLike[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const value = row as TimelineRowLike;
    return [value, ...timelineRows(value.children)];
  });
}

const autoTitlePattern = /^New channel(?: \d+)?$/iu;
const maxRoomTitleLength = 80;
type SteerRequest = {
  roomId: string;
  jobId: string;
  agentId: string;
  message: RoomMessage;
  previous: {
    runId: string;
    triggerMessageId: string | null;
    text: string;
    attachments: Attachment[];
  };
};


/** Blank channels use these names until the first message gives an agent enough context to title them. */
export function isAutoTitlePlaceholder(name: string) {
  return autoTitlePattern.test(name.trim());
}

/** Keep model output suitable for a compact sidebar label. */
export function sanitizeRoomTitle(value: string): string | null {
  const line = value
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;
  const title = line
    .replace(/^(?:channel\s+)?title\s*:\s*/iu, "")
    .replace(/^[\s`*_#"']+|[\s`*_#"']+$/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[.!?;,]+$/u, "")
    .trim()
    .slice(0, maxRoomTitleLength)
    .trim();
  if (!title || /^(?:n\/a|none|pass)$/iu.test(title)) return null;
  return title;
}

export function fallbackRoomTitle(message: RoomMessage): string | null {
  if (message.system) return null;
  const source =
    message.text.trim() ||
    (message.attachments.length
      ? `Files: ${message.attachments.map((attachment) => attachment.name).join(", ")}`
      : "");
  const cleaned = source
    .replace(/@[a-z0-9_.-]+/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    sanitizeRoomTitle(cleaned.split(" ").slice(0, 7).join(" ")) ??
    "New conversation"
  );
}

export type MessageAuthor = {
  jobId?: string;
  automationId?: string;
  agentId: string | null;
  speaker: string;
  sourceThreadId: string;
  depth: number;
};
export class Runtime {
  private locks = new Map<string, Promise<unknown>>();
  private returnTasks = new Map<string, Promise<void>>();
  returnDecision?: (group: Delegation, signal: AbortSignal) => Promise<boolean>;
  chooseAgent?: (input: AgentChoiceInput, signal: AbortSignal) => Promise<AgentChoice>;
  /** A full agent answered outside its DM. Set by the plugin to feed the DM's memory. */
  reportWork?: (report: { job: Job; conversation: Conversation; request: string; reply: string }) => void;
  readonly delegations: Delegations;
  private steerTasks = new Map<string, Promise<void>>();
  private routingRequests = new Map<string, Promise<void>>();
  readonly busy = new Map<string, { threadId: string; at: number }>();
  readonly abort = new AbortController();
  readonly data: ChannelData;
  constructor(
    readonly bb: BbPluginApi,
    readonly store: Store,
    readonly profiles: Profiles,
    readonly features: RuntimeFeatures = DEFAULT_RUNTIME_FEATURES,
    private readonly onSummaryChanged?: () => void,
  ) {
    this.data = new ChannelData(store);
    this.delegations = new Delegations(store);
  }
  busyDetails(agentId: string) {
    const busy = this.busy.get(agentId);
    if (!busy) return null;
    const conversation = this.store.byThread(busy.threadId);
    const group = conversation?.kind === "group";
    return {
      reason: group
        ? `Busy in #${conversation.title}`
        : "Busy with mission work",
      threadId: busy.threadId,
      title: conversation?.title ?? "Mission",
    };
  }
  changed() {
    this.bb.realtime.publish("changed", { revision: randomUUID() });
    this.onSummaryChanged?.();
  }
  private async conversationTarget(
    profile: Profile,
    agent: ChannelAgent,
  ) {
    if (profile.runProjectId)
      return this.profiles.fixedProjectEnvironment(profile);
    if (!agent.hostId)
      throw new Error("BB needs a connected primary machine for agent channel work.");
    return {
      projectId: agent.projectId,
      environment: {
        type: "host" as const,
        hostId: agent.hostId,
        workspace: { type: "unmanaged" as const, path: agent.home },
      },
    };
  }
  private async stageAttachments(projectId: string, attachments: Attachment[]) {
    const bySource = new Map<string, Set<string>>();
    for (const attachment of attachments) {
      if (!attachment.path || attachment.projectId === projectId) continue;
      const paths = bySource.get(attachment.projectId) ?? new Set<string>();
      paths.add(attachment.path);
      bySource.set(attachment.projectId, paths);
    }
    await Promise.all(
      [...bySource].map(([sourceProjectId, paths]) =>
        this.bb.sdk.projects.attachments.copy({
          projectId,
          sourceProjectId,
          paths: [...paths],
        }),
      ),
    );
  }
  async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  private automaticMembers(room: Room, message: RoomMessage) {
    const ancestors = this.messageAncestors(message);
    return room.memberIds
      .map((id) => this.store.get(id))
      .filter(
        (agent) =>
          !agent.retired &&
          agent.id !== message.agentId &&
          !ancestors.has(agent.id),
      );
  }
  private fallbackAutomaticAgent(
    roomId: string,
    members: ChannelAgent[],
  ): ChannelAgent | undefined {
    if (!members.length) return undefined;
    const row = this.store.db
      .prepare(
        `SELECT json_extract(json, '$.agentId') AS agentId
         FROM room_messages
         WHERE room_id = ?
           AND json_extract(json, '$.agentId') IN (${members.map(() => "?").join(",")})
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(roomId, ...members.map((member) => member.id)) as
      | { agentId: string }
      | undefined;
    return members.find((member) => member.id === row?.agentId) ?? members[0];
  }
  private finishAutomaticRouting(
    roomId: string,
    runId: string,
    choice: AgentChoice | null,
    routingIssue: string | undefined,
    durationMs: number,
  ): SteerRequest | undefined {
    const room = this.store.findRoom(roomId);
    const run = room
      ? this.store.runs(roomId).find((candidate) => candidate.id === runId)
      : undefined;
    if (!room || !run) return;
    let selected: ChannelAgent | undefined;
    let warning: string | undefined;
    let steer: SteerRequest | undefined;
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO routing_usage(room_id, created_at, duration_ms, purpose) VALUES (?, ?, ?, 'route')",
        )
        .run(room.id, Date.now(), durationMs);
      if (run.routing !== "pending") return;
      if (room.archived || run.status === "stopped") {
        run.routing = "error";
        run.routingError =
          "Automatic routing stopped because the channel is archived.";
        run.routingAgentIds = [];
        run.status = "stopped";
        this.store.putRun(run);
        return;
      }
      const message = this.store.message(run.id);
      if (!message) {
        run.routing = "error";
        run.routingError =
          "Automatic routing stopped because its message is unavailable.";
        run.routingAgentIds = [];
        run.status = "done";
        this.store.putRun(run);
        return;
      }
      const members = this.automaticMembers(room, message);
      selected = choice?.agentId
        ? members.find((member) => member.id === choice.agentId)
        : undefined;
      if (!selected) {
        selected = this.fallbackAutomaticAgent(room.id, members);
        const reason =
          routingIssue ??
          (choice?.agentId
            ? "Jev chose an agent who is no longer eligible."
            : "Jev returned no usable agent choice.");
        if (selected)
          warning = `Automatic routing fell back to @${selected.handle}: ${reason}`;
      }
      if (!selected) {
        run.routing = "error";
        run.routingError =
          "Automatic routing could not find an eligible channel member.";
        run.routingAgentIds = [];
        run.status = "done";
        this.store.putRun(run);
        return;
      }
      const action: DispatchAction =
        !message.sendMode || message.sendMode === "auto"
          ? "followup"
          : message.sendMode;
      steer = this.dispatchMessage(
        room,
        run,
        message,
        selected.id,
        run.routingDepth ?? 0,
        action,
      );
      run.routingAgentIds = [selected.id];
      run.routing = "done";
      if (warning) run.routingError = warning;
      run.status = run.pendingJobIds.length ? "running" : "done";
      this.store.putRun(run);
    })();
    if (warning) this.bb.log.warn(warning);
    else if (selected)
      this.bb.log.info(
        `Automatic routing chose @${selected.handle} for #${room.name} (${Math.round((choice?.probability ?? 0) * 100)}%, confidence ${Math.round((choice?.confidence ?? 0) * 100)}%)`,
      );
    return steer;
  }
  private async routeAutomatically(
    room: Room,
    run: RoomRun,
    members: ChannelAgent[],
  ) {
    const startedAt = Date.now();
    const conversation = this.store.messages(room.id, 40).map((message) => ({
      role: message.agentId ? ("assistant" as const) : ("user" as const),
      name: message.speaker.slice(0, 200),
      text: message.text.slice(0, 4_000),
    }));
    const candidates = members.map((member) => {
      const profile = this.profiles.getProfile(member.id);
      const mission = profile.kind === "full"
        ? this.profiles.homes
            .instructionDocuments(profile)
            .mission.trim()
            .slice(0, 600)
        : "";
      const persona = (profile.instructions.trim() || profile.description.trim())
        .slice(0, 600);
      return {
        id: member.id,
        name: member.name,
        handle: member.handle,
        description: [
          persona ? `Persona: ${persona}` : "",
          mission ? `Mission: ${mission}` : "",
        ].filter(Boolean).join("\n"),
      };
    });
    let choice: AgentChoice | null = null;
    let routingIssue: string | undefined;
    try {
      if (!this.chooseAgent) throw new Error("Jev is not configured.");
      choice = await this.chooseAgent(
        { title: room.name, conversation, candidates },
        this.abort.signal,
      );
      if (!choice.agentId)
        routingIssue = "Jev returned no usable agent choice.";
    } catch (cause) {
      routingIssue = `Jev failed: ${errorText(cause)}`;
    }
    const durationMs = Date.now() - startedAt;
    if (this.abort.signal.aborted) return;
    await this.locked(`room:${room.id}`, async () => {
      const steer = this.finishAutomaticRouting(
        room.id,
        run.id,
        choice,
        routingIssue,
        durationMs,
      );
      this.changed();
      if (steer) await this.startSteer(steer);
    });
  }
  private startAutomaticRouting(
    room: Room,
    run: RoomRun,
    members: ChannelAgent[],
  ) {
    const task = this.routeAutomatically(room, run, members)
      .catch((cause) => {
        this.bb.log.warn(
          `Automatic routing failed for #${room.name}: ${errorText(cause)}`,
        );
      })
      .finally(() => {
        this.routingRequests.delete(run.id);
      });
    this.routingRequests.set(run.id, task);
  }
  private recoverPendingRouting(room: Room) {
    for (const run of this.store
      .runs(room.id, -1, true)
      .filter(
        (candidate) =>
          candidate.routing === "pending" &&
          !this.routingRequests.has(candidate.id),
      )) {
      const steer = this.finishAutomaticRouting(
        room.id,
        run.id,
        null,
        "Automatic routing was interrupted by a plugin restart.",
        0,
      );
      if (steer) void this.startSteer(steer);
      this.changed();
    }
  }

  async conversation(
    agent: ChannelAgent,
    key: string,
    kind: Conversation["kind"],
    title: string,
    prompt?: string,
    attachments: Attachment[] = [],
  ): Promise<Conversation> {
    if (agent.retired) throw new Error("Restore this agent before starting work.");
    const profile = this.profiles.getProfile(agent.id);
    if (profile.kind === "thin" && kind === "mission")
      throw new Error("Thin agents do not have standing missions to wake.");
    const existing = this.store
      .conversations(agent.id)
      .find((c) => c.key === key);
    if (existing && (existing.agentKind ?? "full") === profile.kind)
      return existing;
    if (existing) this.store.deleteConversation(existing.threadId);
    const docs = profile.kind === "thin"
      ? { mission: "", legacyMemory: false }
      : await this.profiles.homes.spawnDocuments(profile);
    if (profile.kind === "thin" && !profile.runProjectId)
      await this.profiles.homes.ensureHome(profile);
    const execution = await this.profiles.resolveExecution(profile);
    agent = this.store.get(agent.id);
    const target = await this.conversationTarget(profile, agent);
    await this.stageAttachments(target.projectId, attachments);
    const thread = await this.bb.sdk.threads.spawn({
      projectId: target.projectId,
      environment: target.environment,
      input: [
        {
          type: "text",
          text: spawnPreamble(
            profile,
            docs,
            kind === "group" ? "channel" : "mission",
          ),
          mentions: [],
          visibility: "agent-only",
        },
        {
          type: "text",
          text:
            prompt ??
            (profile.kind === "thin"
              ? "Introduce yourself in one short sentence based on your persona. Then wait for a message."
              : profile.runProjectId
                ? "Use the supplied mission to introduce yourself in one short sentence. Use agent_document_read if you need to refresh it. Then wait for a message."
                : "Read MISSION.md. Introduce yourself in one short sentence based on your mission. Then wait for a message."),
          mentions: [],
        },
        ...attachments.map((a) =>
          a.type === "localImage"
            ? { type: "localImage" as const, path: a.path }
            : {
                type: "localFile" as const,
                path: a.path,
                name: a.name,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes,
              },
        ),
      ],
      sendAt: Date.now() + 1500,
      title: `${agent.name} · ${title}`,
      visibility: "hidden",
      providerId: execution.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      serviceTier: agent.serviceTier,
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
      },
      permissionMode: "full",
      pluginMetadata: { role: "channel", profileId: agent.id, schemaVersion: 1, agentId: agent.id, conversationKey: key },
    });
    const c: Conversation = {
      id: randomUUID(),
      agentKind: profile.kind,
      agentId: agent.id,
      key,
      threadId: thread.id,
      title,
      kind,
      createdAt: Date.now(),
    };
    this.store.putConversation(c);
    if (agent.error) this.store.put({ ...this.store.get(agent.id), error: null });
    this.changed();
    return c;
  }
  private async forkConversation(agent: ChannelAgent, job: Job): Promise<Conversation> {
    const sourceThreadId = job.forkSourceThreadId!;
    const profile = this.profiles.getProfile(agent.id);
    const source = await this.bb.sdk.threads.get({ threadId: sourceThreadId });
    // A pre-Agents source is history-only: start fresh on the shared agent path instead of forking it.
    if (source.providerId !== AGENTS_PROVIDER_ID)
      return this.conversation(agent, job.conversationKey, "group", `${this.store.room(job.roomId!).name} · Fork`, jobPrompt(job), job.attachments);
    if (profile.runProjectId) {
      const target = await this.profiles.fixedProjectEnvironment(profile);
      if (source.projectId !== target.projectId)
        throw new Error(
          `@${profile.slug}'s fork source is not in fixed project ${target.projectId}. Retry from the agent's current channel conversation.`,
        );
      await this.stageAttachments(target.projectId, job.attachments);
    }
    // The dispatch hook holds the first input until both conversation and job are registered.
    const thread = await this.bb.sdk.threads.fork({
      sourceThreadId,
      visibility: "hidden",
      title: `${agent.name} · ${this.store.room(job.roomId!).name} · Fork`,
      pluginMetadata: { role: "channel", profileId: agent.id, schemaVersion: 1, agentId: agent.id, conversationKey: job.conversationKey },
      input: [
        { type: "text", text: jobPrompt(job), mentions: [] },
        ...job.attachments.map((a) =>
          a.type === "localImage"
            ? { type: "localImage" as const, path: a.path }
            : {
                type: "localFile" as const,
                path: a.path,
                name: a.name,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes,
              },
        ),
      ],
    });
    const c: Conversation = {
      id: randomUUID(),
      agentKind: agent.kind,
      agentId: agent.id,
      key: job.conversationKey,
      threadId: thread.id,
      title: `${this.store.room(job.roomId!).name} · Fork`,
      kind: "group",
      createdAt: Date.now(),
    };
    this.store.putConversation(c);
    return c;
  }

  async driveForks(agent: ChannelAgent) {
    const first = new Map<string, Job>();
    for (const job of this.store.work(agent.id))
      if (
        isForkConversation(job.conversationKey) &&
        !first.has(job.conversationKey)
      )
        first.set(job.conversationKey, job);
    // Reconcile active forks first, then fill available slots. A blocked dispatch
    // must not prevent another fork from completing or being cleaned up.
    let active = [...first.values()].filter(
      (j) => j.status !== "queued",
    ).length;
    const failures: unknown[] = [];
    const ordered = [...first.values()].sort(
      (a, b) => Number(a.status === "queued") - Number(b.status === "queued"),
    );
    for (const job of ordered) {
      if (
        job.status === "queued" &&
        active >= (agent.limits ?? defaultLimits).concurrentForks
      )
        continue;
      const wasQueued = job.status === "queued";
      try {
        await this.drive(agent, job);
      } catch (cause) {
        failures.push(cause);
      }
      if (!wasQueued && !this.store.work(agent.id).some((j) => j.id === job.id))
        active--;
      if (
        wasQueued &&
        ["running", "dispatching"].includes(
          this.store.job(job.id)?.status ?? "",
        )
      )
        active++;
    }
    if (failures.length) throw failures[0];
  }

  enqueue(
    agent: ChannelAgent,
    args: Partial<Job> & Pick<Job, "id" | "text" | "conversationKey">,
  ) {
    const now = Date.now();
    return this.store.enqueue({
      agentId: agent.id,
      agentKind: agent.kind,
      threadId: null,
      status: "queued",
      reply: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      dispatchStartedAt: null,
      roomId: null,
      runId: null,
      triggerMessageId: null,
      depth: 0,
      attachments: [],
      outputAttachments: [],
      ...args,
    });
  }
  wake(agent: ChannelAgent) {
    if (agent.kind === "thin")
      throw new Error("Thin agents do not have standing missions to wake.");
    if (agent.retired) throw new Error("Restore this agent before waking it.");
    if (agent.paused) throw new Error("Resume this agent before waking it.");
    if (this.store.work(agent.id).some((j) => j.conversationKey === "mission"))
      return false;
    const queued = this.enqueue(agent, {
      id: randomUUID(),
      conversationKey: "mission",
      text: "Review the mission supplied in your agent context. Take one useful, bounded step toward your mission. End with a short note on progress and unfinished work. If blocked or there is nothing useful to do, say so and stop.",
    });
    this.store.put({ ...agent, lastWakeAt: Date.now() });
    this.changed();
    return queued;
  }
  /** Persist a channel notice without creating an agent job or triggering members. */
  postSystemMessage(
    room: Room,
    text: string,
    system: "bot_joined",
  ): RoomMessage {
    const now = Date.now();
    const id = `system:${randomUUID()}`;
    const message: RoomMessage = {
      id,
      roomId: room.id,
      runId: id,
      agentId: null,
      speaker: "BB",
      system,
      text,
      createdAt: now,
      attachments: [],
      replyTo: null,
    };
    const current = this.store.room(room.id);
    this.store.db.transaction(() => {
      this.store.putMessage(message);
      this.store.putRoom({
        ...current,
        updatedAt: Math.max(current.updatedAt + 1, now),
      });
    })();
    return message;
  }
  send(
    room: Room,
    text: string,
    requestId: string,
    attachments: Attachment[] = [],
    replyTo: string | null = null,
    author?: MessageAuthor,
    scheduled?: { automationId: string; agentId: string; name: string },
    requestedMode: SendMode = "auto",
  ): RoomMessage {
    text = text.trim();
    const sendMode = scheduled ? "followup" : requestedMode;
    const existing = this.store.message(requestId);
    if (existing) {
      if (
        existing.roomId !== room.id ||
        existing.agentId !== (author?.agentId ?? null) ||
        existing.sourceThreadId !== author?.sourceThreadId ||
        existing.automationId !==
          (scheduled?.automationId ?? author?.automationId) ||
        (existing.sentText ?? existing.text) !== text ||
        (existing.sendMode ?? "auto") !== sendMode ||
        existing.replyTo !== replyTo ||
        JSON.stringify(existing.attachments.map((a) => a.id)) !==
          JSON.stringify(attachments.map((a) => a.id))
      )
        throw new Error(
          "Message request ID was already used for different content.",
        );
      return existing;
    }
    if (!text.trim() && !attachments.length)
      throw new Error("Write a message or attach a file.");
    if (room.archived)
      throw new Error("Restore this channel before sending a message.");
    if (replyTo && this.store.message(replyTo)?.roomId !== room.id)
      throw new Error("Reply message not found in this group.");
    if (
      author?.agentId &&
      (
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM room_messages WHERE json_extract(json,'$.sourceThreadId')=?",
          )
          .get(author.sourceThreadId) as { n: number }
      ).n >= 3
    )
      throw new Error(
        "This response has already sent three consultation messages. Summarize the results before requesting more work.",
      );
    if (author && author.depth > 2)
      throw new Error(
        "Agent consultation handoff limit reached. Return your findings to the requesting channel.",
      );
    // Explicit sends may invite new agents. This is committed with the message,
    // so editing a draft or retrying a lost response cannot change membership.
    if (
      !scheduled &&
      this.store
        .all()
        .some(
          (agent) =>
            agent.retired && directMention(text, agent.handle),
        )
    )
      throw new Error("Restore the retired agent before mentioning it.");
    const invited = this.store
      .all()
      .filter(
        (agent) =>
          !scheduled &&
          !agent.retired &&
          !room.memberIds.includes(agent.id) &&
          directMention(text, agent.handle),
      );
    room = {
      ...room,
      memberIds: [...new Set([...room.memberIds, ...invited.map((b) => b.id)])],
    };
    if (room.memberIds.length > 16)
      throw new Error("A channel can have up to 16 agents.");
    const now = Date.now();
    const run: RoomRun = {
      id: requestId,
      roomId: room.id,
      status: "running",
      mode: "concurrent",
      pendingJobIds: [],
      settledJobIds: [],
      round: 1,
      remaining: [],
      next: [],
      jobId: null,
      createdAt: now,
      error: null,
    };
    const m: RoomMessage = {
      id: requestId,
      roomId: room.id,
      runId: run.id,
      agentId: author?.agentId ?? null,
      speaker: scheduled
        ? `Automation: ${scheduled.name}`
        : (author?.speaker ?? "You"),
      ...((scheduled?.automationId ?? author?.automationId)
        ? { automationId: scheduled?.automationId ?? author?.automationId }
        : {}),
      ...(author
        ? {
            sourceThreadId: author.sourceThreadId,
            ...(author.jobId ? { sourceJobId: author.jobId } : {}),
          }
        : {}),
      text,
      sentText: text,
      ...(sendMode !== "auto" ? { sendMode } : {}),
      createdAt: now,
      attachments,
      replyTo,
    };
    const shouldAutoTitle =
      !isAutomationTrigger(m) &&
      isAutoTitlePlaceholder(room.name) &&
      !this.store.firstMessage(room.id);
    const ancestors = this.messageAncestors(m);
    const members = room.memberIds
      .map((id) => this.store.get(id))
      .filter(
        (b) => !b.retired && b.id !== author?.agentId && !ancestors.has(b.id),
      );
    const replyAgent = replyTo ? this.store.message(replyTo)?.agentId : null;
    const explicit = members
      .filter(
        (agent) =>
          directMention(text, agent.handle) || agent.id === replyAgent,
      )
      .map((agent) => agent.id);
    const returnOnly =
      !explicit.length &&
      [...ancestors].some(
        (id) =>
          id === replyAgent ||
          directMention(text, this.store.get(id).handle),
      );
    const automaticRouting =
      room.responseBehavior === "smart" &&
      !author &&
      !scheduled &&
      !explicit.length &&
      !returnOnly &&
      members.length > 1;
    let selected = scheduled
      ? [scheduled.agentId]
      : explicit.length
        ? explicit
        : !author && members.length === 1
          ? [members[0]!.id]
          : [];
    if (returnOnly) selected = [];
    const steerRequests: SteerRequest[] = [];
    this.store.db.transaction(() => {
      if (automaticRouting) {
        run.routing = "pending";
        run.routingDepth = 0;
        run.routingAgentIds = [];
      }
      this.store.putMessage(m);
      this.store.claimAttachments(attachments.map((a) => a.id));
      for (const agentId of selected) {
        if (agentId === author?.agentId) continue;
        const action = sendMode === "auto" ? "followup" : sendMode;
        const steer = this.dispatchMessage(
          room,
          run,
          m,
          agentId,
          author?.depth ?? 0,
          action,
        );
        if (steer) steerRequests.push(steer);
      }
      if (!run.pendingJobIds.length && !run.routing) run.status = "done";
      this.trackDelegation(m, run, author?.sourceThreadId);
      this.store.putRun(run);
      if (!isAutomationTrigger(m))
        this.store.putRoom({ ...room, updatedAt: now });
    })();
    if (automaticRouting) this.startAutomaticRouting(room, run, members);
    for (const agent of invited)
      this.postSystemMessage(
        room,
        `${agent.name} joined the channel.`,
        "bot_joined",
      );
    this.changed();
    for (const request of steerRequests) this.startSteer(request);
    if (shouldAutoTitle)
      void this.applyRoomTitle(room.id, fallbackRoomTitle(m));
    return m;
  }

  private sourceJobForMessage(message: RoomMessage) {
    if (message.sourceJobId) return this.store.job(message.sourceJobId);
    if (message.agentId && message.sourceThreadId)
      return (
        this.store
          .work(message.agentId)
          .find(
            (job) =>
              job.threadId === message.sourceThreadId && isExecuting(job),
          ) ?? null
      );
    return this.store.job(message.id);
  }
  private messageAncestors(message: RoomMessage) {
    const source = this.sourceJobForMessage(message);
    return source ? this.delegations.ancestors(source) : new Set<string>();
  }
  private trackDelegation(
    message: RoomMessage,
    run: RoomRun,
    sourceThreadId = message.sourceThreadId,
    sourceJob: Job | null = null,
  ) {
    if (!message.agentId) return;
    sourceJob ??= message.sourceJobId
      ? this.store.job(message.sourceJobId)
      : null;
    sourceJob ??= sourceThreadId
      ? (this.store
          .work(message.agentId)
          .find((job) => job.threadId === sourceThreadId && isExecuting(job)) ??
        null)
      : this.store.job(message.id);
    const ancestors = sourceJob
      ? this.delegations.ancestors(sourceJob)
      : new Set<string>();
    const replyBot = message.replyTo
      ? this.store.message(message.replyTo)?.agentId
      : null;
    const jobs = this.store
      .requestJobs(run.id)
      .filter(
        (job) =>
          job.triggerMessageId === message.id &&
          job.agentId !== message.agentId &&
          !ancestors.has(job.agentId) &&
          (directMention(
            message.sentText ?? message.text,
            this.store.get(job.agentId).handle,
          ) ||
            job.agentId === replyBot),
      );
    this.delegations.track(message, run, jobs, sourceJob);
  }
  private startReturns(room: Room) {
    for (const group of this.delegations.pending(room.id)) {
      if (
        this.returnTasks.has(group.id) ||
        this.returnTasks.size >= 4 ||
        group.retryAt > Date.now() ||
        this.abort.signal.aborted
      )
        continue;
      const task = this.resolveReturn(group)
        .catch((cause) => {
          const current = this.delegations.get(group.id);
          if (current?.status === "waiting" && !this.abort.signal.aborted) {
            current.retryAt = Date.now() + 30000;
            current.error = errorText(cause);
            this.delegations.put(current);
          }
        })
        .finally(() => this.returnTasks.delete(group.id));
      this.returnTasks.set(group.id, task);
    }
  }
  private async timeoutDelegate(
    job: Job,
    deadlineGroupId: string,
    seen = new Set<string>(),
  ) {
    if (
      (this.delegations.get(deadlineGroupId)?.deadlineAt ?? Infinity) >
      Date.now()
    )
      return;
    if (seen.has(job.id)) return;
    seen.add(job.id);
    const nested = this.delegations.get(
      `job:${this.delegations.rootJob(job).id}`,
    );
    if (nested?.status === "waiting") {
      for (const result of this.delegations
        .results(nested)
        .filter((result) => result.status === "pending")) {
        const child = this.store.job(result.jobId);
        if (child) await this.timeoutDelegate(child, deadlineGroupId, seen);
      }
      if (
        (this.delegations.get(deadlineGroupId)?.deadlineAt ?? Infinity) >
        Date.now()
      )
        return;
      this.delegations.put({ ...nested, status: "ignored" });
    }
    const reason = "Direct delegation timed out before all delegates settled.";
    await this.locked(job.agentId, async () => {
      const current = this.store.job(job.id);
      if (
        !current ||
        current.triggerMessageId !== job.triggerMessageId ||
        (this.delegations.get(deadlineGroupId)?.deadlineAt ?? Infinity) >
          Date.now()
      )
        return;
      if (current.status === "done" && nested?.status === "waiting")
        this.store.putJob({
          ...current,
          status: "cancelled",
          timedOut: true,
          error: reason,
        });
      else if (
        !["done", "error", "cancelled"].includes(current.status) ||
        current.cancellationPending
      )
        await this.cancel(current, reason, false, true);
    });
  }
  private async resolveReturn(group: Delegation) {
    const source = group.sourceJobId
      ? this.delegations.attempt(group.sourceJobId)
      : null;
    if (source && ["queued", "dispatching", "running"].includes(source.status))
      return;
    let results = this.delegations.results(group);
    if (results.some((result) => result.status === "pending")) {
      if (Date.now() < group.deadlineAt) return;
      for (const result of results.filter(
        (result) => result.status === "pending",
      )) {
        const job = this.store.job(result.jobId);
        if (job) await this.timeoutDelegate(job, group.id);
      }
      results = this.delegations.results(group);
      if (results.some((result) => result.status === "pending")) return;
    }
    if (!this.returnDecision)
      throw new Error("Delegation classifier is unavailable.");
    const snapshot = JSON.stringify(results);
    const shouldReturn =
      source?.status !== "cancelled" &&
      (await this.returnDecision(group, this.abort.signal));
    if (this.abort.signal.aborted) return;
    await this.locked(`room:${group.roomId}`, async () => {
      const live = this.delegations.get(group.id);
      if (
        !live ||
        live.status !== "waiting" ||
        JSON.stringify(this.delegations.results(live)) !== snapshot
      )
        return;
      const latestSource = live.sourceJobId
        ? this.delegations.attempt(live.sourceJobId)
        : null;
      if (
        latestSource?.id !== source?.id ||
        latestSource?.status !== source?.status ||
        latestSource?.triggerMessageId !== source?.triggerMessageId
      )
        return;
      const room = this.store.findRoom(live.roomId);
      const run = room
        ? this.store
            .runs(room.id)
            .find((candidate) => candidate.id === live.runId)
        : null;
      const agent = this.store.get(live.requesterAgentId);
      this.store.db.transaction(() => {
        live.status = "ignored";
        if (
          shouldReturn &&
          latestSource?.status !== "cancelled" &&
          room &&
          !room.archived &&
          room.memberIds.includes(agent.id) &&
          !agent.retired &&
          run &&
          run.status !== "stopped" &&
          run.pendingJobIds.length + run.settledJobIds.length < 32
        ) {
          const id = `return:${live.id}:${agent.id}`;
          if (
            this.enqueue(agent, {
              id,
              conversationKey: live.conversationKey,
              roomId: room.id,
              runId: run.id,
              triggerMessageId: this.delegations.returnTrigger(live),
              delegationId: source?.delegationId,
              returnOf: live.id,
              depth: 2,
              text: this.delegations.prompt(live),
              taskTitle: "Synthesize delegate results",
            })
          )
            run.pendingJobIds.push(id);
          live.status = "returned";
          live.returnJobId = id;
          run.status = "running";
          this.store.putRun(run);
        }
        this.delegations.put(live);
      })();
      this.changed();
    });
  }

  private targetKey(message: RoomMessage, agentId: string) {
    const primary = `group:${message.roomId}`;
    const parent = message.replyTo ? this.store.message(message.replyTo) : null;
    if (!parent || (parent.agentId && parent.agentId !== agentId)) return primary;
    const job = this.store.job(
      parent.agentId ? parent.id : `${parent.id}:${agentId}`,
    );
    const key =
      (parent.agentId === agentId ? parent.conversationKey : undefined) ??
      job?.conversationKey;
    return key === primary || key?.startsWith(`${primary}:fork:`)
      ? key
      : primary;
  }

  routingTasks(message: RoomMessage, members: ChannelAgent[]): RoutingTask[] {
    return members.map((agent) => {
      const key = this.targetKey(message, agent.id);
      const active = this.store
        .work(agent.id)
        .find(
          (job) =>
            job.conversationKey === key &&
            ["running", "dispatching"].includes(job.status),
        );
      const conversation = this.store
        .conversations(agent.id)
        .find((c) => c.key === key);
      const trigger = active?.triggerMessageId
        ? this.store.message(active.triggerMessageId)
        : null;
      return {
        agentId: agent.id,
        threadId: active?.threadId ?? conversation?.threadId ?? null,
        busy: !!active,
        task: trigger?.text.slice(0, 2000) ?? "",
        jobId: active?.id ?? null,
      };
    });
  }

  private queuedJobTarget(job: Job): Job | undefined {
    return this.store
      .work(job.agentId)
      .find(
        (candidate) =>
          candidate.id !== job.id &&
          candidate.roomId === job.roomId &&
          candidate.conversationKey === job.conversationKey &&
          isExecuting(candidate),
      );
  }

  private dispatchMessage(
    room: Room,
    run: RoomRun,
    message: RoomMessage,
    agentId: string,
    depth: number,
    action: DispatchAction,
    snapshot?: RoutingTask,
  ): SteerRequest | undefined {
    const key = this.targetKey(message, agentId);
    const activeJob = this.store
      .work(agentId)
      .find(
        (job) =>
          job.conversationKey === key &&
          ["dispatching", "running"].includes(job.status),
      );
    // A slow classifier must never steer a different task that started meanwhile.
    if (snapshot && snapshot.jobId !== activeJob?.id && action === "steer")
      action = "followup";
    const previousRun = activeJob?.runId
      ? this.store.runs(room.id).find((r) => r.id === activeJob.runId)
      : undefined;
    if (action === "steer" && activeJob && previousRun) {
      const previous = {
        runId: previousRun.id,
        triggerMessageId: activeJob.triggerMessageId,
        text: activeJob.text,
        attachments: [...activeJob.attachments],
      };
      previousRun.pendingJobIds = previousRun.pendingJobIds.filter(
        (id) => id !== activeJob.id,
      );
      previousRun.status =
        previousRun.pendingJobIds.length || previousRun.routing === "pending"
          ? "running"
          : "done";
      this.store.putRun(previousRun);
      activeJob.pendingSteer = {
        priorPrompt:
          activeJob.pendingSteer?.priorPrompt ?? jobPrompt(activeJob),
      };
      activeJob.requiresPromptMatch = true;
      activeJob.runId = run.id;
      activeJob.triggerMessageId = message.id;
      activeJob.attachments = [...message.attachments];
      activeJob.dispatchAction = "steer";
      activeJob.taskTitle = message.text.slice(0, 240);
      this.prepareGroup(activeJob, this.store.get(agentId));
      run.pendingJobIds.push(activeJob.id);
      return { roomId: room.id, jobId: activeJob.id, agentId, message, previous };
    }
    const source =
      activeJob?.threadId ??
      this.store.conversations(agentId).find((c) => c.key === key)?.threadId;
    // Automatic routing only forks existing sessions. Explicit requests fail visibly below.
    if (action === "fork" && !source && message.sendMode !== "fork")
      action = "followup";
    this.invite(room, run, message, agentId, depth, {
      conversationKey:
        action === "fork" ? `group:${room.id}:fork:${message.id}` : key,
      dispatchAction: action,
      ...(action === "fork" && source ? { forkSourceThreadId: source } : {}),
      ...(action === "fork" && !source
        ? {
            status: "error" as const,
            error:
              "This agent has no session to fork yet. Send a regular message first.",
          }
        : {}),
    });
  }

  async queuedJobAction(
    id: string,
    action: "steer" | "fork",
  ): Promise<{ status: "steered" | "forked" | "sent"; jobId: string }> {
    const initial = this.store.job(id);
    if (!initial?.roomId)
      throw new Error("Queued channel response not found.");
    return this.locked(`room:${initial.roomId}`, () =>
      this.locked(initial.agentId, async () => {
        const job = this.store.job(id);
        if (!job?.roomId)
          throw new Error("Queued channel response not found.");
        if (job.status !== "queued")
          return { status: "sent" as const, jobId: job.id };
        const room = this.store.room(job.roomId);
        const agent = this.store.get(job.agentId);
        if (room.archived)
          throw new Error("Restore this channel before changing queued work.");
        if (agent.retired || !room.memberIds.includes(agent.id))
          throw new Error("Invite this agent before changing queued work.");

        const active = this.queuedJobTarget(job);
        if (!active) {
          const other = this.store
            .work(agent.id)
            .find((candidate) => candidate.id !== job.id && isExecuting(candidate));
          if (other)
            throw new Error(
              `@${agent.handle} is busy in another conversation. This queued message cannot change that work.`,
            );
          await this.drive(agent, job);
          return { status: "sent", jobId: job.id };
        }

        const message = job.triggerMessageId
          ? this.store.message(job.triggerMessageId)
          : null;
        const run = job.runId
          ? this.store.runs(room.id).find((candidate) => candidate.id === job.runId)
          : null;
        if (!message || !run)
          throw new Error("The queued channel request is no longer available.");

        if (action === "fork") {
          if (!active.threadId)
            throw new Error(
              `@${agent.handle}'s running turn is still starting. Try Answer in parallel again shortly.`,
            );
          job.conversationKey = `group:${room.id}:fork:${message.id}`;
          job.dispatchAction = "fork";
          job.forkSourceThreadId = active.threadId;
          this.store.putJob(job);
          await this.driveForks(agent);
          this.changed();
          return { status: "forked", jobId: job.id };
        }

        if (
          !active.runId ||
          !this.store.runs(room.id).some((candidate) => candidate.id === active.runId)
        )
          throw new Error(
            `@${agent.handle}'s running channel request is no longer available to steer.`,
          );
        let request: SteerRequest | undefined;
        this.store.db.transaction(() => {
          job.status = "cancelled";
          job.error = "Converted to a steer by the owner.";
          this.store.putJob(job);
          run.pendingJobIds = run.pendingJobIds.filter(
            (candidate) => candidate !== job.id,
          );
          if (!run.settledJobIds.includes(job.id))
            run.settledJobIds.push(job.id);
          request = this.dispatchMessage(
            room,
            run,
            message,
            agent.id,
            job.depth,
            "steer",
          );
          run.status = "running";
          this.store.putRun(run);
        })();
        if (!request)
          throw new Error(
            `@${agent.handle}'s running channel request is no longer available to steer.`,
          );
        await this.startSteer(request);
        this.changed();
        return { status: "steered", jobId: request.jobId };
      }),
    );
  }

  private startSteer(request: Pick<SteerRequest, "jobId">): Promise<void> {
    if (!this.store.job(request.jobId)?.threadId) return Promise.resolve();
    const running = this.steerTasks.get(request.jobId);
    if (running) return running;
    const task = Promise.resolve()
      .then(async () => {
        const job = this.store.job(request.jobId);
        if (
          !job?.pendingSteer ||
          !job.threadId ||
          !["dispatching", "running"].includes(job.status)
        )
          return;
        const prompt = jobPrompt(job);
        const current = () => {
          const live = this.store.job(job.id);
          return live?.pendingSteer &&
            live.triggerMessageId === job.triggerMessageId &&
            ["running", "dispatching"].includes(live.status)
            ? live
            : null;
        };
        try {
          if (job.pendingSteer.attemptedAt) {
            const matches = await this.latestPromptMatches(
              job.threadId,
              prompt,
            );
            const queued = await this.bb.sdk.threads.queuedMessages.list({
              threadId: job.threadId,
            });
            const delivered =
              matches === true ||
              queued.some((q) =>
                q.content.some((b) => b.type === "text" && b.text === prompt),
              );
            const live = current();
            if (!live) return;
            if (delivered) {
              delete live.pendingSteer;
              live.error = null;
              this.store.putJob(live);
              return;
            }
            // Do not retry an uncertain send while the timeline is unavailable.
            if (
              matches === null ||
              Date.now() - job.pendingSteer.attemptedAt < 3000
            )
              return;
          }
          const profile = this.profiles.getProfile(job.agentId);
          if (profile.runProjectId) {
            const target = await this.profiles.fixedProjectEnvironment(profile);
            await this.stageAttachments(target.projectId, job.attachments);
          }
          const live = current();
          if (!live) return;
          live.pendingSteer!.attemptedAt = Date.now();
          this.store.putJob(live);
          await this.bb.sdk.threads.send({
            threadId: job.threadId,
            mode: "steer",
            input: jobInput(job),
          });
          const accepted = current();
          if (accepted) {
            delete accepted.pendingSteer;
            accepted.error = null;
            this.store.putJob(accepted);
          }
        } catch (cause) {
          const live = current();
          if (live) {
            live.error = `Checking correction delivery: ${errorText(cause)}`;
            this.store.putJob(live);
          }
          this.bb.log.warn(
            `Steering a channel response needs recovery: ${errorText(cause)}`,
          );
        }
        this.changed();
      })
      .finally(() => {
        if (this.steerTasks.get(request.jobId) === task)
          this.steerTasks.delete(request.jobId);
      });
    this.steerTasks.set(request.jobId, task);
    return task;
  }

  /** Retry title work for blank channels after a plugin/server restart. */





  private async applyRoomTitle(roomId: string, candidate: string | null) {
    const title = sanitizeRoomTitle(candidate ?? "");
    if (!title) return false;
    return this.locked("rooms", () =>
      this.locked(`room:${roomId}`, async () => {
        const current = this.store.findRoom(roomId);
        if (!current || !isAutoTitlePlaceholder(current.name)) return false;
        const names = new Set(
          this.store
            .rooms()
            .filter((room) => room.id !== roomId)
            .map((room) => room.name.toLocaleLowerCase()),
        );
        const base = title.slice(0, maxRoomTitleLength).trim();
        let next = base;
        for (let suffix = 2; names.has(next.toLocaleLowerCase()); suffix++) {
          const suffixText = ` ${suffix}`;
          next = `${base.slice(0, maxRoomTitleLength - suffixText.length).trimEnd()}${suffixText}`;
        }
        this.store.putRoom({
          ...current,
          name: next,
          updatedAt: Math.max(Date.now(), current.updatedAt + 1),
        });
        this.changed();
        return true;
      }),
    );
  }
  sendScheduled(
    room: Room,
    agentId: string,
    automationId: string,
    name: string,
    prompt: string,
    requestId: string,
  ) {
    return this.send(room, prompt, requestId, [], null, undefined, {
      agentId,
      automationId,
      name,
    });
  }
  private invite(
    room: Room,
    run: RoomRun,
    trigger: RoomMessage,
    agentId: string,
    depth: number,
    dispatch: Partial<
      Pick<
        Job,
        | "conversationKey"
        | "dispatchAction"
        | "forkSourceThreadId"
        | "status"
        | "error"
      >
    > = {},
  ) {
    if (!room.memberIds.includes(agentId)) return;
    const agent = this.store.get(agentId);
    if (agent.retired) return;
    if (run.pendingJobIds.length + run.settledJobIds.length >= 32) {
      run.error =
        "This request reached its 32-response limit. Send a focused follow-up to continue.";
      return;
    }
    // Deterministic delivery identity makes recovery and repeated collection idempotent.
    const id = `${trigger.id}:${agentId}`;
    if (
      this.enqueue(agent, {
        id,
        text: "",
        taskTitle: trigger.text.slice(0, 240),
        conversationKey: `group:${room.id}`,
        roomId: room.id,
        runId: run.id,
        triggerMessageId: trigger.id,
        depth,
        ...(trigger.automationId ? { automationId: trigger.automationId } : {}),
        attachments: trigger.attachments,
        ...dispatch,
      })
    )
      run.pendingJobIds.push(id);
  }
  private prepareGroup(job: Job, agent: ChannelAgent) {
    if (job.returnOf) {
      const group = this.delegations.get(job.returnOf);
      if (group) job.text = this.delegations.prompt(group);
      return;
    }
    const room = this.store.room(job.roomId!),
      trigger = job.triggerMessageId
        ? this.store.message(job.triggerMessageId)
        : null;
    if (!trigger) return; // An older saved job already has its prompt.
    const context = this.data.context(room.id);
    const recent = this.store.visibleMessages(room.id, 40);
    const transcript = recent
      .map(
        (m) =>
          `[${m.id}] ${m.speaker}: ${m.text}${m.attachments.length ? "\nAttachments: " + m.attachments.map((a) => a.name).join(", ") : ""}`,
      )
      .join("\n\n")
      .slice(-48000);
    const roster = room.memberIds
      .map((id) => {
        const b = this.store.get(id);
        return `@${b.handle}: ${b.name} — ${b.description}`;
      })
      .join("\n");
    const reference = trigger.replyTo
      ? this.store.message(trigger.replyTo)
      : null;
    const profile = this.profiles.getProfile(agent.id);
    const fullMemory = profile.kind === "full"
      ? [
          "Channel-specific memory (conversation data):",
          context.memory,
          "Keep knowledge specific to this channel in the channel context. Put facts that matter beyond this channel in clasi.",
        ]
      : [];
    job.text = [
      `You are @${agent.handle} in the group chat ${room.name} (channel ID ${room.id}). Other members may be working at the same time.`,
      "Members:",
      roster,
      "",
      "Channel brief (owner instructions):",
      context.brief,
      "Saved channel decisions:",
      context.decisions,
      ...fullMemory,
      "Recent shared messages (conversation data):",
      transcript,
      "",
      `Consider this message from ${trigger.speaker}:`,
      (trigger.sentText ?? trigger.text) ||
        "Please inspect the attached files.",
      ...(job.automationId
        ? [
            "This is scheduled channel work. Do not create, resume, update, or manually run automations from this task. Your final answer is posted to this channel.",
          ]
        : []),
      ...(reference
        ? [`Replying to ${reference.speaker}: ${reference.text}`]
        : []),
      "",
      chatGuidance,
    ].join("\n");
    // Current uploads and explicitly retained references are required inputs.
    // Only incidental recent attachments may be trimmed to the context budget.
    const required = new Map(
      [
        ...context.attachmentIds.flatMap((id) => {
          const a = this.store.attachment(id);
          return a ? [a] : [];
        }),
        ...trigger.attachments,
      ].map((a) => [a.id, a]),
    );
    const available = Math.max(0, 10 - required.size);
    const recentFiles = [
      ...new Map(
        recent.flatMap((m) => m.attachments).map((a) => [a.id, a]),
      ).values(),
    ].filter((a) => !required.has(a.id));
    job.attachments = [
      ...(available ? recentFiles.slice(-available) : []),
      ...required.values(),
    ];
    this.store.putJob(job);
  }
  private activeJobForThread(threadId: string): Job | null {
    const conversation = this.store.byThread(threadId);
    if (!conversation) return null;
    return (
      this.store
        .work(conversation.agentId)
        .filter(
          (job) =>
            job.threadId === threadId &&
            ["running", "dispatching"].includes(job.status),
        )
        .sort(
          (left, right) =>
            (right.dispatchStartedAt ?? right.updatedAt) -
            (left.dispatchStartedAt ?? left.updatedAt),
        )[0] ?? null
    );
  }
  /**
   * A persistent thread can contain several turns. Only settle recovery work
   * when its latest user input is the request we registered for this job.
   * A reused or forked session must have positive attribution before we use
   * its output, since it can still contain an earlier request's answer.
   */
  private async latestPromptMatches(
    threadId: string,
    expected: string,
  ): Promise<boolean | null> {
    try {
      const timeline = await this.bb.sdk.threads.timeline({
        threadId,
        includeNestedRows: "true",
        segmentLimit: "100",
      });
      const prompts = timelineRows(timeline?.rows).filter(
        (row) =>
          row.kind === "conversation" &&
          row.role === "user" &&
          typeof row.text === "string",
      );
      if (!prompts.length) return null;
      // A first turn's row can include the spawn preamble before the prompt.
      // The prompt ends with a unique request line, so a suffix match is exact.
      const latest = String(prompts.at(-1)?.text ?? "");
      return latest === expected || latest.endsWith(`\n${expected}`);
    } catch (cause) {
      if (!missingThread(cause))
        this.bb.log.debug(
          `Persistent agent turn verification failed: ${errorText(cause)}`,
        );
      return null;
    }
  }
  /**
   * Thread events do not carry the plugin job ID. Re-check the current thread
   * before accepting an idle/error event so a late event from an earlier turn
   * cannot settle a newer request on the shared conversation.
   */
  async settleFromEvent(threadId: string, text: string | null, error?: string) {
    const job = this.activeJobForThread(threadId);
    if (!job) {
      this.complete(threadId, text, error);
      return;
    }
    try {
      const thread = await this.bb.sdk.threads.get({ threadId });
      if (error ? thread.status !== "error" : thread.status !== "idle") return;
      const matches = await this.latestPromptMatches(threadId, jobPrompt(job));
      if (matches === false || (job.requiresPromptMatch && matches !== true))
        return;
      if (!error && text?.trim()) {
        const output = (await this.bb.sdk.threads.output({ threadId })).output;
        if (output?.trim() && output.trim() !== text.trim()) return;
      }
    } catch (cause) {
      if (missingThread(cause)) {
        this.complete(threadId, null, "The work conversation was deleted.");
        return;
      }
      this.bb.log.debug(
        `Persistent agent event verification failed: ${errorText(cause)}`,
      );
      return;
    }
    const current = this.activeJobForThread(threadId);
    if (
      current?.id !== job.id ||
      current.triggerMessageId !== job.triggerMessageId
    )
      return;
    this.complete(threadId, text, error);
  }
  complete(threadId: string, text: string | null, error?: string) {
    const c = this.store.byThread(threadId);
    if (!c) return;
    if (this.busy.get(c.agentId)?.threadId === threadId)
      this.busy.delete(c.agentId);
    const job = this.activeJobForThread(threadId);
    if (!job) return;
    if (error || (!text?.trim() && !job.outputAttachments.length)) {
      job.status = "error";
      job.error =
        error ||
        "The turn finished without an answer. Inspect the conversation.";
    } else {
      job.reply = passReply(text);
      job.status = "done";
      if (c.agentKind !== "thin" && job.agentKind !== "thin" && job.reply && job.reply !== "[PASS]") {
        const trigger = job.triggerMessageId ? this.store.message(job.triggerMessageId) : null;
        this.reportWork?.({
          job, conversation: c, reply: job.reply,
          request: trigger ? `${trigger.speaker}: ${trigger.text}` : job.text,
        });
      }
    }
    this.store.putJob(job);
    this.changed();
  }
  async cancel(
    job: Job,
    reason: string,
    requireStopped = false,
    timedOut = false,
  ) {
    job.cancellationPending =
      !!job.threadId ||
      job.status === "dispatching" ||
      !!job.cancellationPending;
    job.status = "cancelled";
    job.timedOut ||= timedOut;
    job.error = reason;
    this.store.putJob(job);
    if (job.threadId) {
      try {
        const queued = await this.bb.sdk.threads.queuedMessages.list({
          threadId: job.threadId,
        });
        for (const entry of queued)
          await this.bb.sdk.threads.queuedMessages.delete({
            threadId: job.threadId,
            queuedMessageId: entry.id,
          });
        await this.bb.sdk.threads.stop({ threadId: job.threadId });
      } catch (cause) {
        if (!missingThread(cause)) throw cause;
      }
      job.cancellationPending = false;
      this.store.putJob(job);
      if (this.busy.get(job.agentId)?.threadId === job.threadId)
        this.busy.delete(job.agentId);
    }
    if (requireStopped && this.store.job(job.id)?.cancellationPending)
      throw new Error(
        "Still locating a cancelled response. Try again after automatic cleanup finishes.",
      );
    this.changed();
  }
  async stopRoom(room: Room) {
    // Publish answers that already finished before archiving/cancelling pending work.
    await this.driveRoom(room);
    room = this.store.room(room.id);
    const next = { ...room, paused: false, updatedAt: Date.now() };
    this.store.putRoom(next);
    // Keep the run and roster retryable until host cleanup succeeds.
    for (const agent of this.store.all())
      await this.locked(agent.id, async () => {
        for (const job of this.store.work(agent.id))
          if (job.roomId === room.id)
            await this.cancel(job, "Channel archived by the owner.", true);
      });
    for (const run of this.store.runs(room.id))
      if (run.status === "queued" || run.status === "running") {
        run.status = "stopped";
        run.remaining = [];
        run.next = [];
        if (run.routing === "pending") {
          run.routing = "error";
          run.routingError =
            "Automatic routing stopped because the channel was archived.";
          run.routingAgentIds = [];
        }
        this.store.putRun(run);
      }
    this.changed();
    return next;
  }
  async retire(id: string, retired: boolean): Promise<ChannelAgent> {
    return this.locked("rooms", async () => {
      const roomIds = this.store
        .rooms()
        .map((r) => r.id)
        .sort();
      const lockRooms = async (i: number): Promise<ChannelAgent> => {
        if (i < roomIds.length)
          return this.locked(`room:${roomIds[i]}`, () => lockRooms(i + 1));
        return this.locked(id, async () => {
          const agent = this.store.get(id);
          if (!!agent.retired === retired) return agent;
          if (retired) {
            for (const job of this.store.work(id))
              await this.cancel(job, "Agent retired by the owner.", true);
            for (const c of this.store
              .conversations(id)
              .filter((c) => c.kind === "admin")) {
              try {
                for (const q of await this.bb.sdk.threads.queuedMessages.list({
                  threadId: c.threadId,
                }))
                  await this.bb.sdk.threads.queuedMessages.delete({
                    threadId: c.threadId,
                    queuedMessageId: q.id,
                  });
                await this.bb.sdk.threads.stop({ threadId: c.threadId });
              } catch (cause) {
                if (!missingThread(cause)) throw cause;
              }
            }
          }
          const next = await this.store.retire(id, retired);
          this.busy.delete(id);
          this.changed();
          return next;
        });
      };
      return lockRooms(0);
    });
  }
  async retryJob(id: string): Promise<Job> {
    const original = this.store.job(id);
    if (!original?.roomId)
      throw new Error("Only channel responses can be retried.");
    return this.locked(`room:${original.roomId}`, async () => {
      const job = this.store.job(id);
      if (!job?.roomId)
        throw new Error("This response is no longer available.");
      const room = this.store.room(job.roomId);
      if (room.archived)
        throw new Error("Restore this channel before retrying.");
      const agent = this.store.get(job.agentId);
      if (agent.retired || !room.memberIds.includes(agent.id))
        throw new Error("Invite this agent before retrying.");
      if (
        !["error", "cancelled"].includes(job.status) ||
        job.cancellationPending
      )
        throw new Error("Wait for this response to stop before retrying.");
      const retryId = `retry:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
      const existing = this.store.job(retryId);
      if (existing) return existing;
      const run = this.store.runs(room.id).find((r) => r.id === job.runId);
      if (!run) throw new Error("The original discussion was not found.");
      this.store.db.transaction(() => {
        this.enqueue(agent, {
          id: retryId,
          retryOf: id,
          delegationId: job.delegationId,
          returnOf: job.returnOf,
          dispatchAction: job.dispatchAction,
          forkSourceThreadId: job.forkSourceThreadId,
          ...(job.automationId ? { automationId: job.automationId } : {}),
          text: job.text,
          conversationKey: job.conversationKey,
          roomId: room.id,
          runId: run.id,
          triggerMessageId: job.triggerMessageId,
          depth: job.depth,
          attachments: job.attachments,
        });
        if (job.delegationId) {
          const group = this.delegations.get(job.delegationId);
          if (group?.status === "waiting") {
            group.deadlineAt = Math.max(
              group.deadlineAt,
              Date.now() + (agent.limits ?? defaultLimits).minutesPerTurn * 60000,
            );
            this.delegations.put(group);
          }
        }
        this.store.putRun({
          ...run,
          status: "running",
          pendingJobIds: [...run.pendingJobIds, retryId],
        });
      })();
      this.changed();
      return this.store.job(retryId)!;
    });
  }
  async deleteRoom(id: string): Promise<boolean> {
    return this.locked(`room:${id}`, async () => {
      if (!this.store.findRoom(id)) return false;
      // Wait for in-flight dispatches to finish registering their threads. Use
      // a stable lock order so simultaneous deletions cannot deadlock.
      const botIds = [
        ...new Set(this.store.roomJobs(id, -1).map((j) => j.agentId)),
      ].sort();
      const remove = async (index: number): Promise<boolean> => {
        if (index < botIds.length)
          return this.locked(botIds[index]!, () => remove(index + 1));
        const jobs = this.store.roomJobs(id, -1);
        if (jobs.some((j) => j.status === "dispatching" && !j.threadId))
          throw new Error(
            "An agent response is still being located. Check channel activity and try deleting again.",
          );
        for (const job of jobs) {
          // Retry interrupted cancellation too; don't delete the record until
          // BB confirms its queued input and active turn have both stopped.
          if (!["done", "error"].includes(job.status))
            await this.cancel(job, "Channel deleted by the owner.");
          if (this.store.job(job.id)?.cancellationPending)
            throw new Error(
              "Still locating a cancelled response. Try deleting again after cleanup finishes.",
            );
        }
        const deleted = this.store.db.transaction(() => {
          this.store.db
            .prepare("DELETE FROM channel_notifications WHERE room_id=?")
            .run(id);
          this.store.db
            .prepare("DELETE FROM delegations WHERE room_id=?")
            .run(id);
          this.store.db
            .prepare("DELETE FROM channel_context WHERE room_id=?")
            .run(id);
          this.store.db
            .prepare("DELETE FROM document_revisions WHERE scope=?")
            .run(`channel:${id}`);
          this.store.db
            .prepare("DELETE FROM routing_usage WHERE room_id=?")
            .run(id);
          return this.store.deleteRoom(id);
        })();
        this.changed();
        return deleted;
      };
      return remove(0);
    });
  }
  async roomJobsWithActivity(roomId: string): Promise<Job[]> {
    const jobs = this.store.roomJobs(roomId).map((job) => {
      const title =
        job.taskTitle ??
        (job.triggerMessageId
          ? this.store.message(job.triggerMessageId)?.text.slice(0, 240)
          : undefined);
      if (job.status !== "queued") return { ...job, taskTitle: title };
      const pending = this.store
        .work(job.agentId)
        .filter(
          (j) =>
            isForkConversation(j.conversationKey) ===
            isForkConversation(job.conversationKey),
        );
      const busy = this.busyDetails(job.agentId);
      const active = this.queuedJobTarget(job);
      return {
        ...job,
        taskTitle: title,
        queuePosition: pending.findIndex((j) => j.id === job.id) + 1,
        queueCanSteer: !!active,
        queueCanFork: !!active?.threadId,
        queueReason:
          this.store.get(job.agentId).error ??
          busy?.reason ??
          (isForkConversation(job.conversationKey)
            ? "Waiting for a fork slot"
            : "Waiting for this agent's earlier work"),
        ...(busy
          ? {
              busyThreadId: busy.threadId,
              busyConversationTitle: busy.title,
            }
          : {}),
      };
    });
    return Promise.all(
      jobs.map(async (job) => {
        if (!job.threadId || !["dispatching", "running"].includes(job.status))
          return job;
        try {
          const timeline = await this.bb.sdk.threads.timeline({
            threadId: job.threadId,
            includeNestedRows: "true",
            segmentLimit: "100",
          });
          const activitySnippet = activitySnippetFromTimeline(timeline);
          return activitySnippet ? { ...job, activitySnippet } : job;
        } catch (cause) {
          if (!missingThread(cause))
            this.bb.log.debug(
              `Channel activity refresh failed: ${errorText(cause)}`,
            );
          return job;
        }
      }),
    );
  }
  async driveRoom(room: Room) {
    if (room.archived) return;
    const runs = this.store.runs(room.id, -1, true);
    let changed = false;
    this.store.db.transaction(() => {
      for (const run of runs) {
        // Adopt unfinished discussions saved by the original sequential scheduler.
        if (run.mode !== "concurrent") {
          const trigger = this.store.message(run.id);
          run.pendingJobIds = run.jobId ? [run.jobId] : [];
          run.settledJobIds = [];
          run.mode = "concurrent";
          if (trigger)
            for (const id of [...new Set([...run.remaining, ...run.next])])
              this.invite(room, run, trigger, id, 0);
          run.remaining = [];
          run.next = [];
          run.jobId = null;
          changed = true;
        }
      }
      // Collect across discussions: the room follows completion order, not send order.
      const completed = runs
        .flatMap((run) =>
          run.pendingJobIds.flatMap((id) => {
            const job = this.store.job(id);
            return job && ["done", "error", "cancelled"].includes(job.status)
              ? [{ run, job }]
              : [];
          }),
        )
        .sort((a, b) => a.job.updatedAt - b.job.updatedAt);
      for (const { run, job } of completed) {
        changed = true;
        run.pendingJobIds = run.pendingJobIds.filter((id) => id !== job.id);
        if (run.settledJobIds.includes(job.id)) continue;
        run.settledJobIds.push(job.id);
        if (job.error) run.error = job.error;
        if (
          job.status !== "done" ||
          !room.memberIds.includes(job.agentId) ||
          ((!job.reply || job.reply.trim() === "[PASS]") &&
            !job.outputAttachments.length)
        )
          continue;
        const agent = this.store.get(job.agentId);
        const reply: RoomMessage = {
          id: job.id,
          roomId: room.id,
          runId: run.id,
          agentId: agent.id,
          conversationKey: job.conversationKey,
          ...(job.forkSourceThreadId
            ? { forkSourceThreadId: job.forkSourceThreadId }
            : {}),
          speaker: agent.name,
          ...(job.automationId ? { automationId: job.automationId } : {}),
          text: job.reply?.trim() === "[PASS]" ? "" : (job.reply ?? ""),
          createdAt: job.updatedAt,
          replyTo: job.triggerMessageId,
          attachments: job.outputAttachments,
        };
        if (this.store.putMessage(reply)) {
          const currentRoom = this.store.room(room.id);
          this.store.putRoom({
            ...currentRoom,
            updatedAt: Math.max(currentRoom.updatedAt + 1, Date.now()),
          });
          if (isAutoTitlePlaceholder(currentRoom.name))
            void this.applyRoomTitle(room.id, fallbackRoomTitle(reply));
        }
        if (job.depth < 2 && !job.returnOf) {
          const ancestors = this.delegations.ancestors(job);
          for (const id of room.memberIds)
            if (
              id !== agent.id &&
              !ancestors.has(id) &&
              directMention(reply.text, this.store.get(id).handle)
            )
              this.invite(room, run, reply, id, job.depth + 1);
          this.trackDelegation(reply, run, undefined, job);
        }
      }
      for (const run of runs) {
        run.status =
          run.pendingJobIds.length ||
          run.routing === "pending" ||
          (this.features.delegationReturns &&
            this.delegations.hasPending(run.id))
            ? "running"
            : "done";
        this.store.putRun(run);
      }
    })();
    if (changed) this.changed();
    if (this.features.delegationReturns) this.startReturns(room);
  }
  async reconcileBusy(agent: ChannelAgent) {
    const busy = this.busy.get(agent.id);
    if (busy && Date.now() - busy.at < 5000) return;
    const threadIds = new Set([
      ...this.store
        .conversations(agent.id)
        .filter((c) => c.kind === "admin")
        .map((c) => c.threadId),
      ...this.store
        .work(agent.id)
        .flatMap((j) =>
          j.threadId && !isForkConversation(j.conversationKey)
            ? [j.threadId]
            : [],
        ),
    ]);
    for (const threadId of threadIds) {
      let thread;
      try {
        thread = await this.bb.sdk.threads.get({ threadId });
      } catch (cause) {
        if (!missingThread(cause)) throw cause;
        this.complete(threadId, null, "The work conversation was deleted.");
        this.store.deleteConversation(threadId);
        continue;
      }
      if (thread.status === "active") {
        this.busy.set(agent.id, { threadId, at: Date.now() });
        return;
      }
    }
    this.busy.delete(agent.id);
  }
  async drive(agent: ChannelAgent, forkJob?: Job) {
    if (agent.kind === "thin")
      for (const conversation of this.store
        .conversations(agent.id)
        .filter((candidate) => candidate.kind === "mission"))
        this.store.deleteConversation(conversation.threadId);
    const job =
      forkJob ??
      this.store
        .work(agent.id)
        .find(
          (job) =>
            !isForkConversation(job.conversationKey) &&
            (job.cancellationPending || !agent.paused || !!job.roomId),
        );
    if (!job) return;
    if ((job.agentKind ?? "full") !== agent.kind) {
      if (isExecuting(job) || job.threadId) {
        await this.cancel(job, "Agent kind changed.");
        return;
      }
      job.agentKind = agent.kind;
      this.store.putJob(job);
    }
    if (agent.kind === "thin" && !job.roomId) {
      await this.cancel(
        job,
        "Thin agents do not run standing mission work.",
      );
      return;
    }
    if (job.pendingSteer && job.threadId && !job.cancellationPending) {
      await this.startSteer({ jobId: job.id });
      if (this.store.job(job.id)?.pendingSteer) {
        if (
          Date.now() -
            (job.startedAt ?? job.dispatchStartedAt ?? job.updatedAt) >
          (agent.limits ?? defaultLimits).minutesPerTurn * 60000
        )
          await this.cancel(
            this.store.job(job.id)!,
            "Correction delivery timed out. Inspect the conversation before retrying.",
            false,
            true,
          );
        return;
      }
      // Re-read the cleared marker before normal reconciliation on the next tick.
      return;
    }
    if (job.cancellationPending && job.threadId) {
      await this.cancel(job, job.error ?? "Cancelled by the owner.");
      return;
    }
    if (
      (job.status === "dispatching" || job.status === "running") &&
      job.threadId
    ) {
      let thread;
      try {
        thread = await this.bb.sdk.threads.get({ threadId: job.threadId });
      } catch (cause) {
        if (!missingThread(cause)) throw cause;
        const current = this.store.job(job.id);
        if (current && isExecuting(current)) {
          current.status = "error";
          current.error =
            "The work conversation was deleted. Retry this response to start again.";
          this.store.putJob(current);
        }
        this.store.deleteConversation(job.threadId);
        this.changed();
        return;
      }
      const queued = await this.bb.sdk.threads.queuedMessages.list({
        threadId: job.threadId,
      });
      const current = this.store.job(job.id)!;
      if (!["dispatching", "running"].includes(current.status)) return;
      current.dispatchStartedAt ??= current.updatedAt;
      const matching = queued.some((entry) =>
        entry.content.some(
          (block) => block.type === "text" && block.text === jobPrompt(current),
        ),
      );
      if (thread.status === "error") {
        const matches = await this.latestPromptMatches(
          job.threadId,
          jobPrompt(current),
        );
        if (
          matches === true ||
          (!current.requiresPromptMatch && matches !== false)
        )
          this.complete(
            job.threadId,
            null,
            "The agent turn failed. Inspect the conversation.",
          );
      } else if (thread.status === "active" || matching) {
        current.status = "running";
        if (thread.status === "active" && !current.startedAt)
          current.startedAt = Date.now();
        this.store.putJob(current);
      } else if (thread.status === "idle") {
        const matches = await this.latestPromptMatches(
          job.threadId,
          jobPrompt(current),
        );
        const output = (
          await this.bb.sdk.threads.output({ threadId: job.threadId })
        ).output;
        if (
          matches !== false &&
          (!current.requiresPromptMatch || matches === true) &&
          output?.trim()
        )
          this.complete(job.threadId, output);
        else if (
          matches === false ||
          !current.requiresPromptMatch ||
          matches === true
        )
          this.complete(
            job.threadId,
            null,
            "Dispatch outcome is unknown. Inspect the conversation before sending again.",
          );
      } else if (current.status === "dispatching")
        this.complete(
          job.threadId,
          null,
          "Dispatch outcome is unknown. Inspect the conversation before sending again.",
        );
      const latest = this.store.job(job.id)!;
      if (
        ["dispatching", "running"].includes(latest.status) &&
        Date.now() -
          (latest.startedAt ?? latest.dispatchStartedAt ?? latest.updatedAt) >
          (agent.limits ?? defaultLimits).minutesPerTurn * 60000
      )
        await this.cancel(
          latest,
          `Turn timed out after ${(agent.limits ?? defaultLimits).minutesPerTurn} minutes. Inspect the conversation before retrying.`,
          false,
          true,
        );
      return;
    }
    if (job.status === "dispatching" || job.cancellationPending) {
      const profile = this.profiles.getProfile(agent.id);
      const recoveryProjectId = profile.runProjectId
        ? (await this.profiles.fixedProjectEnvironment(profile)).projectId
        : agent.projectId;
      for (let offset = 0; ; offset += 100) {
        const threads = await this.bb.sdk.threads.list({
          projectId: recoveryProjectId,
          originPluginId: this.bb.pluginId,
          includeHidden: true,
          limit: 100,
          offset,
        });
        for (const thread of threads) {
          const metadata = await this.bb.sdk.threads.getPluginMetadata({
            threadId: thread.id,
          });
          const keys = new Set([
            job.conversationKey,
            `${job.conversationKey}:${job.id}`,
          ]);
          if (
            metadata.agentId !== agent.id ||
            typeof metadata.conversationKey !== "string" ||
            !keys.has(metadata.conversationKey)
          )
            continue;
          if (!this.store.byThread(thread.id))
            this.store.putConversation({
              id: randomUUID(),
              agentId: agent.id,
              key: metadata.conversationKey as string,
              threadId: thread.id,
              title: job.roomId ? this.store.room(job.roomId).name : "Mission",
              kind: job.roomId ? "group" : "mission",
              createdAt: job.createdAt,
            });
          const current = this.store.job(job.id)!;
          current.threadId = thread.id;
          this.store.putJob(current);
          if (current.status === "cancelled")
            await this.cancel(
              current,
              current.error ?? "Cancelled by the owner.",
            );
          this.changed();
          return;
        }
        if (threads.length < 100) break;
      }
      const current = this.store.job(job.id)!;
      if (current.cancellationPending)
        throw new Error(
          "Still locating a cancelled response. Host cleanup will retry automatically.",
        );
      if (current.status === "dispatching") {
        current.status = "error";
        current.error = [
          "Dispatch outcome is unknown. Inspect the conversation before sending again.",
          current.error,
        ]
          .filter(Boolean)
          .join(" ");
        this.store.putJob(current);
        this.changed();
      }
      return;
    }
    if (!forkJob && this.busy.has(agent.id)) return;
    if (
      job.forkSourceThreadId &&
      !this.store
        .conversations(agent.id)
        .some((c) => c.key === job.conversationKey)
    ) {
      const profile = this.profiles.getProfile(agent.id);
      const provider = (
        await this.bb.sdk.providers.list(
          !profile.runProjectId && agent.hostId ? { hostId: agent.hostId } : {},
        )
      ).find((p) => p.id === AGENTS_PROVIDER_ID);
      if (!provider?.capabilities.supportsFork) {
        job.status = "error";
        job.error = `Provider ${AGENTS_PROVIDER_ID} does not support session forks. Choose Follow-up or use a fork-capable provider.`;
        this.store.putJob(job);
        this.changed();
        return;
      }
    }
    for (const scope of [
      { agentId: agent.id, limits: agent.limits ?? defaultLimits },
      ...(job.roomId
        ? [
            {
              roomId: job.roomId,
              limits: this.store.room(job.roomId).limits ?? defaultLimits,
            },
          ]
        : []),
    ]) {
      const filter =
        "agentId" in scope ? "agent_id=?" : "json_extract(json,'$.roomId')=?";
      const scopeId = "agentId" in scope ? scope.agentId : scope.roomId;
      for (const [window, maximum, label] of [
        [3600000, scope.limits.turnsPerHour, "hour"],
        [86400000, scope.limits.turnsPerDay, "day"],
      ] as const) {
        const count = this.store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM jobs WHERE ${filter} AND COALESCE(json_extract(json,'$.startedAt'),json_extract(json,'$.dispatchStartedAt'))>?`,
          )
          .get(scopeId, Date.now() - window) as { n: number };
        if (count.n >= maximum)
          throw new Error(
            `${"agentId" in scope ? "Agent" : "Channel"} limit reached (${maximum} turns per ${label}). Queued work resumes when capacity is available.`,
          );
      }
    }
    if (job.roomId) this.prepareGroup(job, agent);
    job.requiresPromptMatch =
      !!job.forkSourceThreadId ||
      this.store
        .conversations(agent.id)
        .some((c) => c.key === job.conversationKey);
    job.status = "dispatching";
    job.dispatchStartedAt = Date.now();
    this.store.putJob(job);
    try {
      let c = this.store
        .conversations(agent.id)
        .find((candidate) => candidate.key === job.conversationKey);
      let fixedProjectId: string | null = null;
      if (c) {
        const cachedThreadId = c.threadId;
        try {
          const profile = this.profiles.getProfile(agent.id);
          fixedProjectId = profile.runProjectId
            ? (await this.profiles.fixedProjectEnvironment(profile)).projectId
            : null;
          const thread = await this.bb.sdk.threads.get({
            threadId: cachedThreadId,
          });
          // A pre-Agents thread is history-only; the replacement keeps continuity through the agent's DM memory.
          if (thread.providerId !== AGENTS_PROVIDER_ID
            || (fixedProjectId && thread.projectId !== fixedProjectId)) {
            this.store.deleteConversation(cachedThreadId);
            c = undefined;
          }
        } catch (cause) {
          if (!missingThread(cause)) throw cause;
          this.store.deleteConversation(cachedThreadId);
          c = undefined;
        }
      }
      if (!c)
        c = job.forkSourceThreadId
          ? await this.forkConversation(agent, job)
          : await this.conversation(
              agent,
              job.conversationKey,
              job.roomId ? "group" : "mission",
              job.roomId ? this.store.room(job.roomId).name : "Mission",
              jobPrompt(job),
              job.attachments,
            );
      else {
        // The dispatch hook runs during send and must already see this job.
        const pending = this.store.job(job.id)!;
        if (pending.status === "cancelled") return;
        pending.threadId = c.threadId;
        this.store.putJob(pending);
        if (fixedProjectId)
          await this.stageAttachments(fixedProjectId, job.attachments);
        await this.bb.sdk.threads.send({
          threadId: c.threadId,
          mode: "queue-if-active",
          input: jobInput(job),
        });
      }
      const current = this.store.job(job.id)!;
      current.threadId = c.threadId;
      if (current.status === "dispatching") current.status = "running";
      this.store.putJob(current);
      if (current.status === "cancelled")
        await this.cancel(current, current.error ?? "Cancelled by the owner.");
      else if (current.pendingSteer)
        await this.startSteer({ jobId: current.id });
    } catch (cause) {
      const current = this.store.job(job.id)!;
      if (current.status === "dispatching") {
        current.error = `Checking dispatch after: ${errorText(cause)}`;
        this.store.putJob(current);
      }
      if (!forkJob) this.busy.delete(agent.id);
    }
    this.changed();
  }
  async tick() {
    for (const room of this.store.rooms())
      await this.locked(`room:${room.id}`, async () => {
        const current = this.store.findRoom(room.id);
        if (current) {
          this.recoverPendingRouting(current);
          await this.driveRoom(current);
        }
      });
    for (const initial of this.store.all()) {
      if (this.abort.signal.aborted) return;
      await this.locked(initial.id, async () => {
        const agent = this.store.get(initial.id);
        try {
          await this.reconcileBusy(agent);
          const intervalMinutes = agent.intervalMinutes;
          if (
            !agent.retired &&
            agent.kind === "full" &&
            !agent.paused &&
            intervalMinutes !== null &&
            !this.busy.has(agent.id) &&
            Date.now() - agent.lastWakeAt >= intervalMinutes * 60_000
          )
            this.wake(agent);
          try {
            await this.drive(agent);
          } finally {
            await this.driveForks(agent);
          }
          if (agent.error) {
            this.store.put({ ...this.store.get(agent.id), error: null });
            this.changed();
          }
        } catch (cause) {
          const error = errorText(cause);
          if (agent.error !== error) {
            this.store.put({ ...this.store.get(agent.id), error });
            this.changed();
          }
        }
      });
    }
  }
  async dispose() {
    this.abort.abort();
    await Promise.allSettled(this.steerTasks.values());
    await Promise.allSettled(this.routingRequests.values());
    await Promise.allSettled(this.returnTasks.values());
    await Promise.allSettled(this.locks.values());
  }
}
