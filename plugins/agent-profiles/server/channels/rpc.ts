import { createHash, randomUUID } from "node:crypto";
import type {
  BbPluginApi,
  PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "../contract";
import type { Profiles } from "../profiles";
import type { Attachment, Room, RoomMessage } from "./contract";
import { imageMime } from "./image-format";
import { isExecuting } from "./job-state";
import { type MessageAuthor, Runtime, missingThread } from "./runtime";
import { MissingMessageError, type Store } from "./store";

export type ChannelRpcHandlers = Pick<
  PluginRpcHandlers<typeof rpcContract>,
  | "channelsList"
  | "channelSummaries"
  | "createRoom"
  | "updateRoom"
  | "deleteRoom"
  | "room"
  | "transcript"
  | "history"
  | "send"
  | "member"
  | "channelState"
  | "reaction"
  | "upload"
  | "discardAttachment"
  | "composer"
  | "transcribe"
  | "cancelJob"
  | "queuedJobAction"
  | "retryJob"
  | "stopRoom"
  | "resumeRoom"
  | "channelContext"
  | "saveChannelContext"
  | "contextHistory"
  | "channelFiles"
  | "artifactSummaries"
  | "channelArtifactReferences"
  | "usage"
  | "saveLimits"
  | "editMessage"
  | "saveMessage"
  | "savedMessages"
  | "agentActivity"
  | "setMissionSchedule"
  | "wake"
  | "pause"
  | "retire"
>;

export type SendMessage = (
  input: Parameters<ChannelRpcHandlers["send"]>[0],
  threadId?: string,
) => Promise<RoomMessage>;

type ResponseBehavior = "smart" | "directed";
type ChannelSettings = {
  defaultResponseBehavior(): Promise<ResponseBehavior>;
  rememberDefaultResponseBehavior(value: ResponseBehavior): Promise<void>;
};


// The fields of the Pages getPage result (plugins/pages/contract.ts pageDetailSchema) that a channel card shows.
const pageDetailSummarySchema = z.object({
  page: z.object({
    id: z.string().uuid(),
    title: z.string(),
    producer: z.string().nullable(),
  }),
  version: z.object({
    id: z.string().uuid(),
    n: z.number().int().positive(),
    createdAt: z.string(),
  }),
}).nullable();

export function channelSummaries(store: Store) {
  const activeRoomIds = new Set(store.summaryActiveRoomIds());
  return store
    .rooms()
    .filter((room) => !room.archived)
    .map((room) => ({
      id: room.id,
      name: room.name,
      pinned: room.pinned === true,
      unread: room.updatedAt > (room.lastReadAt ?? 0),
      active: activeRoomIds.has(room.id),
      memberCount: room.memberIds.length,
      updatedAt: room.updatedAt,
    }))
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.updatedAt - left.updatedAt ||
        left.id.localeCompare(right.id),
    );
}
function validateRoom(
  store: Store,
  name: string,
  memberIds: string[],
  currentId?: string,
) {
  if (new Set(memberIds).size !== memberIds.length)
    throw new Error("Choose each channel member once.");
  for (const agentId of memberIds) {
    const agent = store.get(agentId);
    if (agent.retired) throw new Error(`Restore @${agent.handle} before inviting it.`);
  }
  if (
    store.rooms().some(
      (room) =>
        room.id !== currentId &&
        room.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
    )
  )
    throw new Error("A channel with this name already exists.");
}

export function agentAuthor(
  store: Store,
  threadId: string,
  targetRoom?: string,
): MessageAuthor {
  const conversation = store.byThread(threadId);
  if (!conversation)
    return {
      agentId: null,
      speaker: "BB agent",
      sourceThreadId: threadId,
      depth: 0,
    };
  const agent = store.get(conversation.agentId);
  if (agent.retired) throw new Error("This agent is retired.");
  const job = store
    .work(agent.id)
    .find((candidate) => candidate.threadId === threadId && isExecuting(candidate));
  if (conversation.kind !== "admin" && !job)
    throw new Error("This agent's response is no longer active.");
  if (job?.roomId) {
    const source = store.room(job.roomId);
    if (source.archived || !source.memberIds.includes(agent.id))
      throw new Error("This agent is no longer active in its requesting channel.");
    if (targetRoom === source.id)
      throw new Error(
        "Your final answer is posted to this channel automatically. Use it to reply or @mention a teammate; do not send a duplicate message here.",
      );
  }
  return {
    agentId: agent.id,
    speaker: agent.name,
    sourceThreadId: threadId,
    ...(job ? { jobId: job.id } : {}),
    depth: job?.roomId ? job.depth + 1 : 0,
    ...(job?.automationId ? { automationId: job.automationId } : {}),
  };
}

