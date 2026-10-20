import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_MEMORY, ENDPOINTS, defaultPreferences } from "../shared/constants.js";
import { READ_CALLS_METHOD, readContract, type CallSummary, type DeviceProfile } from "../shared/contract.js";
import type { ServerContext } from "./context.js";
import { APP_CONTEXT, DESKTOP_DEVICE, FULL_SETUP, loadPlugin, makeContext } from "./core-test-host.js";
import { LIVE_ROW_MAX_MS, appendTrace, endCall, getCall, insertCall, localDay } from "./ledger.js";
import { PHONE_DEVICE } from "./live-session.js";
import {
  MEMORY_OFF_ERROR,
  RECENT_CALLS_HEADING,
  SUMMARY_DELAY_MS,
  forgetCall,
  lastCallLine,
  pruneMemory,
  readCalls,
  recallCalls,
  recentCallsSection,
  registerMemory,
  retryMissingSummaries,
  summariseCall,
  summaryFor,
} from "./memory.js";
import { readPreferences, writePreferences } from "./preferences.js";
import { assemblePrompts, timeLine } from "./prompts/index.js";
import { executeServerTool, toolCatalog } from "./tools/index.js";

const ZONE = "America/New_York";
const MAC: DeviceProfile = { ...DESKTOP_DEVICE, platform: "macOS", deviceName: "Mac", timeZone: ZONE };
const DAY = 24 * 60 * 60 * 1000;
/** Tuesday, October 20, 2026 at 2:00 PM in New York. */
const NOW = Date.UTC(2026, 9, 20, 18, 0);
/** Monday, October 19, 2026 at 3:05 PM in New York. */
const YESTERDAY = Date.UTC(2026, 9, 19, 19, 5);

type Ctx = ServerContext;

/** An ended call with optional words and tool calls in its trace. */
function endedCall(
  ctx: Ctx,
  input: { id: string; startedAt: number; minutes?: number; device?: DeviceProfile; channel?: "app" | "phone"; said?: string[]; tools?: Array<{ name: string; args?: Record<string, unknown>; output?: string }> },
): string {
  const startedAt = input.startedAt;
  const id = insertCall(ctx, { id: input.id, channel: input.channel ?? "app", device: input.device ?? MAC, startedAt });
  let at = startedAt;
  (input.said ?? []).forEach((text, index) => {
    appendTrace(ctx, id, [{ kind: index % 2 === 0 ? "speech.user" : "speech.agent", at: (at += 1000), payload: { text } }]);
  });
  for (const tool of input.tools ?? []) {
    appendTrace(ctx, id, [
      { kind: "tool.call", at: (at += 1000), payload: { name: tool.name, args: tool.args ?? {} } },
      { kind: "tool.result", at: (at += 1000), payload: { name: tool.name, status: "success", output: tool.output ?? "{}" } },
    ]);
  }
  endCall(ctx, id, { reason: "closed", at: startedAt + (input.minutes ?? 5) * 60_000 });
  return id;
}

