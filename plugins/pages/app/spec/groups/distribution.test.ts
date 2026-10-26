// Statistical boundaries ported from GenUI core/distribution.test.ts (Apache-2.0).
import { describe, expect, it } from "vitest";
import { autoEdges, boxSummary, histogram, quantile, readSample } from "./distribution.js";

describe("raw-observation charts", () => {
  it("keeps numeric observations, not strings or missing values, with an omission count", () => {
    expect(readSample("Latency", [3, null, 1, Number.NaN, Infinity, "2", 2])).toEqual({ name: "Latency", values: [1, 2, 3], dropped: 4 });
  });

  it("uses inclusive final bins and shared edges for every series", () => {
    expect(histogram([0, 10, 20], [[-1, 0, 9.9, 10, 20, 21], [15]])).toEqual({ edges: [0, 10, 20], counts: [[2, 2], [0, 1]], outside: 2 });
    expect(histogram([], [[1, 2], [9, 10]])?.edges).toEqual([0, 2, 4, 6, 8, 10]);
    for (const edges of [["a", "b"], [10, 0], [5], [0, 0, 1]]) expect(histogram(edges, [[1]])).toBeNull();
  });

  it("keeps constant samples in one bin and bounds wide-spread auto bins", () => {
    expect(autoEdges([5, 5, 5])).toEqual([4.5, 5.5]);
    expect(autoEdges([])).toEqual([]);
    expect(autoEdges([...Array.from({ length: 200 }, (_, i) => 100 + i % 10), 100000]).length - 1).toBeLessThanOrEqual(40);
  });

  it("draws type-7 quartiles and Tukey whiskers without hiding outliers", () => {
    expect([0.25, 0.5, 0.75].map((p) => quantile([1, 2, 3, 4], p))).toEqual([1.75, 2.5, 3.25]);
    expect(boxSummary([1, 2, 3, 4, 100])).toEqual({ n: 5, min: 1, q1: 2, median: 3, q3: 4, max: 100, low: 1, high: 4, outliers: [100] });
    expect(boxSummary([1, 2, 3, 4, 7])).toMatchObject({ high: 7, outliers: [] });
    expect(boxSummary([3, 3, 3])).toMatchObject({ low: 3, q1: 3, median: 3, q3: 3, high: 3, outliers: [] });
    expect(boxSummary([])).toBeNull();
  });
});
