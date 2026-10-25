import { describe, expect, it } from "vitest";
import { catchUpReason } from "./catch-up-rules";

type Thread = Parameters<typeof catchUpReason>[0];
const now = Date.now();
function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    status: "idle", queuedWork: "none", hasPendingInteraction: false, isUnread: false,
    isPinned: false, updatedAt: now - 31 * 24 * 60 * 60_000,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    ...overrides,
  } as Thread;
}
const completed = { threadId: "a", summary: "Done", outcome: null, workStatus: "completed", lastActivityAt: null };
describe("catch-up suggestions", () => {
  it("prioritizes input and unread updates over archive suggestions", () => {
    expect(catchUpReason(thread({ hasPendingInteraction: true }), completed, now)).toEqual({ attention: "Needs your input" });
    expect(catchUpReason(thread({ isUnread: true }), completed, now)).toEqual({ attention: "Unread update" });
  });
  it("never suggests archiving a busy, pinned or queued thread", () => {
    expect(catchUpReason(thread({ status: "active" }), completed, now)).toEqual({});
    expect(catchUpReason(thread({ isPinned: true }), completed, now)).toEqual({});
    expect(catchUpReason(thread({ queuedWork: "waiting" }), completed, now)).toEqual({});
  });
  it("does not infer task completion from an idle agent, an old label, or elapsed time", () => {
    expect(catchUpReason(thread({ updatedAt: now }), completed, now)).toEqual({});
    expect(catchUpReason(thread(), completed, now)).toEqual({});
    expect(catchUpReason(thread(), undefined, now)).toEqual({});
  });
});

import { catchUpSummary } from "./catch-up-summary";
it("keeps attention, active projects and archive candidates separate", () => {
  const works = [
    { thread: thread({ id: "input", displayTitle: "Input", updatedAt: now, hasPendingInteraction: true }), project: "Alpha" },
    { thread: thread({ id: "active", displayTitle: "Active", updatedAt: now, status: "active" }), project: "Alpha" },
    { thread: thread({ id: "quiet", displayTitle: "Quiet" }), project: "Beta" },
  ];
  const summary = catchUpSummary(works, now);
  expect(summary.attention.map(({ work }) => work.thread.id)).toEqual(["input"]);
  expect(summary.active.map(({ project, items }) => [project, items.map(({ work }) => work.thread.id)])).toEqual([["Alpha", ["active"]], ["Beta", ["quiet"]]]);
  expect(summary.archive).toEqual([]);
});
