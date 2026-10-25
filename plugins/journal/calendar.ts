// Ported from Agent Calendar (activity.ts) by charpeni/bb-plugins agent-calendar.
// https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-calendar
// Copyright (c) charpeni. MIT License.
//
// Pure calendar math shared by the server (RPC + CLI) and the app. Everything
// here works on epoch milliseconds; "local" means the runtime's time zone, so
// the app renders in the viewer's zone and the CLI in the bb server's zone.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Blocks start and end on quarter hours, like a person's calendar entries. */
export const SNAP_MS = 15 * MINUTE_MS;

/** Realtime channel the server publishes on when calendar data changes. */
export const CHANGE_CHANNEL = "journal-calendar";

export const MERGE_GAP_MINUTES = [15, 30, 60, 120] as const;
export type MergeGapMinutes = (typeof MERGE_GAP_MINUTES)[number];
export const DEFAULT_MERGE_GAP_MINUTES: MergeGapMinutes = 30;

/** One agent turn. `end` is null while the turn is still running. */
export type TurnInterval = {
  threadId: string;
  start: number;
  end: number | null;
};

/** A calendar entry: one thread's work, with nearby turns merged together. */
export type ActivityBlock = {
  threadId: string;
  start: number;
  end: number;
  /** Time the agent was actually running inside the block (turn union). */
  activeMs: number;
  turnCount: number;
  ongoing: boolean;
};

export function isMergeGapMinutes(value: unknown): value is MergeGapMinutes {
  return MERGE_GAP_MINUTES.includes(value as MergeGapMinutes);
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

type OpenBlock = ActivityBlock & { rawEnd: number };

/**
 * Turns the raw turn history into calendar blocks for `[from, to)`.
 *
 * Turns of the same thread separated by at most `mergeGapMs` of idle time
 * become one block, so a thread that goes on and off for an hour shows as one
 * hour, while a morning session and an afternoon session stay apart. Each
 * block is then widened to the surrounding quarter hours.
 */
export function buildBlocks(
  turns: readonly TurnInterval[],
  options: { from: number; to: number; mergeGapMs: number; now: number },
): ActivityBlock[] {
  const { from, to, mergeGapMs, now } = options;
  const byThread = new Map<string, Array<{ start: number; end: number; ongoing: boolean }>>();
  for (const turn of turns) {
    const ongoing = turn.end === null;
    const end = Math.max(turn.start, turn.end ?? now);
    // A turn that ended exactly at `from` belongs to the previous range.
    if (turn.start >= to || end < from || (end === from && turn.start < from)) continue;
    const start = Math.max(turn.start, from);
    const clippedEnd = Math.min(end, to);
    let list = byThread.get(turn.threadId);
    if (!list) {
      list = [];
      byThread.set(turn.threadId, list);
    }
    list.push({ start, end: clippedEnd, ongoing });
  }

  const blocks: ActivityBlock[] = [];
  for (const [threadId, list] of byThread) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: OpenBlock[] = [];
    let current: OpenBlock | null = null;
    for (const turn of list) {
      if (current && turn.start - current.rawEnd <= mergeGapMs) {
        current.activeMs += Math.max(0, turn.end - Math.max(turn.start, current.rawEnd));
        current.rawEnd = Math.max(current.rawEnd, turn.end);
        current.turnCount += 1;
        current.ongoing ||= turn.ongoing;
        continue;
      }
      current = {
        threadId,
        start: turn.start,
        end: turn.end,
        rawEnd: turn.end,
        activeMs: turn.end - turn.start,
        turnCount: 1,
        ongoing: turn.ongoing,
      };
      merged.push(current);
    }

    let previous: ActivityBlock | null = null;
    for (const block of merged) {
      const start = Math.max(from, floorTo(block.start, SNAP_MS));
      let end = Math.min(to, ceilTo(block.rawEnd, SNAP_MS));
      if (end <= start) end = Math.min(to, start + SNAP_MS);
      // Snapping can make two blocks touch; a calendar would show them as one.
      if (previous && start <= previous.end) {
        previous.end = Math.max(previous.end, end);
        previous.activeMs += block.activeMs;
        previous.turnCount += block.turnCount;
        previous.ongoing ||= block.ongoing;
        continue;
      }
      previous = {
        threadId,
        start,
        end,
        activeMs: block.activeMs,
        turnCount: block.turnCount,
        ongoing: block.ongoing,
      };
      blocks.push(previous);
    }
  }

  return blocks.sort((a, b) => a.start - b.start || a.threadId.localeCompare(b.threadId));
}

