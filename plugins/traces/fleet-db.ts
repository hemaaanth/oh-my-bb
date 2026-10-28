import Database from "better-sqlite3";
import { join } from "node:path";
import { buildTrace, type TraceEvent, type TraceSpan, type TraceThread } from "./spans";
import { matchesFleetFilter, type FleetFilter } from "./fleet-query";
import type { FleetMode, FleetRow } from "./fleet-contract";

// This is the BB schema shipped with desktop 0.47.1. A migration disables
// fleet reads until this internal dependency is reviewed; thread SDK views remain available.
export const EXPECTED_MIGRATION_HASH = "9fec044e3b7902083cde83067c20b03b3e71076a25bb3e6a0e56090f2a92ac3c";
export const MAX_THREADS = 2_000;
export const MAX_EVENTS = 3_000_000;
const MAX_THREAD_EVENTS = 50_000;
const MAX_ROWS_PER_THREAD = 20;
const MAX_TOOL_SAMPLES = 500;
const TOOL_KINDS: Record<string, true> = { toolCall: true, commandExecution: true, fileRead: true, fileChange: true,
  search: true, webSearch: true, webFetch: true, delegation: true };
const EVENT_SQL = `SELECT id, thread_id AS threadId, sequence AS seq, scope_kind AS scopeKind, turn_id AS turnId,
  item_id AS itemId, item_kind AS itemKind, type, data, created_at AS at, parent_tool_call_id AS parentToolCallId
  FROM events INDEXED BY events_thread_sequence_idx WHERE thread_id=? AND created_at>=? AND created_at<? ORDER BY sequence`;

export class FleetSchemaError extends Error {
  constructor() { super("BB's database schema changed. Fleet scans are disabled; per-thread Waterfall and Context Inspector still work."); }
}
export interface FleetThread {
  id: string; projectId: string; projectName: string; provider: string; model: string | null;
  environmentId: string | null; worktree: boolean; parentThreadId: string | null; status: string; createdAt: number; updatedAt: number;
}
interface DbEvent {
  id: string; threadId: string; seq: number; scopeKind: "thread" | "turn"; turnId: string | null;
  itemId: string | null; itemKind: string | null; type: string; data: string; at: number; parentToolCallId: string | null;
}
export interface ThreadContribution {
  thread: FleetThread; scannedEvents: number; matchedEvents: number; lastSeq: number; limited: boolean; withUsageSnapshot: boolean;
  rows: FleetRow[]; histogram: Array<{ count: number; errors: number }>;
  facets: Record<string, Map<string, number>>; toolDurations: Map<string, { count: number; unknown: number; samples: number[]; partial: boolean }>;
  errors: Map<string, number>; errorProviders: Map<string, number>; errorTools: Map<string, number>;
  ttft: Map<string, { count: number; samples: number[]; partial: boolean }>;
  turns: number; toolCalls: number; failedTools: number; retries: number; fallbacks: number;
}
const safeId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_./:-]{1,100}$/.test(value) ? value : null;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validMs = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function openFleetDb(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, "bb.db"), { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only=ON");
    db.pragma("busy_timeout=1000");
    const migration = db.prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { hash?: string } | undefined;
    if (migration?.hash !== EXPECTED_MIGRATION_HASH) throw new FleetSchemaError();
    const required: Record<string, string[]> = {
      threads: ["id", "project_id", "environment_id", "provider_id", "model_override", "parent_thread_id", "status", "created_at", "updated_at", "deleted_at"],
      events: ["id", "thread_id", "sequence", "scope_kind", "turn_id", "item_id", "item_kind", "type", "data", "created_at"],
      projects: ["id", "name", "deleted_at"], environments: ["id", "is_worktree"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const present = new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
      if (columns.some((column) => !present.has(column))) throw new FleetSchemaError();
    }
    const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((index) => index.name));
    if (!indexes.has("events_thread_sequence_idx") || !indexes.has("events_thread_type_sequence_idx") || !indexes.has("threads_project_updated_idx")) throw new FleetSchemaError();
    return db;
  } catch (cause) { db.close(); if (cause instanceof FleetSchemaError) throw cause; throw new FleetSchemaError(); }
}

function candidateWhere(filter: FleetFilter, from: number): { sql: string; args: Array<string | number> } {
  const conditions = ["(t.updated_at>=? OR t.status='active')", "t.deleted_at IS NULL", "p.deleted_at IS NULL"];
  const args: Array<string | number> = [from]; const t = filter.terms;
  if (t.project) { conditions.push("(t.project_id=? OR lower(p.name)=lower(?))"); args.push(t.project, t.project); }
  if (t.thread) { conditions.push("t.id=?"); args.push(t.thread); }
  if (t.provider) { conditions.push("t.provider_id=?"); args.push(t.provider); }
  if (t.environment) { conditions.push("t.environment_id=?"); args.push(t.environment); }
  if (t.child) { conditions.push(t.child === "true" ? "t.parent_thread_id IS NOT NULL" : "t.parent_thread_id IS NULL"); }
  if (t.worktree) { conditions.push("coalesce(e.is_worktree,0)=?"); args.push(t.worktree === "true" ? 1 : 0); }
  return { sql: conditions.join(" AND "), args };
}

