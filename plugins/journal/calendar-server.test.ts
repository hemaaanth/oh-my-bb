// Turn index and calendar tests. The first group is ported from Agent Calendar
// (server.test.ts) by charpeni/bb-plugins agent-calendar, MIT License.
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { calendarCalls, calendarSchema, calendarWireSchema, packCalendar } from "./server";
import { unpackCalendar } from "./shared";
import { parseCalendarCliArgs } from "./calendar-cli";
import { localDayStart } from "./shared";

// vitest.config.ts pins TZ to America/Toronto; Journal's default work zone is America/New_York.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const WEEK = { from: at(5, 0), to: at(12, 0), mergeGapMinutes: 30 };
const ZONE = "America/New_York";

type FakeThread = ReturnType<typeof makeThreadResponse>;
type FakeEvent = {
  id: string; seq: number; threadId: string; createdAt: number;
  type: "turn/started" | "turn/completed"; scope: { kind: "turn"; turnId: string }; data: Record<string, unknown>;
};

function thread(overrides: Partial<FakeThread> & { id: string }): FakeThread {
  return makeThreadResponse({
    projectId: "proj_web", title: `Thread ${overrides.id}`, status: "idle", archivedAt: null, parentThreadId: null,
    sourceThreadId: null, originPluginId: null, createdAt: at(1, 9), updatedAt: at(5, 18), visibility: "visible",
    ...overrides,
  } as never);
}

function turnEvents(threadId: string, turns: Array<[number, number | null]>, firstSeq = 1) {
  let seq = firstSeq;
  return turns.flatMap(([start, end], index) => {
    const turnId = `${threadId}-t${firstSeq + index}`;
    const events: FakeEvent[] = [{ id: `ev_${seq}`, seq: seq++, threadId, createdAt: start, type: "turn/started", scope: { kind: "turn", turnId }, data: {} }];
    if (end !== null) {
      events.push({ id: `ev_${seq}`, seq: seq++, threadId, createdAt: end, type: "turn/completed", scope: { kind: "turn", turnId }, data: { status: "completed" } });
    }
    return events;
  });
}

type TimelineRow = { kind: "conversation"; role: "user" | "assistant"; initiator?: "user"; text: string; sourceSeqEnd: number; createdAt: number };

type CallRpcArgs = { pluginId: string; method: string; input: unknown; signal?: AbortSignal; outputSchema: { parse(value: unknown): unknown } };

function createWorld(options: { callRpc?: (args: CallRpcArgs) => Promise<unknown>; settings?: Record<string, boolean> } = {}) {
  const threads: FakeThread[] = [];
  const events = new Map<string, FakeEvent[]>();
  const timelines = new Map<string, TimelineRow[]>();
  const timelineReads: string[] = [];
  const rpcCalls: CallRpcArgs[] = [];
  const host = createFakePluginHost({
    pluginId: "journal",
    settings: options.settings,
    sdk: {
      plugins: {
        // Like bb: the answer is checked against the caller's outputSchema.
        callRpc: async (args: CallRpcArgs) => {
          rpcCalls.push(args);
          if (!options.callRpc) throw new Error("Plugin dispatch is not installed");
          return args.outputSchema.parse(await options.callRpc(args));
        },
      },
      threads: {
        // Like bb: hidden threads only come back with includeHidden.
        list: async (args?: { archived?: boolean; offset?: number; includeHidden?: boolean }) =>
          (args?.offset ?? 0) > 0 ? [] : threads.filter((item) => (item.archivedAt !== null) === (args?.archived ?? false)
            && (args?.includeHidden || item.visibility !== "hidden")),
        get: async ({ threadId }: { threadId: string }) => threads.find((item) => item.id === threadId),
        timeline: async ({ threadId }: { threadId: string }) => {
          timelineReads.push(threadId);
          return { rows: timelines.get(threadId) ?? [], timelinePage: { historySnapshot: "fixture", olderCursor: null, olderRowsSourceSeqEnd: null, returnedSegmentCount: 1 } };
        },
        events: {
          list: async (args: { threadId: string; afterSeq?: string; limit?: string }) =>
            (events.get(args.threadId) ?? []).filter((event) => event.seq > Number(args.afterSeq ?? 0)).slice(0, Number(args.limit ?? 100)),
        },
      },
      projects: { list: async () => [{ id: "proj_web", name: "web" }, { id: "proj_api", name: "api" }] },
    } as never,
  });
  return { host, threads, events, timelines, timelineReads, rpcCalls };
}

