import { describe, expect, it } from "vitest";
import { antigravityEmailFromLog, parseAntigravityUsageReport } from "./antigravity-usage.js";

const report = (buckets: unknown[]) => ({
  status: "SUCCESS",
  command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets }] } },
});

describe("Antigravity quota refresh", () => {
  it("converts remaining weekly and five-hour fractions to utilization and keeps the reset times", () => {
    const reset = "2026-11-25T04:59:36Z";
    const fiveHourReset = "2026-11-19T17:00:00Z";
    expect(parseAntigravityUsageReport(report([
      { window: "five_hour", remaining_fraction: 0.5, reset_time: fiveHourReset },
      { window: "weekly", remaining_fraction: 0.75, reset_time: reset },
    ]), 100, "person@example.com")).toEqual({
      observedAt: 100, source: "agy", email: "person@example.com",
      groups: [{
        name: "Gemini Models", weeklyUtilization: 0.25, resetAt: Date.parse(reset),
        fiveHourUtilization: 0.5, fiveHourResetAt: Date.parse(fiveHourReset),
      }],
    });
  });

  it("omits the five-hour window when agy reports only weekly buckets", () => {
    expect(parseAntigravityUsageReport(report([{ window: "weekly", remaining_fraction: 1 }]), 100).groups[0])
      .toEqual({ name: "Gemini Models", weeklyUtilization: 0, resetAt: undefined });
  });

  it("reads the signed-in email from the agy log", () => {
    expect(antigravityEmailFromLog("I1119 server_oauth.go:226] OAuth: authenticated successfully as person@example.com\n"))
      .toBe("person@example.com");
    expect(antigravityEmailFromLog("no sign-in line")).toBeUndefined();
  });

  it("rejects an empty or unmeasured report so the last reading can stay visible", () => {
    expect(() => parseAntigravityUsageReport(report([{ window: "weekly" }]), 100)).toThrow();
    expect(() => parseAntigravityUsageReport({ status: "LOGIN_REQUIRED" }, 100)).toThrow();
  });
});
