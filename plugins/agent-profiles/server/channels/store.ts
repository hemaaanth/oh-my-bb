import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import {
  attachmentSchema,
  conversationSchema,
  isAutomationTrigger,
  jobSchema,
  messageSchema,
  roomSchema,
  runSchema,
  type Attachment,
  type ChannelAgent,
  type Conversation,
  type Job,
  type Reaction,
  type Room,
  type RoomMessage,
  type RoomRun,
} from "./contract";
import {
  TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_WINDOW_SIZE,
  type TranscriptPage,
} from "./transcript-window";
import { usageLimits } from "./workspace-contract";

const HOMES_PROJECT_KEY = "homes-project-id";
const PAUSED_KEY_PREFIX = "channel-agent-paused:";

function storedRoom(json: string): Room {
  const value = JSON.parse(json) as unknown;
  if (
    value &&
    typeof value === "object" &&
    "responseBehavior" in value &&
    value.responseBehavior === "everyone"
  )
    return roomSchema.parse({ ...value, responseBehavior: "smart" });
  return roomSchema.parse(value);
}


type AgentRow = {
  id: string;
  slug: string;
  kind: ChannelAgent["kind"];
  name: string;
  avatar: string;
  description: string;
  provider_id: string;
  model: string;
  reasoning_level: ChannelAgent["reasoningLevel"];
  service_tier: ChannelAgent["serviceTier"];
  permission_mode: ChannelAgent["permissionMode"];
  home_host_id: string | null;
  retired: number;
  limits: string | null;
  last_wake_at: number | null;
  interval_minutes: number | null;
  runtime_error: string | null;
  created_at: string;
  updated_at: string;
};

/** An expected "the cursor message is gone" condition, which the RPC layer reports as data. */
export class MissingMessageError extends Error {
  constructor() {
    super("Message not found in this channel.");
  }
}

export class Store {
  readonly root: string;
  private projectId: string | null;
  private projectPromise: Promise<string> | null = null;

  private constructor(
    private readonly bb: BbPluginApi,
    readonly db: Database.Database,
    projectId: string | null,
    private readonly pausedByAgent: Map<string, boolean>,
  ) {
    this.root = join(dirname(db.name), "homes");
    this.projectId = projectId;
  }

  static async create(bb: BbPluginApi, db: Database.Database) {
    const [projectId, pausedKeys] = await Promise.all([
      bb.storage.kv.get<string>(HOMES_PROJECT_KEY),
      bb.storage.kv.list(PAUSED_KEY_PREFIX),
    ]);
    const pausedByAgent = new Map<string, boolean>();
    await Promise.all(
      pausedKeys.map(async (key) => {
        const paused = await bb.storage.kv.get<boolean>(key);
        if (paused !== undefined)
          pausedByAgent.set(key.slice(PAUSED_KEY_PREFIX.length), paused);
      }),
    );
    return new Store(bb, db, projectId ?? null, pausedByAgent);
  }

  async ensureProject() {
    if (this.projectId) return this.projectId;
    if (!this.projectPromise) {
      this.projectPromise = (async () => {
        const existing = await this.bb.storage.kv.get<string>(HOMES_PROJECT_KEY);
        if (existing) return existing;
        const { primaryHostId } = await this.bb.sdk.system.config();
        if (!primaryHostId)
          throw new Error(
            "BB needs a connected primary machine for agent channel files.",
          );
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const project = await this.bb.sdk.projects.create({
          name: "Agents",
          source: {
            type: "local_path",
            hostId: primaryHostId,
            path: this.root,
          },
        });
        await this.bb.storage.kv.set(HOMES_PROJECT_KEY, project.id);
        return project.id;
      })()
        .then((id) => {
          this.projectId = id;
          return id;
        })
        .finally(() => {
          this.projectPromise = null;
        });
    }
    return this.projectPromise;
  }

