import { describe, expect, it } from "vitest";
import { matchesFleetFilter, parseFleetQuery, parseFleetSince, type FleetMatch } from "./fleet-query";

const row: FleetMatch = { projectId: "proj_1", projectName: "Oh My BB", threadId: "thr_1", provider: "codex",
  model: "gpt-6.1", environmentId: "env_1", worktree: true, child: false,
  kind: "toolCall", type: "item/completed", status: "failed", tool: "executor_execute", category: "rate-limit", durationMs: 6_000 };

describe("fleet query grammar", () => {
  it("parses quoted project names, booleans, durations and AND-only filters", () => {
    const filter = parseFleetQuery('project:"Oh My BB" provider:codex kind:toolCall status:failed tool:executor_execute worktree:true child:false duration:>5s');
    expect(matchesFleetFilter(row, filter)).toBe(true);
    expect(matchesFleetFilter({ ...row, durationMs: 5_000 }, filter)).toBe(false);
    expect(matchesFleetFilter({ ...row, durationMs: null }, filter)).toBe(false);
    expect(matchesFleetFilter({ ...row, child: true }, filter)).toBe(false);
  });

  it("does not treat SQL-looking values as commands or free text", () => {
    const literal = parseFleetQuery('project:"x\' OR 1=1"');
    expect(matchesFleetFilter(row, literal)).toBe(false);
    expect(() => parseFleetQuery("provider:codex OR status:failed")).toThrow(/Invalid query term/);
    expect(() => parseFleetQuery("status:failed status:completed")).toThrow(/Duplicate/);
    expect(() => parseFleetQuery("thread:thr_1;DROP TABLE events")).toThrow(/Thread/);
  });

  it("caps the lookback window and rejects unsupported syntax", () => {
    expect(parseFleetSince("7d", 1_000_000_000).hours).toBe(168);
    expect(parseFleetSince("6h", 1_000_000_000).from).toBe(1_000_000_000 - 6 * 3_600_000);
    expect(() => parseFleetSince("8d")).toThrow(/7 days/);
    expect(() => parseFleetQuery("@foo:bar")).toThrow(/Unsupported/);
    expect(() => parseFleetQuery("duration:banana")).toThrow(/Duration/);
  });
});
