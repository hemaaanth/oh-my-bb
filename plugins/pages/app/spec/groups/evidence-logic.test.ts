// Ported in part from GenUI core/acceptance.test.ts and core/transcript.test.ts (Apache-2.0).
import { describe, expect, it } from "vitest";
import { acceptanceVerdict, cellNumber, compareBest, evidenceShape, formatClock } from "./evidence-logic.js";

describe("acceptanceVerdict", () => {
  it("says the verdict in plain words, conclusion first", () => {
    expect(acceptanceVerdict([{ criterion: "a", status: "pass" }, { criterion: "b", status: "fail" }, { criterion: "c", status: "unknown" }, { criterion: "d" }])).toMatchObject({ headline: "Not done", tone: "danger", line: "1 of 4 criteria pass · 1 failing · 2 unknown" });
    expect(acceptanceVerdict([{ criterion: "a", status: "pass" }, { criterion: "b" }])).toMatchObject({ headline: "Not proven", tone: "warning", line: "1 of 2 criteria pass · 1 unknown" });
    expect(acceptanceVerdict([{ criterion: "a", status: "pass" }])).toMatchObject({ headline: "Done", tone: "success", line: "All 1 criterion pass" });
    expect(acceptanceVerdict([])).toMatchObject({ headline: "No criteria", tone: "neutral" });
  });
});

describe("evidenceShape", () => {
  it("tells files, links, and text apart", () => {
    const kinds = ["src/app.ts:42", "src/app.test.ts:10-14", "core/x.ts#L5-L9", "C:\\repo\\a.ts:3:7", "$BB_THREAD_STORAGE/finish-verification.json", "/tmp/shot.png", "https://example.com/run/12", "506/506 tests passed", "506/506", "v1.2.3", "README.md", " https://a.io/x "].map((text) => evidenceShape(text).kind);
    expect(kinds).toEqual(["file", "file", "file", "file", "file", "file", "url", "text", "text", "text", "file", "url"]);
  });
});

describe("compareBest", () => {
  it("reads leading numbers from text", () => {
    expect([12, "$1,200", "120 ms", "4.5", "-3", "Yes", null, Number.NaN].map(cellNumber)).toEqual([12, 1200, 120, 4.5, -3, null, null, null]);
  });

  it("marks the best cell per scored row, counts ties for each, and names a lone leader", () => {
    const { best, wins, leader } = compareBest(3, [
      { criterion: "Cost", values: ["$120", "$310", "$0"], better: "low" },
      { criterion: "Size", values: [64, null, 0.3], better: "high" },
      { criterion: "Speed", values: [5, 5, 2], better: "high" },
      { criterion: "Same", values: [1, 1, 1], better: "high" },
      { criterion: "Joins", values: ["Yes", "No", "Yes"] },
    ]);
    expect(best).toEqual([[false, false, true], [true, false, false], [true, true, false], [false, false, false], [false, false, false]]);
    expect(wins).toEqual([2, 1, 1]);
    expect(leader).toBe(0);
  });

  it("has no leader on a tie or with nothing scored", () => {
    expect(compareBest(2, [{ criterion: "a", values: [1, 2], better: "high" }, { criterion: "b", values: [1, 2], better: "low" }]).leader).toBeNull();
    expect(compareBest(2, [{ criterion: "a", values: [1, 2] }, { criterion: "b" }]).leader).toBeNull();
  });
});

describe("formatClock", () => {
  it("writes m:ss, and h:mm:ss past an hour", () => {
    expect([0, 5.9, 65, 1189.46, 3723, -4].map(formatClock)).toEqual(["0:00", "0:05", "1:05", "19:49", "1:02:03", "0:00"]);
  });
});
