import { describe, expect, it } from "vitest";
import { hostRow, makeContext, projectRow, threadRow } from "../core-test-host.js";
import { LIVE_THREADS_MAX, RECENT_WINDOW_MS, listLiveThreads, liveStatusOf, relativeTime, type ThreadListRow } from "./live.js";

const NOW = 1_800_000_000_000;
const row = (displayStatus: string, overrides: Record<string, unknown> = {}) =>
  threadRow({ runtime: { displayStatus }, updatedAt: NOW - 1000, ...overrides }) as unknown as ThreadListRow;

describe("live status", () => {
  it("maps each display status", () => {
    expect(liveStatusOf(row("active"), true, NOW)).toBe("active");
    expect(liveStatusOf(row("pending"), true, NOW)).toBe("starting");
    expect(liveStatusOf(row("stopping"), true, NOW)).toBe("stopping");
    expect(liveStatusOf(row("provisioning"), true, NOW)).toBe("provisioning");
    expect(liveStatusOf(row("waiting-for-host"), true, NOW)).toBe("waiting-for-host");
    expect(liveStatusOf(row("active"), false, NOW)).toBe("host-reconnecting");
    expect(liveStatusOf(row("pending"), false, NOW)).toBe("host-reconnecting");
  });

  it("counts idle or failed threads as recently finished for 30 minutes", () => {
    expect(liveStatusOf(row("idle"), true, NOW)).toBe("recently-finished");
    expect(liveStatusOf(row("error"), true, NOW)).toBe("recently-finished");
    expect(liveStatusOf(row("idle", { updatedAt: NOW - RECENT_WINDOW_MS }), true, NOW)).toBe("recently-finished");
    expect(liveStatusOf(row("idle", { updatedAt: NOW - RECENT_WINDOW_MS - 1 }), true, NOW)).toBeNull();
  });

  it("speaks relative time", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 hours ago");
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2 days ago");
  });
});

describe("listLiveThreads", () => {
  it("names projects and machines, skips hidden threads, and puts finished ones last", async () => {
    const rows = [
      row("idle", { id: "thr_done", updatedAt: NOW - 500 }),
      row("active", { id: "thr_old", updatedAt: NOW - 5000 }),
      row("active", { id: "thr_new", updatedAt: NOW - 100, environmentHostId: "host_b" }),
      row("active", { id: "thr_hidden", visibility: "hidden" }),
      row("idle", { id: "thr_stale", updatedAt: NOW - RECENT_WINDOW_MS - 10 }),
    ];
    const { ctx } = await makeContext(undefined, {
      threads: { list: async () => rows },
      projects: { list: async () => [projectRow()] },
      hosts: { list: async () => [hostRow(), hostRow({ id: "host_b", name: "laptop", status: "disconnected" })] },
    } as never);
    const live = await listLiveThreads(ctx, NOW);
    expect(live.map((thread) => [thread.id, thread.status])).toEqual([
      ["thr_new", "host-reconnecting"],
      ["thr_old", "active"],
      ["thr_done", "recently-finished"],
    ]);
    expect(live[1]).toMatchObject({ projectName: "Website", machineName: "studio", title: "Fix the header" });
  });

  it("returns at most 200 threads", async () => {
    const rows = Array.from({ length: LIVE_THREADS_MAX + 20 }, (_, index) => row("active", { id: `thr_${index}` }));
    const { ctx } = await makeContext(undefined, { threads: { list: async () => rows } } as never);
    expect(await listLiveThreads(ctx, NOW)).toHaveLength(LIVE_THREADS_MAX);
  });
});
