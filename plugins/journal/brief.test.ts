import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { ENRICH_STARTUP_DELAY_MS, ENRICH_POLL_MS, threadBriefSchema } from "./server";
import { briefTranscript } from "./brief";

const start = new Date(2026, 8, 22, 10).getTime();
type Row = { kind: "conversation"; role: "user" | "assistant"; initiator?: "user"; text: string; sourceSeqEnd: number; createdAt: number };
type CallRpcArgs = { pluginId: string; method: string; input: unknown; signal?: AbortSignal; outputSchema: { parse(value: unknown): unknown } };

const BRIEF = { goal: "Build the thing", done: ["Built it"], remaining: ["Ship it"], current: "Waiting for review", decisions: ["Use SQLite"], openDecisions: ["Proposal: add caching"] };
const ENTRY = { summary: "Built the thing", category: "feature", outcome: "Shipped", status: "completed", tags: [] };
const CATCH_UP = { paragraphs: [{ text: "Product outreach continues.", links: [{ threadId: "thr_a", phrase: "Product outreach" }] }] };
const STANDUP = { daily: "Daily work happened.", weekly: "Weekly work happened." };

describe("brief transcript excerpt", () => {
  it("keeps a bounded opening request and the newest stopping point, marking the gap", () => {
    const messages = [
      { role: "user" as const, text: `Original goal ${"x".repeat(20_000)}` },
      ...Array.from({ length: 40 }, (_, index) => ({ role: "assistant" as const, text: `Step ${index} ${"y".repeat(800)}` })),
      { role: "assistant" as const, text: "Latest: tests pass, waiting on review" },
    ];
    const result = briefTranscript(messages, true, 14_000);
    expect(result.text.length).toBeLessThanOrEqual(14_000);
    expect(result.text.startsWith("USER: Original goal")).toBe(true);
    expect(result.text.endsWith("Latest: tests pass, waiting on review")).toBe(true);
    expect(result.clipped).toBe(true);
  });

  it("reports no clipping when the whole page fits and omits the opening when the start was not read", () => {
    const messages = [{ role: "user" as const, text: "Goal" }, { role: "assistant" as const, text: "Done" }];
    expect(briefTranscript(messages, true)).toEqual({ text: "USER: Goal\nASSISTANT: Done", clipped: false });
    expect(briefTranscript(messages, false).text).toBe("USER: Goal\nASSISTANT: Done");
  });
});