export function listFleetThreads(db: Database.Database, filter: FleetFilter, from: number): { threads: FleetThread[]; total: number; limited: boolean } {
  const { sql, args } = candidateWhere(filter, from);
  const source = ` FROM threads t JOIN projects p ON p.id=t.project_id LEFT JOIN environments e ON e.id=t.environment_id WHERE ${sql}`;
  const count = db.prepare(`SELECT count(*) AS count${source}`).get(...args) as { count: number };
  const rows = db.prepare(`SELECT t.id, t.project_id AS projectId, p.name AS projectName, t.provider_id AS provider,
    t.model_override AS model, t.environment_id AS environmentId, coalesce(e.is_worktree,0) AS worktree,
    t.parent_thread_id AS parentThreadId, t.status, t.created_at AS createdAt, t.updated_at AS updatedAt${source}
    ORDER BY (t.status='active') DESC, t.updated_at DESC, t.id LIMIT ?`).all(...args, MAX_THREADS) as Array<Omit<FleetThread, "worktree"> & { worktree: number }>;
  return { threads: rows.map((row) => ({ ...row, worktree: row.worktree === 1 })), total: count.count, limited: count.count > MAX_THREADS };
}

export function fleetThreadById(db: Database.Database, threadId: string): FleetThread | null {
  const row = db.prepare(`SELECT t.id, t.project_id AS projectId, p.name AS projectName, t.provider_id AS provider,
    t.model_override AS model, t.environment_id AS environmentId, coalesce(e.is_worktree,0) AS worktree,
    t.parent_thread_id AS parentThreadId, t.status, t.created_at AS createdAt, t.updated_at AS updatedAt
    FROM threads t JOIN projects p ON p.id=t.project_id LEFT JOIN environments e ON e.id=t.environment_id
    WHERE t.id=? AND t.deleted_at IS NULL AND p.deleted_at IS NULL`).get(threadId) as (Omit<FleetThread, "worktree"> & { worktree: number }) | undefined;
  return row ? { ...row, worktree: row.worktree === 1 } : null;
}

