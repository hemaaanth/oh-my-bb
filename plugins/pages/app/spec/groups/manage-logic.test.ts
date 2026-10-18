// Ported in part from GenUI core/tracking.test.ts and core/decisions.test.ts (Apache-2.0).
import { describe, expect, it } from "vitest";
import { boardColumns, dropItems, estimateTask, moveCards, placeCard, slotIndex, estimateTotals, formatDay, localDay, parseDay, readRoadmap, statusKey } from "./manage-logic.js";

const TODAY = parseDay("2026-10-10")!;
const iso = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

describe("days", () => {
  it("parses yyyy-mm-dd and ISO date-times by their date part", () => {
    expect(iso(TODAY)).toBe("2026-10-10");
    expect(parseDay("2026-10-10T23:59:00-07:00")).toBe(TODAY);
    expect(parseDay("2026-2-3")).toBe(parseDay("2026-02-03"));
  });

  it("refuses impossible and non-date values", () => {
    for (const value of ["2026-02-30", "10/10/2026", "", 20261010, undefined]) expect(parseDay(value)).toBeNull();
  });

  it("reads today from the wall clock's calendar day", () => {
    expect(localDay(new Date(2026, 9, 10, 23, 30))).toBe(TODAY);
    expect(localDay(new Date(2026, 9, 10, 0, 5))).toBe(TODAY);
  });

  it("formats days, adding the year only when it isn't this year's", () => {
    expect(formatDay(TODAY, TODAY)).toBe("Oct 10");
    expect(formatDay(parseDay("2027-01-04")!, TODAY)).toBe("Jan 4, 2027");
  });
});

describe("boardColumns", () => {
  it("reads aliases, puts unknown statuses after the workflow and no status last", () => {
    const board = boardColumns([{ title: "Ship it", status: "Done" }, { title: "QA pass", status: "QA" }, { title: "Write docs", status: "in-progress" }, { title: "Spike" }, { title: "Review API", status: "review" }]);
    expect(board.columns.map((column) => [column.label, column.cards.length, column.closed])).toEqual([["In progress", 1, false], ["In review", 1, false], ["Done", 1, true], ["QA", 1, false], ["No status", 1, false]]);
    expect(board.hidden).toBe(0);
    expect(statusKey("Doing")).toBe("in_progress");
    expect(statusKey("Cancelled")).toBe("canceled");
  });

  it("shows the columns asked for, in that order, empty ones included, and counts the rest", () => {
    const board = boardColumns([{ status: "todo" }, { status: "done" }, { status: "blocked" }], ["Done", "In progress", "Todo"]);
    expect(board.columns.map((column) => [column.label, column.cards.length])).toEqual([["Done", 1], ["In progress", 0], ["Todo", 1]]);
    expect(board.hidden).toBe(1);
  });

  it("moves cards between the columns the cards first made and lists each card off its own column", () => {
    const cards = [{ title: "A", status: "todo" }, { title: "B", status: "todo" }, { title: "C", status: "done" }, { title: "D", status: "QA" }];
    const base = boardColumns(cards, ["Todo", "Done"]).columns;
    const moved = moveCards(base, cards, { todo: [2, 1, 1], done: [0, 3, 9], nowhere: [1] });
    expect(moved.columns.map((column) => [column.label, column.cards.map((card) => [card.title, card.index])])).toEqual([["Todo", [["C", 2], ["B", 1]]], ["Done", [["A", 0], ["D", 3]]]]);
    expect(moved.lines).toEqual(["- A: Todo → Done", "- C: Done → Todo", "- D: QA → Done"]);
    const left = moveCards(boardColumns(cards.slice(0, 3)).columns, cards.slice(0, 3), { todo: [2] });
    expect(left.columns.map((column) => [column.label, column.cards.map((card) => card.title)])).toEqual([["Todo", ["C", "A", "B"]], ["Done", []]]);
    expect(left.lines).toEqual(["- C: Done → Todo"]);
  });

  it("reorders within a column without a line, and places across columns at the slot", () => {
    const cards = [{ title: "A", status: "todo" }, { title: "B", status: "todo" }, { title: "C", status: "done" }];
    const base = boardColumns(cards).columns;
    const shown = { todo: [0, 1], done: [2] };
    const reordered = moveCards(base, cards, placeCard(shown, 0, "todo", 1));
    expect(reordered.columns[0]!.cards.map((card) => card.title)).toEqual(["B", "A"]);
    expect(reordered.lines).toEqual([]);
    expect(placeCard(shown, 1, "done", 0)).toEqual({ todo: [0], done: [1, 2] });
    expect(placeCard(shown, 0, "done")).toEqual({ todo: [1], done: [2, 0] });
    expect(placeCard(shown, 2, "todo", -3)).toEqual({ todo: [2, 0, 1], done: [] });
  });

  it("finds the slot from the cards' middles and opens it in the column", () => {
    expect([0, 15, 30, 99].map((y) => slotIndex([10, 30, 50], y))).toEqual([0, 1, 1, 3]);
    expect(slotIndex([], 40)).toBe(0);
    const column = [{ index: 4 }, { index: 7 }, { index: 9 }];
    expect(dropItems(column, 7, 0)).toEqual([null, { index: 4 }, { index: 9 }]);
    expect(dropItems(column, 7, 2)).toEqual([{ index: 4 }, { index: 9 }, null]);
    expect(dropItems(column, 1, null)).toEqual(column);
  });
});

