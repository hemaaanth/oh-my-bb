// Turn index ported from Agent Calendar (server.ts) by charpeni/bb-plugins agent-calendar.
// https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-calendar
// Copyright (c) charpeni. MIT License.
//
// Stores turn start/end times per thread from bb's turn events. Journal adds
// root rollup: child threads and side chats count toward their root thread.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DAY_MS, type TurnInterval } from "./calendar";

export const MAX_RANGE_MS = 62 * DAY_MS;
// Colors go to the most active projects of this window, whatever range is shown.
export const COLOR_WINDOW_MS = 30 * DAY_MS;
export const COLOR_SLOTS = 8;
export const THREAD_PAGE_SIZE = 500;
// The events endpoint refuses pages larger than 100.
export const EVENT_PAGE_SIZE = 100;
export const SYNC_CONCURRENCY = 6;
export const FRESH_SYNC_MS = 30_000;
export const THREAD_SYNC_DEBOUNCE_MS = 1_500;
export const CHANGE_SIGNAL_DEBOUNCE_MS = 1_000;
export const RUNNING_STATUSES = new Set(["active", "starting", "stopping"]);
export const TURN_EVENT_TYPES = ["turn/started", "turn/completed"] as const;

export type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;
type Sdk = BbPluginApi["sdk"];
export type ThreadSummary = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];
export type TurnThread = Pick<ThreadSummary, "id" | "projectId" | "title" | "status" | "archivedAt"
  | "parentThreadId" | "sourceThreadId" | "originPluginId" | "updatedAt">;
export type TurnEvent = Awaited<ReturnType<Sdk["threads"]["events"]["list"]>>[number];

export type TurnThreadRow = {
  thread_id: string; project_id: string; title: string | null; status: string; archived_at: number | null;
  parent_thread_id: string | null; source_thread_id: string | null; origin_plugin_id: string | null;
  updated_at: number; synced_updated_at: number | null; last_seq: number;
};

export async function mapWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]!);
  });
  await Promise.all(runners);
}

export function upsertTurnThread(db: PluginDatabase, thread: TurnThread): void {
  db.prepare(`INSERT INTO journal_turn_threads (thread_id, project_id, title, status, archived_at, parent_thread_id,
      source_thread_id, origin_plugin_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, status=excluded.status,
      archived_at=excluded.archived_at, parent_thread_id=excluded.parent_thread_id, source_thread_id=excluded.source_thread_id,
      origin_plugin_id=excluded.origin_plugin_id, updated_at=MAX(journal_turn_threads.updated_at, excluded.updated_at)`)
    .run(thread.id, thread.projectId, thread.title, thread.status, thread.archivedAt, thread.parentThreadId,
      thread.sourceThreadId ?? null, thread.originPluginId ?? null, thread.updatedAt);
}

export function deleteTurnThread(db: PluginDatabase, threadId: string): void {
  db.prepare("DELETE FROM journal_turns WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM journal_turn_threads WHERE thread_id = ?").run(threadId);
}

/** Records turn events and returns whether any calendar data changed. */
export function applyTurnEvents(db: PluginDatabase, threadId: string, events: readonly TurnEvent[]): boolean {
  let changed = false;
  const start = db.prepare(`INSERT INTO journal_turns (thread_id, turn_id, started_at, ended_at) VALUES (?, ?, ?, NULL)
    ON CONFLICT(thread_id, turn_id) DO NOTHING`);
  const complete = db.prepare(`INSERT INTO journal_turns (thread_id, turn_id, started_at, ended_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id, turn_id) DO UPDATE SET ended_at = excluded.ended_at
    WHERE journal_turns.ended_at IS NULL OR journal_turns.ended_at <> excluded.ended_at`);
  const completeLatestOpen = db.prepare(`UPDATE journal_turns SET ended_at = ?
    WHERE thread_id = ? AND ended_at IS NULL AND started_at <= ?`);
  db.transaction(() => {
    for (const event of events) {
      const turnId = event.scope.kind === "turn" ? event.scope.turnId : null;
      let changes = 0;
      if (event.type === "turn/started") {
        changes = start.run(threadId, turnId ?? `seq:${event.seq}`, event.createdAt).changes;
      } else if (event.type === "turn/completed") {
        changes = turnId
          ? complete.run(threadId, turnId, event.createdAt, event.createdAt).changes
          : completeLatestOpen.run(event.createdAt, threadId, event.createdAt).changes;
      }
      if (changes > 0) changed = true;
    }
  })();
  return changed;
}

