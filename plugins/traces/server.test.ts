import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import type { TraceEvent, TraceResult } from "./spans";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/pi-tools.json", import.meta.url), "utf8")) as { events: TraceEvent[] };
const secret = "unstructured-private-value-12345";

describe("SDK trace RPC and CLI", () => {
  it("pages through 100 events, hides payloads, then refreshes on new events", async () => {
    const events = fixture.events.map((event) => ({ ...event }));
    events.push({ id: "private", threadId: "thr_zjv3792zht", seq: events.at(-1)!.seq + 1,
      scope: { kind: "thread" }, type: "system/error", createdAt: events.at(-1)!.createdAt + 1, data: { message: secret } });
    let reads = 0;
    const thread = makeThreadResponse({ id: "thr_zjv3792zht", providerId: "pi", title: "Pi fixture", environmentId: null });
    const { bb, harness } = createFakePluginHost({ pluginId: "traces", sdk: {
      threads: {
        get: async () => thread,
        events: { list: async ({ afterSeq }: { afterSeq?: string }) => {
          reads++;
          return events.filter((event) => event.seq > Number(afterSeq ?? 0)).slice(0, 100);
        } },
      },
    } });
    harness.sdk.stub("subscribe", () => () => {});
    plugin(bb);
    const result = await harness.behavior.callRpc("traces_thread", { threadId: thread.id, includeChildren: false, reveal: false });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(reads).toBe(2);
    const cached = await harness.behavior.callRpc("traces_thread", { threadId: thread.id, includeChildren: false, reveal: false }) as TraceResult;
    expect(cached.eventCount).toBe(events.length);
    expect(reads).toBe(2);
    const json = await harness.behavior.runCli(["thread", thread.id, "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stdout).not.toContain(secret);
    const text = await harness.behavior.runCli(["thread", thread.id]);
    expect(text.stdout).toContain("Slowest spans:");
    expect(text.stdout).toContain("Errors:");
    const revealed = await harness.behavior.runCli(["thread", thread.id, "--json", "--reveal"]);
    expect(revealed.stdout).toContain(secret);
    const revealedText = await harness.behavior.runCli(["thread", thread.id, "--reveal"]);
    expect(revealedText.stdout).toContain(secret);
    events.push({ id: "after", threadId: thread.id, seq: events.at(-1)!.seq + 1, scope: { kind: "thread" },
      type: "provider/warning", createdAt: events.at(-1)!.createdAt + 2, data: { message: "new warning" } });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: events.at(-1)!.seq });
    const refreshed = await harness.behavior.callRpc("traces_thread", { threadId: thread.id, includeChildren: false, reveal: false }) as TraceResult;
    expect(refreshed.eventCount).toBe(events.length);
    expect(reads).toBe(3); // The appended page starts after the cached last sequence.
    await harness.lifecycle.dispose();
  });
  it("coalesces append bursts and rereads rewritten or gapped histories", async () => {
    const thread = makeThreadResponse({ id: "thr_live", providerId: "pi", title: "Live", environmentId: null });
    let events: TraceEvent[] = [{ id: "start", threadId: thread.id, seq: 1, scope: { kind: "turn", turnId: "t1" },
      type: "turn/started", createdAt: 100, data: {} }];
    const reads: number[] = [];
    let notify: ((event: { id?: string; changes: readonly string[] }) => void) | null = null;
    const { bb, harness } = createFakePluginHost({ pluginId: "traces", sdk: { threads: {
      get: async () => thread,
      events: { list: async ({ afterSeq }: { afterSeq?: string }) => {
        reads.push(Number(afterSeq ?? 0));
        return events.filter((event) => event.seq > Number(afterSeq ?? 0));
      } },
    } } });
    harness.sdk.stub("subscribe", ({ callback }) => { notify = callback as typeof notify; return () => { notify = null; }; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      plugin(bb);
      await harness.behavior.callRpc("traces_thread", { threadId: thread.id, includeChildren: false, reveal: false });
      for (let seq = 2; seq <= 6; seq++) {
        events.push({ id: `event_${seq}`, threadId: thread.id, seq, scope: { kind: "thread" }, type: "provider/warning", createdAt: 100 + seq, data: {} });
        await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: seq });
      }
      expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "traces-changed")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(350);
      expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === "traces-changed")).toHaveLength(1);
      const appended = await harness.behavior.callRpc("traces_thread", { threadId: thread.id, includeChildren: false, reveal: false }) as TraceResult;
      expect(appended.eventCount).toBe(6);
      expect(reads).toEqual([0, 1]);
      events = [{ ...events[0]!, id: "replaced" }];
      notify!({ id: thread.id, changes: ["history-rewritten"] });
      const rewritten = await harness.behavior.callRpc("traces_thread", { threadId: thread.id, includeChildren: false, reveal: false }) as TraceResult;
      expect(rewritten.eventCount).toBe(1);
      expect(reads.at(-1)).toBe(0);
      events.push({ ...events[0]!, id: "gap", seq: 10, createdAt: 200 });
      await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 10 });
      const gap = await harness.behavior.callRpc("traces_thread", { threadId: thread.id, includeChildren: false, reveal: false }) as TraceResult;
      expect(gap.eventCount).toBe(2);
      expect(reads.at(-1)).toBe(0);
      await harness.lifecycle.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("does not cache a stale in-flight read after a history rewrite", async () => {
    const thread = makeThreadResponse({ id: "thr_race", providerId: "pi", title: "Race", environmentId: null });
    const oldEvent: TraceEvent = { id: "old", threadId: thread.id, seq: 1, scope: { kind: "turn", turnId: "t1" },
      type: "turn/started", createdAt: 100, data: {} };
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    let notify: ((event: { id?: string; changes: readonly string[] }) => void) | null = null;
    const { bb, harness } = createFakePluginHost({ pluginId: "traces", sdk: { threads: {
      get: async () => thread,
      events: { list: async () => {
        reads++;
        if (reads === 1) { await gate.promise; return [oldEvent]; }
        return [{ ...oldEvent, id: "replacement" }, { ...oldEvent, id: "new", seq: 2, createdAt: 200 }];
      } },
    } } });
    harness.sdk.stub("subscribe", ({ callback }) => { notify = callback as typeof notify; return () => { notify = null; }; });
    plugin(bb);
    const pending = harness.behavior.callRpc("traces_thread", { threadId: thread.id, includeChildren: false, reveal: false });
    await Promise.resolve(); await Promise.resolve();
    notify!({ id: thread.id, changes: ["history-rewritten"] });
    gate.resolve();
    const result = await pending as TraceResult;
    expect(result.eventCount).toBe(2);
    expect(reads).toBe(2);
    await harness.lifecycle.dispose();
  });
  it("links parent children and delegation childRef, then refreshes parent when a child changes", async () => {
    const rootId = "thr_root"; const childId = "thr_child"; const refId = "thr_ref";
    const root = makeThreadResponse({ id: rootId, title: "Root", providerId: "pi", environmentId: null });
    const child = makeThreadResponse({ id: childId, title: "Child", providerId: "codex", environmentId: null, parentThreadId: rootId });
    const ref = makeThreadResponse({ id: refId, title: "Ref", providerId: "acp-omp", environmentId: null });
    const rootEvents: TraceEvent[] = [
      { id: "r1", threadId: rootId, seq: 1, scope: { kind: "turn", turnId: "t1" }, type: "turn/started", createdAt: 100, data: {} },
      { id: "r2", threadId: rootId, seq: 2, scope: { kind: "turn", turnId: "t1" }, type: "item/started", createdAt: 110,
        data: { item: { type: "delegation", id: "d1", childRef: refId, label: "worker", status: "pending" } } },
      { id: "r3", threadId: rootId, seq: 3, scope: { kind: "turn", turnId: "t1" }, type: "item/completed", createdAt: 200,
        data: { item: { type: "delegation", id: "d1", childRef: refId, label: "worker", status: "completed" } } },
      { id: "r4", threadId: rootId, seq: 4, scope: { kind: "turn", turnId: "t1" }, type: "turn/completed", createdAt: 210, data: { status: "completed" } },
    ];
    const childEvents: TraceEvent[] = [{ id: "c1", threadId: childId, seq: 1, scope: { kind: "turn", turnId: "t2" }, type: "turn/started", createdAt: 130, data: {} }];
    const refEvents: TraceEvent[] = [{ id: "f1", threadId: refId, seq: 1, scope: { kind: "turn", turnId: "t3" }, type: "turn/started", createdAt: 140, data: {} }];
    const threads = new Map([[rootId, root], [childId, child], [refId, ref]]);
    const eventSets = new Map([[rootId, rootEvents], [childId, childEvents], [refId, refEvents]]);
    const { bb, harness } = createFakePluginHost({ pluginId: "traces", sdk: { threads: {
      get: async ({ threadId }: { threadId: string }) => threads.get(threadId)!,
      list: async ({ parentThreadId }: { parentThreadId?: string } = {}) => parentThreadId === rootId ? [child] : [],
      events: { list: async ({ threadId, afterSeq }: { threadId: string; afterSeq?: string }) =>
        (eventSets.get(threadId) ?? []).filter((event) => event.seq > Number(afterSeq ?? 0)) },
    } } });
    harness.sdk.stub("subscribe", () => () => {});
    plugin(bb);
    const first = await harness.behavior.callRpc("traces_thread", { threadId: rootId, includeChildren: true, reveal: false }) as TraceResult;
    const delegation = first.tree.children.flatMap((span) => span.children).find((span) => span.kind === "delegation");
    expect(delegation?.children.some((span) => span.threadId === refId && span.kind === "thread")).toBe(true);
    expect(first.tree.children.some((span) => span.threadId === childId && span.kind === "thread")).toBe(true);
    childEvents.push({ id: "c2", threadId: childId, seq: 2, scope: { kind: "turn", turnId: "t2" }, type: "turn/completed", createdAt: 180, data: { status: "completed" } });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: child, sequence: 2 });
    const fresh = await harness.behavior.callRpc("traces_thread", { threadId: rootId, includeChildren: true, reveal: false }) as TraceResult;
    expect(fresh.tree.children.find((span) => span.threadId === childId)?.children.find((span) => span.kind === "turn")?.status).toBe("completed");
    await harness.lifecycle.dispose();
  });
});
