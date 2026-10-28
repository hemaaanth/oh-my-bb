import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, {
  ENRICH_STARTUP_DELAY_MS,
  briefCatchUpText, classifyThread, cleanSummary, groupMessagesByDay, localDayStart, normalizeIntelligence, plainPreview, readContract, rpcContract, selectTranscript,
} from "./server";
import { addWorkDays } from "./shared";

describe("journal classification", () => {
  it.each([
    ["Fix mobile dashboard overflow", "bug-fix"],
    ["Implement universal agent memory", "feature"],
    ["Improve logged-out page design", "improvement"],
    ["Research database prospects", "research"],
    ["Analyze product metrics", "analysis"],
    ["Set up release workflow", "operations"],
    ["Product outreach email", "content"],
    ["Product launch strategy", "planning"],
    ["Review PR 712", "review"],
    ["Example roadmap", "project"],
    ["Local smoke test", "test"],
  ])("classifies %s", (title, expected) => {
    expect(classifyThread({ title, titleFallback: null })).toBe(expected);
  });

  it("uses the fallback when a title is empty", () => {
    expect(classifyThread({ title: null, titleFallback: "Debug the production failure" })).toBe("bug-fix");
  });
});

describe("journal summaries", () => {
  it("removes agent-profile prefixes and trailing punctuation", () => {
    expect(cleanSummary({ title: "@pr-review · Review PR 712...", titleFallback: null })).toBe("Review PR 712");
  });

  it("removes reply boilerplate and markdown emphasis", () => {
    expect(cleanSummary({ title: null, titleFallback: "Replying to this earlier message in the conversation: **A useful follow-up.**" })).toBe("A useful follow-up");
  });

  it("keeps a summary to one compact line", () => {
    const summary = cleanSummary({ title: null, titleFallback: `  ${"a".repeat(140)}\nmore  ` });
    expect(summary.length).toBe(118);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary).not.toContain("\n");
  });
});

describe("catch-up prose", () => {
  it("keeps complete sentences within the limit and never adds an ellipsis", () => {
    expect(briefCatchUpText("The dashboard is ready. The next unverified step continues beyond the limit.", 35)).toBe("The dashboard is ready.");
    expect(briefCatchUpText("A complete but long sentence about the dashboard and the backfill.", 20)).toBe("A complete but long sentence about the dashboard and the backfill.");
    expect(briefCatchUpText("The dashboard is ready. An unfinished thought...", 200)).toBe("The dashboard is ready.");
  });
});