/** Several threads' blocks merged under one key, such as their project. */
export type GroupBlock = {
  key: string;
  start: number;
  end: number;
  /** Summed agent turn time; parallel threads make it exceed wall time. */
  activeMs: number;
  ongoing: boolean;
  /** Calendar time per thread inside the block, longest first. */
  threads: Array<{ threadId: string; ms: number }>;
};

/**
 * Merges thread blocks that share a key (a project, say) and sit within
 * `mergeGapMs` of each other, so parallel agents read as one calendar entry.
 */
export function groupBlocks(
  blocks: readonly ActivityBlock[],
  keyOf: (threadId: string) => string,
  mergeGapMs: number,
): GroupBlock[] {
  const byKey = new Map<string, ActivityBlock[]>();
  for (const block of blocks) {
    const key = keyOf(block.threadId);
    byKey.set(key, [...(byKey.get(key) ?? []), block]);
  }

  const groups: GroupBlock[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let current: (GroupBlock & { perThread: Map<string, number> }) | null = null;
    const flush = () => {
      if (!current) return;
      const { perThread, ...group } = current;
      group.threads = [...perThread]
        .map(([threadId, ms]) => ({ threadId, ms }))
        .sort((a, b) => b.ms - a.ms || a.threadId.localeCompare(b.threadId));
      groups.push(group);
    };
    for (const block of list) {
      if (!current || block.start - current.end > mergeGapMs) {
        flush();
        current = {
          key,
          start: block.start,
          end: block.end,
          activeMs: block.activeMs,
          ongoing: block.ongoing,
          threads: [],
          perThread: new Map(),
        };
      } else {
        current.end = Math.max(current.end, block.end);
        current.activeMs += block.activeMs;
        current.ongoing ||= block.ongoing;
      }
      current.perThread.set(
        block.threadId,
        (current.perThread.get(block.threadId) ?? 0) + block.end - block.start,
      );
    }
    flush();
  }
  return groups.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}

/** Local midnight of the day containing `t`. */
export function startOfDay(t: number): number {
  const date = new Date(t);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar-day arithmetic that stays on local midnight across DST changes. */
export function addDays(t: number, days: number): number {
  const date = new Date(t);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** Local Monday 00:00 of the week containing `t`. */
export function startOfWeek(t: number): number {
  const day = startOfDay(t);
  const weekday = (new Date(day).getDay() + 6) % 7;
  return addDays(day, -weekday);
}

/** `count + 1` local-midnight boundaries starting at `start`. */
export function dayBoundaries(start: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, index) => addDays(start, index));
}