  private agent(row: AgentRow): ChannelAgent {
    if (!this.projectId)
      throw new Error("Initialize the Agents homes project before loading channel agents.");
    const paused = this.pausedByAgent.get(row.id) ?? true;
    const retired = Boolean(row.retired);
    const intervalMinutes = row.interval_minutes;
    const lastWakeAt = row.last_wake_at ?? 0;
    return {
      id: row.id,
      kind: row.kind,
      handle: row.slug,
      name: row.name,
      avatar: row.avatar,
      description: row.description,
      providerId: row.provider_id,
      model: row.model,
      reasoningLevel: row.reasoning_level,
      serviceTier: row.service_tier,
      permissionMode: row.permission_mode,
      home: row.kind === "thin"
        ? join(this.root, row.id, "files")
        : join(this.root, row.id),
      hostId: row.home_host_id,
      projectId: this.projectId,
      paused,
      retired,
      ...(row.limits
        ? { limits: usageLimits.parse(JSON.parse(row.limits)) }
        : {}),
      intervalMinutes,
      lastWakeAt,
      nextWakeAt:
        row.kind === "full" &&
        intervalMinutes !== null && !paused && !retired
          ? lastWakeAt + intervalMinutes * 60_000
          : null,
      error: row.runtime_error,
      createdAt: Date.parse(row.created_at),
      updatedAt: Date.parse(row.updated_at),
    };
  }

  all(): ChannelAgent[] {
    return (
      this.db
        .prepare("SELECT * FROM profiles ORDER BY rowid")
        .all() as AgentRow[]
    ).map((row) => this.agent(row));
  }

  missionSchedule(id: string) {
    const row = this.db
      .prepare(
        "SELECT interval_minutes, last_wake_at, retired FROM profiles WHERE id = ?",
      )
      .get(id) as
      | {
        interval_minutes: number | null;
        last_wake_at: number | null;
        retired: number;
      }
      | undefined;
    if (!row) throw new Error("Agent not found");
    const intervalMinutes = row.interval_minutes;
    const lastWakeAt = row.last_wake_at ?? 0;
    const paused = this.pausedByAgent.get(id) ?? true;
    const retired = Boolean(row.retired);
    return {
      intervalMinutes,
      paused,
      retired,
      nextWakeAt:
        intervalMinutes !== null && !paused && !retired
          ? lastWakeAt + intervalMinutes * 60_000
          : null,
    };
  }

  get(id: string): ChannelAgent {
    const row = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as
      | AgentRow
      | undefined;
    if (!row) throw new Error("Agent not found");
    return this.agent(row);
  }

  put(agent: ChannelAgent) {
    const result = this.db
      .prepare(
        "UPDATE profiles SET retired = ?, limits = ?, last_wake_at = ?, runtime_error = ? WHERE id = ?",
      )
      .run(
        agent.retired ? 1 : 0,
        agent.limits ? JSON.stringify(agent.limits) : null,
        agent.lastWakeAt || null,
        agent.error,
        agent.id,
      );
    if (!result.changes) throw new Error("Agent not found");
  }

  async setPaused(id: string, paused: boolean) {
    this.get(id);
    await this.bb.storage.kv.set(`${PAUSED_KEY_PREFIX}${id}`, paused);
    this.pausedByAgent.set(id, paused);
    return this.get(id);
  }

  async clearPaused(id: string) {
    await this.bb.storage.kv.delete(`${PAUSED_KEY_PREFIX}${id}`);
    this.pausedByAgent.delete(id);
  }

  setMissionSchedule(id: string, intervalMinutes: number | null) {
    const current = this.get(id);
    if (current.kind === "thin")
      throw new Error("Thin agents do not have mission schedules.");
    if (current.intervalMinutes === intervalMinutes) return current;
    const lastWakeAt = intervalMinutes === null ? current.lastWakeAt : Date.now();
    const result = this.db
      .prepare(
        "UPDATE profiles SET interval_minutes = ?, last_wake_at = ? WHERE id = ?",
      )
      .run(intervalMinutes, lastWakeAt || null, id);
    if (!result.changes) throw new Error("Agent not found");
    return this.get(id);
  }

  async retire(id: string, retired: boolean) {
    const current = this.get(id);
    if (current.retired === retired) return current;
    const next = { ...current, retired, paused: retired ? true : current.paused };
    this.db.transaction(() => {
      this.put(next);
      if (retired) {
        for (const room of this.rooms()) {
          if (!room.memberIds.includes(id)) continue;
          this.putRoom({
            ...room,
            memberIds: room.memberIds.filter((agentId) => agentId !== id),
            updatedAt: Math.max(Date.now(), room.updatedAt + 1),
          });
        }
      }
    })();
    if (retired) await this.setPaused(id, true);
    return this.get(id);
  }


