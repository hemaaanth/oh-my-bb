// Call memory. After a call ends, the reasoning model writes a short summary
// from the transcript and the tool trace. The prompt's "Recent calls" section,
// the recall_calls tool, the Console, and read.calls read those summaries.
// The callMemory preference turns all of it off. Forget and retention delete it.
import { CALL_MEMORY, ENDPOINTS } from "../shared/constants.js";
import type { CallRow, CallSummary, Preferences, ReadCall, RpcOutput, RpcParsedInput, TraceRow } from "../shared/contract.js";
import { shortDeviceName } from "../shared/device-name.js";
import type { ServerContext } from "./context.js";
import { LIVE_ROW_MAX_MS, SPEECH_KINDS, getCall, localDay, onCallEnded, parseJson, toCallRow, type CallDbRow } from "./ledger.js";
import { readPreferences } from "./preferences.js";
import { isPresent } from "./settings.js";
import { callerTimeZone, formatClock, formatWhen } from "./time-zone.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Wait this long after a call ends, so the app's last trace events land first. */
export const SUMMARY_DELAY_MS = 5000;
/** Retention pruning runs at load and then this often. */
export const PRUNE_INTERVAL_MS = DAY_MS;
/** The model may write at most this many tokens, reasoning included. */
const SUMMARY_OUTPUT_TOKENS = 2000;
/** Tool outputs in the summary input are clipped to this. */
const TOOL_OUTPUT_INPUT_MAX = 400;
/** One summary line in "Recent calls" is clipped to this. */
const PROMPT_LINE_SUMMARY_MAX = 220;
/** A call keeps at most this many thread ids. */
const THREAD_IDS_MAX = 20;

export const RECENT_CALLS_HEADING = "# Recent calls";
export const MEMORY_OFF_ERROR = "Call memory is off. The user can turn it on in Dispatch settings, Calls.";

const SPEECH = SPEECH_KINDS as readonly string[];
const SPEECH_SQL = SPEECH_KINDS.map((kind) => `'${kind}'`).join(", ");

type SummaryDbRow = {
  call_id: string;
  local_day: string;
  time_zone: string;
  title: string;
  summary: string;
  topics: string;
  thread_ids: string;
  model: string | null;
  status: CallSummary["status"];
  created_at: number;
};
type TraceDbRow = { at: number; kind: string; payload_json: string | null };

/** Clip to at most `max` characters, ending with "…" when cut. */
export function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

function toSummary(row: SummaryDbRow): CallSummary {
  return {
    localDay: row.local_day,
    timeZone: row.time_zone,
    title: row.title,
    summary: row.summary,
    topics: strings(parseJson(row.topics, [])),
    threadIds: strings(parseJson(row.thread_ids, [])),
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function summaryFor(ctx: ServerContext, callId: string): CallSummary | null {
  const row = ctx.db.prepare("SELECT * FROM call_summaries WHERE call_id = ?").get(callId) as SummaryDbRow | undefined;
  return row ? toSummary(row) : null;
}

/** Summaries for these calls, keyed by call id. */
export function summariesFor(ctx: ServerContext, callIds: readonly string[]): Map<string, CallSummary> {
  if (callIds.length === 0) return new Map();
  const rows = ctx.db
    .prepare(`SELECT * FROM call_summaries WHERE call_id IN (${callIds.map(() => "?").join(", ")})`)
    .all(...callIds) as SummaryDbRow[];
  return new Map(rows.map((row) => [row.call_id, toSummary(row)]));
}

/** A summary the agent and other plugins may see: not skipped. */
const usable = (summary: CallSummary | null | undefined): summary is CallSummary => Boolean(summary && summary.status !== "skipped");

// ---------------------------------------------------------------------------
// The summary input: transcript and tool trace

function traceOf(ctx: ServerContext, callId: string): TraceRow[] {
  const rows = ctx.db
    .prepare("SELECT at, kind, payload_json FROM call_trace WHERE call_id = ? AND (kind IN (" + SPEECH_SQL + ") OR kind IN ('tool.call', 'tool.result')) ORDER BY at, id")
    .all(callId) as TraceDbRow[];
  return rows.map((row, index) => ({ id: index, callId, at: row.at, kind: row.kind, payload: parseJson(row.payload_json, null) }));
}

/** Thread ids the call touched, from tool arguments and tool results. */
export function threadIdsFromTrace(trace: readonly TraceRow[]): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() !== "") ids.add(value.trim());
  };
  for (const event of trace) {
    const payload = event.payload ?? {};
    if (event.kind === "tool.call") {
      const args = (payload.args ?? {}) as Record<string, unknown>;
      add(args.thread_id);
      strings(args.thread_ids).forEach(add);
    } else if (event.kind === "tool.result" && payload.status === "success" && typeof payload.output === "string") {
      const output = parseJson<unknown>(payload.output, null);
      if (output && typeof output === "object" && !Array.isArray(output)) add((output as Record<string, unknown>).threadId);
    }
  }
  return [...ids].slice(0, THREAD_IDS_MAX);
}