/**
 * Reads the stored turns that overlap `[from, to)`. A turn left open by a
 * thread that is no longer running (a crash, a lost completion event) ends at
 * the thread's last update instead of growing forever.
 */
export function readTurns(db: PluginDatabase, from: number, to: number, threadIds?: readonly string[]): TurnInterval[] {
  const only = threadIds ? ` AND turns.thread_id IN (${threadIds.map(() => "?").join(", ") || "NULL"})` : "";
  const rows = db.prepare(`SELECT turns.thread_id, turns.started_at, turns.ended_at, threads.status, threads.updated_at,
      (SELECT MIN(next.started_at) FROM journal_turns AS next
        WHERE next.thread_id = turns.thread_id AND next.started_at > turns.started_at) AS next_started_at
    FROM journal_turns AS turns JOIN journal_turn_threads AS threads ON threads.thread_id = turns.thread_id
    WHERE turns.started_at < ? AND (turns.ended_at IS NULL OR turns.ended_at >= ?)${only}`)
    .all(to, from, ...(threadIds ?? [])) as Array<{ thread_id: string; started_at: number; ended_at: number | null;
      status: string; updated_at: number; next_started_at: number | null }>;
  return rows.map((row) => {
    if (row.ended_at !== null) return { threadId: row.thread_id, start: row.started_at, end: row.ended_at };
    if (RUNNING_STATUSES.has(row.status) && row.next_started_at === null) return { threadId: row.thread_id, start: row.started_at, end: null };
    const cap = Math.min(row.next_started_at ?? Infinity, row.updated_at);
    return { threadId: row.thread_id, start: row.started_at, end: Math.max(row.started_at, cap) };
  });
}

/**
 * Maps every indexed thread to its root. Side chats follow sourceThreadId,
 * other children follow parentThreadId. A parent outside the index (hidden or
 * deleted) ends the walk, so that child becomes its own root.
 */
export function rootMap(db: PluginDatabase): Map<string, string> {
  const rows = db.prepare("SELECT thread_id, parent_thread_id, source_thread_id, origin_plugin_id FROM journal_turn_threads")
    .all() as Array<Pick<TurnThreadRow, "thread_id" | "parent_thread_id" | "source_thread_id" | "origin_plugin_id">>;
  const parentOf = new Map(rows.map((row) => [row.thread_id,
    row.origin_plugin_id === "side-chat" && row.source_thread_id ? row.source_thread_id : row.parent_thread_id]));
  const roots = new Map<string, string>();
  for (const { thread_id: id } of rows) {
    let current = id; const seen = new Set([id]);
    for (;;) {
      const parent = parentOf.get(current);
      if (!parent || !parentOf.has(parent) || seen.has(parent)) break;
      seen.add(parent); current = parent;
    }
    roots.set(id, current);
  }
  return roots;
}

/** The most active projects over the color window, most active first. */
export function busiestProjects(db: PluginDatabase, now: number): string[] {
  const from = now - COLOR_WINDOW_MS;
  const projectOf = new Map((db.prepare("SELECT thread_id, project_id FROM journal_turn_threads").all() as TurnThreadRow[])
    .map((row) => [row.thread_id, row.project_id]));
  const totals = new Map<string, number>();
  // readTurns caps abandoned turns, which would otherwise count until now.
  for (const turn of readTurns(db, from, now)) {
    const projectId = projectOf.get(turn.threadId);
    if (projectId === undefined) continue;
    const ms = Math.max(0, (turn.end ?? now) - Math.max(turn.start, from));
    totals.set(projectId, (totals.get(projectId) ?? 0) + ms);
  }
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, COLOR_SLOTS).map(([projectId]) => projectId);
}

export function turnThreadTitle(row: Pick<TurnThreadRow, "thread_id" | "title">): string {
  return row.title?.trim() || `Untitled thread (${row.thread_id})`;
}
