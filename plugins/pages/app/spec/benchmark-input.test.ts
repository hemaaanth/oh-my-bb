import { describe, expect, it } from "vitest";
import { manualBenchmarks } from "./benchmark-input.js";
import { readBenchmark } from "./reports/benchmark.js";

describe("native benchmark inputs", () => {
  it("retains mixed baselines, per-row units, and higher-is-better rates", () => {
    const rows = manualBenchmarks([{ name: "Requests", mean: 200, unit: "ops/s" }, { name: "Bundle", before: 80, after: 60, unit: "KB" }]);
    expect(rows?.map(row => [row.name, row.before, row.after, row.unit, row.better])).toEqual([["Requests", null, 200, "ops/s", "higher"], ["Bundle", 80, 60, "KB", "lower"]]);
  });
  it("keeps changed conditions distinct from performance results and does not invent a range", () => {
    const rows = manualBenchmarks([{ name: "Build", before: { value: 10, context: { device: "Laptop" } }, after: { value: 5, context: { device: "Desktop" } }, unit: "s" }, { name: "Mean only", mean: 2 }]);
    expect(rows?.[0]?.comparable).toBe(false);
    expect(rows?.[0]?.before).toBe(10);
    expect(rows?.[1]?.min).toBeNull();
    expect(rows?.[1]?.max).toBeNull();
  });
  it("does not use a failed command as the fastest successful baseline", () => {
    const parsed = readBenchmark({ results: [{ command: "crashes", mean: 0.01, exit_codes: [1] }, { command: "works", mean: 1, exit_codes: [0] }, { command: "slower", mean: 2, exit_codes: [0] }] }, null);
    if (!parsed.ok || parsed.report.kind !== "runs") throw new Error("Expected command runs");
    expect(parsed.report.groups[0]!.runs.find(run => run.name === "works")?.ratio).toBe(1);
    expect(parsed.report.groups[0]!.runs.find(run => run.name === "slower")?.ratio).toBe(2);
  });
});