const toolNames = (trace: readonly TraceRow[]): string[] => [
  ...new Set(trace.filter((event) => event.kind === "tool.call" && typeof event.payload?.name === "string").map((event) => String(event.payload!.name))),
];

/** The text the model summarises. Long calls keep their start and their end. */
export function summaryInput(trace: readonly TraceRow[]): string {
  const lines: string[] = [];
  for (const event of trace) {
    const payload = event.payload ?? {};
    if (SPEECH.includes(event.kind) && typeof payload.text === "string") {
      lines.push(`${event.kind === "speech.user" ? "User" : "Agent"}: ${payload.text}`);
    } else if (event.kind === "tool.call") {
      lines.push(`Tool call ${String(payload.name)} ${JSON.stringify(payload.args ?? {})}`);
    } else if (event.kind === "tool.result" && typeof payload.output === "string") {
      lines.push(`Tool result ${String(payload.name)} (${String(payload.status)}): ${clip(payload.output, TOOL_OUTPUT_INPUT_MAX)}`);
    }
  }
  const text = lines.join("\n");
  if (text.length <= CALL_MEMORY.inputMax) return text;
  const half = Math.floor((CALL_MEMORY.inputMax - 20) / 2);
  return `${text.slice(0, half)}\n[… middle of the call left out …]\n${text.slice(-half)}`;
}

// ---------------------------------------------------------------------------
// The model call

export const SUMMARY_INSTRUCTIONS = [
  "You write a short memory of one voice call between a user and their BB voice agent.",
  "BB is an app where coding agents work in threads. The input is the call transcript and the tools the agent used.",
  `Write a title of at most ${CALL_MEMORY.titleMax} characters and a summary of at most ${CALL_MEMORY.summaryMax} characters.`,
  "The summary says what the user wanted, what was done, and what was left open. Name threads and projects by title.",
  `List up to ${CALL_MEMORY.topicsMax} topics as short lowercase phrases.`,
  "Write in plain English. Do not invent anything that is not in the input.",
].join(" ");

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
  },
  required: ["title", "summary", "topics"],
  additionalProperties: false,
} as const;

type ModelSummary = { title: string; summary: string; topics: string[] };

/** The text of a Responses API body: every output_text part of its message items. */
export function responseText(body: unknown): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof record.output_text === "string") return record.output_text;
  const parts: string[] = [];
  for (const item of Array.isArray(record.output) ? record.output : []) {
    const content = item && typeof item === "object" ? (item as Record<string, unknown>).content : null;
    for (const part of Array.isArray(content) ? content : []) {
      const entry = part as Record<string, unknown>;
      if (entry?.type === "output_text" && typeof entry.text === "string") parts.push(entry.text);
    }
  }
  return parts.join("");
}

