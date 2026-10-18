// pieSlices and numericValue are ported from GenUI ui/components/chartMath.test.ts (Apache-2.0).
import { describe, expect, it } from "vitest";
import { chartHeight, chartOptions, numericValue, pieSlices } from "./charts.js";

describe("pieSlices", () => {
  it("drops zero, negative, and missing values and names unlabeled slices", () => {
    expect(pieSlices(["a", "b", "c", "d"], [3, 0, -1, null, 2])).toEqual([{ label: "a", value: 3 }, { label: "Item 5", value: 2 }]);
  });

  it("folds the smallest past eight slices into a trailing Other, keeping data order", () => {
    const values = [5, 1, 9, 2, 8, 3, 7, 4, 6, 0.5];
    const slices = pieSlices(values.map((_, i) => `s${i}`), values);
    expect(slices.map((slice) => slice.label)).toEqual(["s0", "s2", "s4", "s5", "s6", "s7", "s8", "Other"]);
    expect(slices[7]).toEqual({ label: "Other", value: 3.5 });
    expect(pieSlices([], [1, 2, 3, 4, 5, 6, 7, 8]).some((slice) => slice.label === "Other")).toBe(false);
  });
});

describe("numericValue", () => {
  it("reads numbers and strings that are exactly a number", () => {
    expect(numericValue(4)).toBe(4);
    expect(numericValue(" 2.5 ")).toBe(2.5);
    expect(numericValue("-3e2")).toBe(-300);
  });

  it("rejects everything else, including empty strings Number() would make 0", () => {
    for (const value of ["", "  ", "12px", Infinity, null, true]) expect(numericValue(value)).toBeNull();
  });
});

describe("chartOptions", () => {
  const two = [{ name: "A", values: [1, 2] }, { name: "B", values: [3, null] }];
  const types = (options: Record<string, unknown>) => (options.series as { type: string }[]).map((series) => series.type);

  it("maps each Chart type to a Highcharts series type", () => {
    expect(types(chartOptions("bar", ["x", "y"], two))).toEqual(["column", "column"]);
    expect(types(chartOptions("horizontalBar", ["x", "y"], two))).toEqual(["bar", "bar"]);
    expect(types(chartOptions("area", ["x", "y"], two))).toEqual(["area", "area"]);
    expect(chartOptions("stackedBar", ["x", "y"], two).plotOptions).toEqual({ series: { stacking: "normal" } });
    expect(chartOptions("radar", ["x", "y", "z"], two).chart).toMatchObject({ polar: true });
    expect(chartOptions("radial", ["x", "y"], two).chart).toMatchObject({ polar: true, inverted: true });
  });

  it("shows a legend only when it names something", () => {
    expect(chartOptions("bar", ["x"], two.slice(0, 1)).legend).toEqual({ enabled: false });
    expect(chartOptions("bar", ["x"], two).legend).toEqual({ enabled: true });
    expect(chartOptions("donut", ["x"], two).legend).toEqual({ enabled: true });
  });

  it("folds pie slices and drops funnel stages with no value", () => {
    const pie = chartOptions("donut", ["a", "b"], [{ name: "S", values: [0, 4] }]).series as { data: unknown[] }[];
    expect(pie[0]!.data).toEqual([{ name: "b", y: 4 }]);
    const funnel = chartOptions("funnel", ["a", "b", "c"], [{ name: "S", values: [9, null, 2] }]).series as { data: unknown[] }[];
    expect(funnel[0]!.data).toEqual([["a", 9], ["c", 2]]);
  });

  it("reads scatter labels as x and skips points with no x or y", () => {
    const series = chartOptions("scatter", ["1", "two", "3"], [{ name: "S", values: [5, 6, null] }]).series as { data: unknown[] }[];
    expect(series[0]!.data).toEqual([[1, 5]]);
  });

  it("titles the axes only when asked", () => {
    expect(chartOptions("line", ["x"], two, "Week", "Users")).toMatchObject({ xAxis: { title: { text: "Week" } }, yAxis: { title: { text: "Users" } } });
    expect(chartOptions("line", ["x"], two)).toMatchObject({ yAxis: { title: { text: null } } });
  });

  it("grows horizontal bars with their labels", () => {
    expect(chartHeight("horizontalBar", 10)).toBeGreaterThan(chartHeight("horizontalBar", 2));
    expect(chartHeight("bar", 10)).toBe(240);
  });
});
