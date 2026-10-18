// Ported from GenUI ui/components/{calendarMath,explain-logic,content-model,chartMath}.test.ts (Apache-2.0), cut to the helpers Data uses.
import { describe, expect, it } from "vitest";
import { buildTree, calendarLayout, dayLabel, dayString, defaultExpanded, firstWeekday, heatLevel, layoutDiagram, monthWeeks, parseDay, percentages, trendLabel, visibleRows, weekday, type TreeItem } from "./data.js";

describe("parseDay and dayString", () => {
  it("round-trips dates, whatever the process time zone", () => {
    for (const date of ["2026-01-01", "2026-03-08", "2026-10-25", "2024-02-29", "1999-12-31"]) expect(dayString(parseDay(date)!)).toBe(date);
    expect(parseDay("1970-01-02")).toBe(1);
  });

  it("rejects dates that do not exist or are not plain yyyy-mm-dd", () => {
    for (const date of ["2026-02-30", "2025-02-29", "2026-13-01", "0050-01-01", "2026-3-8", "2026-03-08T00:00", 20260308]) expect(parseDay(date)).toBeNull();
  });
});

describe("weekday and dayLabel", () => {
  it("names the day the date string says, not a neighbour", () => {
    expect(weekday(parseDay("2026-10-09")!)).toBe(5);
    expect(weekday(parseDay("1969-12-28")!)).toBe(0);
    expect(dayLabel(parseDay("2026-03-04")!)).toBe("Wed, Mar 4, 2026");
  });
});

describe("calendarLayout", () => {
  it("starts on the Sunday before the first day and covers the last", () => {
    const layout = calendarLayout(parseDay("2026-01-01")!, parseDay("2026-01-31")!);
    expect(dayString(layout.start)).toBe("2025-12-28");
    expect(layout.weeks).toBe(5);
    expect(layout.months).toEqual([{ week: 0, label: "Jan" }]);
  });

  it("names each month at the column holding its 1st", () => {
    // Feb 1 and Mar 1, 2026 are Sundays: the tops of weeks 5 and 9.
    expect(calendarLayout(parseDay("2026-01-01")!, parseDay("2026-03-31")!).months).toEqual([{ week: 0, label: "Jan" }, { week: 5, label: "Feb" }, { week: 9, label: "Mar" }]);
  });

  it("drops the name of a month the range enters too late to fit", () => {
    expect(calendarLayout(parseDay("2026-01-27")!, parseDay("2026-03-10")!).months.map((month) => month.label)).toEqual(["Feb", "Mar"]);
  });

  it("is one column for a single day", () => {
    const day = parseDay("2026-10-09")!;
    expect(calendarLayout(day, day)).toMatchObject({ weeks: 1, months: [{ week: 0, label: "Oct" }] });
  });
});