function overlap(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

export type TimesheetRow = {
  threadId: string;
  /** Calendar time per day, aligned with the boundaries passed in. */
  dayMs: number[];
  totalMs: number;
  activeMs: number;
  blockCount: number;
};

/**
 * Sums calendar time per thread and per day. Blocks that cross midnight are
 * split at the local day boundary.
 */
export function buildTimesheet(
  blocks: readonly ActivityBlock[],
  boundaries: readonly number[],
): TimesheetRow[] {
  const days = boundaries.length - 1;
  const rows = new Map<string, TimesheetRow>();
  for (const block of blocks) {
    let row = rows.get(block.threadId);
    if (!row) {
      row = {
        threadId: block.threadId,
        dayMs: Array.from({ length: days }, () => 0),
        totalMs: 0,
        activeMs: 0,
        blockCount: 0,
      };
      rows.set(block.threadId, row);
    }
    for (let day = 0; day < days; day += 1) {
      const ms = overlap(block.start, block.end, boundaries[day]!, boundaries[day + 1]!);
      row.dayMs[day]! += ms;
      row.totalMs += ms;
    }
    row.activeMs += block.activeMs;
    row.blockCount += 1;
  }
  return [...rows.values()].sort((a, b) => b.totalMs - a.totalMs);
}

/** "2h 15m", "45m", or "" for zero, rounded to the minute. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Decimal hours the way time sheets show them: "1.25", "0.5", "3". */
export function formatHours(ms: number): string {
  if (ms <= 0) return "";
  return String(Math.round((ms / HOUR_MS) * 100) / 100);
}

// Day layout for the calendar grid, in minutes since local midnight.

export const DAY_MINUTES = 24 * 60;
/** How far blocks move right on a day with Dispatch calls, to clear the call rail. */
export const CALL_RAIL_INSET_PX = 10;

/** Minutes since local midnight, so DST days still line up with the hour grid. */
export function wallMinutes(t: number, dayStart: number): number {
  if (t - dayStart >= 23 * 60 * MINUTE_MS && startOfDay(t) !== dayStart) return DAY_MINUTES;
  const date = new Date(t);
  return date.getHours() * 60 + date.getMinutes();
}

export type DaySegment<T> = { entry: T; top: number; bottom: number; lane: number; lanes: number; span: number };

/** Side-by-side lanes for overlapping entries, like a calendar app. */
export function layoutDay<T extends { start: number; end: number }>(entries: readonly T[], dayStart: number, dayEnd: number): DaySegment<T>[] {
  const segments: DaySegment<T>[] = entries.filter((entry) => entry.start < dayEnd && entry.end > dayStart).map((entry) => {
    const top = wallMinutes(Math.max(entry.start, dayStart), dayStart);
    const bottom = Math.max(top + 15, wallMinutes(Math.min(entry.end, dayEnd), dayStart));
    return { entry, top, bottom: Math.min(bottom, DAY_MINUTES), lane: 0, lanes: 1, span: 1 };
  }).sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: DaySegment<T>[] = []; let laneEnds: number[] = []; let clusterEnd = -1;
  const flush = () => {
    for (const segment of cluster) {
      segment.lanes = laneEnds.length;
      const blocked = (lane: number) => cluster.some((other) => other.lane === lane && other.top < segment.bottom && other.bottom > segment.top);
      while (segment.lane + segment.span < segment.lanes && !blocked(segment.lane + segment.span)) segment.span += 1;
    }
    cluster = []; laneEnds = [];
  };
  for (const segment of segments) {
    if (segment.top >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= segment.top);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(segment.bottom); } else laneEnds[lane] = segment.bottom;
    segment.lane = lane; cluster.push(segment); clusterEnd = Math.max(clusterEnd, segment.bottom);
  }
  flush();
  return segments;
}

/** A call's piece of one day. `end` is null while the call is live. */
export type CallSegment<T> = { call: T; top: number; bottom: number; live: boolean };

/** Call pieces for one day. Calls never take a lane; a live call runs to `now`; a call across midnight splits per day. */
export function layoutCalls<T extends { start: number; end: number | null }>(calls: readonly T[], dayStart: number, dayEnd: number, now: number): CallSegment<T>[] {
  return calls.flatMap((call) => {
    const end = Math.max(call.start, call.end ?? now);
    if (call.start >= dayEnd || (end <= dayStart && call.start !== dayStart)) return [];
    const top = wallMinutes(Math.max(call.start, dayStart), dayStart);
    return [{ call, top, bottom: Math.max(top, wallMinutes(Math.min(end, dayEnd), dayStart)), live: call.end === null }];
  });
}

/** One day of the grid: block lanes, the call rail, and the block inset the rail needs. */
export function layoutDayWithCalls<T extends { start: number; end: number }, C extends { start: number; end: number | null }>(
  entries: readonly T[], calls: readonly C[], dayStart: number, dayEnd: number, now: number,
) {
  const rail = layoutCalls(calls, dayStart, dayEnd, now);
  return { segments: layoutDay(entries, dayStart, dayEnd), calls: rail, inset: rail.length > 0 ? CALL_RAIL_INSET_PX : 0 };
}

/** Calls the search box keeps: all of them, or those whose title or summary matches. Project and work-type filters never hide calls. */
export function filterCalls<T extends { title: string | null; summary: string | null }>(calls: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...calls];
  return calls.filter((call) => [call.title, call.summary].some((text) => text?.toLowerCase().includes(needle)));
}