async function loadWorld() {
  const world = createWorld();
  await plugin(world.host.bb);
  return world;
}

afterEach(() => { vi.useRealTimers(); });

describe("Journal turn index", () => {
  it("indexes turn history and returns merged blocks over RPC", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_a", title: "Fix the flaky test" }), thread({ id: "thr_b", projectId: "proj_api", archivedAt: at(6, 9) }));
    world.events.set("thr_a", turnEvents("thr_a", [[at(5, 9, 5), at(5, 9, 20)], [at(5, 9, 40), at(5, 9, 55)], [at(5, 14, 0), at(5, 14, 20)]]));
    world.events.set("thr_b", turnEvents("thr_b", [[at(6, 8, 0), at(6, 8, 50)]]));
    await plugin(world.host.bb);

    const activity = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", WEEK))));

    expect(activity.blocks.map((block) => [block.threadId, block.start, block.end])).toEqual([
      ["thr_a", at(5, 9), at(5, 10)], ["thr_a", at(5, 14), at(5, 14, 30)], ["thr_b", at(6, 8), at(6, 9)],
    ]);
    expect(activity.threads).toContainEqual(expect.objectContaining({ id: "thr_b", projectId: "proj_api", archived: true }));
    expect(activity.threads.find((item) => item.id === "thr_a")?.title).toBe("Fix the flaky test");
  });

  it("keeps project colors the same whatever range is shown", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_web", projectId: "proj_web" }), thread({ id: "thr_api", projectId: "proj_api" }));
    const recent = Date.now() - 2 * 86_400_000;
    world.events.set("thr_web", turnEvents("thr_web", [[recent, recent + 3_600_000]]));
    world.events.set("thr_api", turnEvents("thr_api", [[recent - 86_400_000, recent - 85_000_000]]));
    await plugin(world.host.bb);

    const oneDay = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", {
      from: recent - 3_600_000, to: recent + 2 * 3_600_000, mergeGapMinutes: 30,
    }))));

    expect(oneDay.threads.map((item) => item.id)).toEqual(["thr_web"]);
    // Both projects keep their slots, in bb's project order.
    expect(oneDay.colorOrder).toEqual(["proj_web", "proj_api"]);
  });

  it("pages through long turn histories", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_long" }));
    const turns = Array.from({ length: 80 }, (_, index): [number, number] => [at(5, 0) + index * 10 * 60_000, at(5, 0) + index * 10 * 60_000 + 60_000]);
    world.events.set("thr_long", turnEvents("thr_long", turns));
    await plugin(world.host.bb);

    const activity = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", WEEK))));

    expect(activity.blocks).toHaveLength(1);
    expect(activity.blocks[0]!.turnCount).toBe(80);
    expect(world.host.harness.sdk.callsTo("threads.events.list").length).toBeGreaterThan(1);
  });

  it("only re-reads threads that changed since the last sync", async () => {
    const world = await loadWorld();
    world.threads.push(thread({ id: "thr_a" }), thread({ id: "thr_b" }));
    world.events.set("thr_a", turnEvents("thr_a", [[at(5, 9), at(5, 10)]]));
    world.events.set("thr_b", turnEvents("thr_b", [[at(5, 11), at(5, 12)]]));
    await world.host.harness.callRpc("journal_calendar", WEEK);
    const firstReads = world.host.harness.sdk.callsTo("threads.events.list").length;

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    world.events.get("thr_b")!.push(...turnEvents("thr_b", [[at(5, 15), at(5, 16)]], 3));
    world.threads[1] = { ...world.threads[1]!, updatedAt: at(5, 16) };
    const calendar = async () => calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", WEEK))));
    // A stale index answers at once; the sync it starts fills the next answer.
    expect((await calendar()).blocks.filter((block) => block.threadId === "thr_b")).toHaveLength(1);
    await vi.waitFor(async () => expect((await calendar()).blocks.filter((block) => block.threadId === "thr_b")).toHaveLength(2));

    const reads = world.host.harness.sdk.callsTo("threads.events.list").slice(firstReads);
    expect(reads.map(([args]) => (args as { threadId: string }).threadId)).toEqual(["thr_b"]);
    expect((reads[0]![0] as { afterSeq: string }).afterSeq).toBe("2");
  });

  it("shows running turns as ongoing and caps abandoned ones", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_running", status: "active" }), thread({ id: "thr_crashed", status: "idle", updatedAt: at(5, 10, 40) }));
    world.events.set("thr_running", turnEvents("thr_running", [[Date.now() - 20 * 60_000, null]]));
    world.events.set("thr_crashed", turnEvents("thr_crashed", [[at(5, 10), null]]));
    await plugin(world.host.bb);

    const activity = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", {
      from: Math.max(Math.min(at(5, 0), Date.now() - 86_400_000), Date.now() - 61 * 86_400_000),
      to: Math.max(at(12, 0), Date.now() + 3_600_000), mergeGapMinutes: 30,
    }))));

    const running = activity.blocks.find((block) => block.threadId === "thr_running");
    const crashed = activity.blocks.find((block) => block.threadId === "thr_crashed");
    expect(running?.ongoing).toBe(true);
    expect(running!.end).toBeGreaterThanOrEqual(Date.now());
    expect(crashed).toMatchObject({ start: at(5, 10), end: at(5, 10, 45), ongoing: false });
  });

  it("follows lifecycle events between full syncs", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_a" }));
    await plugin(world.host.bb);
    await world.host.harness.callRpc("journal_calendar", WEEK);

    vi.useFakeTimers();
    world.events.set("thr_a", turnEvents("thr_a", [[at(5, 13), at(5, 13, 40)]]));
    await world.host.harness.emitThreadEvent("thread.idle", {
      thread: thread({ id: "thr_a", updatedAt: at(5, 13, 40) }), lastAssistantText: null,
    } as never);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    const activity = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", WEEK))));
    expect(activity.blocks).toEqual([expect.objectContaining({ threadId: "thr_a", start: at(5, 13) })]);
    expect(world.host.harness.realtimeSignals.map((signal) => signal.channel)).toContain("journal-calendar");
    await world.host.harness.lifecycle.dispose();
  });

  it("drops deleted threads from the calendar", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_a" }));
    world.events.set("thr_a", turnEvents("thr_a", [[at(5, 9), at(5, 10)]]));
    await plugin(world.host.bb);
    await world.host.harness.callRpc("journal_calendar", WEEK);

    await world.host.harness.emitThreadEvent("thread.deleted", { thread: thread({ id: "thr_a" }) } as never);

    const activity = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", WEEK))));
    expect(activity.blocks).toEqual([]);
    await world.host.harness.lifecycle.dispose();
  });

  it("rejects ranges longer than 62 days and unknown merge gaps", async () => {
    const { host } = await loadWorld();
    await expect(host.harness.callRpc("journal_calendar", { from: 0, to: 63 * 86_400_000, mergeGapMinutes: 30 })).rejects.toThrow();
    await expect(host.harness.callRpc("journal_calendar", { ...WEEK, mergeGapMinutes: 45 })).rejects.toThrow();
  });

  it("prints a time sheet and a log from the CLI", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_a", title: "Fix the flaky test" }));
    world.events.set("thr_a", turnEvents("thr_a", [[at(6, 9, 10), at(6, 10, 20)]]));
    await plugin(world.host.bb);

    const sheet = await world.host.harness.runCli(["timesheet", "--week", "2026-10-07"]);
    expect(sheet.exitCode).toBe(0);
    expect(sheet.stdout).toContain("Fix the flaky test (thr_a)");
    expect(sheet.stdout).toMatch(/Total(\s+[\d.]+){7}\s+1\.5\n/);

    const log = await world.host.harness.runCli(["log", "--day", "2026-10-06", "--json"]);
    const parsed = JSON.parse(log.stdout!) as { projects: Array<{ id: string; name: string }>; blocks: Array<{ start: number; end: number }>; truncatedBlocks: number };
    expect(parsed.projects).toEqual([{ id: "proj_web", name: "web" }]);
    expect(parsed.blocks).toEqual([expect.objectContaining({ start: at(6, 9), end: at(6, 10, 30) })]);
    expect(parsed.truncatedBlocks).toBe(0);

    const text = await world.host.harness.runCli(["log", "--day", "2026-10-06"]);
    expect(text.stdout).toContain("09:00–10:30");

    const usage = await world.host.harness.runCli(["log", "--gap", "45"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("Invalid --gap value: 45");
  });
});

