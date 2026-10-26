import { describe, expect, it } from "vitest";
import { CHANNELS } from "../shared/constants.js";
import { FULL_SETUP, loadPlugin, published, threadRow, type Stubs } from "./core-test-host.js";
import { NO_CALL, PRICING_NOTE } from "./cli.js";

const secrets = Object.values(FULL_SETUP);
const expectNoSecrets = (text: string) => {
  for (const secret of secrets) expect(text).not.toContain(secret);
};
const insertLive = (bb: Awaited<ReturnType<typeof loadPlugin>>["bb"], channel = "app") =>
  bb.storage
    .database()
    .prepare("INSERT INTO calls (id, channel, device_json, started_at) VALUES (?, ?, ?, ?)")
    .run(`call_${channel}`, channel, JSON.stringify({ label: "Chrome on Mac" }), Date.now());

describe("bb dispatch status", () => {
  it("prints no secret in text or JSON, and none reaches realtime or logs", async () => {
    const { harness } = await loadPlugin({ ...FULL_SETUP });
    const text = await harness.runCli(["status"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Voice: ready");
    expect(text.stdout).toContain("Call: none live");
    expectNoSecrets(text.stdout);

    const json = await harness.runCli(["status", "--json"]);
    const parsed = JSON.parse(json.stdout);
    expect(parsed).toMatchObject({ voice: { ready: true }, live: { live: false } });
    expect(Object.values(parsed.fields).every((value) => typeof value === "boolean")).toBe(true);
    expectNoSecrets(json.stdout);

    await harness.callRpc("setupStatus", {});
    await harness.callRpc("preferencesRead", {});
    expectNoSecrets(JSON.stringify(harness.inspection.realtimeSignals));
    expectNoSecrets(JSON.stringify(harness.inspection.logEntries));
  });

});

describe("bb dispatch usage", () => {
  it("prints the report fields plus the pricing note as JSON", async () => {
    const { harness } = await loadPlugin();
    const { exitCode, stdout } = await harness.runCli(["usage", "--json", "--days", "7"]);
    expect(exitCode).toBe(0);
    expect(Object.keys(JSON.parse(stdout)).sort()).toEqual(
      ["days", "note", "perDay", "rateCheckedOn", "totalSeconds", "totalUsd", "usdPerMinute"].sort(),
    );
    expect(JSON.parse(stdout)).toMatchObject({ days: 7, note: PRICING_NOTE });
  });

  it("says so when there are no calls", async () => {
    const { harness } = await loadPlugin();
    const { stdout } = await harness.runCli(["usage"]);
    expect(stdout).toContain("No calls in the last 30 days.");
    expect(stdout).toContain(PRICING_NOTE);
  });
});

describe("call controls", () => {
  it("stop ends the live call and exits 0 without one", async () => {
    const { bb, harness } = await loadPlugin();
    expect(await harness.runCli(["stop"])).toMatchObject({ exitCode: 0, stdout: NO_CALL });
    insertLive(bb);
    expect(await harness.runCli(["stop"])).toMatchObject({ exitCode: 0, stdout: "Stopped" });
    expect(published(harness, CHANNELS.callControl)).toHaveLength(2);
  });

  it("mute and unmute relay to the call and fail without one", async () => {
    const { bb, harness } = await loadPlugin();
    const none = await harness.runCli(["mute"]);
    expect(none.exitCode).not.toBe(0);
    expect(none.stderr).toContain(NO_CALL);
    insertLive(bb);
    expect(await harness.runCli(["mute"])).toMatchObject({ exitCode: 0, stdout: "Muted" });
    expect(await harness.runCli(["unmute"])).toMatchObject({ exitCode: 0, stdout: "Unmuted" });
    expect(published(harness, CHANNELS.agentCommand)).toEqual([
      { command: "mute", nonce: null },
      { command: "unmute", nonce: null },
    ]);
  });
});

describe("bb dispatch live and read", () => {
  const stubs = {
    threads: {
      list: async () => [threadRow()],
      get: async () => threadRow(),
      output: async () => ({ output: "The header is fixed." }),
    },
  } as unknown as Stubs;

  it("live lists working threads", async () => {
    const { harness } = await loadPlugin(undefined, stubs);
    const { stdout } = await harness.runCli(["live", "--json"]);
    expect(JSON.parse(stdout)).toMatchObject({ threads: [{ id: "thr_a", status: "active", title: "Fix the header" }] });
  });

  it("read prints the latest output", async () => {
    const { harness } = await loadPlugin(undefined, stubs);
    const { exitCode, stdout } = await harness.runCli(["read", "thr_a"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Fix the header (active)");
    expect(stdout).toContain("The header is fixed.");
  });
});

describe("bb dispatch forget", () => {
  it("forgets the latest call by default, or a call by id, and deletes its words", async () => {
    const { bb, harness } = await loadPlugin({ ...FULL_SETUP });
    const db = bb.storage.database();
    const insert = db.prepare("INSERT INTO calls (id, channel, device_json, started_at) VALUES (?, 'app', '{}', ?)");
    insert.run("call_old", 1000);
    insert.run("call_new", 2000);
    db.prepare("INSERT INTO call_trace (call_id, at, kind, payload_json) VALUES ('call_new', 2001, 'speech.user', '{\"text\":\"secret\"}')").run();

    const latest = await harness.runCli(["forget"]);
    expect(latest).toMatchObject({ exitCode: 0, stdout: "Forgot call_new. Its transcript and summary are deleted." });
    expect(db.prepare("SELECT forget FROM calls WHERE id = 'call_new'").get()).toEqual({ forget: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM call_trace WHERE call_id = 'call_new'").get()).toEqual({ n: 0 });

    expect((await harness.runCli(["forget", "call_old"])).stdout).toContain("Forgot call_old.");
    const unknown = await harness.runCli(["forget", "call_none"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("There is no call with id call_none.");
  });

  it("fails when there are no calls", async () => {
    const { harness } = await loadPlugin({ ...FULL_SETUP });
    const result = await harness.runCli(["forget"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("There are no calls to forget.");
  });
});