describe("monthWeeks and firstWeekday", () => {
  const dates = (weeks: (number | null)[][]) => weeks.map((week) => week.map((day) => day === null ? null : new Date(day * 86_400_000).getUTCDate()));

  it("pads a month into whole weeks from the given first day", () => {
    const monday = dates(monthWeeks(2026, 10, 1));
    expect(monday[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(monday.at(-1)).toEqual([26, 27, 28, 29, 30, 31, null]);
    expect(dates(monthWeeks(2026, 10, 0))[0]).toEqual([null, null, null, null, 1, 2, 3]);
    expect(monthWeeks(2026, 2, 0)).toHaveLength(4);
  });

  it("falls back to region data where Intl has no week info (Firefox)", () => {
    const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
    const saved = ["getWeekInfo", "weekInfo"].map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const);
    for (const [name] of saved) delete proto[name];
    try {
      expect(firstWeekday("en-US")).toBe(0);
      expect(firstWeekday("ja")).toBe(0);
      expect(firstWeekday("fr")).toBe(1);
      expect(firstWeekday("ar-EG")).toBe(6);
    } finally {
      for (const [name, descriptor] of saved) if (descriptor !== undefined) Object.defineProperty(proto, name, descriptor);
    }
  });

  it("starts the week where the locale does", () => {
    expect(firstWeekday("en-US")).toBe(0);
    expect(firstWeekday("en-GB")).toBe(1);
    expect(firstWeekday("de-DE")).toBe(1);
    expect(firstWeekday("ar-EG")).toBe(6);
    expect(firstWeekday("not a locale")).toBe(1);
  });
});

const shape = (items: readonly TreeItem[]): unknown[] => items.map((item) => item.folder ? { [`${item.label}/`]: shape(item.children) } : item.label);
const flatten = (items: readonly TreeItem[]): TreeItem[] => items.flatMap((item) => [item, ...flatten(item.children)]);
const find = (items: readonly TreeItem[], label: string) => flatten(items).find((item) => item.label === label)!;

describe("buildTree", () => {
  it("merges shared folders and puts folders before files in first-seen order", () => {
    expect(shape(buildTree(["README.md", "src/ui/b.tsx", "src/a.ts", "src/core/x.ts", "docs/", "src/ui/a.tsx", "package.json"]))).toEqual([
      { "src/": [{ "ui/": ["b.tsx", "a.tsx"] }, { "core/": ["x.ts"] }, "a.ts"] },
      { "docs/": [] },
      "README.md",
      "package.json",
    ]);
  });

  it("collapses duplicates and turns a file into a folder once something is below it", () => {
    expect(shape(buildTree(["src", "src/a.ts", "src/a.ts", "./src//b.ts"]))).toEqual([{ "src/": ["a.ts", "b.ts"] }]);
  });

  it("drops empty and unreadable entries", () => {
    expect(buildTree(["", "/", " ./ ", 42, null, true, [], { children: ["x"] }, { label: "  " }])).toEqual([]);
  });

  it("builds nested label items in their given order, with notes and string leaves", () => {
    const tree = buildTree([{ label: "Launch", note: "done" }, { label: "Backend", children: ["api/routes.ts", { label: "Database" }, "api/db.ts"] }]);
    expect(shape(tree)).toEqual(["Launch", { "Backend/": [{ "api/": ["routes.ts", "db.ts"] }, "Database"] }]);
    expect(find(tree, "Launch").note).toBe("done");
  });

  it("reorders path items around label items without moving the label items", () => {
    expect(shape(buildTree(["a.ts", { label: "Notes" }, "lib/b.ts"]))).toEqual([{ "lib/": ["b.ts"] }, "Notes", "a.ts"]);
  });

  it("gives every item a unique id that survives more items arriving", () => {
    const first = buildTree(["src/a.ts", { label: "x" }, { label: "x" }]);
    const ids = flatten(first).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const later = buildTree(["src/a.ts", { label: "x" }, { label: "x" }, "src/b.ts", "lib/c.ts"]);
    expect(find(later, "src").id).toBe(find(first, "src").id);
    expect(find(later, "a.ts").id).toBe(find(first, "a.ts").id);
  });
});

describe("defaultExpanded", () => {
  it("opens folders down to three levels", () => {
    const tree = buildTree(["a/b/c/d/e.ts"]);
    const open = defaultExpanded(tree);
    expect(open.has(find(tree, "a").id)).toBe(true);
    expect(open.has(find(tree, "c").id)).toBe(true);
    expect(open.has(find(tree, "d").id)).toBe(false);
  });

  it("leaves a folder closed when opening it would pass the row budget", () => {
    const tree = buildTree(["small/a.ts", ...Array.from({ length: 60 }, (_, i) => `big/f${i}.ts`)]);
    const open = defaultExpanded(tree);
    expect(open.has(find(tree, "small").id)).toBe(true);
    expect(open.has(find(tree, "big").id)).toBe(false);
  });
});

describe("visibleRows", () => {
  it("lists open folders' children with depth and sibling positions", () => {
    const tree = buildTree(["src/a.ts", "src/b.ts", "README.md"]);
    const src = find(tree, "src").id;
    const rows = visibleRows(tree, (id) => id === src);
    expect(rows.map((row) => [row.item.label, row.depth, row.position, row.siblings])).toEqual([["src", 0, 1, 2], ["a.ts", 1, 1, 2], ["b.ts", 1, 2, 2], ["README.md", 0, 2, 2]]);
    expect(rows[1]!.parent).toBe(src);
    expect(visibleRows(tree, () => false)).toHaveLength(2);
  });
});

describe("percentages", () => {
  it("always sums to 100", () => {
    expect(percentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentages([1, 2, 3, 4, 5, 6, 7])).toEqual([4, 7, 11, 14, 18, 21, 25]);
    expect(percentages([1000, 1, 1]).reduce((sum, share) => sum + share, 0)).toBe(100);
  });

  it("gives the spare points to the largest remainders", () => {
    expect(percentages([0.5, 0.5, 99])).toEqual([1, 0, 99]);
  });

  it("is all zeros without a positive total", () => {
    expect(percentages([])).toEqual([]);
    expect(percentages([0, 0])).toEqual([0, 0]);
  });
});

describe("trendLabel", () => {
  it("summarizes first to last with direction and change", () => {
    expect(trendLabel([12, 30, 18])).toBe("Trend from 12 to 18, up 50%");
    expect(trendLabel([1200, 900])).toBe("Trend from 1,200 to 900, down 25%");
    expect(trendLabel([4, 9, 4])).toBe("Trend from 4 to 4, flat");
    expect(trendLabel([0, 3])).toBe("Trend from 0 to 3, up");
    expect(trendLabel([7])).toBe("No trend");
  });
});

describe("heatLevel", () => {
  it("shades counts in levels, with nothing at level 0", () => {
    expect([0, -2, 1, 25, 26, 100].map((value) => heatLevel(value, 100))).toEqual([0, 0, 1, 1, 2, 4]);
    expect(heatLevel(5, 0)).toBe(0);
  });
});

describe("layoutDiagram", () => {
  it("puts each node one layer below its deepest parent", () => {
    expect(layoutDiagram(["a", "b", "c", "d"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "c", to: "d" }])).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("ignores the edge that closes a cycle, self loops, and unknown nodes", () => {
    expect(layoutDiagram(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }, { from: "b", to: "b" }, { from: "c", to: "zz" }])).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps unconnected nodes on the first layer", () => {
    expect(layoutDiagram(["x", "y"], [])).toEqual([["x", "y"]]);
  });

  it("orders a layer by where its parents sit, so edges do not cross", () => {
    expect(layoutDiagram(["l", "r", "under-r", "under-l"], [{ from: "l", to: "under-l" }, { from: "r", to: "under-r" }])).toEqual([["l", "r"], ["under-l", "under-r"]]);
  });
});