  conversations(id: string): Conversation[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM conversations WHERE agent_id = ? ORDER BY rowid DESC",
        )
        .all(id) as Array<{ json: string }>
    ).map((row) => conversationSchema.parse(JSON.parse(row.json)));
  }

  byThread(id: string): Conversation | null {
    const row = this.db
      .prepare("SELECT json FROM conversations WHERE thread_id = ?")
      .get(id) as { json: string } | undefined;
    return row ? conversationSchema.parse(JSON.parse(row.json)) : null;
  }

  putConversation(conversation: Conversation) {
    const value = conversationSchema.parse(conversation);
    this.db
      .prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)")
      .run(
        value.id,
        value.agentId,
        value.key,
        value.threadId,
        JSON.stringify(value),
      );
  }

  deleteConversation(threadId: string) {
    this.db
      .prepare("DELETE FROM conversations WHERE thread_id = ?")
      .run(threadId);
  }

  jobs(id: string, limit = 100): Job[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM jobs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        )
        .all(id, limit) as Array<{ json: string }>
    ).map((row) => jobSchema.parse(JSON.parse(row.json)));
  }

  work(id: string): Job[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM jobs WHERE agent_id = ? AND (status NOT IN ('done', 'error', 'cancelled') OR json_extract(json, '$.cancellationPending') = 1) ORDER BY created_at, rowid",
        )
        .all(id) as Array<{ json: string }>
    ).map((row) => jobSchema.parse(JSON.parse(row.json)));
  }

  job(id: string): Job | null {
    const row = this.db.prepare("SELECT json FROM jobs WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? jobSchema.parse(JSON.parse(row.json)) : null;
  }

  enqueue(job: Job) {
    const value = jobSchema.parse(job);
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?, ?)")
        .run(
          value.id,
          value.agentId,
          value.status,
          value.createdAt,
          JSON.stringify(value),
        ).changes > 0
    );
  }

  putJob(job: Job) {
    job.updatedAt = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE jobs SET status = ?, json = ? WHERE id = ?")
        .run(job.status, JSON.stringify(jobSchema.parse(job)), job.id);
      if (job.status === "error" && job.roomId)
        this.queueNotification(`error:${job.id}`, job.roomId, "error", job.id);
    })();
  }

  rooms(): Room[] {
    return (
      this.db.prepare("SELECT json FROM rooms ORDER BY rowid DESC").all() as Array<{
        json: string;
      }>
    ).map((row) => storedRoom(row.json));
  }

  activeRoomIds(): string[] {
    return (
      this.db
        .prepare(`
          SELECT id FROM rooms WHERE id IN (
            SELECT json_extract(json, '$.roomId') FROM jobs
            WHERE status IN ('queued', 'dispatching', 'running')
              OR json_extract(json, '$.cancellationPending') = 1
            UNION
            SELECT room_id FROM room_runs
            WHERE json_extract(json, '$.status') IN ('queued', 'running')
          ) ORDER BY id
        `)
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  summaryActiveRoomIds(): string[] {
    return (
      this.db
        .prepare(`
          SELECT id FROM rooms WHERE id IN (
            SELECT json_extract(json, '$.roomId') FROM jobs
            WHERE status IN ('dispatching', 'running')
            UNION
            SELECT room_id FROM room_runs
            WHERE json_extract(json, '$.status') = 'running'
              OR json_extract(json, '$.routing') = 'pending'
          ) ORDER BY id
        `)
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  room(id: string): Room {
    const room = this.findRoom(id);
    if (!room) throw new Error("Channel not found");
    return room;
  }

  findRoom(id: string): Room | null {
    const row = this.db.prepare("SELECT json FROM rooms WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? storedRoom(row.json) : null;
  }

  deleteRoom(id: string) {
    return this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM reactions WHERE message_id IN (SELECT id FROM room_messages WHERE room_id = ?)",
        )
        .run(id);
      this.db
        .prepare(
          "DELETE FROM draft_uploads WHERE id IN (SELECT id FROM attachments WHERE json_extract(json, '$.roomId') = ?)",
        )
        .run(id);
      this.db
        .prepare("DELETE FROM attachments WHERE json_extract(json, '$.roomId') = ?")
        .run(id);
      this.db.prepare("DELETE FROM jobs WHERE json_extract(json, '$.roomId') = ?").run(id);
      this.db
        .prepare("DELETE FROM conversations WHERE key = ? OR substr(key, 1, ?) = ?")
        .run(`group:${id}`, `group:${id}:`.length, `group:${id}:`);
      this.db.prepare("DELETE FROM delegations WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM channel_context WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM channel_notifications WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM routing_usage WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM room_runs WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM room_messages WHERE room_id = ?").run(id);
      return this.db.prepare("DELETE FROM rooms WHERE id = ?").run(id).changes > 0;
    })();
  }

  putRoom(room: Room) {
    const value = roomSchema.parse(room);
    this.db
      .prepare(
        "INSERT INTO rooms VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      )
      .run(value.id, JSON.stringify(value));
  }

  messages(roomId: string, limit = 200, offset = 0): RoomMessage[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM (SELECT rowid, json FROM room_messages WHERE room_id = ? ORDER BY rowid DESC LIMIT ? OFFSET ?) ORDER BY rowid",
        )
        .all(roomId, limit, offset) as Array<{ json: string }>
    ).map((row) => messageSchema.parse(JSON.parse(row.json)));
  }

  visibleMessages(roomId: string, limit = 200, offset = 0): RoomMessage[] {
    return (
      this.db
        .prepare(
          `SELECT json FROM (
            SELECT rowid, json FROM room_messages
            WHERE room_id = ?
              AND NOT (json_extract(json, '$.automationId') IS NOT NULL
                AND json_extract(json, '$.agentId') IS NULL)
            ORDER BY rowid DESC LIMIT ? OFFSET ?
          ) ORDER BY rowid`,
        )
        .all(roomId, limit, offset) as Array<{ json: string }>
    ).map((row) => messageSchema.parse(JSON.parse(row.json)));
  }

  firstMessage(roomId: string): RoomMessage | null {
    const row = this.db
      .prepare(
        `SELECT json FROM room_messages
         WHERE room_id = ?
           AND NOT (json_extract(json, '$.automationId') IS NOT NULL
             AND json_extract(json, '$.agentId') IS NULL)
           AND json_extract(json, '$.system') IS NULL
         ORDER BY rowid ASC LIMIT 1`,
      )
      .get(roomId) as { json: string } | undefined;
    return row ? messageSchema.parse(JSON.parse(row.json)) : null;
  }

  parents(messages: RoomMessage[]) {
    return [
      ...new Set(messages.flatMap((message) => (message.replyTo ? [message.replyTo] : []))),
    ].flatMap((id) => {
      const message = this.message(id);
      return message && !isAutomationTrigger(message) ? [message] : [];
    });
  }

  history(roomId: string, before?: string, query = "", limit = 50) {
    this.room(roomId);
    let cursor = Number.MAX_SAFE_INTEGER;
    if (before) {
      const row = this.db
        .prepare("SELECT rowid FROM room_messages WHERE id = ? AND room_id = ?")
        .get(before, roomId) as { rowid: number } | undefined;
      if (!row) throw new Error("Message cursor not found in this channel.");
      cursor = row.rowid;
    }
    const rows = (
      this.db
        .prepare(
          `SELECT json FROM room_messages WHERE room_id = ? AND rowid < ?
            AND NOT (json_extract(json, '$.automationId') IS NOT NULL
              AND json_extract(json, '$.agentId') IS NULL)
            AND (? = ''
              OR instr(lower(json_extract(json, '$.text')), lower(?)) > 0
              OR instr(lower(json_extract(json, '$.speaker')), lower(?)) > 0)
            ORDER BY rowid DESC LIMIT ?`,
        )
        .all(roomId, cursor, query, query, query, limit + 1) as Array<{
        json: string;
      }>
    ).map((row) => messageSchema.parse(JSON.parse(row.json)));
    const messages = rows.slice(0, limit).reverse();
    return {
      messages,
      parents: this.parents(messages),
      nextBefore: rows.length > limit ? messages[0]!.id : null,
    };
  }

  transcript(
    roomId: string,
    options: {
      before?: string;
      after?: string;
      around?: string;
      start?: string;
      limit?: number;
    } = {},
  ): TranscriptPage {
    this.room(roomId);
    const limit = Math.max(
      1,
      Math.min(options.limit ?? TRANSCRIPT_PAGE_SIZE, TRANSCRIPT_WINDOW_SIZE),
    );
    const visible = `room_id = ? AND NOT (
      json_extract(json, '$.automationId') IS NOT NULL
      AND json_extract(json, '$.agentId') IS NULL
    )`;
    const cursorId =
      options.before ?? options.after ?? options.around ?? options.start;
    const cursor =
      cursorId === undefined
        ? undefined
        : (this.db
            .prepare(`SELECT rowid FROM room_messages WHERE id = ? AND ${visible}`)
            .get(cursorId, roomId) as { rowid: number } | undefined);
    if (cursorId !== undefined && !cursor) throw new MissingMessageError();

    type Row = { rowid: number; json: string };
    const select = (
      condition: string,
      ascending: boolean,
      count: number,
      value?: number,
    ) =>
      this.db
        .prepare(`SELECT rowid, json FROM room_messages WHERE ${visible} ${condition}
          ORDER BY rowid ${ascending ? "ASC" : "DESC"} LIMIT ?`)
        .all(
          ...(value === undefined ? [roomId, count] : [roomId, value, count]),
        ) as Row[];

    let rows: Row[];
    if (options.around !== undefined) {
      const earlier = select(
        "AND rowid <= ?",
        false,
        Math.ceil(limit / 2),
        cursor!.rowid,
      ).reverse();
      rows = [
        ...earlier,
        ...select("AND rowid > ?", true, limit - earlier.length, cursor!.rowid),
      ];
      if (rows.length < limit && rows.length) {
        rows = [
          ...select(
            "AND rowid < ?",
            false,
            limit - rows.length,
            rows[0]!.rowid,
          ).reverse(),
          ...rows,
        ];
      }
    } else if (options.start !== undefined) {
      rows = select("AND rowid >= ?", true, limit, cursor!.rowid);
    } else if (options.after !== undefined) {
      rows = select("AND rowid > ?", true, limit, cursor!.rowid);
    } else {
      rows = select(
        cursor ? "AND rowid < ?" : "",
        false,
        limit,
        cursor?.rowid,
      ).reverse();
    }

    const messages = rows.map((row) =>
      messageSchema.parse(JSON.parse(row.json)),
    );
    const boundary = (operator: "<" | ">", value: number | undefined) =>
      value !== undefined &&
      !!this.db
        .prepare(
          `SELECT 1 FROM room_messages WHERE ${visible} AND rowid ${operator} ? LIMIT 1`,
        )
        .get(roomId, value);
    return {
      messages,
      parents: this.parents(messages),
      reactions: this.reactions(
        roomId,
        messages.map((message) => message.id),
      ),
      hasOlder: boundary("<", rows[0]?.rowid ?? cursor?.rowid),
      hasNewer: boundary(">", rows.at(-1)?.rowid ?? cursor?.rowid),
    };
  }

  message(id: string): RoomMessage | null {
    const row = this.db
      .prepare("SELECT json FROM room_messages WHERE id = ?")
      .get(id) as { json: string } | undefined;
    return row ? messageSchema.parse(JSON.parse(row.json)) : null;
  }

  queueNotification(
    id: string,
    roomId: string,
    kind: "reply" | "error" | "interaction",
    subjectId: string,
  ) {
    const room = this.findRoom(roomId);
    if (!room) return;
    const createdAt = Math.max(Date.now(), room.updatedAt + 1);
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO channel_notifications(id, room_id, kind, subject_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, roomId, kind, subjectId, createdAt).changes;
    if (inserted) this.putRoom({ ...room, updatedAt: createdAt });
  }

  putMessage(message: RoomMessage) {
    const value = messageSchema.parse(message);
    return this.db.transaction(() => {
      const inserted =
        this.db
          .prepare("INSERT OR IGNORE INTO room_messages VALUES (?, ?, ?)")
          .run(value.id, value.roomId, JSON.stringify(value)).changes > 0;
      if (inserted && value.agentId && !value.system)
        this.queueNotification(
          `reply:${value.id}`,
          value.roomId,
          "reply",
          value.id,
        );
      return inserted;
    })();
  }

  reactions(roomId: string, messageIds?: string[]): Reaction[] {
    if (messageIds && !messageIds.length) return [];
    return this.db
      .prepare(
        `SELECT r.message_id AS messageId, r.emoji, r.actor_id AS actorId,
          r.actor_name AS actorName, r.created_at AS createdAt
         FROM reactions r
         JOIN room_messages m ON m.id = r.message_id
         WHERE m.room_id = ?
         ${messageIds ? `AND r.message_id IN (${messageIds.map(() => "?").join(",")})` : ""}
         ORDER BY r.created_at`,
      )
      .all(roomId, ...(messageIds ?? [])) as Reaction[];
  }

  react(
    roomId: string,
    messageId: string,
    emoji: string,
    actorId: string,
    actorName: string,
    active: boolean,
  ) {
    if (this.message(messageId)?.roomId !== roomId)
      throw new Error("Message not found in this channel.");
    if (active) {
      this.db
        .prepare("INSERT OR IGNORE INTO reactions VALUES (?, ?, ?, ?, ?)")
        .run(messageId, emoji, actorId, actorName, Date.now());
    } else {
      this.db
        .prepare(
          "DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND actor_id = ?",
        )
        .run(messageId, emoji, actorId);
    }
    return this.reactions(roomId, [messageId]);
  }

  runs(roomId: string, limit = -1, activeOnly = false): RoomRun[] {
    return (
      this.db
        .prepare(
          `SELECT json FROM (
            SELECT rowid, json FROM room_runs WHERE room_id = ?
            ${activeOnly ? "AND json_extract(json, '$.status') IN ('queued', 'running')" : ""}
            ORDER BY rowid DESC LIMIT ?
          ) ORDER BY rowid`,
        )
        .all(roomId, limit) as Array<{ json: string }>
    ).map((row) => runSchema.parse(JSON.parse(row.json)));
  }

  requestJobs(runId: string): Job[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM jobs WHERE json_extract(json, '$.runId') = ? ORDER BY created_at, rowid",
        )
        .all(runId) as Array<{ json: string }>
    ).map((row) => jobSchema.parse(JSON.parse(row.json)));
  }

  putRun(run: RoomRun) {
    const value = runSchema.parse(run);
    this.db
      .prepare(
        "INSERT INTO room_runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      )
      .run(value.id, value.roomId, JSON.stringify(value));
  }

  roomJobs(roomId: string, limit = 100): Job[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM jobs WHERE json_extract(json, '$.roomId') = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        )
        .all(roomId, limit) as Array<{ json: string }>
    ).map((row) => jobSchema.parse(JSON.parse(row.json)));
  }

  activity(
    agentId: string | undefined,
    roomId: string | undefined,
    limit: number,
    offset: number,
  ): Job[] {
    return (
      this.db
        .prepare(
          `SELECT json FROM jobs
           WHERE (? IS NULL OR agent_id = ?)
             AND (? IS NULL OR json_extract(json, '$.roomId') = ?)
           ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(
          agentId ?? null,
          agentId ?? null,
          roomId ?? null,
          roomId ?? null,
          limit,
          offset,
        ) as Array<{ json: string }>
    ).map((row) => jobSchema.parse(JSON.parse(row.json)));
  }

  putAttachment(attachment: Attachment) {
    const value = attachmentSchema.parse(attachment);
    this.db
      .prepare(
        "INSERT INTO attachments VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      )
      .run(value.id, JSON.stringify(value));
  }

  stageAttachment(attachment: Attachment, bytes: Buffer) {
    this.db.transaction(() => {
      this.putAttachment(attachment);
      this.db
        .prepare("INSERT INTO draft_uploads VALUES (?, ?, ?)")
        .run(attachment.id, bytes, Date.now());
    })();
  }

  stagedAttachment(id: string): Buffer | null {
    return (
      (
        this.db
          .prepare("SELECT bytes FROM draft_uploads WHERE id = ?")
          .get(id) as { bytes: Buffer } | undefined
      )?.bytes ?? null
    );
  }

  claimAttachments(ids: string[]) {
    for (const id of ids)
      this.db.prepare("DELETE FROM draft_uploads WHERE id = ?").run(id);
  }

  discardAttachment(id: string) {
    this.db.transaction(() => {
      if (!this.stagedAttachment(id)) return;
      this.db.prepare("DELETE FROM draft_uploads WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    })();
  }

  expiredAttachments(before: number): Attachment[] {
    return (
      this.db
        .prepare(
          "SELECT a.json FROM attachments a JOIN draft_uploads d ON a.id = d.id WHERE d.created_at < ?",
        )
        .all(before) as Array<{ json: string }>
    ).map((row) => attachmentSchema.parse(JSON.parse(row.json)));
  }

  attachment(id: string): Attachment {
    const row = this.db
      .prepare("SELECT json FROM attachments WHERE id = ?")
      .get(id) as { json: string } | undefined;
    if (!row) throw new Error("Attachment not found.");
    return attachmentSchema.parse(JSON.parse(row.json));
  }
}