describe("Journal calendar rollup and work days", () => {
  it("rolls visible children and side chats into their root and skips hidden threads", async () => {
    const world = createWorld();
    world.threads.push(
      thread({ id: "thr_root", title: "Ship the calendar" }),
      thread({ id: "thr_child", parentThreadId: "thr_root", title: "Review agent" }),
      thread({ id: "thr_side", originPluginId: "side-chat", sourceThreadId: "thr_root", title: "Quick question" }),
      thread({ id: "thr_grandchild", parentThreadId: "thr_child", title: "Nested helper" }),
      thread({ id: "thr_hidden", parentThreadId: "thr_root", visibility: "hidden" }),
    );
    world.events.set("thr_root", turnEvents("thr_root", [[at(5, 9), at(5, 9, 20)]]));
    world.events.set("thr_child", turnEvents("thr_child", [[at(5, 9, 30), at(5, 9, 50)]]));
    world.events.set("thr_side", turnEvents("thr_side", [[at(5, 14), at(5, 14, 10)]]));
    world.events.set("thr_grandchild", turnEvents("thr_grandchild", [[at(5, 9, 40), at(5, 10)]]));
    world.events.set("thr_hidden", turnEvents("thr_hidden", [[at(5, 16), at(5, 17)]]));
    await plugin(world.host.bb);

    const activity = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", WEEK))));

    expect(activity.blocks.map((block) => [block.threadId, block.start, block.end, block.childThreadIds])).toEqual([
      ["thr_root", at(5, 9), at(5, 10), ["thr_child", "thr_grandchild"]],
      ["thr_root", at(5, 14), at(5, 14, 15), ["thr_side"]],
    ]);
    expect(activity.blocks[0]).toMatchObject({ turnCount: 3, activeMs: 50 * 60_000 });
    expect(activity.threads.find((item) => item.id === "thr_grandchild")).toMatchObject({ parentThreadId: "thr_child", rootThreadId: "thr_root" });
    expect(activity.threads.find((item) => item.id === "thr_side")).toMatchObject({ parentThreadId: "thr_root", rootThreadId: "thr_root" });
    expect(activity.threads.map((item) => item.id)).not.toContain("thr_hidden");

    const sheet = JSON.parse((await world.host.harness.runCli(["timesheet", "--week", "2026-10-05", "--json"])).stdout!) as { rows: Array<{ threadId: string }> };
    expect(sheet.rows.map((row) => row.threadId)).toEqual(["thr_root"]);
  });

  it("joins each block to its root's work day in the work time zone", async () => {
    const world = createWorld();
    world.threads.push(thread({ id: "thr_root", title: "Ship the calendar" }), thread({ id: "thr_child", parentThreadId: "thr_root", title: "Review agent" }));
    // 23:30 Toronto on Oct 5 is still Oct 5 in New York; the next block is Oct 6.
    world.events.set("thr_root", turnEvents("thr_root", [[at(5, 10), at(5, 11)], [at(5, 23, 0), at(5, 23, 20)], [at(6, 11), at(6, 11, 30)]]));
    world.events.set("thr_child", turnEvents("thr_child", [[at(5, 10, 10), at(5, 10, 40)]]));
    await plugin(world.host.bb);
    const db = world.host.bb.storage.database();
    const insert = db.prepare(`INSERT INTO journal_work_days_v2 (thread_id, day_start, first_activity_at, last_activity_at,
      message_count, source_seq_end, summary, outcome, category, work_status, ai_model, enriched_at, day_timezone)
      VALUES (?, ?, ?, ?, 4, 10, ?, ?, ?, ?, 'model', ?, ?)`);
    const oct5 = localDayStart(at(5, 12), ZONE);
    insert.run("thr_root", oct5, at(5, 10), at(5, 23, 20), "Built the turn index", "Index shipped", "feature", "completed", at(6, 2), ZONE);
    insert.run("thr_child", oct5, at(5, 10, 10), at(5, 10, 40), "Reviewed the index", "Two fixes", "review", "completed", at(6, 2), ZONE);

    const activity = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", WEEK))));

    const [morning, late, nextDay] = activity.blocks;
    expect(morning!.work).toMatchObject({ dayStart: oct5, summary: "Built the turn index", outcome: "Index shipped",
      category: "feature", workStatus: "completed", provisional: false });
    expect(morning!.work!.children).toEqual([expect.objectContaining({ threadId: "thr_child", outcome: "Two fixes" })]);
    expect(late!.work).toMatchObject({ dayStart: oct5, summary: "Built the turn index" });
    // No indexed day: provisional, with the thread's category as the fallback.
    expect(nextDay!.work).toMatchObject({ dayStart: localDayStart(at(6, 12), ZONE), summary: "", provisional: true });
    expect(nextDay!.work!.category).toBe(activity.threads.find((item) => item.id === "thr_root")!.category);

    db.prepare("UPDATE journal_work_days_v2 SET enriched_at=NULL WHERE thread_id='thr_root'").run();
    const unenriched = calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", WEEK))));
    expect(unenriched.blocks[0]!.work).toMatchObject({ summary: "Built the turn index", provisional: true });

    const log = await world.host.harness.runCli(["log", "--day", "2026-10-05"]);
    expect(log.stdout).toContain("+1 child");
    expect(log.stdout.match(/Built the turn index — Index shipped/g)).toHaveLength(1);

    // A provisional summary that only repeats the title is not printed.
    db.prepare("UPDATE journal_work_days_v2 SET summary='Ship the calendar', outcome=NULL WHERE thread_id='thr_root'").run();
    db.prepare("UPDATE journal_work_days_v2 SET outcome=NULL WHERE thread_id='thr_child'").run();
    const titled = await world.host.harness.runCli(["log", "--day", "2026-10-05"]);
    expect(titled.stdout.match(/Ship the calendar/g)).toHaveLength(2);
  });
});

