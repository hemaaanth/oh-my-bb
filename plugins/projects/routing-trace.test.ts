import { describe, expect, it } from "vitest";
import {
  appendTrace,
  createTrace,
  matchSuggestion,
  routingExamples,
  type RecordedSuggestion,
  type RoutingTrace,
} from "./routing-trace";

const suggestion = (prompt: string, at: number, projectId: string | null, kind: RecordedSuggestion["kind"] = "project"): RecordedSuggestion => ({
  prompt, at, kind, projectId, probability: 0.8, confidence: 0.7, autoApply: kind === "project",
});

describe("routing traces", () => {
  it("matches the suggestion made for the thread's first message", () => {
    const recent = [
      suggestion("Fix the router", 1_000, "p_a"),
      suggestion("Fix the router so it", 2_000, "p_b"),
      suggestion("Fix the router so it learns", 3_000, "p_c"),
    ];
    expect(matchSuggestion("Fix the router  so it learns", 4_000, recent)?.projectId).toBe("p_c");
    expect(matchSuggestion("Fix the router so it learns from history", 4_000, recent)?.projectId).toBe("p_c");
    expect(matchSuggestion("Something unrelated", 4_000, recent)).toBeNull();
    expect(matchSuggestion("Fix the router so it learns", 3_000 + 31 * 60_000, recent)).toBeNull();
  });

  it("scores hits, misses, and unguided threads", () => {
    const base = { threadId: "t1", createdAt: 1, message: "Do it" };
    expect(createTrace({ ...base, suggestion: suggestion("Do it", 1, "p_a"), finalProjectId: "p_a" }).outcome).toBe("hit");
    expect(createTrace({ ...base, suggestion: suggestion("Do it", 1, "p_a"), finalProjectId: null }).outcome).toBe("miss");
    expect(createTrace({ ...base, suggestion: suggestion("Do it", 1, null, "no_project"), finalProjectId: null }).outcome).toBe("hit");
    expect(createTrace({ ...base, suggestion: suggestion("Do it", 1, null, "none"), finalProjectId: "p_a" }).outcome).toBe("unguided");
  });

  it("keeps the newest bounded trace per thread and puts corrections first in examples", () => {
    const trace = (threadId: string, createdAt: number, finalProjectId: string | null, outcome: RoutingTrace["outcome"]): RoutingTrace => ({
      threadId, createdAt, message: `message ${threadId}`, finalProjectId, outcome,
      suggested: { kind: "project", projectId: "p_a", probability: 0.9, confidence: 0.9, autoApply: true },
    });
    let traces: RoutingTrace[] = [];
    traces = appendTrace(traces, trace("t1", 1, "p_a", "hit"));
    traces = appendTrace(traces, trace("t2", 2, "p_a", "hit"));
    traces = appendTrace(traces, trace("t3", 3, null, "miss"));
    traces = appendTrace(traces, trace("t1", 4, "p_a", "miss"));
    expect(traces.map(({ threadId }) => threadId)).toEqual(["t1", "t3", "t2"]);
    const examples = routingExamples(traces, { perTarget: 2 });
    expect(examples.get("p_a")).toEqual(["message t1", "message t2"]);
    expect(examples.get("no_project")).toEqual(["message t3"]);
  });
});
