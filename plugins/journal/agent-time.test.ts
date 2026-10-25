import { describe, expect, it } from "vitest";
import { agentTimeText, describeLastWork, workDayTurnStats } from "./agent-time";
import { addWorkDays, localDayStart } from "./shared";

// vitest.config.ts pins TZ to America/Toronto, which matches New York.
const ZONE = "America/New_York";
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const day5 = localDayStart(at(5, 12), ZONE);
const day6 = addWorkDays(day5, 1, ZONE);
type Turn = { threadId: string; start: number; end: number | null };
const lastWork = (turns: Turn[], now: number) => describeLastWork(turns, at(1, 0), now, ZONE);

describe("workDayTurnStats", () => {
  it("sums agent time and counts blocks inside one work day", () => {
    const stats = workDayTurnStats([
      { threadId: "a", start: at(5, 9, 5), end: at(5, 9, 20) },
      { threadId: "a", start: at(5, 9, 40), end: at(5, 9, 55) },
      { threadId: "a", start: at(5, 14), end: at(5, 14, 20) },
    ], day5, day6, at(6, 12));
    expect(stats).toEqual({ activeMs: 50 * 60_000, turnCount: 3, blockCount: 2, firstActivityAt: at(5, 9, 5), lastActivityAt: at(5, 14, 20) });
  });

  it("clips a turn across midnight to each day", () => {
    const turns = [{ threadId: "a", start: at(5, 23, 30), end: at(6, 0, 30) }];
    expect(workDayTurnStats(turns, day5, day6, at(7, 12))).toMatchObject({ activeMs: 30 * 60_000, firstActivityAt: at(5, 23, 30), lastActivityAt: day6 - 1 });
    expect(workDayTurnStats(turns, day6, addWorkDays(day6, 1, ZONE), at(7, 12))).toMatchObject({ activeMs: 30 * 60_000, firstActivityAt: day6, lastActivityAt: at(6, 0, 30) });
  });

  it("returns zero time and no bounds when no turn touches the day", () => {
    expect(workDayTurnStats([{ threadId: "a", start: at(6, 9), end: at(6, 10) }], day5, day6, at(7, 12)))
      .toEqual({ activeMs: 0, turnCount: 0, blockCount: 0, firstActivityAt: null, lastActivityAt: null });
  });
});

describe("describeLastWork", () => {
  it("names the part of today", () => {
    const now = at(5, 16);
    expect(lastWork([{ threadId: "a", start: at(5, 9), end: at(5, 11, 10) }], now))
      .toEqual({ lastWorkedAt: at(5, 11, 10), agentMs: 130 * 60_000, worked: "worked 2h 10m this morning" });
    expect(lastWork([{ threadId: "a", start: at(5, 9), end: at(5, 9, 30) }, { threadId: "a", start: at(5, 14), end: at(5, 14, 30) }], now)?.worked)
      .toBe("worked 1h today");
  });

  it("uses yesterday, a weekday, then a date for older work", () => {
    const turns = [{ threadId: "a", start: at(5, 9), end: at(5, 9, 40) }];
    expect(lastWork(turns, at(6, 10))?.worked).toBe("worked 40m yesterday");
    expect(lastWork(turns, at(9, 10))?.worked).toBe("worked 40m on Monday");
    expect(lastWork(turns, at(14, 10))?.worked).toBe("worked 40m on Oct 5");
  });

  it("counts a running block up to now", () => {
    const now = at(5, 20);
    const result = lastWork([{ threadId: "a", start: at(5, 19), end: null }], now);
    expect(result).toMatchObject({ lastWorkedAt: now, worked: "worked 1h this evening" });
  });

  it("returns null without blocks", () => {
    expect(lastWork([], at(5, 10))).toBeNull();
  });
});

describe("agentTimeText", () => {
  it("formats agent time for CLI rows", () => {
    expect(agentTimeText({ activeMs: 135 * 60_000, blockCount: 3 })).toBe(" · 2h 15m agent, 3 blocks");
    expect(agentTimeText({ activeMs: 20_000, blockCount: 1 })).toBe(" · <1m agent, 1 block");
    expect(agentTimeText({ activeMs: 40 * 60_000 })).toBe(" · 40m agent");
    expect(agentTimeText({ activeMs: 0, blockCount: 0 })).toBe("");
    expect(agentTimeText({ activeMs: null })).toBe("");
  });
});