describe("parseCalendarCliArgs", () => {
  const now = at(7, 15);

  it("defaults to this week's time sheet and today's log", () => {
    expect(parseCalendarCliArgs(["timesheet"], now)).toMatchObject({ kind: "run", command: "timesheet", range: { from: at(5, 0), to: at(12, 0) }, gap: 30 });
    expect(parseCalendarCliArgs(["log"], now)).toMatchObject({ command: "log", range: { from: at(7, 0), to: at(8, 0) } });
  });

  it("resolves relative and explicit dates", () => {
    expect(parseCalendarCliArgs(["timesheet", "--week", "last"], now)).toMatchObject({ range: { from: new Date(2026, 8, 28).getTime() } });
    expect(parseCalendarCliArgs(["log", "--day=yesterday", "--gap", "60"], now)).toMatchObject({ range: { from: at(6, 0) }, gap: 60 });
  });

  it("rejects invalid input", () => {
    expect(parseCalendarCliArgs(["timesheet", "--week", "2026-02-30"], now)).toMatchObject({ kind: "error" });
    expect(parseCalendarCliArgs(["timesheet", "--day", "today"], now)).toMatchObject({ kind: "error" });
    expect(parseCalendarCliArgs(["log", "--day", "today", "--week", "this"], now)).toMatchObject({ kind: "error" });
    expect(parseCalendarCliArgs(["export"], now)).toMatchObject({ kind: "error" });
  });
});