/** Store a summary row directly. */
function remember(ctx: Ctx, callId: string, summary: Partial<CallSummary> = {}): void {
  const call = getCall(ctx, callId)!;
  ctx.db
    .prepare(
      `INSERT INTO call_summaries (call_id, local_day, time_zone, title, summary, topics, thread_ids, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      callId,
      summary.localDay ?? localDay(call.startedAt, ZONE),
      summary.timeZone ?? ZONE,
      summary.title ?? `Title of ${callId}`,
      summary.summary ?? `Summary of ${callId}.`,
      JSON.stringify(summary.topics ?? []),
      JSON.stringify(summary.threadIds ?? []),
      summary.model ?? "gpt-test",
      summary.status ?? "done",
      call.startedAt,
    );
}

const speechCount = (ctx: Ctx, callId: string) =>
  (ctx.db.prepare("SELECT COUNT(*) AS n FROM call_trace WHERE call_id = ? AND kind LIKE 'speech.%'").get(callId) as { n: number }).n;
const toolCount = (ctx: Ctx, callId: string) =>
  (ctx.db.prepare("SELECT COUNT(*) AS n FROM call_trace WHERE call_id = ? AND kind LIKE 'tool.%'").get(callId) as { n: number }).n;

type Request = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
let requests: Request[] = [];
let reply: () => Response = () => new Response("{}", { status: 500 });

/** A Responses API body whose message text is `json`. */
const modelReply = (json: unknown) => () =>
  new Response(
    JSON.stringify({
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(json) }] },
      ],
    }),
    { status: 200 },
  );

beforeEach(() => {
  requests = [];
  reply = () => new Response("{}", { status: 500 });
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")), headers: (init?.headers ?? {}) as Record<string, string> });
    return reply();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("call summaries", () => {
  it("asks the reasoning model with low effort and JSON output, and stores a done row", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const id = endedCall(ctx, {
      id: "call_a",
      startedAt: YESTERDAY,
      said: ["Start a thread to fix the header.", "Started it."],
      tools: [{ name: "start_thread", output: JSON.stringify({ threadId: "thr_new" }) }, { name: "read_thread", args: { thread_id: "thr_old" } }],
    });
    reply = modelReply({ title: "x".repeat(200), summary: "Fixed  the\nheader. ".repeat(100), topics: ["header", "css"] });

    const summary = await summariseCall(ctx, id, () => NOW);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(ENDPOINTS.responses);
    expect(request.headers.Authorization).toBe(`Bearer ${FULL_SETUP.openaiKey}`);
    expect(request.body).toMatchObject({
      model: defaultPreferences().reasoningModel,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", strict: true } },
      store: false,
    });
    expect(request.body.input).toContain("User: Start a thread to fix the header.");
    expect(request.body.input).toContain("Agent: Started it.");
    expect(summary).toMatchObject({ status: "done", localDay: "2026-10-19", timeZone: ZONE, topics: ["header", "css"], model: defaultPreferences().reasoningModel });
    expect(summary!.title.length).toBeLessThanOrEqual(CALL_MEMORY.titleMax);
    expect(summary!.summary.length).toBeLessThanOrEqual(CALL_MEMORY.summaryMax);
    expect(summary!.summary).not.toMatch(/\s{2}|\n/);
    expect(summary!.threadIds).toEqual(["thr_new", "thr_old"]);
  });

  it("stores a fallback from the tool trace when the model fails", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const id = endedCall(ctx, { id: "call_a", startedAt: YESTERDAY, said: ["Hi"], tools: [{ name: "read_thread", args: { thread_id: "thr_old" } }] });
    reply = () => new Response("busy", { status: 503 });
    const summary = await summariseCall(ctx, id, () => NOW);
    expect(summary).toMatchObject({ status: "fallback", title: "Call: read_thread", threadIds: ["thr_old"], model: null });
    expect(summary!.summary).toContain("Threads: thr_old.");
  });

  it("stores a fallback when the model's JSON has no title", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const id = endedCall(ctx, { id: "call_a", startedAt: YESTERDAY, said: ["Hi"] });
    reply = modelReply({ title: "", summary: "x", topics: [] });
    expect(await summariseCall(ctx, id)).toMatchObject({ status: "fallback", title: "Call" });
  });

  it("skips calls with nothing said or done, and calls ended while memory is off", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const empty = endedCall(ctx, { id: "call_empty", startedAt: YESTERDAY });
    expect(await summariseCall(ctx, empty)).toMatchObject({ status: "skipped" });
    await writePreferences(ctx, { callMemory: false });
    const off = endedCall(ctx, { id: "call_off", startedAt: YESTERDAY, said: ["Hi"] });
    expect(await summariseCall(ctx, off)).toMatchObject({ status: "skipped" });
    expect(requests).toHaveLength(0);
  });

  it("does not summarise an open or forgotten call, and keeps an existing summary", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const open = insertCall(ctx, { channel: "app", device: MAC });
    expect(await summariseCall(ctx, open)).toBeNull();
    const forgotten = endedCall(ctx, { id: "call_f", startedAt: YESTERDAY, said: ["Hi"] });
    forgetCall(ctx, forgotten);
    expect(await summariseCall(ctx, forgotten)).toBeNull();
    const done = endedCall(ctx, { id: "call_d", startedAt: YESTERDAY, said: ["Hi"] });
    remember(ctx, done, { title: "Kept" });
    expect(await summariseCall(ctx, done)).toMatchObject({ title: "Kept" });
    expect(requests).toHaveLength(0);
  });

  it("retries calls without a summary, newest first and at most retryMax", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const count = CALL_MEMORY.retryMax + 2;
    for (let n = 0; n < count; n += 1) endedCall(ctx, { id: `call_${String(n).padStart(2, "0")}`, startedAt: NOW - (count - n) * 60 * 60_000, said: ["Hi"] });
    endedCall(ctx, { id: "call_old", startedAt: NOW - 200 * DAY, said: ["Hi"] });
    reply = modelReply({ title: "T", summary: "S", topics: [] });

    expect(await retryMissingSummaries(ctx, NOW)).toBe(CALL_MEMORY.retryMax);
    // The two oldest in retention and the one past retention wait.
    expect(summaryFor(ctx, "call_00")).toBeNull();
    expect(summaryFor(ctx, "call_01")).toBeNull();
    expect(summaryFor(ctx, "call_old")).toBeNull();
    expect(summaryFor(ctx, `call_${count - 1}`)).toMatchObject({ status: "done" });
    expect(await retryMissingSummaries(ctx, NOW)).toBe(2);
  });

  it("does not retry while memory is off", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    endedCall(ctx, { id: "call_a", startedAt: NOW - DAY, said: ["Hi"] });
    await writePreferences(ctx, { callMemory: false });
    expect(await retryMissingSummaries(ctx, NOW)).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("summarises a call in the background a few seconds after it ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { ctx } = await makeContext({ ...FULL_SETUP });
    reply = modelReply({ title: "Background", summary: "S", topics: [] });
    registerMemory(ctx);
    const id = insertCall(ctx, { channel: "phone", device: PHONE_DEVICE });
    appendTrace(ctx, id, [{ kind: "speech.user", at: Date.now(), payload: { text: "Hi" } }]);
    appendTrace(ctx, id, [{ kind: "call.closed", at: Date.now(), payload: {} }]);
    expect(summaryFor(ctx, id)).toBeNull();
    await vi.advanceTimersByTimeAsync(SUMMARY_DELAY_MS);
    await vi.waitFor(() => expect(summaryFor(ctx, id)).toMatchObject({ title: "Background", timeZone: expect.any(String) }));
  });
});

describe("do not remember", () => {
  it("deletes the transcript and summary, keeps the tool trace, and drops later words", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const id = endedCall(ctx, { id: "call_a", startedAt: YESTERDAY, said: ["Secret", "Noted"], tools: [{ name: "list_threads" }] });
    remember(ctx, id);
    expect(forgetCall(ctx, id)).toBe(true);
    expect(getCall(ctx, id)!.forgotten).toBe(true);
    expect(summaryFor(ctx, id)).toBeNull();
    expect(speechCount(ctx, id)).toBe(0);
    expect(toolCount(ctx, id)).toBe(2);
    appendTrace(ctx, id, [{ kind: "speech.user", at: YESTERDAY + 1, payload: { text: "More" } }]);
    expect(speechCount(ctx, id)).toBe(0);
    expect(forgetCall(ctx, "call_none")).toBe(false);
  });

  it("works on a live call through the forgetCall RPC", async () => {
    const { harness, bb } = await loadPlugin({ ...FULL_SETUP });
    const ctx = { db: bb.storage.database() } as Ctx;
    const id = insertCall(ctx, { channel: "app", device: MAC });
    await expect(harness.callRpc("forgetCall", { callId: id })).resolves.toEqual({ forgotten: true });
    expect(getCall(ctx, id)!.forgotten).toBe(true);
    await expect(harness.callRpc("forgetCall", { callId: "call_none" })).rejects.toThrow();
  });
});

describe("retention", () => {
  it("prunes summaries and transcripts older than the retention period, and keeps the call rows", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    await writePreferences(ctx, { memoryRetentionDays: 30 });
    const old = endedCall(ctx, { id: "call_old", startedAt: NOW - 31 * DAY, said: ["Old", "Words"] });
    const recent = endedCall(ctx, { id: "call_new", startedAt: NOW - 29 * DAY, said: ["New"] });
    remember(ctx, old);
    remember(ctx, recent);
    expect(await pruneMemory(ctx, NOW)).toEqual({ summaries: 1, speech: 2 });
    expect(summaryFor(ctx, old)).toBeNull();
    expect(speechCount(ctx, old)).toBe(0);
    expect(getCall(ctx, old)).not.toBeNull();
    expect(summaryFor(ctx, recent)).not.toBeNull();
    expect(speechCount(ctx, recent)).toBe(1);
  });

  it("keeps everything when retention is forever, and defaults to 90 days", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    expect((await readPreferences(ctx)).memoryRetentionDays).toBe(90);
    await writePreferences(ctx, { memoryRetentionDays: 0 });
    const old = endedCall(ctx, { id: "call_old", startedAt: NOW - 3000 * DAY, said: ["Old"] });
    remember(ctx, old);
    expect(await pruneMemory(ctx, NOW)).toEqual({ summaries: 0, speech: 0 });
  });
});

describe("prompt memory", () => {
  it("lists recent calls newest first within the size limit", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    for (let n = 0; n < 8; n += 1) {
      const id = endedCall(ctx, { id: `call_${n}`, startedAt: NOW - (8 - n) * 60 * 60_000 });
      remember(ctx, id, { title: `Call ${n}`, summary: "word ".repeat(200) });
    }
    remember(ctx, endedCall(ctx, { id: "call_skip", startedAt: NOW - 10 * 60_000 }), { status: "skipped", title: "Skipped" });
    const preferences = await readPreferences(ctx);
    const section = recentCallsSection(ctx, preferences, NOW, ZONE)!;
    expect(section.startsWith(RECENT_CALLS_HEADING)).toBe(true);
    expect(section.length).toBeLessThanOrEqual(CALL_MEMORY.promptMax);
    expect(section).not.toContain("Skipped");
    const listed = [...section.matchAll(/: (Call \d)\./g)].map((match) => match[1]);
    expect(listed[0]).toBe("Call 7");
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThanOrEqual(CALL_MEMORY.promptCalls);
    expect(section).toContain("today at");
    expect(section).toContain("from Mac");
  });

  it("says when and where the last call was", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    endedCall(ctx, { id: "call_a", startedAt: YESTERDAY });
    const preferences = await readPreferences(ctx);
    expect(lastCallLine(ctx, preferences, NOW, ZONE)).toBe("- Last call: yesterday at 3:05 PM from Mac.");
    endedCall(ctx, { id: "call_b", startedAt: NOW - 60_000, channel: "phone", device: PHONE_DEVICE });
    expect(lastCallLine(ctx, preferences, NOW, ZONE)).toBe("- Last call: today at 1:59 PM from Phone.");
  });

  it("shows nothing when memory is off", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    remember(ctx, endedCall(ctx, { id: "call_a", startedAt: YESTERDAY }));
    const preferences = await writePreferences(ctx, { callMemory: false });
    expect(recentCallsSection(ctx, preferences, NOW, ZONE)).toBeNull();
    expect(lastCallLine(ctx, preferences, NOW, ZONE)).toBeNull();
  });

  it("puts the caller's zone, the last call, and Recent calls in the runtime part", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    remember(ctx, endedCall(ctx, { id: "call_a", startedAt: YESTERDAY }), { title: "Header fix" });
    const tokyo = await assemblePrompts(ctx, { context: APP_CONTEXT, device: { ...MAC, timeZone: "Asia/Tokyo" }, now: new Date(NOW) });
    expect(tokyo.voice.runtime).toContain("- Local date and time: Wednesday, October 21, 2026 at 3:00 AM (Asia/Tokyo).");
    expect(tokyo.voice.runtime).toContain("- Last call: yesterday at 4:05 AM from Mac.");
    expect(tokyo.backend.runtime).toContain(RECENT_CALLS_HEADING);
    expect(tokyo.backend.runtime).toContain("Header fix");
  });

  it("uses homeTimeZone for phone calls", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    await writePreferences(ctx, { homeTimeZone: "Europe/London" });
    const phone = await assemblePrompts(ctx, { context: { ...APP_CONTEXT, channel: "phone" }, device: PHONE_DEVICE, now: new Date(NOW) });
    expect(phone.voice.runtime).toContain("- Local date and time: Tuesday, October 20, 2026 at 7:00 PM (Europe/London).");
  });

  it("formats the time line and the local day in a zone", () => {
    expect(timeLine(new Date(NOW), "Asia/Kolkata")).toBe("- Local date and time: Tuesday, October 20, 2026 at 11:30 PM (Asia/Kolkata).");
    const lateEvening = Date.UTC(2026, 9, 21, 2, 30);
    expect(localDay(lateEvening, ZONE)).toBe("2026-10-20");
    expect(localDay(lateEvening, "UTC")).toBe("2026-10-21");
  });
});

describe("recall_calls", () => {
  async function seeded() {
    const made = await makeContext({ ...FULL_SETUP });
    const { ctx } = made;
    remember(ctx, endedCall(ctx, { id: "call_y", startedAt: YESTERDAY }), { title: "Header fix", summary: "Fixed the header in Website.", topics: ["css"], threadIds: ["thr_a"] });
    remember(ctx, endedCall(ctx, { id: "call_t", startedAt: NOW - 60 * 60_000 }), { title: "Billing", summary: "Talked about invoices." });
    remember(ctx, endedCall(ctx, { id: "call_old", startedAt: NOW - 5 * DAY }), { title: "Old header idea", summary: "Planned the header." });
    return made;
  }

  it("filters by day and by every query word, newest first", async () => {
    const { ctx } = await seeded();
    await writePreferences(ctx, { homeTimeZone: ZONE });
    const byDay = await recallCalls(ctx, { day: "2026-10-19" }, NOW);
    expect(byDay.calls).toMatchObject([{ id: "call_y", day: "2026-10-19", ago: "yesterday", from: "Mac", title: "Header fix", threadIds: ["thr_a"] }]);
    expect((await recallCalls(ctx, { query: "HEADER" }, NOW)).calls.map((call) => call.id)).toEqual(["call_y", "call_old"]);
    expect((await recallCalls(ctx, { query: "header css" }, NOW)).calls.map((call) => call.id)).toEqual(["call_y"]);
    expect((await recallCalls(ctx, { limit: 1 }, NOW)).calls.map((call) => call.id)).toEqual(["call_t"]);
    expect((await recallCalls(ctx, { limit: 999 }, NOW)).calls).toHaveLength(3);
    expect(await recallCalls(ctx, { query: "nothing" }, NOW)).toMatchObject({ calls: [], note: expect.stringContaining("No remembered call") });
  });

  it("rejects a malformed day", async () => {
    const { ctx } = await seeded();
    await expect(recallCalls(ctx, { day: "yesterday" })).rejects.toThrow(/2026-10-19/);
  });

  it("runs as a tool and leaves the catalog when memory is off", async () => {
    const { ctx } = await seeded();
    const call = { callId: "call_t", name: "recall_calls", args: { query: "billing" }, context: APP_CONTEXT };
    const result = await executeServerTool(ctx, call);
    expect(result.status).toBe("success");
    expect(JSON.parse(result.output).calls[0]).toMatchObject({ id: "call_t", title: "Billing" });
    const flags = { mobile: false, canNavigate: true, channel: "app" as const };
    expect((await toolCatalog(ctx, flags)).map((tool) => tool.name)).toContain("recall_calls");

    await writePreferences(ctx, { callMemory: false });
    expect((await toolCatalog(ctx, flags)).map((tool) => tool.name)).not.toContain("recall_calls");
    await expect(recallCalls(ctx, {})).rejects.toThrow(MEMORY_OFF_ERROR);
    expect(await executeServerTool(ctx, call)).toMatchObject({ status: "error" });
  });
});

describe("read.calls", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const window = (since: number, until: number) => readContract[READ_CALLS_METHOD].input.parse({ since: iso(since), until: iso(until) });

  it("returns calls that overlap the window, live ones too, oldest first", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const since = NOW - DAY;
    const until = NOW;
    endedCall(ctx, { id: "before", startedAt: since - 60 * 60_000, minutes: 30 });
    endedCall(ctx, { id: "spans_start", startedAt: since - 10 * 60_000, minutes: 20 });
    endedCall(ctx, { id: "inside", startedAt: since + 60 * 60_000 });
    endedCall(ctx, { id: "spans_end", startedAt: until - 60_000, minutes: 10 });
    endedCall(ctx, { id: "after", startedAt: until + 60_000 });
    insertCall(ctx, { id: "live", channel: "phone", device: PHONE_DEVICE, startedAt: since + 3 * 60 * 60_000 });
    insertCall(ctx, { id: "stale_open", channel: "app", device: MAC, startedAt: since - LIVE_ROW_MAX_MS - DAY });
    remember(ctx, "inside", { title: "Inside", summary: "Did things.", threadIds: ["thr_a"] });

    const out = await readCalls(ctx, window(since, until), NOW);
    expect(out.memory).toBe(true);
    expect(out.calls.map((call) => call.id)).toEqual(["spans_start", "inside", "live", "spans_end"]);
    expect(out.calls.find((call) => call.id === "inside")).toEqual({
      id: "inside",
      startedAt: iso(since + 60 * 60_000),
      endedAt: iso(since + 65 * 60_000),
      channel: "app",
      device: "Mac",
      title: "Inside",
      summary: "Did things.",
      threadIds: ["thr_a"],
    });
    expect(out.calls.find((call) => call.id === "live")).toMatchObject({ endedAt: null, device: "Phone", title: null, summary: null });
  });

  it("rejects a window that is empty, reversed, or longer than 62 days", () => {
    expect(() => window(NOW, NOW)).toThrow(/until must be after since/);
    expect(() => window(NOW, NOW - 1)).toThrow(/until must be after since/);
    expect(() => window(NOW - 63 * DAY, NOW)).toThrow(/62 days/);
    expect(() => window(NOW - 62 * DAY, NOW)).not.toThrow();
    expect(() => readContract[READ_CALLS_METHOD].input.parse({ since: "yesterday", until: iso(NOW) })).toThrow();
  });

  it("nulls titles and summaries when memory is off", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    remember(ctx, endedCall(ctx, { id: "call_a", startedAt: NOW - 60 * 60_000, tools: [{ name: "read_thread", args: { thread_id: "thr_a" } }] }), { threadIds: ["thr_a"] });
    await writePreferences(ctx, { callMemory: false });
    const out = await readCalls(ctx, window(NOW - DAY, NOW), NOW);
    expect(out).toEqual({
      memory: false,
      calls: [expect.objectContaining({ id: "call_a", title: null, summary: null, threadIds: [] })],
    });
  });

  it("keeps a forgotten call with a null title and summary", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const id = endedCall(ctx, { id: "call_a", startedAt: NOW - 60 * 60_000 });
    remember(ctx, id);
    forgetCall(ctx, id);
    const out = await readCalls(ctx, window(NOW - DAY, NOW), NOW);
    expect(out.calls).toEqual([expect.objectContaining({ id, title: null, summary: null, threadIds: [] })]);
  });

  it("falls back to trace thread ids for a call without a summary yet", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    endedCall(ctx, { id: "call_a", startedAt: NOW - 60 * 60_000, tools: [{ name: "read_thread", args: { thread_id: "thr_a" } }] });
    const out = await readCalls(ctx, window(NOW - DAY, NOW), NOW);
    expect(out.calls).toEqual([expect.objectContaining({ title: null, summary: null, threadIds: ["thr_a"] })]);
  });

  it("is registered, discoverable, and validates its input", async () => {
    const { harness } = await loadPlugin({ ...FULL_SETUP });
    const published = harness.registrations.experimental_publishedRpcMethods.find((entry) => entry.method === READ_CALLS_METHOD);
    expect(published).toBeDefined();
    const since = new Date(Date.now() - DAY).toISOString();
    await expect(harness.callRpc(READ_CALLS_METHOD, { since, until: new Date().toISOString() })).resolves.toEqual({ memory: true, calls: [] });
    await expect(harness.callRpc(READ_CALLS_METHOD, { since, until: since })).rejects.toThrow();
  });
});