describe("journal intelligence", () => {
  it("keeps the first user intent and most recent work within the transcript budget", () => {
    const result = selectTranscript([
      { role: "user", text: "Build a durable journal", sourceSeqEnd: 1 },
      { role: "assistant", text: "x".repeat(100), sourceSeqEnd: 2 },
      { role: "user", text: "Use a cheap model", sourceSeqEnd: 3 },
      { role: "assistant", text: "Added cached transcript summaries", sourceSeqEnd: 4 },
    ], 100);
    expect(result.text).toContain("Build a durable journal");
    expect(result.text).toContain("Added cached transcript summaries");
    expect(result.maxSeq).toBe(4);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it("normalizes structured model output", () => {
    expect(normalizeIntelligence({
      summary: "  Added transcript-aware summaries. ", category: "feature",
      outcome: " Cached by transcript sequence. ", status: "completed",
      tags: ["AI", "ai", "OpenRouter"],
    })).toEqual({
      summary: "Added transcript-aware summaries", category: "feature",
      outcome: "Cached by transcript sequence", status: "completed",
      tags: ["ai", "openrouter"],
    });
  });
});

describe("daily activity replay", () => {
  it("groups a multi-day thread into one work record per local day", () => {
    const monday = new Date(2026, 8, 14, 10).getTime();
    const tuesday = new Date(2026, 8, 15, 11).getTime();
    const groups = groupMessagesByDay([
      { role: "user", text: "Start the implementation", sourceSeqEnd: 1, createdAt: monday },
      { role: "assistant", text: "Implemented the collector", sourceSeqEnd: 2, createdAt: monday + 3_600_000 },
      { role: "user", text: "Continue with the chart", sourceSeqEnd: 3, createdAt: tuesday },
    ]);
    expect([...groups.keys()]).toEqual([localDayStart(monday), localDayStart(tuesday)]);
    expect(groups.get(localDayStart(monday))).toHaveLength(2);
    expect(groups.get(localDayStart(tuesday))).toHaveLength(1);
  });

  it("ignores messages without a usable activity timestamp", () => {
    expect(groupMessagesByDay([{ role: "assistant", text: "No timestamp", sourceSeqEnd: 1 }]).size).toBe(0);
  });
});

describe("work-day timezone", () => {
  it("uses Eastern midnight across both daylight-saving transitions", () => {
    const march = Date.parse("2026-03-08T05:00:00Z");
    expect(localDayStart(Date.parse("2026-03-08T23:59:00Z"))).toBe(march);
    expect(addWorkDays(march, 1)).toBe(Date.parse("2026-03-09T04:00:00Z"));
    const november = Date.parse("2026-11-01T04:00:00Z");
    expect(addWorkDays(november, 1)).toBe(Date.parse("2026-11-02T05:00:00Z"));
  });
  it("groups new days using the configured timezone", () => {
    const timestamp = Date.parse("2026-10-13T01:00:00Z");
    expect(localDayStart(timestamp)).toBe(Date.parse("2026-10-12T04:00:00Z"));
    expect(localDayStart(timestamp, "Asia/Kolkata")).toBe(Date.parse("2026-10-12T18:30:00Z"));
  });
});


describe("background enrichment", () => {
  const start = new Date(2026, 8, 22, 10).getTime();
  type Deferred = { resolve: (value: Response) => void };
  let openRouter: Array<{ kind: string; body: Record<string, unknown> }>;
  let heldStandups: Deferred[];
  let responseCost: number;

  function openRouterResponse(content: unknown) {
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: responseCost } }), { status: 200 });
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: start, toFake: ["setTimeout", "clearTimeout", "Date"] });
    openRouter = []; heldStandups = []; responseCost = 0.0001;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { response_format: { json_schema: { name: string } } };
      const kind = body.response_format.json_schema.name; openRouter.push({ kind, body });
      if (kind === "journal_standup") return new Promise<Response>((resolve) => heldStandups.push({ resolve }));
      if (kind === "catch_up") return openRouterResponse({ paragraphs: [{ text: "Product outreach continues. [thr_open] (https://example.com/extra)", links: [{ threadId: "thr_open", phrase: "Product outreach" }, { threadId: "thr_open", phrase: "continues" }, { threadId: "invented", phrase: "continues" }] }, { text: "The new calendar tools are in place [Read more](thr_open)", threadIds: ["thr_open"] }, { text: "Incomplete paragraph" }] });
      return openRouterResponse({ summary: "Built the thing", category: "feature", outcome: "Shipped", status: "completed", tags: ["thing"] });
    }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function loadJournal(threads: Array<ReturnType<typeof makeThreadResponse>>, listThreads = false,
    timelineRows?: Array<{ kind: "conversation"; role: "user" | "assistant"; initiator?: "user"; text: string; sourceSeqEnd: number; createdAt: number }>) {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const { bb, harness } = createFakePluginHost({
      pluginId: "journal", settings: { openRouterApiKey: "sk-test" },
      sdk: {
        projects: { list: async () => [{ id: "proj", name: "Project" }] as never },
        threads: {
          list: async ({ archived = false, limit = 100, offset = 0 } = {}) =>
            (listThreads ? threads.filter((thread) => Boolean(thread.archivedAt) === archived).slice(offset, offset + limit) : []) as never,
          get: async ({ threadId }: { threadId: string }) => byId.get(threadId) as never,
          timeline: async () => ({
            rows: timelineRows ?? [
              { kind: "conversation", role: "user", initiator: "user", text: "Build the thing", sourceSeqEnd: 1, createdAt: start },
              { kind: "conversation", role: "assistant", text: "Built it", sourceSeqEnd: 2, createdAt: start },
            ],
            timelinePage: { historySnapshot: "fixture", olderCursor: null, olderRowsSourceSeqEnd: null, returnedSegmentCount: 1 },
          }) as never,
        },
      },
    });
    await plugin(bb);
    const db = bb.storage.database();
    const pending = (threadId: string) => db.prepare("SELECT pending_turns AS turns, archived FROM journal_pending_enrichment WHERE thread_id=?").get(threadId) as { turns: number; archived: number } | undefined;
    return { bb, harness, db, pending };
  }
  const thread = (id: string, overrides: Partial<ReturnType<typeof makeThreadResponse>> = {}) =>
    makeThreadResponse({ id, projectId: "proj", title: "Build the thing", parentThreadId: null, visibility: "visible", archivedAt: null, createdAt: start, ...overrides });
  const changedSignals = (harness: ReturnType<typeof createFakePluginHost>["harness"]) => harness.inspection.realtimeSignals
    .filter((signal) => signal.channel === "journal-changed" && !Object.hasOwn(signal.payload as object, "synced"));

  it("returns current visible open thread summaries for catch-up", async () => {
    const { harness } = await loadJournal([thread("thr_open"), thread("thr_archived", { archivedAt: start + 1000 })]);
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_open") } as never);
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_archived", { archivedAt: start + 1000 }) } as never);
    const result = await harness.behavior.callRpc("journal_catch_up", null) as { entries: Array<{ threadId: string; summary: string }> };
    expect(result.entries).toEqual([expect.objectContaining({ threadId: "thr_open", summary: "Build the thing" })]);
  });

  it("uses server journal threads for clickable references and caches the narrative", async () => {
    const { harness } = await loadJournal([thread("thr_open")]);
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_open") } as never);
    const input = { force: false };
    const first = await harness.behavior.callRpc("journal_catch_up_narrative", input);
    expect(first).toEqual({ paragraphs: [
      { text: "Product outreach continues.", links: [{ threadId: "thr_open", phrase: "Product outreach" }] },
      { text: "The new calendar tools are in place.", links: [{ threadId: "thr_open", phrase: "new calendar tools" }] },
    ] });
    expect(await harness.behavior.callRpc("journal_catch_up_narrative", input)).toEqual(first);
    expect(openRouter.filter((call) => call.kind === "catch_up")).toHaveLength(1);
    const request = openRouter.find((call) => call.kind === "catch_up")!.body as { messages: Array<{ content: string }> };
    expect(request.messages[1].content).toContain("Build the thing");
    expect(request.messages[1].content).toContain("Built it");
    expect(await harness.behavior.callRpc("journal_catch_up_narrative", { ...input, force: true })).toEqual(first);
    expect(openRouter.filter((call) => call.kind === "catch_up")).toHaveLength(2);
    const { harness: restarted } = await harness.lifecycle.reload(plugin);
    expect(await restarted.behavior.callRpc("journal_catch_up_narrative", input)).toEqual(first);
    expect(openRouter.filter((call) => call.kind === "catch_up")).toHaveLength(2);
    await restarted.lifecycle.dispose();
  });

  it("shows the last catch-up with a note when the spend budget is exhausted", async () => {
    const { harness } = await loadJournal([thread("thr_open"), thread("thr_next")]);
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_open") } as never);
    const previous = rpcContract.journal_catch_up_narrative.output.parse(await harness.behavior.callRpc("journal_catch_up_narrative", { force: false }));
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_next") } as never);
    await harness.behavior.callRpc("journal_preferences_update", { automaticDailyBudgetUsd: 0 });
    const fallback = await harness.behavior.callRpc("journal_catch_up_narrative", { force: false });
    expect(fallback).toMatchObject({ paragraphs: previous.paragraphs,
      notice: expect.stringContaining("Automatic AI budget reached") });
    expect(openRouter.filter((call) => call.kind === "catch_up")).toHaveLength(1);
    expect(await harness.behavior.callRpc("journal_catch_up_narrative", { force: true }))
      .toMatchObject({ paragraphs: previous.paragraphs });
    expect(openRouter.filter((call) => call.kind === "catch_up")).toHaveLength(2);
    const status = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(status.automaticAiBudget).toMatchObject({ attempts: 1, limitUsd: 0, remainingUsd: 0 });
    await harness.lifecycle.dispose();
  });

  it("explains a depleted budget even when no catch-up has been cached", async () => {
    const { harness } = await loadJournal([thread("thr_open")]);
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_open") } as never);
    await harness.behavior.callRpc("journal_preferences_update", { automaticDailyBudgetUsd: 0 });
    expect(await harness.behavior.callRpc("journal_catch_up_narrative", { force: false }))
      .toMatchObject({ paragraphs: [], notice: expect.stringContaining("Automatic AI budget reached") });
    expect(openRouter).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("allows a cached pre-migration attempt count to continue under the new spend limit", async () => {
    const { harness, db } = await loadJournal([thread("thr_open")]);
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_open") } as never);
    db.prepare("INSERT INTO journal_auto_ai_budget (day_start, work_timezone, attempts) VALUES (?, 'America/New_York', 25)")
      .run(localDayStart(start));
    await harness.behavior.callRpc("journal_catch_up_narrative", { force: false });
    expect(openRouter.filter((call) => call.kind === "catch_up")).toHaveLength(1);
    const status = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(status.automaticAiBudget).toMatchObject({ attempts: 26, hardLimit: 500, limitUsd: 0.50 });
    await harness.lifecycle.dispose();
  });

  it("enforces the hard backstop even when estimated cost is still below budget", async () => {
    const { harness, db } = await loadJournal([thread("thr_open"), thread("thr_next")]);
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_open") } as never);
    db.prepare("INSERT INTO journal_auto_ai_budget (day_start, work_timezone, attempts) VALUES (?, 'America/New_York', 499)")
      .run(localDayStart(start));
    await harness.behavior.callRpc("journal_catch_up_narrative", { force: false });
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_next") } as never);
    const fallback = await harness.behavior.callRpc("journal_catch_up_narrative", { force: false });
    expect(rpcContract.journal_catch_up_narrative.output.parse(fallback).notice).toContain("Automatic AI budget reached");
    expect(openRouter.filter((call) => call.kind === "catch_up")).toHaveLength(1);
    const status = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(status.automaticAiBudget).toMatchObject({ attempts: 500, hardLimit: 500 });
    await harness.lifecycle.dispose();
  });

  it("charges the reserved estimate when a custom model returns no usable price", async () => {
    const { harness } = await loadJournal([thread("thr_open"), thread("thr_next")]);
    await harness.behavior.callRpc("journal_preferences_update", { openRouterModel: "provider/unknown-model" });
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_open") } as never);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ paragraphs: [{
        text: "Product outreach continues.", links: [{ threadId: "thr_open", phrase: "Product outreach" }],
      }] }) } }],
    }), { status: 200 }));
    expect(await harness.behavior.callRpc("journal_catch_up_narrative", { force: false }))
      .toMatchObject({ paragraphs: [expect.objectContaining({ text: "Product outreach continues." })] });
    await harness.behavior.emitThreadEvent("thread.created", { thread: thread("thr_next") } as never);
    const fallback = await harness.behavior.callRpc("journal_catch_up_narrative", { force: false });
    expect(rpcContract.journal_catch_up_narrative.output.parse(fallback).notice).toContain("Automatic AI budget reached");
    const status = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(status.automaticAiBudget).toMatchObject({ spentUsd: 0.50, reservedUsd: 0, attempts: 1, remainingUsd: 0 });
    expect(JSON.parse((await harness.behavior.runCli(["cost", "--json"])).stdout!))
      .toMatchObject({ unpricedCalls: 1 });
    await harness.lifecycle.dispose();
  });

  it("indexes today's conversation without an AI call", async () => {
    const { harness, db, pending } = await loadJournal([thread("thr_a")]);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread("thr_a") } as never);
    const row = db.prepare("SELECT day_start AS dayStart, message_count AS messageCount, enriched_at AS enrichedAt, day_timezone AS timeZone FROM journal_work_days_v2 WHERE thread_id='thr_a'").get();
    expect(row).toEqual({ dayStart: localDayStart(start), messageCount: 2, enrichedAt: null, timeZone: "America/New_York" });
    expect(pending("thr_a")).toBeUndefined();
    expect(openRouter).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("finalizes a closed day once and records actual token cost", async () => {
    const { harness, db } = await loadJournal([thread("thr_a")]);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread("thr_a") } as never);
    // A busy day can exceed the one-page provisional timeline.
    db.prepare("UPDATE journal_work_days_v2 SET message_count=1 WHERE thread_id='thr_a'").run();
    vi.setSystemTime(start + 86_400_000);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS);
    expect(openRouter.map((call) => call.kind)).toEqual(["journal_entry"]);
    const row = db.prepare("SELECT outcome, enriched_at AS enrichedAt, message_count AS messageCount FROM journal_work_days_v2 WHERE thread_id='thr_a'").get() as { outcome: string; enrichedAt: number | null; messageCount: number };
    expect(row).toMatchObject({ outcome: "Shipped", messageCount: 2 });
    expect(row.enrichedAt).not.toBeNull();
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread("thr_a") } as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(db.prepare("SELECT message_count AS count FROM journal_work_days_v2 WHERE thread_id='thr_a'").get()).toEqual({ count: 2 });
    expect(openRouter.map((call) => call.kind)).toEqual(["journal_entry"]);
    expect(await harness.behavior.runCli(["cost", "--json"])).toMatchObject({
      exitCode: 0, stdout: JSON.stringify({ calls: 1, promptTokens: 100, completionTokens: 50, costUsd: 0.0001, unpricedCalls: 0, unmeasuredCalls: 0 }),
    });
    await harness.lifecycle.dispose();
  });

  it("rolls children and side chats into one parent day and includes test work", async () => {
    const parent = thread("thr_parent"); const child = thread("thr_child", { parentThreadId: parent.id, title: "Agent review" });
    const sideChat = thread("thr_side", { parentThreadId: null, sourceThreadId: parent.id,
      originPluginId: "side-chat", title: "Yes. The latest execute" });
    const testThread = thread("thr_test", { title: "Local smoke test" });
    const hidden = thread("thr_hidden", { visibility: "hidden" });
    const { harness, db } = await loadJournal([parent, child, sideChat, testThread, hidden]);
    for (const target of [parent, child, sideChat, testThread, hidden]) {
      await harness.behavior.emitThreadEvent("thread.created", { thread: target } as never);
      await harness.behavior.emitThreadEvent("thread.idle", { thread: target } as never);
    }
    expect(db.prepare("SELECT count(*) AS count FROM journal_work_days_v2 WHERE thread_id='thr_hidden'").get()).toEqual({ count: 0 });
    const result = await harness.behavior.callRpc("journal_replay", {
      start: localDayStart(start), end: localDayStart(start + 86_400_000), mode: "day", query: "", category: null,
      projectId: null, limit: 100, offset: 0,
    }) as { workDays: number; activeThreads: number; categories: Array<{ name: string }>;
      entries: Array<{ threadId: string; children: Array<{ threadId: string; title: string }> }> };
    expect(result.workDays).toBe(2);
    expect(result.activeThreads).toBe(2);
    expect(result.categories).toContainEqual(expect.objectContaining({ name: "test" }));
    const children = result.entries.find((entry) => entry.threadId === parent.id)?.children;
    expect(children).toHaveLength(2);
    expect(children).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: child.id, title: expect.stringContaining(parent.title!) }),
      expect.objectContaining({ threadId: sideChat.id, title: expect.stringContaining(parent.title!) }),
    ]));
    db.prepare("UPDATE journal_work_days_v2 SET outcome='Shipped' WHERE thread_id IN ('thr_parent','thr_child')").run();
    db.prepare("UPDATE journal_work_days_v2 SET outcome='Reviewed risk' WHERE thread_id='thr_side'").run();
    const deduplicated = await harness.behavior.callRpc("journal_replay", {
      start: localDayStart(start), end: localDayStart(start + 86_400_000), mode: "day",
    }) as { entries: Array<{ threadId: string; outcome: string | null;
      children: Array<{ threadId: string; outcome: string | null }> }> };
    const parentDay = deduplicated.entries.find((entry) => entry.threadId === parent.id)!;
    expect(parentDay.outcome).toBe("Shipped");
    expect(parentDay.children.find((entry) => entry.threadId === child.id)?.outcome).toBeNull();
    expect(parentDay.children.find((entry) => entry.threadId === sideChat.id)?.outcome).toBe("Reviewed risk");
    const lifecycle = JSON.parse((await harness.behavior.runCli(["list", "--lifecycle", "--json"])).stdout!);
    expect(lifecycle.entries.map((entry: { threadId: string }) => entry.threadId)).not.toContain(sideChat.id);
    const allLifecycle = JSON.parse((await harness.behavior.runCli(["list", "--lifecycle", "--all", "--json"])).stdout!);
    expect(allLifecycle.entries.map((entry: { threadId: string }) => entry.threadId)).toContain(sideChat.id);
    await harness.lifecycle.dispose();
  });

  it("paginates work separately from lifecycle events and never shows a current outcome on old events", async () => {
    const first = thread("thr_first"); const second = thread("thr_second");
    const { harness, db } = await loadJournal([first, second]);
    for (const target of [first, second]) {
      await harness.behavior.emitThreadEvent("thread.created", { thread: target } as never);
      await harness.behavior.emitThreadEvent("thread.idle", { thread: target } as never);
    }
    db.prepare("UPDATE journal_threads SET outcome='PR opened' WHERE thread_id='thr_first'").run();
    await harness.behavior.emitThreadEvent("thread.archived", { thread: { ...first, archivedAt: start } } as never);
    const page = JSON.parse((await harness.behavior.runCli(["list", "--limit", "1", "--offset", "1", "--json"])).stdout!);
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 1, hasMore: false, entries: [expect.objectContaining({ threadId: "thr_second" })] });
    expect((await harness.behavior.runCli(["list", "--limit", "1"])).stdout).toContain("More rows:");
    const lifecycle = JSON.parse((await harness.behavior.runCli(["list", "--lifecycle", "--json"])).stdout!);
    expect(lifecycle.total).toBe(3);
    expect(lifecycle.entries).toContainEqual(expect.objectContaining({ threadId: first.id, eventType: "created", outcome: null }));
    vi.setSystemTime(start + 1_000);
    const summary = JSON.parse((await harness.behavior.runCli(["summary", "--json"])).stdout!);
    expect(summary.week.current).toMatchObject({ activeThreads: 2, workDays: 2, archived: 1 });
    await harness.lifecycle.dispose();
  });

  it("estimates all-time coverage without writes and resumes one thread per batch", async () => {
    const { harness, db } = await loadJournal([thread("thr_a"), thread("thr_b"),
      thread("thr_c", { originPluginId: "side-chat", sourceThreadId: "thr_a" })], true);
    vi.setSystemTime(start + 86_400_000);
    const dryRun = JSON.parse((await harness.behavior.runCli(["backfill", "--dry-run", "--json"])).stdout!);
    expect(dryRun).toMatchObject({ dryRun: true, threads: 3, workDays: 2, threadDays: 3, daysToEnrich: 3,
      model: "google/gemini-3.1-flash-lite-preview", timeZone: "America/New_York", progress: null });
    expect(dryRun.estimatedInputTokens).toBeGreaterThan(0);
    expect(dryRun.estimatedCostUsd).toBeGreaterThan(0);
    expect(db.prepare("SELECT count(*) AS count FROM journal_work_days_v2").get()).toEqual({ count: 0 });
    const first = JSON.parse((await harness.behavior.runCli(["backfill", "--limit", "1", "--json"])).stdout!);
    expect(first).toMatchObject({ processedThreads: 1, processedDays: 1, enrichedDays: 1, remainingThreads: 2, cursorThreadId: "thr_a" });
    const second = JSON.parse((await harness.behavior.runCli(["backfill", "--limit", "1", "--json"])).stdout!);
    expect(second).toMatchObject({ processedThreads: 2, processedDays: 2, enrichedDays: 2, remainingThreads: 1, cursorThreadId: "thr_b" });
    const third = JSON.parse((await harness.behavior.runCli(["backfill", "--limit", "1", "--json"])).stdout!);
    expect(third).toMatchObject({ processedThreads: 3, processedDays: 3, enrichedDays: 3, remainingThreads: 0, cursorThreadId: "thr_c" });
    expect(openRouter.filter((call) => call.kind === "journal_entry")).toHaveLength(3);
    expect(JSON.parse((await harness.behavior.runCli(["backfill", "--dry-run", "--json"])).stdout!))
      .toMatchObject({ daysToEnrich: 0 });
    await harness.lifecycle.dispose();
  });

  it("filters stored work by inclusive local dates and shows paged thread summaries without generating", async () => {
    const visible = thread("thr_dated");
    const hidden = thread("thr_hidden", { visibility: "hidden" });
    const { harness, db } = await loadJournal([visible, hidden]);
    await harness.behavior.emitThreadEvent("thread.created", { thread: visible } as never);
    await harness.behavior.emitThreadEvent("thread.created", { thread: hidden } as never);
    const march = localDayStart(Date.parse("2026-03-08T18:00:00Z"));
    const september = localDayStart(start);
    const insert = db.prepare(`INSERT INTO journal_work_days_v2
      (thread_id, day_start, first_activity_at, last_activity_at, message_count, source_seq_end,
       summary, outcome, category, work_status, tags_json, day_timezone)
      VALUES ('thr_dated', ?, ?, ?, 2, 2, ?, ?, 'feature', 'completed', '["release"]', 'America/New_York')`);
    insert.run(march, march + 3600_000, march + 3600_000, "March work", "March shipped");
    insert.run(september, start, start, "September work", "September shipped");

    const marchPage = readContract["read.list"].output.parse(await harness.behavior.callRpc("read.list", {
      from: "2026-03-08", to: "2026-03-08",
    }));
    expect(marchPage).toMatchObject({ total: 1, entries: [{ threadId: "thr_dated", dayStart: march, summary: "March work" }] });
    const cliMarch = await harness.behavior.runCli(["list", "--from", "2026-03-08", "--to", "2026-03-08", "--json"]);
    expect(JSON.parse(cliMarch.stdout!)).toMatchObject({ total: 1, entries: [{ dayStart: march }] });
    const lifecycle = readContract["read.list"].output.parse(await harness.behavior.callRpc("read.list", {
      lifecycle: true, from: "2026-09-22", to: "2026-09-22",
    }));
    expect(lifecycle.total).toBe(1);
    expect(readContract["read.list"].output.parse(await harness.behavior.callRpc("read.list", {
      lifecycle: true, from: "2026-03-08", to: "2026-03-08",
    })).total).toBe(0);

    const first = readContract["read.show"].output.parse(await harness.behavior.callRpc("read.show", {
      threadId: "thr_dated", limit: 1,
    }));
    expect(first).toMatchObject({ thread: { summary: "Build the thing", threadId: "thr_dated" },
      total: 2, hasMore: true, days: [{ summary: "September work", outcome: "September shipped", tags: ["release"] }] });
    const second = readContract["read.show"].output.parse(await harness.behavior.callRpc("read.show", {
      threadId: "thr_dated", limit: 1, offset: 1,
    }));
    expect(second).toMatchObject({ hasMore: false, days: [{ summary: "March work", outcome: "March shipped" }] });
    expect(JSON.parse((await harness.behavior.runCli(["show", "thr_dated", "--json"])).stdout!))
      .toMatchObject({ total: 2, days: [{ summary: "September work" }, { summary: "March work" }] });
    await expect(harness.behavior.callRpc("read.show", { threadId: "thr_hidden" })).rejects.toThrow("not found");
    expect((await harness.behavior.runCli(["list", "--from", "2026-02-30"])).exitCode).toBe(1);
    expect(openRouter).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("keeps legacy work-day rows intact during idle indexing and explicit backfill", async () => {
    const { harness, db } = await loadJournal([thread("thr_a")], true);
    const day = localDayStart(start);
    db.prepare(`INSERT INTO journal_work_days
      (thread_id, day_start, first_activity_at, last_activity_at, message_count, source_seq_end,
       summary, outcome, category, ai_model, enriched_at)
      VALUES ('thr_a', ?, ?, ?, 2, 2, 'Earlier work', 'Earlier outcome', 'feature', 'old-model', ?)`)
      .run(day, start, start, start);
    const original = db.prepare("SELECT * FROM journal_work_days WHERE thread_id='thr_a'").get();
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread("thr_a") } as never);
    expect(db.prepare("SELECT * FROM journal_work_days WHERE thread_id='thr_a'").get()).toEqual(original);
    const provisional = JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout!);
    expect(provisional).toMatchObject({ total: 1, entries: [expect.objectContaining({ threadId: "thr_a" })] });
    vi.setSystemTime(start + 86_400_000);
    expect((await harness.behavior.runCli(["backfill", "--limit", "1"])).exitCode).toBe(0);
    expect(db.prepare("SELECT * FROM journal_work_days WHERE thread_id='thr_a'").get()).toEqual(original);
    const completed = JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout!);
    expect(completed).toMatchObject({ total: 1, entries: [expect.objectContaining({ outcome: "Shipped" })] });
    expect(db.prepare("SELECT work_timezone AS timeZone FROM journal_backfill_threads WHERE thread_id='thr_a'").get())
      .toEqual({ timeZone: "America/New_York" });
    await harness.lifecycle.dispose();
  });

  it("includes older cursor pages in the read-only backfill estimate", async () => {
    const { harness } = await loadJournal([thread("thr_paged")], true);
    harness.inspection.sdk.stub("threads.timeline", async ({ beforeAnchorId }: { beforeAnchorId?: string }) => ({
      rows: [{ kind: "conversation", role: "user", initiator: "user", text: "Build the calendar",
        sourceSeqEnd: beforeAnchorId ? 1 : 2, createdAt: beforeAnchorId ? start - 86_400_000 : start }],
      timelinePage: { historySnapshot: "fixture", olderCursor: beforeAnchorId ? null : { anchorId: "older", anchorSeq: 1 },
        olderRowsSourceSeqEnd: null, returnedSegmentCount: 1 },
    }));
    try {
      const estimate = await harness.behavior.runCli(["backfill", "--dry-run", "--json"]);
      expect(estimate.exitCode).toBe(0);
      expect(JSON.parse(estimate.stdout!)).toMatchObject({ threadDays: 2, workDays: 2 });
      expect(openRouter).toEqual([]);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("finalizes more than 25 closed days under the dollar budget across reloads", async () => {
    const threads = Array.from({ length: 30 }, (_, index) => thread(`thr_${index}`));
    const { harness, db } = await loadJournal(threads);
    const day = localDayStart(start);
    for (const target of threads) {
      await harness.behavior.emitThreadEvent("thread.created", { thread: target } as never);
      db.prepare(`INSERT INTO journal_work_days_v2
        (thread_id, day_start, first_activity_at, last_activity_at, message_count, source_seq_end,
         summary, category, day_timezone)
        VALUES (?, ?, ?, ?, 2, 2, 'Build the thing', 'feature', 'America/New_York')`)
        .run(target.id, day, start, start);
    }
    vi.setSystemTime(start + 86_400_000);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS + 7 * 30_000);
    expect(openRouter.filter((call) => call.kind === "journal_entry")).toHaveLength(30);
    expect(db.prepare("SELECT count(*) AS count FROM journal_work_days_v2 WHERE enriched_at IS NULL").get())
      .toMatchObject({ count: 0 });
    const { harness: restarted } = await harness.lifecycle.reload(plugin);
    const budget = JSON.parse((await restarted.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(budget.automaticAiBudget).toMatchObject({ attempts: 30, limitUsd: 0.50, hardLimit: 500, reservedUsd: 0 });
    expect(budget.automaticAiBudget.spentUsd).toBeCloseTo(0.003, 6);
    restarted.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS + 30_000);
    expect(openRouter.filter((call) => call.kind === "journal_entry")).toHaveLength(30);
    await restarted.lifecycle.dispose();
  });

  it("stops automatic finalization at the spend limit but permits explicit activity-sync", async () => {
    const { harness, db } = await loadJournal([thread("thr_a"), thread("thr_b")]);
    for (const id of ["thr_a", "thr_b"]) {
      await harness.behavior.emitThreadEvent("thread.created", { thread: thread(id) } as never);
      await harness.behavior.emitThreadEvent("thread.idle", { thread: thread(id) } as never);
    }
    responseCost = 0.50;
    vi.setSystemTime(start + 86_400_000);
    harness.behavior.runService("enrichment-queue");
    await vi.advanceTimersByTimeAsync(ENRICH_STARTUP_DELAY_MS + 30_000);
    expect(openRouter.filter((call) => call.kind === "journal_entry")).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS count FROM journal_work_days_v2 WHERE enriched_at IS NULL").get())
      .toMatchObject({ count: 1 });
    const automatic = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(automatic.automaticAiBudget).toMatchObject({ spentUsd: 0.50, reservedUsd: 0, attempts: 1, remainingUsd: 0 });
    expect((await harness.behavior.runCli(["activity-sync", "--thread", "thr_b", "--json"])).exitCode).toBe(0);
    expect(db.prepare("SELECT outcome FROM journal_work_days_v2 WHERE thread_id='thr_b'").get())
      .toMatchObject({ outcome: "Shipped" });
    const after = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(after.automaticAiBudget).toMatchObject({ spentUsd: 0.50, attempts: 1 });
    await harness.lifecycle.dispose();
  });

  it("stops at a failed daily call and resumes the same thread without double counting", async () => {
    const { harness } = await loadJournal([thread("thr_a")], true);
    vi.setSystemTime(start + 86_400_000);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => new Response("Rate limited", { status: 429 }));
    const failedRun = await harness.behavior.runCli(["backfill", "--limit", "1", "--json"]);
    expect(failedRun.exitCode).toBe(1);
    expect(JSON.parse(failedRun.stdout!)).toMatchObject({ processedThreads: 0, failedThreadId: "thr_a", remainingThreads: 1 });
    const resumed = await harness.behavior.runCli(["backfill", "--limit", "1", "--json"]);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout!)).toMatchObject({ processedThreads: 1, enrichedDays: 1, remainingThreads: 0 });
    expect(JSON.parse((await harness.behavior.runCli(["cost", "--json"])).stdout!)).toMatchObject({ calls: 1 });
    await harness.lifecycle.dispose();
  });

  it("stops on an exhausted OpenRouter key without marking a work day failed", async () => {
    const { harness } = await loadJournal([thread("thr_a"), thread("thr_b")], true);
    vi.setSystemTime(start + 86_400_000);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "Key limit exceeded (monthly limit)" } }), { status: 403 }));
    const blocked = await harness.behavior.runCli(["backfill", "--limit", "2", "--json"]);
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stdout!)).toMatchObject({
      processedThreads: 0, enrichedDays: 0, remainingThreads: 2, failedDays: 0,
      failedThreadId: "thr_a", aiAttempts: 1, blockedError: expect.stringContaining("monthly limit"),
    });
    expect(JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!))
      .toMatchObject({ failedDays: 0, failures: [], blockedError: expect.stringContaining("monthly limit") });
    const resumed = await harness.behavior.runCli(["backfill", "--limit", "2", "--json"]);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout!)).toMatchObject({
      processedThreads: 2, enrichedDays: 2, remainingThreads: 0, failedDays: 0, blockedError: null,
    });
    expect(openRouter.filter((call) => call.kind === "journal_entry")).toHaveLength(2);
    await harness.lifecycle.dispose();
  });

  it("persists a completed day before a later day hits the provider limit", async () => {
    const rows = [
      { kind: "conversation" as const, role: "user" as const, initiator: "user" as const,
        text: "First day work", sourceSeqEnd: 1, createdAt: start - 86_400_000 },
      { kind: "conversation" as const, role: "user" as const, initiator: "user" as const,
        text: "Second day work", sourceSeqEnd: 2, createdAt: start },
    ];
    const { harness } = await loadJournal([thread("thr_a")], true, rows);
    vi.setSystemTime(start + 86_400_000);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => openRouterResponse({
        summary: "Completed first day", category: "feature", outcome: "Shipped", status: "completed", tags: [],
      }))
      .mockImplementationOnce(async () => new Response("Rate limited", { status: 429 }));
    const blocked = await harness.behavior.runCli(["backfill", "--limit", "1", "--json"]);
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stdout!)).toMatchObject({
      processedThreads: 0, enrichedDays: 1, failedDays: 0, remainingThreads: 1, aiAttempts: 2,
    });
    const resumed = await harness.behavior.runCli(["backfill", "--limit", "1", "--json"]);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout!)).toMatchObject({
      processedThreads: 1, enrichedDays: 2, failedDays: 0, remainingThreads: 0, aiAttempts: 1,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await harness.lifecycle.dispose();
  });

  it("records an invalid daily response after three attempts and advances to the next thread", async () => {
    const { harness, db } = await loadJournal([thread("thr_a"), thread("thr_b")], true);
    vi.setSystemTime(start + 86_400_000);
    const malformed = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"summary\":" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }), { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementationOnce(malformed).mockImplementationOnce(malformed).mockImplementationOnce(malformed);
    const completed = await harness.behavior.runCli(["backfill", "--limit", "2", "--json"]);
    expect(completed.exitCode).toBe(0);
    expect(JSON.parse(completed.stdout!)).toMatchObject({
      processedThreads: 2, enrichedDays: 1, failedDays: 1, aiAttempts: 4, remainingThreads: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(db.prepare("SELECT thread_id FROM journal_backfill_threads WHERE thread_id='thr_a'").all()).toEqual([]);
    const status = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(status).toMatchObject({ failedDays: 1, failures: [expect.objectContaining({
      threadId: "thr_a", dayStart: localDayStart(start), attempts: 3, error: expect.stringContaining("JSON"),
    })] });
    const retry = await harness.behavior.runCli(["backfill", "--limit", "2", "--json"]);
    expect(retry.exitCode).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const restarted = await harness.behavior.runCli(["backfill", "--restart", "--limit", "2", "--json"]);
    expect(restarted.exitCode).toBe(0);
    expect(JSON.parse(restarted.stdout!)).toMatchObject({ failedDays: 0, processedThreads: 2 });
    expect(JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!))
      .toMatchObject({ failedDays: 0, failures: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    await harness.lifecycle.dispose();
  });

  it("caps explicit backfill calls and resumes a partly summarized thread", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      kind: "conversation" as const, role: "user" as const, initiator: "user" as const, text: `Work on day ${index}`,
      sourceSeqEnd: index + 1, createdAt: start - (100 - index) * 86_400_000,
    }));
    const { harness } = await loadJournal([thread("thr_a")], true, rows);
    vi.setSystemTime(start + 86_400_000);
    const paused = await harness.behavior.runCli(["backfill", "--limit", "1", "--json"]);
    expect(paused.exitCode).toBe(0);
    expect(JSON.parse(paused.stdout!)).toMatchObject({
      paused: true, aiAttempts: 100, processedThreads: 0, enrichedDays: 100, remainingThreads: 1,
    });
    expect(openRouter.filter((call) => call.kind === "journal_entry")).toHaveLength(100);
    const completed = await harness.behavior.runCli(["backfill", "--limit", "1", "--json"]);
    expect(completed.exitCode).toBe(0);
    expect(JSON.parse(completed.stdout!)).toMatchObject({
      paused: false, aiAttempts: 1, processedThreads: 1, enrichedDays: 101, remainingThreads: 0,
    });
    expect(openRouter.filter((call) => call.kind === "journal_entry")).toHaveLength(101);
    await harness.lifecycle.dispose();
  });

  it("does not generate period AI prose while today is provisional", async () => {
    const { harness } = await loadJournal([thread("thr_a")]);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread("thr_a") } as never);
    for (let index = 0; index < 2; index += 1) {
      const result = await harness.behavior.callRpc("journal_replay", { start: localDayStart(start),
        end: addWorkDays(localDayStart(start), 1), mode: "day" }) as { narrative: string | null; narrativeStale: boolean };
      expect(result).toMatchObject({ narrative: null, narrativeStale: true });
    }
    expect(openRouter).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("turns markdown assistant text into a plain preview", () => {
    expect(plainPreview("## Done\n\nPushed **the fix** in `1d70ca6`, see [PR #96](https://x.test/96).")).toBe("Done Pushed the fix in 1d70ca6, see PR #96");
  });


  it("returns a stale narrative at once and regenerates it once in the background", async () => {
    const { harness, db } = await loadJournal([]);
    const day = localDayStart(start) - 86_400_000;
    db.prepare(`INSERT INTO journal_threads (thread_id, project_id, project_name, title, summary, category, provider_id, created_at, updated_at)
      VALUES ('thr_a', 'proj', 'Project', 'Build', 'Built the thing', 'feature', 'codex', ?, ?)`).run(start, start);
    db.prepare(`INSERT INTO journal_work_days (thread_id, day_start, first_activity_at, last_activity_at, message_count, source_seq_end, summary, category)
      VALUES ('thr_a', ?, ?, ?, 2, 2, 'Built the thing', 'feature')`).run(day, day + 1_000, day + 1_000);
    const cacheKey = `replay:day:${day}:${day + 86_400_000}`;
    db.prepare("INSERT INTO journal_period_cache (cache_key, source_json, daily_narrative, weekly_narrative, ai_model, updated_at) VALUES (?, 'older facts', 'Old day', 'Old week', 'm', 0)").run(cacheKey);
    const input = { start: day, end: day + 86_400_000, mode: "day" };

    await expect(harness.behavior.callRpc("journal_replay", { ...input, narrative: false }))
      .resolves.toMatchObject({ narrative: null, narrativeStale: false, total: 1 });
    expect(openRouter).toEqual([]);
    const [first, second] = await Promise.all([harness.behavior.callRpc("journal_replay", input), harness.behavior.callRpc("journal_replay", input)]) as Array<{ narrative: string | null; narrativeStale: boolean }>;
    expect(first).toMatchObject({ narrative: "Old day", narrativeStale: true });
    expect(second).toMatchObject({ narrative: "Old day", narrativeStale: true });
    expect(openRouter.filter((call) => call.kind === "journal_standup")).toHaveLength(1);
    expect(changedSignals(harness)).toEqual([]);
    const reserved = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(reserved.automaticAiBudget.attempts).toBe(1);
    expect(reserved.automaticAiBudget.reservedUsd).toBeGreaterThan(0);

    heldStandups[0]!.resolve(openRouterResponse({ daily: "New day", weekly: "New week" }));
    await vi.waitFor(() => expect(changedSignals(harness)).toHaveLength(1));
    const settled = JSON.parse((await harness.behavior.runCli(["backfill", "--status", "--json"])).stdout!);
    expect(settled.automaticAiBudget).toMatchObject({ spentUsd: 0.0001, reservedUsd: 0, attempts: 1 });
    await expect(harness.behavior.callRpc("journal_replay", input)).resolves.toMatchObject({ narrative: "New day", narrativeStale: false });
    expect(openRouter.filter((call) => call.kind === "journal_standup")).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});