describe("Agent time on work days", () => {
  const conversation = (times: number[]): TimelineRow[] => times.map((createdAt, index) => ({
    kind: "conversation", ...(index % 2 ? { role: "assistant" as const } : { role: "user" as const, initiator: "user" as const }),
    text: `Message ${index + 1}`, sourceSeqEnd: index + 1, createdAt }));
  const stats = (world: Awaited<ReturnType<typeof loadWorld>>, threadId: string) => world.host.bb.storage.database().prepare(`SELECT
    active_ms AS activeMs, turn_count AS turnCount, block_count AS blockCount, first_activity_at AS firstActivityAt,
    last_activity_at AS lastActivityAt, message_count AS messageCount FROM journal_work_days_v2 WHERE thread_id=? ORDER BY day_start`).all(threadId);

  it("takes agent time and activity bounds from turns, and skips idle captures with no new turns", async () => {
    vi.useFakeTimers({ now: at(5, 16), toFake: ["Date"] });
    const world = createWorld();
    const target = thread({ id: "thr_a", title: "Fix the flaky test", createdAt: at(5, 9) });
    world.threads.push(target);
    // Two turns 20 minutes apart merge into one block; the afternoon turn is a second block.
    world.events.set("thr_a", turnEvents("thr_a", [[at(5, 9, 5), at(5, 9, 20)], [at(5, 9, 40), at(5, 9, 55)], [at(5, 14, 0), at(5, 14, 20)]]));
    world.timelines.set("thr_a", conversation([at(5, 9, 6), at(5, 14, 10)]));
    await plugin(world.host.bb);

    await world.host.harness.emitThreadEvent("thread.idle", { thread: target } as never);
    expect(stats(world, "thr_a")).toEqual([{ activeMs: 50 * 60_000, turnCount: 3, blockCount: 2,
      firstActivityAt: at(5, 9, 5), lastActivityAt: at(5, 14, 20), messageCount: 2 }]);
    expect(world.timelineReads).toHaveLength(1);

    // Nothing started or ended since the last capture: no timeline read.
    await world.host.harness.emitThreadEvent("thread.idle", { thread: target } as never);
    expect(world.timelineReads).toHaveLength(1);

    // A new turn makes the next idle capture again.
    world.events.get("thr_a")!.push(...turnEvents("thr_a", [[at(5, 15, 0), at(5, 15, 10)]], 7));
    world.timelines.set("thr_a", conversation([at(5, 9, 6), at(5, 14, 10), at(5, 15, 5)]));
    await world.host.harness.emitThreadEvent("thread.idle", { thread: target } as never);
    expect(world.timelineReads).toHaveLength(2);
    expect(stats(world, "thr_a")).toEqual([expect.objectContaining({ activeMs: 60 * 60_000, turnCount: 4, blockCount: 3,
      lastActivityAt: at(5, 15, 10), messageCount: 3 })]);

    const list = JSON.parse((await world.host.harness.runCli(["list", "--json"])).stdout!);
    expect(list.entries[0]).toMatchObject({ threadId: "thr_a", activeMs: 60 * 60_000, turnCount: 4, blockCount: 3 });
    expect((await world.host.harness.runCli(["list"])).stdout).toContain("· 1h agent");
    const show = await world.host.harness.runCli(["show", "thr_a"]);
    expect(show.stdout).toContain("2026-10-05 · 1h agent, 3 blocks:");
    expect(JSON.parse((await world.host.harness.runCli(["show", "thr_a", "--json"])).stdout!).days[0])
      .toMatchObject({ activeMs: 60 * 60_000, turnCount: 4, blockCount: 3 });

    const catchUp = await world.host.harness.callRpc("journal_catch_up", null) as { entries: Array<Record<string, unknown>> };
    expect(catchUp.entries).toEqual([expect.objectContaining({ threadId: "thr_a", lastWorkedAt: at(5, 15, 10),
      agentMs: 60 * 60_000, worked: "worked 1h today" })]);
  });

  it("keeps message times on threads without turns", async () => {
    vi.useFakeTimers({ now: at(5, 16), toFake: ["Date"] });
    const world = createWorld();
    const target = thread({ id: "thr_quiet", createdAt: at(5, 9) });
    world.threads.push(target);
    world.timelines.set("thr_quiet", conversation([at(5, 10), at(5, 11)]));
    await plugin(world.host.bb);
    await world.host.harness.emitThreadEvent("thread.idle", { thread: target } as never);
    expect(stats(world, "thr_quiet")).toEqual([{ activeMs: null, turnCount: null, blockCount: null,
      firstActivityAt: at(5, 10), lastActivityAt: at(5, 11), messageCount: 2 }]);
    // Without a turn mark the idle capture never skips.
    await world.host.harness.emitThreadEvent("thread.idle", { thread: target } as never);
    expect(world.timelineReads).toHaveLength(2);
  });

  it("counts dry-run work days from the turn index and reads timelines only for threads without turns", async () => {
    vi.useFakeTimers({ now: at(7, 12), toFake: ["Date"] });
    const world = createWorld();
    // A turn across midnight touches two work days.
    world.threads.push(thread({ id: "thr_turns" }), thread({ id: "thr_plain" }));
    world.events.set("thr_turns", turnEvents("thr_turns", [[at(5, 23, 30), at(6, 0, 30)]]));
    world.timelines.set("thr_plain", conversation([at(5, 10)]));
    await plugin(world.host.bb);
    const result = JSON.parse((await world.host.harness.runCli(["backfill", "--dry-run", "--json"])).stdout!);
    expect(result).toMatchObject({ dryRun: true, threads: 2, threadDays: 3, daysToEnrich: 3, timelineReads: 1,
      estimateBasis: "turn-index-upper-bound" });
    expect(world.timelineReads).toEqual(["thr_plain"]);
    const text = (await world.host.harness.runCli(["backfill", "--dry-run"])).stdout!;
    expect(text).toContain("Estimated at most");
    expect(text).toContain("exact counts need full transcripts");
  });
});

