import { describe, expect, it } from "vitest";
import { parseAntigravityUsageReport } from "./antigravity-usage.js";

const report = (buckets: unknown[]) => ({
  status: "SUCCESS",
  command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets }] } },
});

describe("Antigravity quota refresh", () => {
  it("converts remaining weekly fractions to utilization and keeps the reset time", () => {
    const reset = "2026-11-25T04:59:36Z";
    expect(parseAntigravityUsageReport(report([
      { window: "five_hour", remaining_fraction: 0.5 },
      { window: "weekly", remaining_fraction: 0.75, reset_time: reset },
    ]), 100)).toEqual({
      plan: "Weekly quota", observedAt: 100, source: "agy",
      groups: [{ name: "Gemini Models", weeklyUtilization: 0.25, resetAt: Date.parse(reset) }],
    });
  });

  it("rejects an empty or unmeasured report so the last reading can stay visible", () => {
    expect(() => parseAntigravityUsageReport(report([{ window: "weekly" }]), 100)).toThrow();
    expect(() => parseAntigravityUsageReport({ status: "LOGIN_REQUIRED" }, 100)).toThrow();
  });
});