export function authorizeChannel(
  store: Store,
  threadId: string,
  roomId: string,
) {
  const author = agentAuthor(store, threadId);
  if (author.agentId && !store.room(roomId).memberIds.includes(author.agentId))
    throw new Error("This agent must be invited to the channel before accessing it.");
  return author;
}

export function creatorMembers(
  store: Store,
  threadId: string,
  memberIds: string[],
) {
  const author = agentAuthor(store, threadId);
  const result = [
    ...new Set([...memberIds, ...(author.agentId ? [author.agentId] : [])]),
  ];
  if (result.length > 16)
    throw new Error("A channel can have up to 16 agents, including its creator.");
  return result;
}

export function channelReaction(
  store: Store,
  threadId: string,
  input: Parameters<ChannelRpcHandlers["reaction"]>[0],
) {
  const author = agentAuthor(store, threadId);
  const room = store.room(input.id);
  if (room.archived || (author.agentId && !room.memberIds.includes(author.agentId)))
    throw new Error("Join an active channel before reacting.");
  return store.react(
    input.id,
    input.messageId,
    input.emoji,
    author.agentId ?? `thread:${threadId}`,
    author.speaker,
    input.active,
  );
}

export function requestStatus(
  store: Store,
  roomId: string,
  requestId: string,
  limit = 20,
  offset = 0,
) {
  store.room(roomId);
  const message = store.message(requestId);
  if (!message || message.roomId !== roomId)
    throw new Error("Request not found in this channel.");
  const run = store.runs(roomId).find((candidate) => candidate.id === message.runId);
  if (!run) throw new Error("Request not found.");
  const jobs = store.requestJobs(run.id);
  const unfinished = jobs.filter(
    (job) =>
      !["done", "error", "cancelled"].includes(job.status) ||
      job.cancellationPending,
  );
  const superseded = new Map(
    jobs.filter((job) => job.retryOf).map((job) => [job.retryOf!, job.id]),
  );
  const latest = jobs.filter((job) => !superseded.has(job.id));
  return {
    channelId: roomId,
    requestId: run.id,
    complete:
      ["done", "stopped"].includes(run.status) && unfinished.length === 0,
    status: run.status,
    error:
      run.routingError ??
      (run.error?.includes("32-response limit")
        ? run.error
        : (latest.find((job) => job.status === "error")?.error ?? null)),
    total: jobs.length,
    pending: unfinished.length,
    failed: latest.filter((job) => job.status === "error").length,
    cancelled: latest.filter((job) => job.status === "cancelled").length,
    responses: jobs.slice(offset, offset + limit).map((job) => ({
      id: job.id,
      retryOf: job.retryOf ?? null,
      supersededBy: superseded.get(job.id) ?? null,
      agentId: job.agentId,
      name: store.get(job.agentId).name,
      status: job.status,
      cancellationPending: !!job.cancellationPending,
      threadId: job.threadId,
      messageId: store.message(job.id)?.id ?? null,
      reply: job.reply?.slice(0, 4_000) ?? null,
      truncated: (job.reply?.length ?? 0) > 4_000,
      error: job.error,
    })),
    nextOffset: offset + limit < jobs.length ? offset + limit : null,
  };
}

