import { describe, expect, it } from "vitest";
import { buildTrace, type TraceEvent, type TraceSpan, type TraceThread } from "./spans";
import { clampWindow, fitWindow, groupTurnCalls, panWindow, projectSpan, turnMetrics, zoomWindow } from "./investigate";

const metadata = { model: "test-model", provider: "pi", reasoningLevel: null, permissionMode: null, environment: null, initiator: null };
function span(id: string, kind: string, name: string, durationMs: number | null, children: TraceSpan[] = []): TraceSpan {
  return { id, kind, name, threadId: "thr_abc", turnId: "t1", itemId: id, start: 1_000, end: durationMs === null ? null : 1_000 + durationMs,
    durationMs, status: "completed", error: null, input: null, output: null, inputSize: null, outputSize: null,
    metadata, usage: null, contextUsage: null, children };
}

describe("turn investigation", () => {
  it("groups calls by safe executable without losing nested spans, failures or unknown durations", () => {
    const nested = span("child", "fileRead", "File read", 20);
    const git = span("git", "commandExecution", "Command · git", 100, [nested]);
    const failed = { ...span("git2", "commandExecution", "Command · git", 200), status: "failed" };
    const unknown = span("git3", "commandExecution", "Command · git", null);
    const npm = span("npm", "commandExecution", "Command · npm", 40);
    const turn = span("turn", "turn", "t1", 500, [git, failed, unknown, npm]);
    const groups = groupTurnCalls(turn);
    expect(groups.map((group) => group.label)).toEqual(["Command · git", "Command · npm", "fileRead · File read"]);
    expect(groups[0]).toMatchObject({ count: 3, measured: 2, unknown: 1, totalMs: 300, failures: 1, slowest: { id: "git2" } });
    expect(groups[0]!.runs.map((run) => run.id)).toEqual(["git", "git2", "git3"]);
    expect(groups[0]!.runs[0]!.children[0]!.id).toBe("child");
    expect(turn.children[0]!.children[0]!.id).toBe("child");
  });

  it("labels only allowlisted command executables even when raw arguments contain secrets", () => {
    const thread: TraceThread = { id: "thr_abc", title: "Test", providerId: "pi", environmentId: null,
      parentThreadId: null, createdAt: 1_000, updatedAt: 2_000, status: "idle" };
    const events: TraceEvent[] = [
      { id: "turn", threadId: thread.id, seq: 1, type: "turn/started", createdAt: 1_000, scope: { kind: "turn", turnId: "t1" }, data: {} },
      ...[["git", "git status --token private-secret"], ["unknown", "private-secret --send"], ["npm", "npm test"]].map(([id, command], index) => ({
        id: id!, threadId: thread.id, seq: index + 2, type: "item/completed", createdAt: 1_100 + index * 100,
        scope: { kind: "turn" as const, turnId: "t1" }, data: { item: { id, type: "commandExecution", command, durationMs: 100 } },
      })),
      { id: "end", threadId: thread.id, seq: 5, type: "turn/completed", createdAt: 2_000, scope: { kind: "turn", turnId: "t1" }, data: {} },
    ];
    const result = buildTrace(thread, events);
    const groups = groupTurnCalls(result.tree.children[0]!);
    expect(groups.map((group) => group.label).sort()).toEqual(["Command · git", "Command · npm", "Command · other"]);
    expect(groups.map((group) => group.label).join(" ")).not.toContain("private-secret");
  });

  it("compares completed allocations and reports running or absent usage as unknown", () => {
    const completed = { ...span("a", "turn", "t1", 500, [span("tool", "toolCall", "fetch", 200),
      { ...span("provider", "error", "provider/error", 0), status: "failed" }]),
      usage: { last: { inputTokens: 40, outputTokens: 5 } } };
    const running = { ...span("b", "turn", "t2", null, [span("pending", "toolCall", "fetch", null)]), usage: null };
    expect(turnMetrics(completed)).toMatchObject({ durationMs: 500, calls: 1, failures: 0, errors: 1, lastInputTokens: 40, lastOutputTokens: 5 });
    expect(turnMetrics(completed).timeMs).not.toBeNull();
    expect(turnMetrics(running)).toMatchObject({ durationMs: null, timeMs: null, calls: 1, lastInputTokens: null, lastOutputTokens: null });
  });

  it("clamps zoom, pan and fit for empty, short and lengthy running windows", () => {
    expect(clampWindow({ from: 10, to: 10 }, 0)).toEqual({ from: 0, to: 20 });
    expect(zoomWindow({ from: 0, to: 1_000 }, 1_000, 0.5)).toEqual({ from: 250, to: 750 });
    expect(panWindow({ from: 250, to: 750 }, 1_000, 700)).toEqual({ from: 500, to: 1_000 });
    expect(panWindow({ from: 250, to: 750 }, 1_000, -700)).toEqual({ from: 0, to: 500 });
    expect(fitWindow(8_000, 8_200, 10_000)).toEqual({ from: 7_976, to: 8_224 });
    expect(zoomWindow({ from: 0, to: 20 }, 10_000, 0.01)).toEqual({ from: 0, to: 20 });
    expect(projectSpan(0, 100, { from: 250, to: 750 })).toBeNull();
    expect(projectSpan(200, 350, { from: 250, to: 750 })).toEqual({ left: 0, width: 20 });
    expect(projectSpan(500, 900, { from: 250, to: 750 })).toEqual({ left: 50, width: 50 });
    expect(projectSpan(750, 800, { from: 250, to: 750 })).toBeNull();
  });
});