async function askModel(ctx: ServerContext, model: string, input: string): Promise<ModelSummary> {
  const values = await ctx.settings.get();
  if (!isPresent(values.openaiKey)) throw new Error("No OpenAI key");
  const response = await fetch(ENDPOINTS.responses, {
    method: "POST",
    headers: { Authorization: `Bearer ${values.openaiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: SUMMARY_INSTRUCTIONS,
      input,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "call_summary", schema: SUMMARY_SCHEMA, strict: true } },
      max_output_tokens: SUMMARY_OUTPUT_TOKENS,
      store: false,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  const parsed = parseJson<Partial<ModelSummary> | null>(responseText(await response.json()), null);
  if (!parsed || typeof parsed.title !== "string" || typeof parsed.summary !== "string" || parsed.title.trim() === "" || parsed.summary.trim() === "") {
    throw new Error("The summary had no title or summary");
  }
  return { title: parsed.title, summary: parsed.summary, topics: strings(parsed.topics) };
}

/** The summary when the model fails: what the tool trace shows. */
export function fallbackSummary(trace: readonly TraceRow[], threadIds: readonly string[]): Omit<ModelSummary, "topics"> {
  const tools = toolNames(trace);
  const title = tools.length > 0 ? `Call: ${tools.join(", ")}` : "Call";
  const parts = [
    "No summary was written for this call.",
    tools.length > 0 ? `Tools used: ${tools.join(", ")}.` : "No tools were used.",
    threadIds.length > 0 ? `Threads: ${threadIds.join(", ")}.` : "",
  ];
  return { title: clip(title, CALL_MEMORY.titleMax), summary: clip(parts.filter(Boolean).join(" "), CALL_MEMORY.summaryMax) };
}

// ---------------------------------------------------------------------------
// Writing summaries

type NewSummary = Omit<CallSummary, "createdAt" | "localDay" | "timeZone">;

function storeSummary(ctx: ServerContext, call: CallRow, preferences: Preferences, summary: NewSummary, now: number): CallSummary | null {
  // The owner may have said "do not remember" while the model was writing.
  if (getCall(ctx, call.id)?.forgotten) return null;
  const timeZone = callerTimeZone(call.device, preferences.homeTimeZone);
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO call_summaries (call_id, local_day, time_zone, title, summary, topics, thread_ids, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      call.id,
      localDay(call.startedAt, timeZone),
      timeZone,
      summary.title,
      summary.summary,
      JSON.stringify(summary.topics),
      JSON.stringify(summary.threadIds),
      summary.model,
      summary.status,
      now,
    );
  return summaryFor(ctx, call.id);
}

// Calls being summarised now, per database. The end listener and the retry at load may overlap.
const inFlight = new WeakMap<object, Set<string>>();

/**
 * Summarise one ended call and store the result. Returns the stored summary,
 * or null when the call is open, forgotten, or already being summarised.
 * Never throws for a model failure: that stores a `fallback` row.
 */
export async function summariseCall(ctx: ServerContext, callId: string, now: () => number = Date.now): Promise<CallSummary | null> {
  const call = getCall(ctx, callId);
  if (!call || call.endedAt === null || call.forgotten) return null;
  const existing = summaryFor(ctx, callId);
  if (existing) return existing;
  const running = inFlight.get(ctx.db) ?? new Set<string>();
  inFlight.set(ctx.db, running);
  if (running.has(callId)) return null;
  running.add(callId);
  try {
    const preferences = await readPreferences(ctx);
    const empty = { title: "", summary: "", topics: [], threadIds: [], model: null };
    // Memory off at the end of a call: remember that this call is not to be summarised later.
    if (!preferences.callMemory) return storeSummary(ctx, call, preferences, { ...empty, status: "skipped" }, now());
    const trace = traceOf(ctx, callId);
    const threadIds = threadIdsFromTrace(trace);
    const said = trace.some((event) => SPEECH.includes(event.kind));
    if (!said && toolNames(trace).length === 0) return storeSummary(ctx, call, preferences, { ...empty, status: "skipped" }, now());
    const model = preferences.reasoningModel;
    try {
      const written = await askModel(ctx, model, summaryInput(trace));
      return storeSummary(
        ctx,
        call,
        preferences,
        {
          title: clip(oneLine(written.title), CALL_MEMORY.titleMax),
          summary: clip(oneLine(written.summary), CALL_MEMORY.summaryMax),
          topics: written.topics.map((topic) => clip(oneLine(topic), 40)).filter(Boolean).slice(0, CALL_MEMORY.topicsMax),
          threadIds,
          model,
          status: "done",
        },
        now(),
      );
    } catch {
      return storeSummary(ctx, call, preferences, { ...fallbackSummary(trace, threadIds), topics: [], threadIds, model: null, status: "fallback" }, now());
    }
  } finally {
    running.delete(callId);
  }
}

/** The oldest start time memory keeps, or 0 when it keeps everything. */
function retentionCutoff(preferences: Preferences, now: number): number {
  return preferences.memoryRetentionDays > 0 ? now - preferences.memoryRetentionDays * DAY_MS : 0;
}

/**
 * Summarise ended calls that have no summary row, newest first, at most
 * CALL_MEMORY.retryMax of them. A crash or reload before the delayed summary
 * leaves such calls. Returns how many it summarised.
 */
export async function retryMissingSummaries(ctx: ServerContext, now = Date.now()): Promise<number> {
  const preferences = await readPreferences(ctx);
  if (!preferences.callMemory) return 0;
  const ids = ctx.db
    .prepare(
      `SELECT c.id FROM calls c LEFT JOIN call_summaries s ON s.call_id = c.id
       WHERE s.call_id IS NULL AND c.ended_at IS NOT NULL AND c.forget = 0 AND c.started_at >= ?
       ORDER BY c.started_at DESC LIMIT ?`,
    )
    .all(retentionCutoff(preferences, now), CALL_MEMORY.retryMax) as Array<{ id: string }>;
  let done = 0;
  for (const { id } of ids) {
    if (await summariseCall(ctx, id)) done += 1;
  }
  return done;
}

// ---------------------------------------------------------------------------
// Forget and retention

/**
 * "Do not remember this call": delete its transcript and summary and never
 * summarise it again. The call row and its tool trace stay for usage and cost.
 * Returns false for an unknown call.
 */
export function forgetCall(ctx: ServerContext, callId: string): boolean {
  const result = ctx.db.prepare("UPDATE calls SET forget = 1 WHERE id = ?").run(callId);
  if (result.changes === 0) return false;
  ctx.db.prepare(`DELETE FROM call_trace WHERE call_id = ? AND kind IN (${SPEECH_SQL})`).run(callId);
  ctx.db.prepare("DELETE FROM call_summaries WHERE call_id = ?").run(callId);
  return true;
}

/** Delete summaries and transcripts of calls older than the retention period. */
export async function pruneMemory(ctx: ServerContext, now = Date.now()): Promise<{ summaries: number; speech: number }> {
  const cutoff = retentionCutoff(await readPreferences(ctx), now);
  if (cutoff === 0) return { summaries: 0, speech: 0 };
  const old = "SELECT id FROM calls WHERE started_at < ?";
  const summaries = ctx.db.prepare(`DELETE FROM call_summaries WHERE call_id IN (${old})`).run(cutoff).changes;
  const speech = ctx.db.prepare(`DELETE FROM call_trace WHERE kind IN (${SPEECH_SQL}) AND call_id IN (${old})`).run(cutoff).changes;
  return { summaries, speech };
}

// ---------------------------------------------------------------------------
// Reading memory: prompt, tool, read.calls

type RememberedCall = { call: CallRow; summary: CallSummary };

function remembered(ctx: ServerContext, where: string, params: unknown[], limit: number): RememberedCall[] {
  const rows = ctx.db
    .prepare(
      `SELECT c.*, s.* FROM call_summaries s JOIN calls c ON c.id = s.call_id
       WHERE s.status != 'skipped' AND c.forget = 0 ${where}
       ORDER BY c.started_at DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<CallDbRow & SummaryDbRow>;
  return rows.map((row) => ({ call: toCallRow(row), summary: toSummary(row) }));
}

/** "today", "yesterday", or "Monday, October 12", seen from `now` in `timeZone`. */
export function relativeDay(ms: number, now: number, timeZone: string): string {
  const day = localDay(ms, timeZone);
  if (day === localDay(now, timeZone)) return "today";
  if (day === localDay(now - DAY_MS, timeZone)) return "yesterday";
  return new Date(ms).toLocaleDateString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
}

const whereFrom = (call: CallRow): string => shortDeviceName(call.device, call.channel) ?? (call.channel === "phone" ? "Phone" : "the app");

/** "Last call: yesterday at 3:05 PM from Mac", or null when there is none or memory is off. */
export function lastCallLine(ctx: ServerContext, preferences: Preferences, now: number, timeZone: string): string | null {
  if (!preferences.callMemory) return null;
  const row = ctx.db
    .prepare("SELECT * FROM calls WHERE ended_at IS NOT NULL AND forget = 0 ORDER BY started_at DESC LIMIT 1")
    .get() as CallDbRow | undefined;
  if (!row) return null;
  const call = toCallRow(row);
  return `- Last call: ${relativeDay(call.startedAt, now, timeZone)} at ${formatClock(call.startedAt, timeZone)} from ${whereFrom(call)}.`;
}

/**
 * The "# Recent calls" prompt section: the newest summarised calls, at most
 * CALL_MEMORY.promptMax characters. Null when memory is off or there are none.
 */
export function recentCallsSection(ctx: ServerContext, preferences: Preferences, now: number, timeZone: string): string | null {
  if (!preferences.callMemory) return null;
  const lines = [RECENT_CALLS_HEADING, "", "Summaries of the last calls with the user, newest first. Use recall_calls for more."];
  let length = lines.join("\n").length;
  let added = 0;
  for (const { call, summary } of remembered(ctx, "", [], CALL_MEMORY.promptCalls)) {
    const when = `${relativeDay(call.startedAt, now, timeZone)} at ${formatClock(call.startedAt, timeZone)}`;
    const line = `- ${when}, from ${whereFrom(call)}: ${summary.title}. ${clip(oneLine(summary.summary), PROMPT_LINE_SUMMARY_MAX)}`;
    if (length + 1 + line.length > CALL_MEMORY.promptMax) break;
    lines.push(line);
    length += 1 + line.length;
    added += 1;
  }
  return added > 0 ? lines.join("\n") : null;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The recall_calls tool. Throws when memory is off or the day is malformed. */
export async function recallCalls(
  ctx: ServerContext,
  input: { day?: string; query?: string; limit?: number },
  now = Date.now(),
): Promise<{ calls: Array<Record<string, unknown>>; note?: string }> {
  const preferences = await readPreferences(ctx);
  if (!preferences.callMemory) throw new Error(MEMORY_OFF_ERROR);
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.day !== undefined) {
    if (!DAY_PATTERN.test(input.day)) throw new Error("day must look like 2026-10-19.");
    where.push("AND s.local_day = ?");
    params.push(input.day);
  }
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const word of words) {
    where.push("AND instr(lower(s.title || ' ' || s.summary || ' ' || s.topics), ?) > 0");
    params.push(word);
  }
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? CALL_MEMORY.recallDefault)), CALL_MEMORY.recallMax);
  const found = remembered(ctx, where.join(" "), params, limit);
  const timeZone = callerTimeZone(null, preferences.homeTimeZone);
  const calls = found.map(({ call, summary }) => ({
    id: call.id,
    day: summary.localDay,
    when: formatWhen(call.startedAt, summary.timeZone),
    ago: relativeDay(call.startedAt, now, timeZone),
    from: whereFrom(call),
    title: summary.title,
    summary: clip(summary.summary, CALL_MEMORY.summaryMax),
    topics: summary.topics,
    threadIds: summary.threadIds,
  }));
  return calls.length > 0 ? { calls } : { calls, note: "No remembered call matches. Calls older than the retention period are forgotten." };
}

