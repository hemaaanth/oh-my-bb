// The call ledger (CONTRACTS §4.2, SPEC §16): calls, their trace, and usage.
// Owned by P1. P3 records phone calls through insertCall, appendTrace,
// recordUsageSeconds and endCall.
import { CHANNELS, LIVE_RATE_CHECKED_ON, LIVE_USD_PER_MINUTE, TOOL_OUTPUT_TRACE_MAX } from "../shared/constants.js";
import type {
  CallChannel,
  CallRow,
  DeviceProfile,
  LiveStatus,
  TraceEvent,
  TraceRow,
  UsageReport,
} from "../shared/contract.js";
import type { ServerContext } from "./context.js";

/**
 * A row with no end time counts as live only for this long. A crashed client
 * never writes its end, and an old open row must not block calls forever.
 */
export const LIVE_ROW_MAX_MS = 6 * 60 * 60 * 1000;

/** Trace kinds that end a call when they arrive. */
const ENDING_KINDS: Record<string, string> = {
  "call.closed": "closed",
  "call.stopped": "stopped",
  "call.failed": "failed",
  "call.suspended": "suspended",
};

type CallDbRow = {
  id: string;
  openai_session_id: string | null;
  channel: CallChannel;
  nonce: string | null;
  client_id: string | null;
  device_json: string;
  thread_id: string | null;
  project_id: string | null;
  started_at: number;
  ended_at: number | null;
  close_reason: string | null;
  billed_seconds: number;
  unclean: number;
  forget: number;
};
type TraceDbRow = { id: number; call_id: string; at: number; kind: string; payload_json: string | null };

const UNKNOWN_DEVICE: DeviceProfile = { platform: "", mobile: false, browser: "", displayMode: "", runtime: "browser", label: "Unknown device" };

export function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function toCallRow(row: CallDbRow): CallRow {
  return {
    id: row.id,
    openaiSessionId: row.openai_session_id,
    channel: row.channel,
    nonce: row.nonce,
    clientId: row.client_id,
    device: parseJson(row.device_json, UNKNOWN_DEVICE),
    threadId: row.thread_id,
    projectId: row.project_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    closeReason: row.close_reason,
    billedSeconds: row.billed_seconds,
    unclean: row.unclean === 1,
    forgotten: row.forget === 1,
  };
}

export type { CallDbRow };

/** Trace kinds that hold what was said. Forget and retention remove them. */
export const SPEECH_KINDS = ["speech.user", "speech.agent"] as const;

// One listener per database, so a test context without registerMemory never summarises.
const endListeners = new WeakMap<object, (callId: string) => void>();

/** Run `listener` once for each call that ends. Returns the unsubscribe. */
export function onCallEnded(ctx: ServerContext, listener: (callId: string) => void): () => void {
  endListeners.set(ctx.db, listener);
  return () => {
    if (endListeners.get(ctx.db) === listener) endListeners.delete(ctx.db);
  };
}

function toTraceRow(row: TraceDbRow): TraceRow {
  const payload = parseJson<unknown>(row.payload_json, null);
  return {
    id: row.id,
    callId: row.call_id,
    at: row.at,
    kind: row.kind,
    payload: typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null,
  };
}

export const newCallId = (): string => `call_${crypto.randomUUID().replaceAll("-", "")}`;

export type NewCall = {
  id?: string;
  channel: CallChannel;
  device: DeviceProfile;
  openaiSessionId?: string | null;
  nonce?: string | null;
  clientId?: string | null;
  threadId?: string | null;
  projectId?: string | null;
  startedAt?: number;
};

