import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    expect(reads).toBe(4);
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