describe("Journal Dispatch calls", () => {
  const DISPATCH = {
    memory: true,
    calls: [
      { id: "call_2", startedAt: new Date(at(6, 9)).toISOString(), endedAt: null, channel: "phone", device: "Pixel",
        title: null, summary: null, threadIds: [] },
      { id: "call_1", startedAt: new Date(at(5, 9)).toISOString(), endedAt: new Date(at(5, 9, 12)).toISOString(), channel: "app",
        device: "Laptop", title: "Plan the release", summary: "Talked through the release.", threadIds: ["thr_a"] },
    ],
  };
  const calendar = async (world: ReturnType<typeof createWorld>, range = WEEK) =>
    calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(await world.host.harness.callRpc("journal_calendar", range))));
  const warnings = (world: ReturnType<typeof createWorld>) =>
    world.host.harness.logEntries.filter((entry) => entry.level === "warn" && entry.message.includes("Dispatch"));

  it("never asks Dispatch while the setting is off", async () => {
    const world = createWorld({ callRpc: async () => DISPATCH });
    await plugin(world.host.bb);
    expect((await calendar(world)).calls).toBeUndefined();
    expect(world.rpcCalls).toEqual([]);
  });

  it("merges Dispatch calls into the calendar while the setting is on", async () => {
    const world = createWorld({ callRpc: async () => DISPATCH, settings: { showDispatchCalls: true } });
    await plugin(world.host.bb);
    // Startup alone does not ask Dispatch.
    expect(world.rpcCalls).toEqual([]);
    const activity = await calendar(world);
    expect(world.rpcCalls).toEqual([expect.objectContaining({ pluginId: "dispatch", method: "read.calls",
      input: { since: new Date(WEEK.from).toISOString(), until: new Date(WEEK.to).toISOString() } })]);
    expect(activity.calls).toEqual([
      { id: "call_1", start: at(5, 9), end: at(5, 9, 12), channel: "app", device: "Laptop", remembered: true,
        title: "Plan the release", summary: "Talked through the release.", threadIds: ["thr_a"] },
      { id: "call_2", start: at(6, 9), end: null, channel: "phone", device: "Pixel", remembered: false,
        title: null, summary: null, threadIds: [] },
    ]);
  });

  it("drops call details when Dispatch call memory is off", async () => {
    const world = createWorld({ callRpc: async () => ({ ...DISPATCH, memory: false }), settings: { showDispatchCalls: true } });
    await plugin(world.host.bb);
    expect((await calendar(world)).calls?.find((call) => call.id === "call_1"))
      .toMatchObject({ remembered: false, title: null, summary: null, threadIds: [], device: "Laptop" });
  });

  it("shows no calls when Dispatch is missing, fails, or answers in the wrong shape, and warns once a minute", async () => {
    vi.useFakeTimers({ now: at(7, 12), toFake: ["Date"] });
    let answer: () => Promise<unknown> = async () => { throw new Error("Plugin dispatch is not installed"); };
    const world = createWorld({ callRpc: () => answer(), settings: { showDispatchCalls: true } });
    await plugin(world.host.bb);
    expect((await calendar(world)).calls).toEqual([]);
    answer = async () => ({ memory: true, calls: [{ id: 1 }] });
    expect((await calendar(world, { ...WEEK, from: at(4, 0) })).calls).toEqual([]);
    expect(world.rpcCalls).toHaveLength(2);
    expect(warnings(world)).toHaveLength(1);
    vi.setSystemTime(at(7, 12, 2));
    expect((await calendar(world, { ...WEEK, from: at(3, 0) })).calls).toEqual([]);
    expect(warnings(world)).toHaveLength(2);
  });

  it("stops waiting for Dispatch after 1.5 seconds", async () => {
    let signal: AbortSignal | undefined;
    const world = createWorld({ callRpc: (args) => { signal = args.signal; return new Promise(() => {}); }, settings: { showDispatchCalls: true } });
    await plugin(world.host.bb);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = calendar(world);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).calls).toEqual([]);
    expect(signal?.aborted).toBe(true);
    expect(warnings(world)[0]?.message).toContain("1500 ms");
  });

  it("reuses Dispatch calls for the same window for 30 seconds", async () => {
    vi.useFakeTimers({ now: at(7, 12), toFake: ["Date"] });
    const world = createWorld({ callRpc: async () => DISPATCH, settings: { showDispatchCalls: true } });
    await plugin(world.host.bb);
    await calendar(world);
    vi.setSystemTime(at(7, 12) + 29_000);
    expect((await calendar(world)).calls).toHaveLength(2);
    expect(world.rpcCalls).toHaveLength(1);
    // Another window is its own read.
    await calendar(world, { ...WEEK, from: at(6, 0) });
    expect(world.rpcCalls).toHaveLength(2);
    vi.setSystemTime(at(7, 12) + 30_000);
    await calendar(world);
    expect(world.rpcCalls).toHaveLength(3);
  });

  it("turns calls on from the toolbar RPC and refreshes the calendar", async () => {
    const world = createWorld({ callRpc: async () => DISPATCH });
    await plugin(world.host.bb);
    expect(await world.host.harness.callRpc("journal_set_show_calls", { enabled: true })).toEqual({ enabled: true });
    expect((await calendar(world)).calls).toHaveLength(2);
    expect(await world.host.harness.callRpc("journal_set_show_calls", { enabled: false })).toEqual({ enabled: false });
    expect((await calendar(world)).calls).toBeUndefined();
    expect(world.rpcCalls).toHaveLength(1);
  });

  it("round-trips calls through the calendar wire format and still reads replies without them", () => {
    const calls = calendarCalls(DISPATCH as Parameters<typeof calendarCalls>[0]);
    const activity = { from: WEEK.from, to: WEEK.to, mergeGapMinutes: 30, generatedAt: at(7, 12), syncedAt: null, workTimeZone: ZONE,
      projects: [], colorOrder: [], threads: [], blocks: [], turns: [] };
    expect(calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(packCalendar({ ...activity, calls }))))).toMatchObject({ calls });
    expect(calendarSchema.parse(unpackCalendar(calendarWireSchema.parse(packCalendar(activity)))).calls).toBeUndefined();
  });
});