/** Create a calls row. Returns its id. */
export function insertCall(ctx: ServerContext, call: NewCall): string {
  const id = call.id ?? newCallId();
  ctx.db
    .prepare(
      `INSERT INTO calls (id, openai_session_id, channel, nonce, client_id, device_json, thread_id, project_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      call.openaiSessionId ?? null,
      call.channel,
      call.nonce ?? null,
      call.clientId ?? null,
      JSON.stringify(call.device),
      call.threadId ?? null,
      call.projectId ?? null,
      call.startedAt ?? Date.now(),
    );
  return id;
}

export function getCall(ctx: ServerContext, callId: string): CallRow | null {
  const row = ctx.db.prepare("SELECT * FROM calls WHERE id = ?").get(callId) as CallDbRow | undefined;
  return row ? toCallRow(row) : null;
}

/** Set the session id once OpenAI reports it. */
export function setSessionId(ctx: ServerContext, callId: string, sessionId: string): void {
  ctx.db.prepare("UPDATE calls SET openai_session_id = ? WHERE id = ?").run(sessionId, callId);
}

/** The cumulative usage snapshot. The last one wins (SPEC §16). */
export function recordUsageSeconds(ctx: ServerContext, callId: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  ctx.db.prepare("UPDATE calls SET billed_seconds = ? WHERE id = ?").run(seconds, callId);
}

/** Mark a call ended. Only the first end counts. Returns true when it was open. */
export function endCall(ctx: ServerContext, callId: string, end: { reason: string; at?: number; unclean?: boolean; seconds?: number }): boolean {
  if (end.seconds !== undefined) recordUsageSeconds(ctx, callId, end.seconds);
  const result = ctx.db
    .prepare("UPDATE calls SET ended_at = ?, close_reason = ?, unclean = MAX(unclean, ?) WHERE id = ? AND ended_at IS NULL")
    .run(end.at ?? Date.now(), end.reason, end.unclean ? 1 : 0, callId);
  if (result.changes === 0) return false;
  endListeners.get(ctx.db)?.(callId);
  return true;
}

/** Open calls, newest first. Pass `now` to apply the staleness window. */
export function openCalls(ctx: ServerContext, now = Date.now()): CallRow[] {
  const rows = ctx.db
    .prepare("SELECT * FROM calls WHERE ended_at IS NULL AND started_at > ? ORDER BY started_at DESC")
    .all(now - LIVE_ROW_MAX_MS) as CallDbRow[];
  return rows.map(toCallRow);
}

export function liveStatus(ctx: ServerContext, now = Date.now()): LiveStatus {
  const live = openCalls(ctx, now)[0];
  if (!live) return { live: false, channel: null, startedAt: null, device: null };
  return { live: true, channel: live.channel, startedAt: live.startedAt, device: live.device };
}

function clipPayload(kind: string, payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (kind !== "tool.result" || !payload || typeof payload.output !== "string") return payload;
  return { ...payload, output: payload.output.slice(0, TOOL_OUTPUT_TRACE_MAX) };
}

/**
 * Append trace events, apply their side effects on the calls row (usage and
 * call end), and publish them on `trace-tail`. Unknown call ids are skipped.
 */
export function appendTrace(ctx: ServerContext, callId: string, events: readonly TraceEvent[]): TraceRow[] {
  const call = events.length === 0 ? null : getCall(ctx, callId);
  if (!call) return [];
  // A call the owner asked to forget keeps no words, even ones still arriving.
  if (call.forgotten) events = events.filter((event) => !(SPEECH_KINDS as readonly string[]).includes(event.kind));
  if (events.length === 0) return [];
  const insert = ctx.db.prepare("INSERT INTO call_trace (call_id, at, kind, payload_json) VALUES (?, ?, ?, ?)");
  const rows: TraceRow[] = [];
  for (const event of events) {
    const payload = clipPayload(event.kind, event.payload);
    const result = insert.run(callId, event.at, event.kind, payload === undefined ? null : JSON.stringify(payload));
    rows.push({ id: Number(result.lastInsertRowid), callId, at: event.at, kind: event.kind, payload: payload ?? null });
    const seconds = typeof payload?.seconds === "number" ? payload.seconds : undefined;
    if (event.kind === "usage.seconds" && seconds !== undefined) recordUsageSeconds(ctx, callId, seconds);
    const ending = ENDING_KINDS[event.kind];
    if (ending) {
      const reason = typeof payload?.reason === "string" && payload.reason !== "" ? payload.reason : ending;
      endCall(ctx, callId, { reason, at: event.at, unclean: payload?.unclean === true, ...(seconds !== undefined ? { seconds } : {}) });
    }
  }
  try {
    ctx.bb.realtime.publish(CHANNELS.traceTail, { callId, events: rows });
  } catch {
    // The trace is stored. A missed live tail only delays the Console.
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Pages. Cursors are opaque strings: "<time>|<id>".

const encodeCursor = (time: number, id: string | number): string => `${time}|${id}`;
function decodeCursor(cursor: string | undefined): { time: number; id: string } | null {
  if (!cursor) return null;
  const split = cursor.indexOf("|");
  const time = Number(cursor.slice(0, split));
  if (split < 1 || !Number.isFinite(time)) return null;
  return { time, id: cursor.slice(split + 1) };
}

export function callsPage(ctx: ServerContext, input: { cursor?: string; limit: number; channel?: CallChannel }) {
  const after = decodeCursor(input.cursor);
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.channel) {
    where.push("channel = ?");
    params.push(input.channel);
  }
  if (after) {
    where.push("(started_at < ? OR (started_at = ? AND id < ?))");
    params.push(after.time, after.time, after.id);
  }
  const sql = `SELECT * FROM calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC LIMIT ?`;
  const rows = ctx.db.prepare(sql).all(...params, input.limit + 1) as CallDbRow[];
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    calls: page.map(toCallRow),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.started_at, last.id) : null,
  };
}

export function callTrace(ctx: ServerContext, input: { callId: string; cursor?: string; limit: number }) {
  const after = decodeCursor(input.cursor);
  const afterId = after ? Number(after.id) : 0;
  const rows = (
    after
      ? ctx.db
          .prepare("SELECT * FROM call_trace WHERE call_id = ? AND (at > ? OR (at = ? AND id > ?)) ORDER BY at, id LIMIT ?")
          .all(input.callId, after.time, after.time, afterId, input.limit + 1)
      : ctx.db.prepare("SELECT * FROM call_trace WHERE call_id = ? ORDER BY at, id LIMIT ?").all(input.callId, input.limit + 1)
  ) as TraceDbRow[];
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    events: page.map(toTraceRow),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.at, last.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Usage (SPEC §16)

/** Local calendar day, YYYY-MM-DD, in `timeZone` (an IANA zone), or the server's zone. */
export function localDay(ms: number, timeZone?: string): string {
  const date = new Date(ms);
  if (timeZone) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
export const costUsd = (seconds: number): number => round((seconds / 60) * LIVE_USD_PER_MINUTE, 4);

/** Minutes and cost per local day of `startedAt`, newest day first. */
export function usageReport(ctx: ServerContext, days: number, now = Date.now()): UsageReport {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const rows = ctx.db
    .prepare("SELECT started_at, billed_seconds FROM calls WHERE started_at >= ? ORDER BY started_at DESC")
    .all(start.getTime()) as Array<{ started_at: number; billed_seconds: number }>;
  const byDay = new Map<string, { seconds: number; calls: number }>();
  for (const row of rows) {
    const day = localDay(row.started_at);
    const entry = byDay.get(day) ?? { seconds: 0, calls: 0 };
    entry.seconds += row.billed_seconds;
    entry.calls += 1;
    byDay.set(day, entry);
  }
  const perDay = [...byDay.entries()].map(([day, entry]) => ({
    day,
    seconds: round(entry.seconds, 3),
    usd: costUsd(entry.seconds),
    calls: entry.calls,
  }));
  const totalSeconds = round(
    perDay.reduce((sum, day) => sum + day.seconds, 0),
    3,
  );
  return {
    days,
    usdPerMinute: LIVE_USD_PER_MINUTE,
    rateCheckedOn: LIVE_RATE_CHECKED_ON,
    perDay,
    totalSeconds,
    totalUsd: costUsd(totalSeconds),
  };
}
