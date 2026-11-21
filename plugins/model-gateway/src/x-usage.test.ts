import { describe, expect, it } from "vitest";
import { grokEmailFromAuth, parseXUsage } from "./x-usage.js";

describe("shared X usage refresh", () => {
  it("converts the official Grok billing response to one shared weekly window", () => {
    const reset = "2026-11-18T08:17:17.326+00:00";
    expect(parseXUsage({
      config: {
        creditUsagePercent: 26,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-11T08:17:17.326+00:00", end: reset },
        prepaidBalance: { val: 12.5 },
      },
      subscription_tier: "SuperGrok",
    }, 100)).toEqual({
      plan: "SuperGrok",
      weeklyUtilization: 0.26,
      resetAt: Date.parse(reset),
      observedAt: 100,
      extraBalanceUsd: 12.5,
      source: "grok",
    });
  });

  it("reads the newest signed-in email from the Grok login file", () => {
    expect(grokEmailFromAuth({
      "https://auth.x.ai::a": { email: "old@example.com", create_time: "2026-01-01T00:00:00Z", key: "secret" },
      "https://auth.x.ai::b": { email: "new@example.com", create_time: "2026-06-01T00:00:00Z" },
    })).toBe("new@example.com");
    expect(grokEmailFromAuth({ "https://auth.x.ai::a": { first_name: "Person" } })).toBeUndefined();
    expect(grokEmailFromAuth(null)).toBeUndefined();
  });

  it("rejects invalid utilization and reset values", () => {
    const response = { config: { creditUsagePercent: 101, currentPeriod: { end: "never" } }, subscription_tier: "Premium" };
    expect(() => parseXUsage(response, 100)).toThrow();
  });
});