export function threadMatchesFleetFilter(thread: FleetThread, filter: FleetFilter): boolean {
  const t = filter.terms;
  return (!t.project || t.project === thread.projectId || t.project.toLowerCase() === thread.projectName.toLowerCase())
    && (!t.thread || t.thread === thread.id)
    && (!t.provider || t.provider === thread.provider)
    && (!t.environment || t.environment === thread.environmentId)
    && (!t.worktree || (t.worktree === "true") === thread.worktree)
    && (!t.child || (t.child === "true") === (thread.parentThreadId !== null));
}
function safeEvent(row: DbEvent, raw: Record<string, unknown>): TraceEvent {
  const data: Record<string, unknown> = {};
  if (row.type.startsWith("item/")) {
    const item = object(raw.item);
    const id = safeId(row.itemId) ?? safeId(item.id);
    if (id) data.item = { id, type: safeId(row.itemKind) ?? safeId(item.type) ?? "item",
      status: safeId(item.status), tool: safeId(item.tool), durationMs: validMs(item.durationMs),
      exitCode: validMs(item.exitCode), parentToolCallId: safeId(row.parentToolCallId) };
    if (raw.itemId) data.itemId = safeId(raw.itemId);
  } else if (row.type === "client/turn/requested") data.execution = { model: safeId(object(raw.execution).model) };
  else if (row.type === "turn/completed") data.status = safeId(raw.status);
  else if (row.type === "provider/error") { data.willRetry = raw.willRetry === true; data.errorInfo = { category: safeId(object(raw.errorInfo).category) }; }
  return { id: row.id, threadId: row.threadId, seq: row.seq, type: row.type, createdAt: row.at,
    scope: row.scopeKind === "turn" && row.turnId ? { kind: "turn", turnId: row.turnId } : { kind: "thread" }, data };
}
function increment(map: Map<string, number>, key: string) {
  const group = !map.has(key) && map.size >= 200 ? "other" : key;
  map.set(group, (map.get(group) ?? 0) + 1);
}
function addFacet(facets: ThreadContribution["facets"], name: string, value: string | null) {
  if (!value) return;
  const map = facets[name] ?? (facets[name] = new Map());
  if (!map.has(value) && map.size >= 100) { increment(map, "other"); return; }
  increment(map, value);
}
function boundedSample(map: Map<string, { count: number; samples: number[]; partial: boolean }>, key: string, value: number) {
  const group = !map.has(key) && map.size >= 200 ? "other" : key;
  let entry = map.get(group);
  if (!entry) { entry = { count: 0, samples: [], partial: false }; map.set(group, entry); }
  entry.count++;
  if (entry.samples.length < MAX_TOOL_SAMPLES) entry.samples.push(value);
  else entry.partial = true;
}
function rowForEvent(event: DbEvent, raw: Record<string, unknown>, thread: FleetThread, model: string | null, durationMs: number | null): FleetRow {
  const item = object(raw.item);
  const kind = safeId(event.itemKind) ?? (event.type.startsWith("item/") ? safeId(item.type) : null) ?? event.type;
  const tool = kind === "toolCall" ? safeId(item.tool) : kind === "commandExecution" ? "Command" : null;
  const status = event.type === "item/started" ? "pending" : event.type === "turn/started" ? "running"
    : event.type === "provider/error" || event.type === "system/error" || event.type === "client/turn/rejected" ? "failed"
    : safeId(item.status) ?? (event.type === "turn/completed" ? safeId(raw.status) : null) ?? "recorded";
  const category = event.type === "provider/error" ? safeId(object(raw.errorInfo).category) ?? "unknown"
    : event.type === "system/error" ? safeId(raw.code) ?? "system" : status === "failed" ? "item-failed" : null;
  return { id: event.id, seq: event.seq, at: event.at, threadId: thread.id, turnId: event.turnId, itemId: event.itemId,
    projectId: thread.projectId, projectName: thread.projectId, provider: thread.provider, model,
    environmentId: thread.environmentId, worktree: thread.worktree, child: thread.parentThreadId !== null,
    type: event.type, kind, status, tool, category, durationMs,
    name: tool ? `${kind} · ${tool}` : kind };
}
function rowForSpan(span: TraceSpan, thread: FleetThread): FleetRow | null {
  if (span.kind === "thread") return null;
  const tool = span.kind === "toolCall" ? safeId(span.name) : span.kind === "commandExecution" ? "Command" : null;
  return { id: span.id, seq: 0, at: span.start, threadId: thread.id, turnId: span.turnId, itemId: span.itemId,
    projectId: thread.projectId, projectName: thread.projectId, provider: thread.provider,
    model: span.metadata.model ?? thread.model, environmentId: thread.environmentId, worktree: thread.worktree,
    child: thread.parentThreadId !== null, type: span.kind, kind: span.kind, status: span.status,
    tool, category: span.error ? "item-failed" : null, durationMs: span.durationMs, name: tool ? `${span.kind} · ${tool}` : span.kind };
}