describe("Estimate (PERT)", () => {
  it("computes the PERT mean and σ per task; likely defaults to the midpoint", () => {
    expect(estimateTask({ task: "a", low: 2, likely: 3, high: 6 })).toMatchObject({ error: null, likely: 3, mean: 20 / 6, sd: 4 / 6 });
    expect(estimateTask({ task: "b", low: 1, high: 4 })).toMatchObject({ likely: 2.5, mean: 2.5, sd: 0.5 });
    expect(estimateTask({ task: "c", low: 5, likely: 5, high: 5 })).toMatchObject({ mean: 5, sd: 0 });
  });

  it("explains invalid rows", () => {
    expect(estimateTask({ task: "a", low: 5, high: 3 }).error).toBe("low 5 is above high 3");
    expect(estimateTask({ task: "a", low: 1, likely: 9, high: 3 }).error).toBe("likely 9 is outside 1–3");
    expect(estimateTask({ task: "a", high: 3 }).error).toBe("needs low");
    expect(estimateTask({ task: "a", low: 3 }).error).toBe("needs high");
    expect(estimateTask({ task: "a" }).error).toBe("needs low and high");
    expect(estimateTask({ task: "a", low: -1, high: 3 }).error).toBe("can't be negative");
  });

  it("adds means and variances, P50/P80/P90 from the normal approximation, invalid rows left out", () => {
    const totals = estimateTotals([{ task: "a", low: 2, likely: 3, high: 6 }, { task: "b", low: 1, likely: 2, high: 9 }, { task: "c", low: 4, likely: 5, high: 12 }, { task: "bad", low: 9, high: 1 }].map(estimateTask));
    expect(totals).toMatchObject({ count: 3, excluded: 1, low: 7, likely: 10, high: 27 });
    // By hand: mean 74/6 ≈ 12.33, σ = √(4/9 + 16/9 + 16/9) = 2.
    expect(totals.p50).toBeCloseTo(74 / 6, 10);
    expect(totals.p80).toBeCloseTo(74 / 6 + 0.8416212335729143 * 2, 10);
    expect(totals.p90).toBeCloseTo(14.9, 2);
  });

  it("clamps the percentiles to the sum of the highs", () => {
    const totals = estimateTotals([estimateTask({ task: "a", low: 0, likely: 10, high: 10 })]);
    expect(totals.p50).toBeCloseTo(50 / 6, 10);
    expect(totals.p90).toBe(10);
  });

  it("is all zeros with no valid task", () => {
    expect(estimateTotals([])).toEqual({ count: 0, excluded: 0, low: 0, likely: 0, high: 0, p50: 0, p80: 0, p90: 0 });
  });
});

describe("readRoadmap", () => {
  const plan = [
    { title: "Design", start: "2026-09-21", end: "2026-10-02", lane: "Product", status: "done" as const },
    { title: "Build", start: "2026-10-01", end: "2026-10-20", lane: "Engineering" },
    { title: "Beta", start: "2026-10-23", lane: "Engineering" },
    { title: "Docs", start: "2026-09-28", end: "2026-10-08", lane: "Product" },
    { title: "Launch", start: "2026-10-28", end: "2026-10-28", milestone: true },
  ];

  it("lays out lanes in first-seen order with inclusive end days", () => {
    const roadmap = readRoadmap(plan, TODAY);
    expect(roadmap.lanes.map((lane) => [lane.name, lane.items.map((item) => item.title)])).toEqual([["Product", ["Design", "Docs"]], ["Engineering", ["Build", "Beta"]], ["", ["Launch"]]]);
    expect(iso(roadmap.lanes[1]!.items[0]!.end)).toBe("2026-10-20");
  });

  it("derives status, milestones, and lateness", () => {
    const [[design, docs], [build, beta], [launch]] = readRoadmap(plan, TODAY).lanes.map((lane) => lane.items);
    expect(design).toMatchObject({ status: "done", late: false });
    expect(build).toMatchObject({ status: "active", late: false });
    expect(beta).toMatchObject({ milestone: true, status: "planned", end: beta!.start });
    expect(docs).toMatchObject({ status: "planned", late: true });
    expect(launch).toMatchObject({ milestone: true, late: false });
  });

  it("picks the axis scale from the span and aligns the axis to it", () => {
    const weeks = readRoadmap(plan, TODAY);
    expect(iso(weeks.from)).toBe("2026-09-21");
    expect(weeks.ticks[0]!.label).toBe("Sep 21");
    expect(weeks.ticks.find((tick) => tick.major)?.label).toBe("Oct 5");
    const months = readRoadmap([{ title: "H1", start: "2026-11-15", end: "2027-03-01" }, { title: "H2", start: "2027-03-02", end: "2027-08-30" }], TODAY);
    expect(iso(months.from)).toBe("2026-10-01");
    expect(months.ticks.map((tick) => tick.label).slice(0, 4)).toEqual(["Oct 2026", "Nov", "Dec", "Jan 2027"]);
    const days = readRoadmap([{ title: "Sprint", start: "2026-10-12", end: "2026-10-23" }], TODAY);
    expect(days.from).toBe(TODAY);
    expect(days.ticks).toHaveLength(14);
  });

  it("leaves far-away today off the axis", () => {
    expect(readRoadmap([{ title: "Next year", start: "2027-06-01", end: "2027-06-30" }], TODAY).from).toBeGreaterThan(TODAY);
  });

  it("skips items without usable dates", () => {
    const roadmap = readRoadmap([{ title: "Fine", start: "2026-10-01", end: "2026-10-05" }, { title: "Backwards", start: "2026-10-05", end: "2026-10-01" }, { title: "Undated" }, { title: "", start: "2026-10-01" }], TODAY);
    expect(roadmap.lanes.flatMap((lane) => lane.items.map((item) => item.title))).toEqual(["Fine"]);
    expect(roadmap.skipped).toBe(3);
    expect(readRoadmap([], TODAY)).toMatchObject({ lanes: [], ticks: [], skipped: 0 });
  });
});
