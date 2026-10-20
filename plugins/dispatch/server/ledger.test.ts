import { describe, expect, it } from "vitest";
import { CHANNELS, LIVE_USD_PER_MINUTE } from "../shared/constants.js";
import { DESKTOP_DEVICE, loadPlugin, makeContext, published } from "./core-test-host.js";
import { LIVE_ROW_MAX_MS, appendTrace, callTrace, callsPage, getCall, insertCall, liveStatus, localDay, usageReport } from "./ledger.js";

const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).getTime();

describe("trace and calls rows", () => {
  it("usage.seconds sets billed_seconds and an ending kind ends the call", async () => {
    const { ctx, harness } = await makeContext();
    const id = insertCall(ctx, { channel: "app", device: DESKTOP_DEVICE });
    appendTrace(ctx, id, [{ kind: "usage.seconds", at: 10, payload: { seconds: 42.5 } }]);
    expect(getCall(ctx, id)).toMatchObject({ billedSeconds: 42.5, endedAt: null });
    appendTrace(ctx, id, [{ kind: "call.closed", at: 20, payload: { seconds: 61 } }]);
    expect(getCall(ctx, id)).toMatchObject({ billedSeconds: 61, endedAt: 20, closeReason: "closed" });
    expect(published(harness, CHANNELS.traceTail)).toHaveLength(2);
  });

  it("skips events for an unknown call", async () => {
    const { ctx, harness } = await makeContext();
    expect(appendTrace(ctx, "call_none", [{ kind: "note", at: 1 }])).toEqual([]);
    expect(published(harness, CHANNELS.traceTail)).toEqual([]);
  });

  it("counts an open row as live only for six hours", async () => {
    const { ctx } = await makeContext();
    insertCall(ctx, { channel: "phone", device: DESKTOP_DEVICE, startedAt: Date.now() - LIVE_ROW_MAX_MS - 1000 });
    expect(liveStatus(ctx).live).toBe(false);
    insertCall(ctx, { channel: "app", device: DESKTOP_DEVICE });
    expect(liveStatus(ctx)).toMatchObject({ live: true, channel: "app" });
  });

  it("pages calls newest first and the trace oldest first", async () => {
    const { ctx } = await makeContext();
    const ids = [1, 2, 3].map((n) => insertCall(ctx, { id: `call_${n}`, channel: "app", device: DESKTOP_DEVICE, startedAt: n * 1000 }));
    const first = callsPage(ctx, { limit: 2 });
    expect(first.calls.map((call) => call.id)).toEqual(["call_3", "call_2"]);
    const second = callsPage(ctx, { limit: 2, cursor: first.nextCursor! });
    expect(second).toMatchObject({ calls: [{ id: "call_1" }], nextCursor: null });
    appendTrace(ctx, ids[0]!, [1, 2, 3].map((n) => ({ kind: `k${n}`, at: n })));
    const trace = callTrace(ctx, { callId: ids[0]!, limit: 2 });
    expect(trace.events.map((event) => event.kind)).toEqual(["k1", "k2"]);
    expect(callTrace(ctx, { callId: ids[0]!, limit: 2, cursor: trace.nextCursor! }).events.map((event) => event.kind)).toEqual(["k3"]);
  });
});

describe("usage report", () => {
  it("groups billed seconds by local day and prices them", async () => {
    const { ctx } = await makeContext();
    const seconds = [
      [at(18, 1), 60],
      [at(18, 23), 120],
      [at(19, 9), 30],
      [at(1, 9), 999],
    ] as const;
    for (const [startedAt, billed] of seconds) {
      const id = insertCall(ctx, { channel: "app", device: DESKTOP_DEVICE, startedAt });
      appendTrace(ctx, id, [{ kind: "usage.seconds", at: startedAt, payload: { seconds: billed } }]);
    }
    const report = usageReport(ctx, 7, at(19, 12));
    expect(report.perDay).toEqual([
      { day: "2026-10-19", seconds: 30, usd: 0.025, calls: 1 },
      { day: "2026-10-18", seconds: 180, usd: 0.15, calls: 2 },
    ]);
    expect(report).toMatchObject({ days: 7, totalSeconds: 210, usdPerMinute: LIVE_USD_PER_MINUTE, legacyTokenRows: 0 });
    expect(localDay(at(18, 23))).toBe("2026-10-18");
  });

  it("counts legacy token rows separately and never prices them", async () => {
    const { ctx, bb } = await makeContext();
    const insert = bb.storage.database().prepare("INSERT INTO legacy_token_usage (row_json, imported_at) VALUES (?, ?)");
    insert.run('{"tokens":100}', 1);
    insert.run('{"tokens":200}', 1);
    const report = usageReport(ctx, 30);
    expect(report).toMatchObject({ legacyTokenRows: 2, totalSeconds: 0, totalUsd: 0, perDay: [] });
  });

  it("serves traceAppend and usageReport over RPC", async () => {
    const { bb, harness } = await loadPlugin();
    bb.storage.database().prepare("INSERT INTO calls (id, channel, device_json, started_at) VALUES ('call_r', 'app', '{}', ?)").run(Date.now());
    await harness.callRpc("traceAppend", { callId: "call_r", events: [{ kind: "usage.seconds", at: Date.now(), payload: { seconds: 90 } }] });
    expect(await harness.callRpc("usageReport", { days: 1 })).toMatchObject({ totalSeconds: 90 });
  });
});