export function scanFleetThread(db: Database.Database, thread: FleetThread, from: number, to: number, filter: FleetFilter, mode: FleetMode, bucketTo = to): ThreadContribution {
  const result: ThreadContribution = { thread, scannedEvents: 0, matchedEvents: 0, lastSeq: 0, limited: false, withUsageSnapshot: false,
    rows: [], histogram: Array.from({ length: 25 }, () => ({ count: 0, errors: 0 })), facets: {},
    toolDurations: new Map(), errors: new Map(), errorProviders: new Map(), errorTools: new Map(), ttft: new Map(),
    turns: 0, toolCalls: 0, failedTools: 0, retries: 0, fallbacks: 0 };
  let model = safeId(thread.model);
  const previousRequest = db.prepare(`SELECT data FROM events INDEXED BY events_thread_type_sequence_idx
    WHERE thread_id=? AND type='client/turn/requested' AND created_at<? ORDER BY sequence DESC LIMIT 1`).get(thread.id, from) as { data: string } | undefined;
  if (previousRequest && previousRequest.data.length <= 2_000_000) {
    try { model = safeId(object(object(JSON.parse(previousRequest.data)).execution).model) ?? model; }
    catch { result.limited = true; }
  }
  const starts = new Map<string, number[]>(); const backgrounds = new Map<string, number[]>();
  const turnStarts = new Map<string, number>(); const firstOutput = new Set<string>();
  const safeEvents: TraceEvent[] = [];
  const query = db.prepare(EVENT_SQL);
  for (const event of query.iterate(thread.id, from, to) as Iterable<DbEvent>) {
    if (++result.scannedEvents > MAX_THREAD_EVENTS) { result.limited = true; break; }
    result.lastSeq = event.seq;
    let data: Record<string, unknown> = {};
    if (event.data.length <= 2_000_000) {
      try { data = object(JSON.parse(event.data)); } catch { result.limited = true; }
    } else result.limited = true;
    const item = object(data.item);
    if (event.type === "client/turn/requested") model = safeId(object(data.execution).model) ?? model;
    if (event.type === "thread/tokenUsage/updated") result.withUsageSnapshot = true;
    if (event.type === "turn/started" && event.turnId) turnStarts.set(event.turnId, event.at);
    let durationMs = validMs(item.durationMs);
    const itemId = safeId(event.itemId) ?? safeId(item.id);
    if (itemId && event.type === "item/started") {
      const key = `${event.turnId ?? ""}\0${itemId}`;
      const list = starts.get(key) ?? []; list.push(event.at); starts.set(key, list);
      if (event.itemKind === "backgroundTask") backgrounds.set(itemId, list);
    } else if (itemId && (event.type === "item/completed" || event.type === "item/backgroundTask/completed")) {
      const list = event.type === "item/backgroundTask/completed" ? backgrounds.get(itemId) : starts.get(`${event.turnId ?? ""}\0${itemId}`);
      const start = list?.pop();
      if (start !== undefined) durationMs = Math.max(0, event.at - start);
    }
    if (event.type === "item/agentMessage/delta" || event.type === "item/reasoning/textDelta") {
      if (event.turnId && !firstOutput.has(event.turnId)) {
        firstOutput.add(event.turnId);
        const start = turnStarts.get(event.turnId);
        if (start !== undefined && event.at >= start) boundedSample(result.ttft, `${thread.provider}\0${new Date(event.at).getUTCHours()}`, event.at - start);
      }
    }
    if (mode === "spans") safeEvents.push(safeEvent(event, data));
    const row = rowForEvent(event, data, thread, model, durationMs);
    if (!matchesFleetFilter({ ...row, projectName: thread.projectName }, filter)) continue;
    if (mode === "events") addMatched(row);
    if (event.type === "turn/started") result.turns++;
    if (event.type === "provider/error" && data.willRetry === true) result.retries++;
    if (event.type === "provider/modelFallback") result.fallbacks++;
    if (event.type === "item/completed" && Object.hasOwn(TOOL_KINDS, row.kind)) {
      result.toolCalls++;
      if (row.status === "failed") result.failedTools++;
      const name = row.tool ?? row.kind;
      const group = !result.toolDurations.has(name) && result.toolDurations.size >= 200 ? "other tools" : name;
      let entry = result.toolDurations.get(group);
      if (!entry) { entry = { count: 0, unknown: 0, samples: [], partial: false }; result.toolDurations.set(group, entry); }
      entry.count++;
      if (durationMs === null) entry.unknown++;
      else if (entry.samples.length < MAX_TOOL_SAMPLES) entry.samples.push(durationMs);
      else entry.partial = true;
    }
    if (row.status === "failed") {
      increment(result.errors, row.category ?? "unknown"); increment(result.errorProviders, thread.provider);
      increment(result.errorTools, row.tool ?? row.kind);
    }
  }
  if (mode === "spans" && safeEvents.length) {
    const traceThread: TraceThread = { id: thread.id, title: null, providerId: thread.provider, environmentId: thread.environmentId,
      parentThreadId: thread.parentThreadId, createdAt: Math.max(from, thread.createdAt), updatedAt: thread.updatedAt, status: "idle" };
    const tree = buildTrace(traceThread, safeEvents).tree;
    const spanThread = { ...thread, model };
    const visit = (span: TraceSpan) => { const row = rowForSpan(span, spanThread);
      if (row && row.at >= from && row.at < to && matchesFleetFilter({ ...row, projectName: thread.projectName }, filter)) addMatched(row);
      for (const child of span.children) visit(child);
    };
    visit(tree);
  }
  return result;

  function addMatched(row: FleetRow) {
    result.matchedEvents++;
    const index = row.at >= bucketTo ? 24 : Math.min(23, Math.max(0, Math.floor((row.at - from) / Math.max(1, (bucketTo - from) / 24))));
    result.histogram[index]!.count++;
    if (row.status === "failed") result.histogram[index]!.errors++;
    for (const [field, value] of Object.entries({ project: row.projectId, provider: row.provider, model: row.model,
      environment: row.environmentId, worktree: String(row.worktree), child: String(row.child), kind: row.kind,
      status: row.status, tool: row.tool, category: row.category })) addFacet(result.facets, field, value);
    result.rows.push(row);
    if (result.rows.length > (filter.terms.thread ? 250 : MAX_ROWS_PER_THREAD)) {
      result.rows.sort((a, b) => b.at - a.at || b.seq - a.seq);
      result.rows.length = filter.terms.thread ? 250 : MAX_ROWS_PER_THREAD;
    }
  }
}