describe("subscription backend and thread briefings", () => {
  let gatewayCalls: CallRpcArgs[]; let gatewayReply: (args: CallRpcArgs) => unknown; let timelineReads: string[];
  beforeEach(() => {
    vi.useFakeTimers({ now: start, toFake: ["setTimeout", "clearTimeout", "Date"] });
    gatewayCalls = []; timelineReads = [];
    gatewayReply = (args) => {
      if (args.method === "inference.status") return { available: true, models: ["gpt-6-luna", "gpt-5.6-luna"], usableAccounts: 1, inFlight: 0, maxConcurrent: 2, retryAt: null, reason: null };
      const name = (args.input as { schema: { name: string } }).schema.name;
      const text = JSON.stringify(name === "thread_brief" ? BRIEF : name === "catch_up" ? CATCH_UP : name === "journal_standup" ? STANDUP : name === "journal_test" ? { ok: true } : ENTRY);
      return { ok: true, text, model: "gpt-6-luna", billing: "subscription", usage: { inputTokens: 100, outputTokens: 20 } };
    };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("paid OpenRouter request attempted"); }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const thread = (id: string, overrides: Partial<ReturnType<typeof makeThreadResponse>> = {}) =>
    makeThreadResponse({ id, projectId: "proj", title: "Build the thing", parentThreadId: null, visibility: "visible", archivedAt: null, createdAt: start, status: "idle", ...overrides });

  async function load(threads: Array<ReturnType<typeof thread>>, settings: Record<string, string | number | boolean> = { aiBackend: "subscription" },
    timelines: Record<string, { rows: Row[]; hasOlder?: boolean }> = {}) {
    const byId = new Map(threads.map((item) => [item.id, item]));
    const { bb, harness } = createFakePluginHost({
      pluginId: "journal", settings,
      sdk: {
        projects: { list: async () => [{ id: "proj", name: "Project" }] as never },
        plugins: { callRpc: async (args: CallRpcArgs) => { gatewayCalls.push(args); return args.outputSchema.parse(await gatewayReply(args)); } } as never,
        threads: {
          list: async () => [] as never,
          get: async ({ threadId }: { threadId: string }) => byId.get(threadId) as never,
          events: { list: async () => [] } as never,
          timeline: async ({ threadId }: { threadId: string }) => {
            timelineReads.push(threadId);
            const timeline = timelines[threadId];
            return { rows: timeline?.rows ?? [
              { kind: "conversation", role: "user", initiator: "user", text: `Work on ${threadId}`, sourceSeqEnd: 1, createdAt: start },
              { kind: "conversation", role: "assistant", text: `Progress on ${threadId}`, sourceSeqEnd: 2, createdAt: start },
            ], timelinePage: { historySnapshot: "fixture", olderCursor: timeline?.hasOlder ? { anchorId: "older", anchorSeq: 1 } : null,
              olderRowsSourceSeqEnd: null, returnedSegmentCount: 1 } } as never;
          },
        },
      },
    });
    await plugin(bb);
    for (const item of threads) await harness.behavior.emitThreadEvent("thread.created", { thread: item } as never);
    return { harness, db: bb.storage.database(), timelines };
  }
  /** New conversation in a thread, so its next idle changes the briefing source. */
  const addMessage = (timelines: Record<string, { rows: Row[]; hasOlder?: boolean }>, threadId: string, seq: number) => {
    timelines[threadId] = { rows: [
      { kind: "conversation", role: "user", initiator: "user", text: `Work on ${threadId}`, sourceSeqEnd: 1, createdAt: start },
      { kind: "conversation", role: "assistant", text: `Newer progress ${seq}`, sourceSeqEnd: seq, createdAt: Date.now() },
    ] };
  };
  const completions = () => gatewayCalls.filter((call) => call.method === "inference.complete");
  const briefCalls = () => completions().filter((call) => (call.input as { schema: { name: string } }).schema.name === "thread_brief");
  const readBrief = async (harness: Awaited<ReturnType<typeof load>>["harness"], threadId: string) =>
    threadBriefSchema.parse(await harness.behavior.callRpc("journal_thread_brief", { threadId }));
  async function idleAndSweep(harness: Awaited<ReturnType<typeof load>>["harness"], ids: string[], threads: Array<ReturnType<typeof thread>>) {
    for (const id of ids) await harness.behavior.emitThreadEvent("thread.idle", { thread: threads.find((item) => item.id === id)! } as never);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
  }

  it("writes one briefing after idle, and the header read makes no model call, transcript read, or gateway request", async () => {
    const threads = [thread("thr_a")];
    const { harness } = await load(threads);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: threads[0]! } as never);
    // Inside the 2-minute idle debounce nothing runs.
    await vi.advanceTimersByTimeAsync(ENRICH_POLL_MS);
    expect(briefCalls()).toHaveLength(0);
    expect((await readBrief(harness, "thr_a"))).toMatchObject({ brief: null, pending: true, automatic: true });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(briefCalls()).toHaveLength(1);

    const before = { gateway: gatewayCalls.length, timelines: timelineReads.length };
    const saved = await readBrief(harness, "thr_a");
    await readBrief(harness, "thr_a");
    expect(saved).toMatchObject({ brief: BRIEF, stale: false, model: "subscription:gpt-6-luna", pending: false,
      coverage: { historyClipped: false, excerptClipped: false, startRead: true, passes: 1 } });
    expect({ gateway: gatewayCalls.length, timelines: timelineReads.length }).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });

  it("marks a briefing stale when a visible child changes, waits out the cooldown, and ignores hidden subtrees", async () => {
    const threads = [thread("thr_a"), thread("thr_child", { parentThreadId: "thr_a" }),
      thread("thr_hidden", { parentThreadId: "thr_a", visibility: "hidden" }), thread("thr_grand", { parentThreadId: "thr_hidden" })];
    const { harness, timelines } = await load(threads);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS);
    await idleAndSweep(harness, ["thr_a"], threads);
    expect(briefCalls()).toHaveLength(1);
    // The visible child read; the hidden child and its visible grandchild never are.
    expect(timelineReads).toContain("thr_child");
    expect(timelineReads).not.toContain("thr_hidden");
    expect(timelineReads).not.toContain("thr_grand");
    expect((await readBrief(harness, "thr_grand")).visible).toBe(false);

    vi.setSystemTime(Date.now() + 60 * 60_000);
    addMessage(timelines, "thr_child", 3); // the child finishes more work; the root is unchanged
    await harness.behavior.emitThreadEvent("thread.idle", { thread: threads[1]! } as never);
    const stale = await readBrief(harness, "thr_child");
    expect(stale).toMatchObject({ rootThreadId: "thr_a", stale: true, pending: true });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(briefCalls()).toHaveLength(2);
    expect((await readBrief(harness, "thr_a")).stale).toBe(false);

    // Within the 30-minute cooldown a new change waits.
    addMessage(timelines, "thr_child", 4);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: threads[1]! } as never);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(briefCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(briefCalls()).toHaveLength(3);
    await harness.lifecycle.dispose();
  });

  it("keeps the saved briefing and records a retry when the gateway is unavailable, never falling back to OpenRouter", async () => {
    const threads = [thread("thr_a")];
    const { harness, timelines } = await load(threads, { aiBackend: "subscription", openRouterApiKey: "sk-paid" });
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS);
    await idleAndSweep(harness, ["thr_a"], threads);
    const retryAt = Date.now() + 15 * 60_000;
    gatewayReply = () => ({ ok: false, code: "rate_limited", message: "All ChatGPT accounts held", retryAt });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    addMessage(timelines, "thr_a", 3);
    await idleAndSweep(harness, ["thr_a"], threads);
    const after = await readBrief(harness, "thr_a");
    expect(after).toMatchObject({ brief: BRIEF, stale: true, retryAt, error: expect.stringContaining("rate_limited") });
    const attempts = briefCalls().length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(briefCalls()).toHaveLength(attempts);
    expect(fetch).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });

  it("treats a non-subscription billing answer as unavailable", async () => {
    const threads = [thread("thr_a")];
    const { harness } = await load(threads);
    gatewayReply = () => ({ ok: true, text: JSON.stringify(BRIEF), model: "gpt-6-luna", billing: "api-key", usage: null });
    const result = await harness.behavior.runCli(["brief", "thr_a", "--refresh"]);
    expect(result.exitCode).toBe(1);
    expect((await readBrief(harness, "thr_a")).brief).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("runs no automatic briefings on the OpenRouter backend, the existing default", async () => {
    const threads = [thread("thr_a")];
    const { harness } = await load(threads, { openRouterApiKey: "sk-paid" });
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS);
    await idleAndSweep(harness, ["thr_a"], threads);
    expect(gatewayCalls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readBrief(harness, "thr_a")).toMatchObject({ brief: null, automatic: false, pending: false });
    await harness.lifecycle.dispose();
  });

  it("returns a graceful root when the parent is not indexed", async () => {
    const threads = [thread("thr_orphan", { parentThreadId: "thr_unknown" })];
    const { harness } = await load(threads);
    expect(await readBrief(harness, "thr_orphan")).toMatchObject({ visible: true, rootThreadId: "thr_orphan", brief: null });
    expect(await readBrief(harness, "thr_missing")).toMatchObject({ visible: false, rootThreadId: null });
    await harness.lifecycle.dispose();
  });

  it("reports clipped coverage for a long thread and keeps the opening plus the latest stopping point", async () => {
    const rows: Row[] = [
      { kind: "conversation", role: "user", initiator: "user", text: `Original request ${"x".repeat(30_000)}`, sourceSeqEnd: 1, createdAt: start },
      ...Array.from({ length: 30 }, (_, index): Row => ({ kind: "conversation", role: "assistant", text: `Step ${index} ${"y".repeat(900)}`, sourceSeqEnd: index + 2, createdAt: start })),
      { kind: "conversation", role: "assistant", text: "Concrete result: deployed", sourceSeqEnd: 40, createdAt: start },
    ];
    const threads = [thread("thr_a")];
    const { harness } = await load(threads, { aiBackend: "subscription" }, { thr_a: { rows } });
    expect((await harness.behavior.runCli(["brief", "thr_a", "--refresh"])).exitCode).toBe(0);
    const input = (briefCalls()[0]!.input as { input: string }).input;
    expect(input).toContain("USER: Original request");
    expect(input).toContain("Concrete result: deployed");
    expect(input.length).toBeLessThan(64_000);
    expect((await readBrief(harness, "thr_a")).coverage).toMatchObject({ historyClipped: false, excerptClipped: true, startRead: true });
    await harness.lifecycle.dispose();
  });

  it("marks the start as unread when older timeline pages exist", async () => {
    const threads = [thread("thr_a")];
    const { harness } = await load(threads, { aiBackend: "subscription" }, { thr_a: { hasOlder: true, rows: [
      { kind: "conversation", role: "assistant", text: "Latest step", sourceSeqEnd: 500, createdAt: start },
    ] } });
    await harness.behavior.runCli(["brief", "thr_a", "--refresh"]);
    expect((await readBrief(harness, "thr_a")).coverage).toMatchObject({ historyClipped: true, startRead: false });
    await harness.lifecycle.dispose();
  });

  it("serves every AI path from the subscription without an OpenRouter key and without charging the dollar budget", async () => {
    const threads = [thread("thr_a")];
    const { harness, db } = await load(threads, { aiBackend: "subscription", automaticDailyBudgetUsd: 0 });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: threads[0]! } as never);
    vi.setSystemTime(start + 86_400_000);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS);
    expect(db.prepare("SELECT outcome, ai_model AS model FROM journal_work_days_v2 WHERE thread_id='thr_a'").get())
      .toEqual({ outcome: "Shipped", model: "subscription:gpt-6-luna" });
    expect(await harness.behavior.callRpc("journal_catch_up_narrative", { force: false })).toEqual(CATCH_UP);
    expect((await harness.behavior.runCli(["enrich", "--thread", "thr_a"])).exitCode).toBe(0);
    const status = JSON.parse((await harness.behavior.runCli(["ai-status", "--json"])).stdout!);
    expect(status).toMatchObject({ backend: "subscription", configured: true, automaticAiBudget: { spentUsd: 0, reservedUsd: 0, limitUsd: 0 } });
    expect(JSON.parse((await harness.behavior.runCli(["cost", "--json"])).stdout!)).toMatchObject({ costUsd: 0, unpricedCalls: 0 });
    expect(await harness.behavior.callRpc("journal_ai_test", null)).toMatchObject({ ok: true, backend: "subscription" });
    expect(fetch).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });

  it("keeps the last catch-up when the gateway is unavailable", async () => {
    const threads = [thread("thr_a"), thread("thr_b")];
    const { harness } = await load(threads);
    const first = await harness.behavior.callRpc("journal_catch_up_narrative", { force: false });
    gatewayReply = (args) => args.method === "inference.status"
      ? { available: false, models: [], usableAccounts: 0, inFlight: 0, maxConcurrent: 2, retryAt: null, reason: "No ChatGPT subscription account" }
      : { ok: false, code: "unavailable", message: "No ChatGPT subscription account", retryAt: null };
    await harness.behavior.emitThreadEvent("thread.idle", { thread: threads[1]! } as never);
    expect(await harness.behavior.callRpc("journal_catch_up_narrative", { force: false }))
      .toMatchObject({ paragraphs: (first as typeof CATCH_UP).paragraphs, notice: expect.stringContaining("unavailable") });
    expect(JSON.parse((await harness.behavior.runCli(["ai-status", "--json"])).stdout!))
      .toMatchObject({ configured: false, reason: "No ChatGPT subscription account" });
    expect(fetch).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });

  it("drops a deleted child from its parent's briefing source and never reads its timeline again", async () => {
    const threads = [thread("thr_a"), thread("thr_child", { parentThreadId: "thr_a" })];
    const { harness } = await load(threads);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS);
    await idleAndSweep(harness, ["thr_a"], threads);
    expect(briefCalls()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: threads[1]! } as never);
    expect(await readBrief(harness, "thr_a")).toMatchObject({ stale: true, pending: true });
    timelineReads = [];
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(briefCalls()).toHaveLength(2);
    expect(timelineReads).toEqual(["thr_a"]);
    expect((await readBrief(harness, "thr_a")).stale).toBe(false);
    // Journal history keeps the deleted child's rows.
    expect((await harness.behavior.runCli(["list", "--lifecycle", "--all", "--json"])).stdout).toContain("thr_child");
    await harness.lifecycle.dispose();
  });

  it("does not let many running roots starve an idle one", async () => {
    const threads = Array.from({ length: 22 }, (_, index) => thread(`thr_${String(index).padStart(2, "0")}`));
    const { harness, db } = await load(threads);
    for (const item of threads) await harness.behavior.emitThreadEvent("thread.idle", { thread: item } as never);
    for (const item of threads.slice(0, 21)) db.prepare("UPDATE journal_turn_threads SET status='active' WHERE thread_id=?").run(item.id);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS + 3 * 60_000);
    expect(briefCalls()).toHaveLength(1);
    expect((await readBrief(harness, "thr_21")).brief).toEqual(BRIEF);
    expect((await readBrief(harness, "thr_00")).running).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("records unknown subscription token usage as unmeasured, not as zero tokens", async () => {
    const threads = [thread("thr_a")];
    const { harness } = await load(threads);
    gatewayReply = () => ({ ok: true, text: JSON.stringify(BRIEF), model: "gpt-6-luna", billing: "subscription", usage: null });
    await harness.behavior.runCli(["brief", "thr_a", "--refresh"]);
    expect(JSON.parse((await harness.behavior.runCli(["cost", "--json"])).stdout!)).toMatchObject({ calls: 1, costUsd: 0, unmeasuredCalls: 1 });
    await harness.lifecycle.dispose();
  });

  it("bounds large catch-up, replay, and period facts to valid JSON under the gateway cap", async () => {
    const big = "z".repeat(1_500);
    const threads = Array.from({ length: 100 }, (_, index) => thread(`thr_${String(index).padStart(3, "0")}`, { title: `Big ${index} ${big}` }));
    const { harness } = await load(threads);
    for (const item of threads) await harness.behavior.emitThreadEvent("thread.idle", { thread: item } as never);
    await harness.behavior.callRpc("journal_catch_up_narrative", { force: true }).catch(() => undefined);
    const day = new Date(start); day.setHours(0, 0, 0, 0);
    const next = day.getTime() + 86_400_000;
    vi.setSystemTime(next + 3_600_000);
    await harness.behavior.callRpc("journal_replay", { start: day.getTime(), end: next, mode: "day" });
    await harness.behavior.callRpc("journal_summary", { yesterdayStart: day.getTime(), todayStart: next, weekStart: day.getTime() - 86_400_000,
      now: next, previousWeekStart: day.getTime() - 8 * 86_400_000, previousWeekEnd: day.getTime() - 86_400_000 });
    await vi.advanceTimersByTimeAsync(1);
    const names = new Set<string>();
    for (const call of completions()) {
      const { input, schema } = call.input as { input: string; schema: { name: string } };
      names.add(schema.name);
      expect(input.length).toBeLessThanOrEqual(64_000);
      const json = input.slice(input.indexOf(schema.name === "catch_up" ? "" : "{"));
      expect(() => JSON.parse(schema.name === "catch_up" ? input : json)).not.toThrow();
    }
    expect(names).toEqual(new Set(["catch_up", "journal_standup"]));
    expect(completions().filter((call) => (call.input as { schema: { name: string } }).schema.name === "journal_standup")).toHaveLength(2);
    expect(completions().some((call) => (call.input as { input: string }).input.includes("omitted"))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  }, 30_000);

  it("keeps CJK and escaped facts under the gateway's 128 KiB request bytes", async () => {
    const wide = "工作进展\"引号\"".repeat(150);
    const threads = Array.from({ length: 50 }, (_, index) => thread(`thr_${String(index).padStart(2, "0")}`, { title: `${index} ${wide}` }));
    const rows: Row[] = [
      { kind: "conversation", role: "user", initiator: "user", text: `目标 ${"汉".repeat(40_000)}`, sourceSeqEnd: 1, createdAt: start },
      { kind: "conversation", role: "assistant", text: `最新 ${"字".repeat(40_000)} 最终已验证`, sourceSeqEnd: 2, createdAt: start },
    ];
    const { harness } = await load(threads, { aiBackend: "subscription" }, { thr_00: { rows } });
    gatewayReply = (args) => args.method === "inference.status" ? { available: true, models: ["gpt-6-luna"], usableAccounts: 1, inFlight: 0, maxConcurrent: 2, retryAt: null, reason: null } : { ok: true, text: JSON.stringify((args.input as { schema: { name: string } }).schema.name === "catch_up" ? { paragraphs: [{ text: "Work continues.", links: [{ threadId: "thr_00", phrase: "Work continues" }] }] } : (args.input as { schema: { name: string } }).schema.name === "journal_standup" ? STANDUP : BRIEF), model: "gpt-6-luna", billing: "subscription", usage: null };
    for (const item of threads) await harness.behavior.emitThreadEvent("thread.idle", { thread: item } as never);
    await harness.behavior.callRpc("journal_catch_up_narrative", { force: true });
    await harness.behavior.runCli(["brief", "thr_00", "--refresh"]);
    const day = new Date(start); day.setHours(0, 0, 0, 0);
    vi.setSystemTime(day.getTime() + 86_400_000 + 3_600_000);
    await harness.behavior.callRpc("journal_summary", { yesterdayStart: day.getTime(), todayStart: day.getTime() + 86_400_000,
      weekStart: day.getTime() - 86_400_000, now: day.getTime() + 86_400_000, previousWeekStart: day.getTime() - 8 * 86_400_000, previousWeekEnd: day.getTime() - 86_400_000 });
    await vi.advanceTimersByTimeAsync(1);
    const sent = completions().map((call) => call.input as { system: string; input: string; schema: { name: string } });
    expect(new Set(sent.map((request) => request.schema.name))).toEqual(new Set(["catch_up", "thread_brief", "journal_standup"]));
    for (const request of sent) {
      expect(request.input.length).toBeLessThanOrEqual(64_000);
      expect(Buffer.byteLength(JSON.stringify([request.system, request.input, request.schema]), "utf8")).toBeLessThanOrEqual(128 * 1024);
      if (request.schema.name === "catch_up") expect(() => JSON.parse(request.input)).not.toThrow();
      if (request.schema.name === "thread_brief") expect(request.input).toContain("最终已验证");
    }
    await harness.lifecycle.dispose();
  }, 30_000);

  it("treats a deleted root as a boundary: its child becomes a live root and the deleted timeline is never read", async () => {
    const threads = [thread("thr_root"), thread("thr_kid", { parentThreadId: "thr_root" })];
    const { harness } = await load(threads);
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: threads[0]! } as never);
    expect(await readBrief(harness, "thr_kid")).toMatchObject({ visible: true, rootThreadId: "thr_kid", pending: true });
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS);
    await idleAndSweep(harness, ["thr_kid"], threads);
    expect(briefCalls()).toHaveLength(1);
    expect(timelineReads.filter((id) => id === "thr_root")).toEqual([]);
    expect((await readBrief(harness, "thr_kid")).brief).toEqual(BRIEF);
    await harness.lifecycle.dispose();
  });

  it.each(["success", "error"] as const)("never resurrects a deleted root after an in-flight %s", async (reply) => {
    const root = thread("thr_root");
    const { harness, db } = await load([root]);
    const pending = Promise.withResolvers<unknown>();
    gatewayReply = () => pending.promise;
    const refresh = harness.behavior.runCli(["brief", root.id, "--refresh"]);
    await vi.waitFor(() => expect(briefCalls()).toHaveLength(1));
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: root } as never);
    pending.resolve(reply === "success"
      ? { ok: true, text: JSON.stringify(BRIEF), model: "gpt-6-luna", billing: "subscription", usage: null }
      : { ok: false, code: "unavailable", message: "held", retryAt: null });
    await refresh;
    expect(db.prepare("SELECT * FROM journal_thread_briefs WHERE thread_id=?").get(root.id)).toBeUndefined();
    expect(await readBrief(harness, root.id)).toMatchObject({ visible: false, brief: null });
    await harness.lifecycle.dispose();
  });

  it.each(["success", "error"] as const)("discards an in-flight %s briefing with a deleted child and keeps the newer queue", async (reply) => {
    const threads = [thread("thr_root"), thread("thr_child", { parentThreadId: "thr_root" })];
    const { harness, db } = await load(threads);
    const pending = Promise.withResolvers<unknown>();
    const normal = gatewayReply;
    gatewayReply = (args) => (args.input as { schema: { name: string } }).schema.name === "thread_brief" ? pending.promise : normal(args);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: threads[0]! } as never);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS + 2 * 60_000 + ENRICH_POLL_MS);
    expect(briefCalls()).toHaveLength(1);
    expect((briefCalls()[0]!.input as { input: string }).input).toContain("Child thread");
    const oldIdle = db.prepare("SELECT idle_at AS idle FROM journal_brief_pending WHERE thread_id='thr_root'").get() as { idle: number };
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: threads[1]! } as never);
    const newerIdle = db.prepare("SELECT idle_at AS idle FROM journal_brief_pending WHERE thread_id='thr_root'").get() as { idle: number };
    expect(newerIdle.idle).toBeGreaterThan(oldIdle.idle);
    gatewayReply = normal;
    pending.resolve(reply === "success"
      ? { ok: true, text: JSON.stringify(BRIEF), model: "gpt-6-luna", billing: "subscription", usage: null }
      : { ok: false, code: "unavailable", message: "held", retryAt: null });
    await vi.waitFor(() => expect(db.prepare("SELECT brief_json FROM journal_thread_briefs WHERE thread_id='thr_root'").get()).toBeUndefined());
    expect(db.prepare("SELECT idle_at AS idle FROM journal_brief_pending WHERE thread_id='thr_root'").get()).toEqual(newerIdle);
    timelineReads = [];
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(briefCalls()).toHaveLength(2);
    expect(timelineReads).toEqual(["thr_root"]);
    expect((await readBrief(harness, "thr_root")).brief).toEqual(BRIEF);
    await harness.lifecycle.dispose();
  });

  it("does not show cached prose as fresh after the model changes, and keeps it visibly stale when the gateway is down", async () => {
    const threads = [thread("thr_a")];
    const { harness } = await load(threads);
    const first = await harness.behavior.callRpc("journal_catch_up_narrative", { force: false });
    const catchUps = () => completions().filter((call) => (call.input as { schema: { name: string } }).schema.name === "catch_up");
    expect(catchUps()).toHaveLength(1);
    await harness.behavior.callRpc("journal_preferences_update", { gatewayModel: "gpt-5.6-luna" });
    await harness.behavior.callRpc("journal_catch_up_narrative", { force: false });
    expect(catchUps()).toHaveLength(2);
    expect((catchUps()[1]!.input as { model: string }).model).toBe("gpt-5.6-luna");
    gatewayReply = () => ({ ok: false, code: "unavailable", message: "No ChatGPT subscription account", retryAt: null });
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_new") } as never);
    expect(await harness.behavior.callRpc("journal_catch_up_narrative", { force: false }))
      .toMatchObject({ paragraphs: (first as typeof CATCH_UP).paragraphs, notice: expect.stringContaining("unavailable") });
    await harness.lifecycle.dispose();
  });

  it("keeps the status backend/model snapshot when a slow gateway status returns after settings switch", async () => {
    const slow = Promise.withResolvers<unknown>();
    const { harness } = await load([thread("thr_a")], { aiBackend: "subscription", openRouterApiKey: "sk-paid" });
    gatewayReply = (args) => args.method === "inference.status" ? slow.promise : { ok: false, code: "unavailable", message: "held", retryAt: null };
    const pending = harness.behavior.callRpc("journal_intelligence_status", null);
    await vi.waitFor(() => expect(gatewayCalls.some((call) => call.method === "inference.status")).toBe(true));
    await harness.behavior.callRpc("journal_preferences_update", { aiBackend: "openrouter" });
    slow.resolve({ available: true, models: ["gpt-6-luna"], usableAccounts: 1, inFlight: 0, maxConcurrent: 2, retryAt: null, reason: null });
    expect(await pending).toMatchObject({ backend: "subscription", model: "subscription:gpt-6-luna", configured: true, automaticBriefs: true });
    expect(await harness.behavior.callRpc("journal_intelligence_status", null))
      .toMatchObject({ backend: "openrouter", model: "google/gemini-3.1-flash-lite-preview", configured: true, automaticBriefs: false });
    await harness.lifecycle.dispose();
  });
  it("refetches replay and period prose after a model switch, then marks the old prose stale if the new backend is unavailable", async () => {
    const threads = [thread("thr_a")];
    const { harness, db } = await load(threads);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: threads[0]! } as never);
    const day = new Date(start); day.setHours(0, 0, 0, 0);
    const today = day.getTime() + 86_400_000;
    vi.setSystemTime(today + 3_600_000);
    const replay = { start: day.getTime(), end: today, mode: "day" as const };
    const summary = { yesterdayStart: day.getTime(), todayStart: today, weekStart: day.getTime() - 86_400_000,
      now: today, previousWeekStart: day.getTime() - 8 * 86_400_000, previousWeekEnd: day.getTime() - 86_400_000 };
    await harness.behavior.callRpc("journal_replay", replay);
    await harness.behavior.callRpc("journal_summary", summary);
    await vi.advanceTimersByTimeAsync(1);
    const standups = () => completions().filter((call) => (call.input as { schema: { name: string } }).schema.name === "journal_standup");
    expect(standups()).toHaveLength(2);
    await harness.behavior.callRpc("journal_preferences_update", { gatewayModel: "gpt-5.6-luna" });
    await harness.behavior.callRpc("journal_replay", replay);
    await harness.behavior.callRpc("journal_summary", summary);
    await vi.advanceTimersByTimeAsync(1);
    expect(standups()).toHaveLength(4);
    const changedModel = standups()[2]!.input;
    expect(changedModel).toMatchObject({ model: "gpt-5.6-luna" });
    // The old cache is visibly stale if a new model cannot answer.
    gatewayReply = () => ({ ok: false, code: "unavailable", message: "held", retryAt: null });
    await harness.behavior.callRpc("journal_preferences_update", { gatewayModel: "gpt-6-luna" });
    // Same gpt-6 model is already cached: change a saved day without reading transcripts.
    db.prepare("UPDATE journal_work_days_v2 SET summary='A newer result' WHERE thread_id='thr_a'").run();
    const stale = await harness.behavior.callRpc("journal_replay", replay) as { narrative: string | null; narrativeStale: boolean };
    expect(stale).toMatchObject({ narrativeStale: true });
    await harness.lifecycle.dispose();
  });
});