export function createChannelRpc(
  bb: BbPluginApi,
  store: Store,
  runtime: Runtime,
  profiles: Profiles,
  settings: ChannelSettings,
) {
  const sendMessage: SendMessage = (
    { id, text, attachmentIds, replyTo, requestId, sendMode },
    threadId,
  ) =>
    runtime.locked(`room:${id}`, async () => {
      const room = store.room(id);
      if (threadId) agentAuthor(store, threadId, id);
      const attachments = attachmentIds.map((attachmentId) => {
        const attachment = store.attachment(attachmentId);
        if (attachment.roomId !== id)
          throw new Error("Attachment belongs to a different channel.");
        return attachment;
      });
      const author = threadId ? agentAuthor(store, threadId, id) : undefined;
      if (store.message(requestId))
        return runtime.send(
          room,
          text,
          requestId,
          attachments,
          replyTo,
          author,
          undefined,
          sendMode,
        );
      if (room.archived)
        throw new Error("Restore this channel before sending a message.");
      if (!text.trim() && !attachments.length)
        throw new Error("Write a message or attach a file.");
      if (replyTo && store.message(replyTo)?.roomId !== id)
        throw new Error("Reply message not found in this channel.");
      for (const attachment of attachments) {
        if (attachment.path) continue;
        const bytes = store.stagedAttachment(attachment.id);
        if (!bytes)
          throw new Error("This draft attachment has expired. Attach the file again.");
        const uploaded = await bb.sdk.projects.attachments.upload({
          projectId: attachment.projectId,
          clientFile: bytes,
          filename: attachment.name,
          mimeType: attachment.mimeType,
        });
        attachment.path = uploaded.path;
        store.putAttachment(attachment);
      }
      return runtime.send(
        room,
        text,
        requestId,
        attachments,
        replyTo,
        author,
        undefined,
        sendMode,
      );
    });

  const handlers: ChannelRpcHandlers = {
    channelsList: async () => {
      await store.ensureProject();
      return {
        agents: store.all(),
        rooms: store.rooms(),
        activeRoomIds: store.activeRoomIds(),
      };
    },
    channelSummaries: () => channelSummaries(store),
    createRoom: async ({ name, memberIds, requestId, responseBehavior }) => {
      await store.ensureProject();
      const requestedBehavior = responseBehavior;
      return runtime.locked("rooms", async () => {
        const existing = requestId
          ? store.rooms().find((room) => room.id === requestId)
          : undefined;
        if (existing) {
          if (
            (name !== undefined && existing.name !== name) ||
            JSON.stringify(existing.memberIds) !== JSON.stringify(memberIds) ||
            (requestedBehavior !== undefined &&
              requestedBehavior !== existing.responseBehavior)
          )
            throw new Error(
              "Channel request ID was already used for different content.",
            );
          return existing;
        }
        if (name === undefined) {
          const names = new Set(store.rooms().map((room) => room.name.toLowerCase()));
          name = "New channel";
          for (let suffix = 2; names.has(name.toLowerCase()); suffix++)
            name = `New channel ${suffix}`;
        }
        validateRoom(store, name, memberIds);
        const behavior = requestedBehavior ??
          (await settings.defaultResponseBehavior());
        const now = Date.now();
        const room: Room = {
          id: requestId ?? randomUUID(),
          name,
          memberIds,
          responseBehavior: behavior,
          paused: false,
          createdAt: now,
          updatedAt: now,
        };
        store.putRoom(room);
        for (const agentId of memberIds) {
          const agent = store.get(agentId);
          runtime.postSystemMessage(
            room,
            `${agent.name} joined the channel.`,
            "bot_joined",
          );
        }
        runtime.changed();
        return store.room(room.id);
      });
    },
    updateRoom: async ({ id, name, memberIds: requestedMembers, responseBehavior }) => {
      await store.ensureProject();
      return runtime.locked("rooms", () =>
        runtime.locked(`room:${id}`, async () => {
          const room = store.room(id);
          const memberIds = requestedMembers ?? room.memberIds;
          validateRoom(store, name, memberIds, id);
          const behavior = responseBehavior;
          const removed = room.memberIds.filter(
            (memberId) => !memberIds.includes(memberId),
          );
          for (const job of removed.flatMap((agentId) =>
            store.work(agentId).filter((candidate) => candidate.roomId === id),
          ))
            if (
              removed.includes(job.agentId) &&
              (!["done", "error", "cancelled"].includes(job.status) ||
                job.cancellationPending)
            )
              await runtime.cancel(job, "Agent removed from the channel.", true);
          const next = {
            ...room,
            name,
            memberIds,
            ...(behavior ? { responseBehavior: behavior } : {}),
            updatedAt: Date.now(),
          };
          const added = memberIds.filter(
            (memberId) => !room.memberIds.includes(memberId),
          );
          store.putRoom(next);
          for (const agentId of added) {
            const agent = store.get(agentId);
            runtime.postSystemMessage(
              next,
              `${agent.name} joined the channel.`,
              "bot_joined",
            );
          }
          runtime.changed();
          return store.room(id);
        }),
      );
    },
    deleteRoom: async ({ id }) => ({ deleted: await runtime.deleteRoom(id) }),
    // A deleted channel is an expected state for open views, so it is data, not an error.
    room: async ({ id, start, limit }) => {
      const room = store.findRoom(id);
      if (!room) return { missing: "channel" as const };
      return {
        room,
        ...store.transcript(id, { start, limit }),
        runs: store.runs(id, 50),
        jobs: await runtime.roomJobsWithActivity(id),
        delegationWaits: runtime.delegations.waits(id),
      };
    },
    transcript: ({ id, ...options }) => {
      if (!store.findRoom(id)) return { missing: "channel" as const };
      try {
        return store.transcript(id, options);
      } catch (error) {
        if (error instanceof MissingMessageError) return { missing: "message" as const };
        throw error;
      }
    },
    history: ({ id, before, query, limit }) =>
      store.history(id, before, query, limit),
    send: (input) => sendMessage(input),
    member: ({ id, agentId, present }) =>
      runtime.locked(`room:${id}`, async () => {
        const room = store.room(id);
        const agent = store.get(agentId);
        if (present && agent.retired)
          throw new Error("Restore this agent before inviting it.");
        if (room.archived)
          throw new Error("Restore this channel before changing members.");
        const added = present && !room.memberIds.includes(agentId);
        const memberIds = present
          ? [...new Set([...room.memberIds, agentId])]
          : room.memberIds.filter((memberId) => memberId !== agentId);
        if (memberIds.length > 16)
          throw new Error("A channel can have up to 16 agents.");
        const next = { ...room, memberIds, updatedAt: Date.now() };
        if (!present)
          await runtime.locked(agentId, async () => {
            for (const job of store.work(agentId).filter((job) => job.roomId === id))
              await runtime.cancel(job, "Agent removed from the channel.", true);
          });
        store.putRoom(next);
        if (added)
          runtime.postSystemMessage(
            next,
            `${agent.name} joined the channel.`,
            "bot_joined",
          );
        runtime.changed();
        return store.room(id);
      }),
    channelState: ({ id, rememberDefault, ...patch }) =>
      runtime.locked(`room:${id}`, async () => {
        const responseBehavior = patch.responseBehavior;
        if (responseBehavior && rememberDefault)
          await settings.rememberDefaultResponseBehavior(responseBehavior);
        const normalizedPatch = {
          ...patch,
          ...(responseBehavior ? { responseBehavior } : {}),
        };
        let room = store.room(id);
        if (normalizedPatch.archived) room = await runtime.stopRoom(room);
        const next = {
          ...room,
          ...normalizedPatch,
          ...(normalizedPatch.lastReadAt !== undefined
            ? {
                lastReadAt: Math.max(
                  room.lastReadAt ?? 0,
                  Math.min(room.updatedAt, normalizedPatch.lastReadAt),
                ),
              }
            : {}),
        };
        store.putRoom(next);
        runtime.changed();
        return next;
      }),
    reaction: ({ id, messageId, emoji, active }) => {
      const reactions = store.react(
        id,
        messageId,
        emoji,
        "user",
        "You",
        active,
      );
      runtime.changed();
      return reactions;
    },
    upload: ({ id, name, mimeType, data }) =>
      runtime.locked(`room:${id}`, async () => {
        store.room(id);
        const projectId = await store.ensureProject();
        const bytes = Buffer.from(data, "base64");
        if (!bytes.length || bytes.length > 8 * 1024 * 1024)
          throw new Error("Attachments must be between 1 byte and 8 MB.");
        const hash = createHash("sha256")
          .update(JSON.stringify([id, name, mimeType]))
          .update(bytes)
          .digest("hex");
        const attachmentId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        try {
          return store.attachment(attachmentId);
        } catch {
          // New content continues below.
        }
        const detectedImage = imageMime(bytes);
        const attachment: Attachment = {
          id: attachmentId,
          roomId: id,
          projectId,
          name,
          path: "",
          mimeType: detectedImage ?? mimeType,
          type: detectedImage ? "localImage" : "localFile",
          sizeBytes: bytes.length,
        };
        store.stageAttachment(attachment, bytes);
        return attachment;
      }),
    discardAttachment: ({ id, attachmentId }) =>
      runtime.locked(`room:${id}`, async () => {
        const attachment = store.attachment(attachmentId);
        if (attachment.roomId !== id)
          throw new Error("Attachment belongs to a different channel.");
        store.discardAttachment(attachmentId);
        return { ok: true as const };
      }),
    composer: async () => ({
      voiceEnabled: (await bb.sdk.system.config()).voiceTranscriptionEnabled,
    }),
    transcribe: async ({ data, mimeType, prompt }) => {
      if (!(await bb.sdk.system.config()).voiceTranscriptionEnabled)
        throw new Error("Enable voice transcription in BB settings to use dictation.");
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.length > 5 * 1024 * 1024)
        throw new Error("Recording is empty or exceeds 5 MB.");
      return bb.sdk.system.transcribeVoice({
        file: new File(
          [bytes],
          mimeType.includes("mp4") ? "dictation.mp4" : "dictation.webm",
          { type: mimeType },
        ),
        prompt,
      });
    },
    cancelJob: ({ id }) =>
      runtime.locked("cancel", async () => {
        const initial = store.job(id);
        if (!initial) throw new Error("Work item not found.");
        return runtime.locked(initial.agentId, async () => {
          const job = store.job(id);
          if (!job) throw new Error("Work item not found.");
          if (
            ["done", "error", "cancelled"].includes(job.status) &&
            !job.cancellationPending
          )
            return { cancelled: false };
          await runtime.cancel(job, "Cancelled by the owner.");
          return { cancelled: true };
        });
      }),
    queuedJobAction: ({ jobId, action }) =>
      runtime.queuedJobAction(jobId, action),
    retryJob: ({ id }) => runtime.retryJob(id),
    stopRoom: ({ id }) =>
      runtime.locked(`room:${id}`, () => runtime.stopRoom(store.room(id))),
    resumeRoom: ({ id }) =>
      runtime.locked(`room:${id}`, async () => {
        const room = {
          ...store.room(id),
          paused: false,
          updatedAt: Date.now(),
        };
        store.putRoom(room);
        runtime.changed();
        return room;
      }),
    channelContext: ({ id }) => runtime.data.context(id),
    saveChannelContext: ({ id, version, ...content }) =>
      runtime.locked(`room:${id}`, async () => {
        if (store.room(id).archived)
          throw new Error("Restore this channel before editing context.");
        const value = runtime.data.saveContext(id, content, version, "You");
        runtime.changed();
        return value;
      }),
    contextHistory: ({ id, before }) => {
      store.room(id);
      return runtime.data.revisions(`channel:${id}`, before);
    },
    channelFiles: ({ id, before }) => runtime.data.files(id, before),
    artifactSummaries: async ({ references }) =>
      Promise.all(references.map(async (reference) => {
        try {
          const detail = await bb.sdk.plugins.callRpc({
            pluginId: "pages",
            method: "getPage",
            input: {
              pageId: reference.id,
              versionId: reference.revision,
            },
            outputSchema: pageDetailSummarySchema,
          });
          if (
            !detail ||
            detail.page.id !== reference.id ||
            detail.version.id !== reference.revision
          ) return { ...reference, available: false as const };
          return {
            ...reference,
            available: true as const,
            title: detail.page.title,
            kind: detail.page.producer === "pr-review" ? "pr-review" as const : "report" as const,
            sequence: detail.version.n,
            revisionCreatedAt: detail.version.createdAt,
          };
        } catch {
          return { ...reference, available: false as const };
        }
      })),
    channelArtifactReferences: ({ id }) => runtime.data.artifactReferences(id),
    usage: ({ id, kind }) =>
      runtime.data.usage(
        kind === "channel" ? id : undefined,
        kind === "agent" ? id : undefined,
      ),
    saveLimits: ({ id, kind, limits }) =>
      runtime.locked(kind === "channel" ? `room:${id}` : id, async () => {
        if (kind === "channel") store.putRoom({ ...store.room(id), limits });
        else {
          const agent = store.get(id);
          store.put({
            ...agent,
            limits,
            updatedAt: Math.max(Date.now(), agent.updatedAt + 1),
          });
        }
        runtime.changed();
        return runtime.data.usage(
          kind === "channel" ? id : undefined,
          kind === "agent" ? id : undefined,
        );
      }),
    editMessage: ({ id, messageId, text, expectedText }) =>
      runtime.locked(`room:${id}`, async () => {
        const message = store.message(messageId);
        if (
          !message ||
          message.roomId !== id ||
          message.agentId ||
          message.sourceThreadId ||
          message.automationId ||
          message.system
        )
          throw new Error("Only your own messages can be edited.");
        if (store.room(id).archived)
          throw new Error("Restore this channel before editing messages.");
        if (message.text !== expectedText)
          throw new Error("This message changed. Reload before editing.");
        const next = {
          ...message,
          sentText: message.sentText ?? message.text,
          text,
          editedAt: Date.now(),
        };
        store.db
          .prepare("UPDATE room_messages SET json = ? WHERE id = ?")
          .run(JSON.stringify(next), message.id);
        runtime.changed();
        return next;
      }),
    saveMessage: ({ id, messageId, saved }) => {
      store.room(id);
      const message = store.message(messageId);
      if (
        !message ||
        message.roomId !== id ||
        message.system ||
        (message.automationId && !message.agentId)
      )
        throw new Error("Message not found.");
      const next = { ...message, saved };
      store.db
        .prepare("UPDATE room_messages SET json = ? WHERE id = ?")
        .run(JSON.stringify(next), message.id);
      runtime.changed();
      return next;
    },
    savedMessages: ({ id, before }) => {
      store.room(id);
      return (
        store.db
          .prepare(
            `SELECT json FROM room_messages
             WHERE room_id = ? AND json_extract(json, '$.saved') = 1
               AND (? IS NULL OR rowid < (
                 SELECT rowid FROM room_messages WHERE id = ? AND room_id = ?
               ))
             ORDER BY rowid DESC LIMIT 50`,
          )
          .all(id, before ?? null, before ?? null, id) as Array<{ json: string }>
      ).map((row) => JSON.parse(row.json));
    },
    agentActivity: async ({ id }) => {
      await store.ensureProject();
      return {
        agent: store.get(id),
        conversations: store.conversations(id),
        jobs: store.jobs(id, 50),
      };
    },
    setMissionSchedule: async ({ id, intervalMinutes }) => {
      if (profiles.getProfile(id).kind === "thin")
        throw new Error("Thin agents do not have mission schedules.");
      await store.ensureProject();
      return runtime.locked(id, async () => {
        const agent = store.setMissionSchedule(id, intervalMinutes);
        runtime.changed();
        return agent;
      });
    },
    wake: async ({ id }) => {
      if (profiles.getProfile(id).kind === "thin")
        throw new Error("Thin agents do not have standing missions to wake.");
      await store.ensureProject();
      return runtime.locked(id, async () => ({ queued: runtime.wake(store.get(id)) }));
    },
    pause: async ({ id, paused }) => {
      if (profiles.getProfile(id).kind === "thin")
        throw new Error("Thin agents cannot be paused or resumed.");
      await store.ensureProject();
      return runtime.locked(id, async () => {
        const agent = store.get(id);
        if (agent.retired && !paused)
          throw new Error("Restore this agent before resuming its mission.");
        await store.setPaused(id, paused);
        if (paused) {
          for (const job of store.work(id).filter((candidate) => !candidate.roomId))
            await runtime.cancel(job, "Agent paused by the owner.");
          for (const conversation of store
            .conversations(id)
            .filter((candidate) => candidate.kind !== "group")) {
            try {
              await bb.sdk.threads.stop({ threadId: conversation.threadId });
            } catch (cause) {
              if (!missingThread(cause)) throw cause;
            }
          }
          if (
            !store
              .work(id)
              .some(
                (job) =>
                  job.roomId && job.threadId === runtime.busy.get(id)?.threadId,
              )
          )
            runtime.busy.delete(id);
        } else {
          await bb.experimental_hooks.recheck("message.dispatch");
        }
        runtime.changed();
        return store.get(id);
      });
    },
    retire: async ({ id, retired }) => {
      await store.ensureProject();
      const agent = await runtime.retire(id, retired);
      bb.realtime.publish("profiles-changed", {
        reason: retired ? "retired" : "restored",
        profileId: id,
      });
      return agent;
    },
  };

  return { handlers, sendMessage };
}

export function registerAttachmentRoute(bb: BbPluginApi, store: Store) {
  bb.http.route("GET", "/attachment", async (context) => {
    try {
      const attachment = store.attachment(context.req.query("id") ?? "");
      const staged = store.stagedAttachment(attachment.id);
      const result = staged
        ? { bytes: staged, mimeType: attachment.mimeType || "application/octet-stream" }
        : await bb.sdk.projects.attachments.read({
            projectId: attachment.projectId,
            path: attachment.path,
          });
      const detectedImage = imageMime(result.bytes);
      const inline = context.req.query("inline") === "1" && detectedImage;
      return new Response(new Uint8Array(result.bytes), {
        headers: {
          "Content-Type": detectedImage || "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch {
      return context.text("Attachment not found", 404);
    }
  });
}
