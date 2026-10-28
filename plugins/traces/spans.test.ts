import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTrace, type TraceEvent, type TraceResult, type TraceThread, type TraceSpan } from "./spans";
import { presentTrace } from "./redact";

function fixture(name: string): { thread: TraceThread; events: TraceEvent[] } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}
function all(span: TraceSpan): TraceSpan[] { return [span, ...span.children.flatMap(all)]; }

const providers = [
  ["claude-code", "claude-code-plan"], ["codex", "codex-delegation"], ["acp-omp", "acp-omp-worktree"], ["pi", "pi-tools"],
] as const;

describe("real, redacted provider event fixtures", () => {
  it.each(providers)("builds %s turns and items without impossible durations", (provider, name) => {
    const { thread, events } = fixture(name);
    const result = buildTrace(thread, events);
    const spans = all(result.tree);
    expect(result.tree.metadata.provider).toBe(provider);
    expect(spans.some((s) => s.kind === "turn")).toBe(true);
    expect(spans.some((s) => s.kind === "commandExecution" || s.kind === "toolCall" || s.kind === "fileRead")).toBe(true);
    for (const span of spans) {
      if (span.end === null || span.kind === "thread") continue;
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(span.durationMs).toBeLessThanOrEqual(events.at(-1)!.createdAt - events[0]!.createdAt + 1_000);
    }
    expect(Object.values(result.summary.timeMs).reduce((sum, ms) => sum + ms, 0)).toBe(result.summary.elapsedMs);
    expect(result.summary.activeMs).toBeLessThanOrEqual(result.summary.elapsedMs);
  });

  it("consumes the nearest unmatched start when an item ID is reused in one turn", () => {
    const { thread, events } = fixture("claude-code-reuse");
    const result = buildTrace(thread, events);
    const paired = all(result.tree).filter((s) => s.itemId === "da6f343971-i382");
    expect(paired).toHaveLength(2);
    expect(paired.every((s) => s.durationMs === 0)).toBe(true);
  });

  it("nests Codex in-provider child turns under their delegation item", () => {
    const { thread, events } = fixture("codex-delegation");
    const result = buildTrace(thread, events);
    const delegation = all(result.tree).find((s) => s.kind === "delegation");
    expect(delegation?.children.some((s) => s.kind === "turn")).toBe(true);
    expect(all(delegation!).some((s) => s.kind === "commandExecution")).toBe(true);
  });

  it("makes queue, first-output, interaction, retry, and fallback delays visible", () => {
    const datasets = ["claude-code-plan", "claude-code-errors", "codex-retries", "claude-code-fallback"];
    const labels = datasets.flatMap((name) => { const { thread, events } = fixture(name); return all(buildTrace(thread, events).tree).filter((s) => s.kind === "wait").map((s) => s.name); });
    expect(labels).toContain("Queue");
    expect(labels).toContain("First output");
    expect(labels).toContain("Approval / input");
    expect(labels).toContain("Provider retry");
    expect(labels).toContain("Model fallback");
  });

  it("marks unstored usage as null instead of zero, and keeps stored snapshots", () => {
    const pi = fixture("pi-tools");
    const stored = all(buildTrace(pi.thread, pi.events).tree).filter((s) => s.kind === "turn");
    expect(stored.some((s) => s.usage !== null)).toBe(true);
    const claude = fixture("claude-code-plan");
    const unstored = all(buildTrace(claude.thread, claude.events).tree).filter((s) => s.kind === "turn");
    expect(unstored.some((s) => s.usage === null)).toBe(true);
  });

  it("turns unknown event types into generic events", () => {
    const { thread, events } = fixture("pi-tools");
    const at = events.at(-1)!.createdAt;
    const result = buildTrace(thread, [...events, { id: "unknown", threadId: thread.id, seq: events.at(-1)!.seq + 1, createdAt: at,
      type: "provider/new-unknown-event", scope: { kind: "thread" }, data: { token: "opaque-secret" } }]);
    expect(all(result.tree).some((s) => s.name === "provider/new-unknown-event" && s.kind === "event")).toBe(true);
  });

  it("hides arbitrary secrets in every output surface by default; explicit reveal restores them", () => {
    const { thread, events } = fixture("pi-tools");
    const secret = "no-recognizable-prefix-secret-19";
    const at = events.at(-1)!.createdAt + 1;
    const injected: TraceEvent = { id: "private-item", threadId: thread.id, seq: events.at(-1)!.seq + 1, createdAt: at,
      type: "item/completed", scope: { kind: "turn", turnId: "private-turn" }, data: { item: { type: "toolCall", id: "private", tool: "fetch", status: "failed", result: { token: secret }, error: secret } } };
    const file: TraceEvent = { id: "private-file", threadId: thread.id, seq: events.at(-1)!.seq + 2, createdAt: at + 1,
      type: "item/completed", scope: { kind: "turn", turnId: "private-turn" }, data: { item: { type: "fileRead", id: "file", path: secret, status: "completed" } } };
    const raw = buildTrace({ ...thread, title: secret, environmentLabel: secret }, [...events, injected, file]);
    const hidden = presentTrace(raw, false);
    expect(JSON.stringify(hidden)).not.toContain(secret);
    expect(JSON.stringify(presentTrace(raw, true))).toContain(secret);
  });

  it("counts parallel child work once without inflating parent turn time", () => {
    const { thread, events } = fixture("claude-code-plan");
    const child = fixture("acp-omp-worktree");
    const childResult = buildTrace(child.thread, child.events);
    const result: TraceResult = buildTrace(thread, events, [childResult]);
    expect(result.tree.children.some((s) => s.threadId === child.thread.id)).toBe(true);
    expect(result.summary.activeMs).toBeLessThanOrEqual(result.summary.elapsedMs);
  });
  it("tracks a user question wait without treating it as model work", () => {
    const thread: TraceThread = { id: "thr_question", title: "question", providerId: "pi", environmentId: null,
      parentThreadId: null, createdAt: 100, updatedAt: 220, status: "idle" };
    const events: TraceEvent[] = [
      { id: "start", threadId: thread.id, seq: 1, type: "turn/started", createdAt: 100, scope: { kind: "turn", turnId: "t1" }, data: {} },
      { id: "pending", threadId: thread.id, seq: 2, type: "system/userQuestion/lifecycle", createdAt: 120, scope: { kind: "turn", turnId: "t1" }, data: { interactionId: "q1", status: "pending" } },
      { id: "resolved", threadId: thread.id, seq: 3, type: "system/userQuestion/lifecycle", createdAt: 200, scope: { kind: "turn", turnId: "t1" }, data: { interactionId: "q1", status: "resolved" } },
      { id: "done", threadId: thread.id, seq: 4, type: "turn/completed", createdAt: 220, scope: { kind: "turn", turnId: "t1" }, data: { status: "completed" } },
    ];
    const result = buildTrace(thread, events);
    expect(all(result.tree).find((s) => s.name === "User question")?.durationMs).toBe(80);
    expect(result.summary.timeMs.wait).toBe(80);
  });
});