/**
 * read.calls: calls that overlap the window, oldest first. Read-only: it never
 * calls a model and never writes. Forgotten calls and calls without a usable
 * summary appear with a null title and summary.
 */
export async function readCalls(
  ctx: ServerContext,
  input: RpcParsedInput<"read.calls">,
  now = Date.now(),
): Promise<RpcOutput<"read.calls">> {
  const memory = (await readPreferences(ctx)).callMemory;
  const since = Date.parse(input.since);
  const until = Date.parse(input.until);
  // A row with no end counts as live only within the staleness window. An old open row counts by its start.
  const rows = ctx.db
    .prepare(
      `SELECT * FROM calls WHERE started_at < ?
       AND (ended_at > ? OR (ended_at IS NULL AND (started_at > ? OR started_at > ?)))
       ORDER BY started_at ASC, id ASC`,
    )
    .all(until, since, since, now - LIVE_ROW_MAX_MS) as CallDbRow[];
  const calls = rows.map(toCallRow);
  const summaries = memory ? summariesFor(ctx, calls.map((call) => call.id)) : new Map<string, CallSummary>();
  return {
    memory,
    calls: calls.map((call): ReadCall => {
      const summary = summaries.get(call.id);
      const shown = memory && !call.forgotten;
      return {
        id: call.id,
        startedAt: new Date(call.startedAt).toISOString(),
        endedAt: call.endedAt === null ? null : new Date(call.endedAt).toISOString(),
        channel: call.channel,
        device: shortDeviceName(call.device, call.channel),
        title: shown && usable(summary) ? clip(summary.title, CALL_MEMORY.titleMax) : null,
        summary: shown && usable(summary) ? clip(summary.summary, CALL_MEMORY.summaryMax) : null,
        threadIds: !shown ? [] : summary ? (usable(summary) ? summary.threadIds : []) : threadIdsFromTrace(traceOf(ctx, call.id)),
      };
    }),
  };
}

// ---------------------------------------------------------------------------

/** Summarise calls as they end, retry missed ones, and prune at load and daily. */
export function registerMemory(ctx: ServerContext): void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  const quietly = (work: () => Promise<unknown>) => {
    work().catch(() => {
      // Memory is best effort. A failure here must never touch a call.
    });
  };
  const unsubscribe = onCallEnded(ctx, (callId) => {
    if (disposed) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) quietly(() => summariseCall(ctx, callId));
    }, SUMMARY_DELAY_MS);
    timers.add(timer);
  });
  quietly(async () => {
    await pruneMemory(ctx);
    if (!disposed) await retryMissingSummaries(ctx);
  });
  const daily = setInterval(() => quietly(() => pruneMemory(ctx)), PRUNE_INTERVAL_MS);
  daily.unref?.();
  ctx.bb.onDispose(() => {
    disposed = true;
    unsubscribe();
    clearInterval(daily);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });
}
