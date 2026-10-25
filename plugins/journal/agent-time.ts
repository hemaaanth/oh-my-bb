// Agent time per work day, derived from the turn index. Pure: server.ts reads
// the turns and stores the results on work-day rows.
import { buildBlocks, DEFAULT_MERGE_GAP_MINUTES, formatDuration, MINUTE_MS, type TurnInterval } from "./calendar";
import { addWorkDays, localDayStart, localHour } from "./shared";

export const WORK_GAP_MS = DEFAULT_MERGE_GAP_MINUTES * MINUTE_MS;

export type WorkDayTurnStats = {
  activeMs: number; turnCount: number; blockCount: number;
  /** Null when no turn touches the day; callers then keep message times. */
  firstActivityAt: number | null; lastActivityAt: number | null;
};

/** Agent time for one thread's turns on the work day [day, nextDay). */
export function workDayTurnStats(turns: readonly TurnInterval[], day: number, nextDay: number, now: number): WorkDayTurnStats {
  const blocks = buildBlocks(turns, { from: day, to: nextDay, mergeGapMs: WORK_GAP_MS, now });
  let firstActivityAt: number | null = null; let lastActivityAt: number | null = null;
  for (const turn of turns) {
    const end = Math.max(turn.start, turn.end ?? now);
    // The same filter buildBlocks applies, so times and blocks agree.
    if (turn.start >= nextDay || end < day || (end === day && turn.start < day)) continue;
    const first = Math.max(turn.start, day);
    // Stay inside the day: work-day queries filter on last_activity_at < end.
    const last = Math.min(end, nextDay - 1);
    if (firstActivityAt === null || first < firstActivityAt) firstActivityAt = first;
    if (lastActivityAt === null || last > lastActivityAt) lastActivityAt = last;
  }
  return {
    activeMs: blocks.reduce((sum, block) => sum + block.activeMs, 0),
    turnCount: blocks.reduce((sum, block) => sum + block.turnCount, 0),
    blockCount: blocks.length, firstActivityAt, lastActivityAt,
  };
}

export type LastWork = { lastWorkedAt: number; agentMs: number; worked: string };

function partOfDay(hour: number): string {
  if (hour < 5) return "overnight";
  if (hour < 12) return "this morning";
  if (hour < 17) return "this afternoon";
  return "this evening";
}

/**
 * The latest work day of one thread's turns since `from` as a phrase, such as
 * "worked 2h 15m this morning" or "worked 40m yesterday". Null without turns.
 */
export function describeLastWork(turns: readonly TurnInterval[], from: number, now: number, timeZone: string): LastWork | null {
  const blocks = buildBlocks(turns, { from, to: now + 1, mergeGapMs: WORK_GAP_MS, now });
  if (blocks.length === 0) return null;
  // Block edges snap to 15 minutes; the last turn end is exact.
  const lastWorkedAt = Math.max(...turns.filter((turn) => turn.start < now + 1).map((turn) => Math.min(now, turn.end ?? now)));
  const day = localDayStart(Math.max(...blocks.map((block) => block.start)), timeZone);
  const dayBlocks = blocks.filter((block) => localDayStart(block.start, timeZone) === day);
  const agentMs = dayBlocks.reduce((sum, block) => sum + block.activeMs, 0);
  const today = localDayStart(now, timeZone);
  let when: string;
  if (day === today) {
    const parts = new Set(dayBlocks.map((block) => partOfDay(localHour(block.start, timeZone))));
    when = parts.size === 1 ? [...parts][0]! : "today";
  } else if (day === addWorkDays(today, -1, timeZone)) when = "yesterday";
  else if (day > addWorkDays(today, -7, timeZone)) when = `on ${new Date(day + 12 * 3_600_000).toLocaleDateString("en-US", { timeZone, weekday: "long" })}`;
  else when = `on ${new Date(day + 12 * 3_600_000).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" })}`;
  return { lastWorkedAt, agentMs, worked: `worked ${formatDuration(agentMs) || "<1m"} ${when}` };
}

/** CLI suffix for a work-day row, such as " · 2h 15m agent, 3 blocks". Empty without agent time. */
export function agentTimeText(day: { activeMs: number | null; blockCount?: number | null }): string {
  if (!day.activeMs) return "";
  const blocks = day.blockCount ? `, ${day.blockCount} ${day.blockCount === 1 ? "block" : "blocks"}` : "";
  return ` · ${formatDuration(day.activeMs) || "<1m"} agent${blocks}`;
}
