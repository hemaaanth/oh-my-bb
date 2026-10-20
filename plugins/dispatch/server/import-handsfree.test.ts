// Import tests (SPEC §17). Every input is a fixture built in a temp folder:
// a `bb.db` with an old `config` row, secret files, and an old `data.db`.
// Nothing here touches the owner's real data directory.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECRET_IDS } from "../shared/constants.js";
import type { ImportReport } from "../shared/contract.js";
import { mapConfig } from "./import-handsfree.js";
import plugin from "./index.js";

const SID = `AC${"0a".repeat(16)}`;
// Made up for the test. They stand in for real secrets and must never be echoed.
const SECRET_VALUES = {
  openaiApiKey: `sk-test-${randomBytes(8).toString("hex")}`,
  twilioAccountSid: SID,
  twilioAuthToken: "token-with a space",
  destinationNumber: "4155550100",
  openaiSipProjectId: "proj_Abc123",
} as const;

const CONFIG = {
  assistantName: "  Oak ",
  voice: "gleam",
  model: "gpt-live-1",
  backendModel: "gpt-5.5",
  notifications: false,
  mobileViewBehavior: "new",
  pluginCommands: "git, linear ,git",
  shortcuts: { toggle: "mod+shift+k", mute: "Mod+Shift+P" },
  petLook: { style: "solid", color: "#ff8800", roundness: 140.4, followPointer: false, antennaFlash: true },
  credentialPreference: "subscription",
};

const SESSION_1 = "s-desk";
const SESSION_2 = "s-sip";
const SESSION_3 = "s-open";

type Fixture = { dir: string; dbPath: string };

/** Build `<dir>/bb.db`, `<dir>/plugins/handsfree/secrets/*` and `<dir>/plugins/handsfree/data.db`. */
function buildFixture(config: unknown = CONFIG): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-import-"));
  const oldDir = path.join(dir, "plugins", "handsfree");
  fs.mkdirSync(path.join(oldDir, "secrets"), { recursive: true });

  const main = new Database(path.join(dir, "bb.db"));
  main.exec("CREATE TABLE plugin_kv (plugin_id TEXT, key TEXT, value TEXT, PRIMARY KEY (plugin_id, key))");
  main.prepare("INSERT INTO plugin_kv VALUES (?, ?, ?)").run("handsfree", "config", JSON.stringify(config));
  main.prepare("INSERT INTO plugin_kv VALUES (?, ?, ?)").run("other-plugin", "config", JSON.stringify({ assistantName: "Nope" }));
  main.close();

  for (const [file, value] of Object.entries(SECRET_VALUES)) fs.writeFileSync(path.join(oldDir, "secrets", file), `${value}\n`);

  const dbPath = path.join(oldDir, "data.db");
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE prompt_versions (id INTEGER PRIMARY KEY, body TEXT, created_at INTEGER);
    CREATE TABLE session_events (id INTEGER PRIMARY KEY, session_id TEXT, kind TEXT, payload TEXT, at INTEGER);
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY, session_id TEXT, input_tokens INTEGER, output_tokens INTEGER);
  `);
  const prompt = old.prepare("INSERT INTO prompt_versions (body, created_at) VALUES (?, ?)");
  prompt.run("OLD PROMPT TEXT, version one", 1_700_000_000_000);
  prompt.run("OLD PROMPT TEXT, version two", 1_700_000_100_000);
  const event = old.prepare("INSERT INTO session_events (session_id, kind, payload, at) VALUES (?, ?, ?, ?)");
  const device = { platform: "Linux", mobile: false, browser: "Chrome", displayMode: "browser", runtime: "browser", label: "Chrome on Linux" };
  event.run(SESSION_1, "session.started", JSON.stringify({ device }), 1_700_000_200_000);
  event.run(SESSION_1, "transcript.user", JSON.stringify({ text: "hello" }), 1_700_000_201_000);
  event.run(SESSION_1, "tool.call", JSON.stringify({ name: "list_threads" }), 1_700_000_202_000);
  event.run(SESSION_1, "usage.seconds", JSON.stringify({ seconds: 30 }), 1_700_000_230_000);
  event.run(SESSION_1, "usage.seconds", JSON.stringify({ seconds: 65 }), 1_700_000_265_000);
  event.run(SESSION_1, "session.closed", JSON.stringify({ reason: "user" }), 1_700_000_266_000);
  event.run(SESSION_2, "session.started", JSON.stringify({ device: { ...device, runtime: "sip", label: "Phone" } }), 1_700_001_000_000);
  event.run(SESSION_2, "session.stopped", null, 1_700_001_050_000);
  event.run(SESSION_3, "session.started", JSON.stringify({ device }), 1_700_002_000_000);
  event.run(SESSION_3, "weird.event", "not json", 1_700_002_005_000);
  const usage = old.prepare("INSERT INTO usage_events (session_id, input_tokens, output_tokens) VALUES (?, ?, ?)");
  usage.run(SESSION_1, 100, 200);
  usage.run(SESSION_1, 300, 400);
  usage.run(SESSION_2, 5, 6);
  old.close();
  return { dir, dbPath };
}

const hashOf = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function load(fixture: Fixture) {
  const { bb, harness } = createFakePluginHost({ pluginId: "dispatch", dataDir: fixture.dir });
  // The plugin defines its settings once, so keep its handle to read values back.
  const define = bb.settings.define.bind(bb.settings);
  let handle: ReturnType<typeof define> | undefined;
  vi.spyOn(bb.settings, "define").mockImplementation(((descriptors: Parameters<typeof define>[0]) => (handle = define(descriptors))) as typeof define);
  await plugin(bb);
  const settings = () => (handle as { get(): Promise<Record<string, unknown>> }).get();
  return { bb, harness, settings };
}

const count = (bb: Awaited<ReturnType<typeof load>>["bb"], table: string) =>
  (bb.storage.database().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

let fixture: Fixture;
beforeEach(() => {
  fixture = buildFixture();
});
afterEach(() => {
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

describe("dry run", () => {
  it("reports counts and writes nothing", async () => {
    const { bb, harness, settings: readSettings } = await load(fixture);
    const before = hashOf(fixture.dbPath);
    const report = (await harness.callRpc("importHandsfree", { dryRun: true, includeLegacyUsage: false })) as ImportReport;

    expect(report.dryRun).toBe(true);
    expect(report.calls).toBe(3);
    expect(report.traceEvents).toBe(10);
    expect(report.instructions.imported).toBe(1);
    expect(report.legacyTokenRows).toBe(0);
    expect(report.skipped.join(" ")).toContain("Legacy token usage skipped (3 rows)");

    expect(count(bb, "calls")).toBe(0);
    expect(count(bb, "call_trace")).toBe(0);
    expect(count(bb, "instruction_revisions")).toBe(0);
    expect(count(bb, "legacy_token_usage")).toBe(0);
    expect(await bb.storage.kv.get("preferences")).toBeUndefined();
    expect(await bb.storage.kv.get("import.handsfree")).toBeUndefined();
    expect((await readSettings()).openaiKey).toBeFalsy();
    // Load publishes setup-updated once; the dry run itself must publish nothing.
    expect(harness.inspection.realtimeSignals.filter((s) => s.channel !== "setup-updated")).toEqual([]);
    expect(hashOf(fixture.dbPath)).toBe(before);
  });

  it("is the default for the CLI, and --apply is what writes", async () => {
    const { bb, harness } = await load(fixture);
    const dry = await harness.runCli(["import", "--from", "handsfree"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("Dry run. Nothing was written.");
    expect(count(bb, "calls")).toBe(0);
    expect(await bb.storage.kv.get("import.handsfree")).toBeUndefined();

    const both = await harness.runCli(["import", "--from", "handsfree", "--dry-run", "--apply"]);
    expect(both.exitCode).not.toBe(0);

    const applied = await harness.runCli(["import", "--from", "handsfree", "--apply"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Import done.");
    expect(count(bb, "calls")).toBe(3);
  });
});

describe("preferences (SPEC §17 field mapping)", () => {
  it("maps every old field", () => {
    const { prefs, imported, dropped, defaulted } = mapConfig(CONFIG);
    expect(prefs).toMatchObject({
      agentName: "Oak",
      voice: "gleam",
      voiceModel: "gpt-live-1",
      reasoningModel: "gpt-5.5",
      announcements: false,
      mobileDrawerBehavior: "new",
      pluginAccess: { mode: "selected", ids: ["git", "linear"] },
      pet: { style: "solid", color: "#ff8800", roundness: 100, followPointer: false, antennaFlash: true },
    });
    expect(prefs.hotkeys.toggle).toBe("Mod+Shift+K");
    expect(imported).toEqual([
      "agentName",
      "voice",
      "voiceModel",
      "reasoningModel",
      "announcements",
      "mobileDrawerBehavior",
      "pluginAccess",
      "hotkeys.toggle",
      "pet.style",
      "pet.color",
      "pet.roundness",
      "pet.followPointer",
      "pet.antennaFlash",
    ]);
    // The old mute shortcut is a BB combination, so it falls back to the default.
    expect(prefs.hotkeys.mute).toBe("Mod+Shift+U");
    expect(defaulted).toEqual(["hotkeys.mute"]);
    expect(dropped).toEqual(["credentialPreference"]);
  });

  it.each([
    ["assistantName", { assistantName: "   " }, "agentName", (p: ReturnType<typeof mapConfig>["prefs"]) => p.agentName, "Juno"],
    ["voice", { voice: "not-a-voice" }, "voice", (p: ReturnType<typeof mapConfig>["prefs"]) => p.voice, "gleam"],
    ["model", { model: "gpt-4o-realtime" }, "voiceModel", (p: ReturnType<typeof mapConfig>["prefs"]) => p.voiceModel, "gpt-live-1"],
    ["backendModel", { backendModel: "gpt-9" }, "reasoningModel", (p: ReturnType<typeof mapConfig>["prefs"]) => p.reasoningModel, "gpt-5.6-terra"],
    ["notifications", { notifications: "yes" }, "announcements", (p: ReturnType<typeof mapConfig>["prefs"]) => p.announcements, true],
    ["mobileViewBehavior", { mobileViewBehavior: "other" }, "mobileDrawerBehavior", (p: ReturnType<typeof mapConfig>["prefs"]) => p.mobileDrawerBehavior, "reuse"],
    ["pluginCommands", { pluginCommands: " , " }, "pluginAccess", (p: ReturnType<typeof mapConfig>["prefs"]) => p.pluginAccess, { mode: "all" }],
    ["shortcuts.toggle", { shortcuts: { toggle: "H" } }, "hotkeys.toggle", (p: ReturnType<typeof mapConfig>["prefs"]) => p.hotkeys.toggle, "Mod+Shift+H"],
    ["petLook.style", { petLook: { style: "chunky" } }, "pet.style", (p: ReturnType<typeof mapConfig>["prefs"]) => p.pet.style, "outline"],
    ["petLook.color", { petLook: { color: "red" } }, "pet.color", (p: ReturnType<typeof mapConfig>["prefs"]) => p.pet.color, "theme"],
    ["petLook.roundness", { petLook: { roundness: "round" } }, "pet.roundness", (p: ReturnType<typeof mapConfig>["prefs"]) => p.pet.roundness, 50],
    ["petLook.followPointer", { petLook: { followPointer: 1 } }, "pet.followPointer", (p: ReturnType<typeof mapConfig>["prefs"]) => p.pet.followPointer, true],
    ["petLook.antennaFlash", { petLook: { antennaFlash: "on" } }, "pet.antennaFlash", (p: ReturnType<typeof mapConfig>["prefs"]) => p.pet.antennaFlash, false],
  ])("an unusable old %s becomes the default and is reported", (_old, config, reported, read, expected) => {
    const result = mapConfig(config);
    expect(read(result.prefs)).toEqual(expected);
    expect(result.defaulted).toEqual([reported]);
    expect(result.imported).toEqual([]);
  });

  it("reads all and none for the plugin list", () => {
    expect(mapConfig({ pluginCommands: "ALL" }).prefs.pluginAccess).toEqual({ mode: "all" });
    expect(mapConfig({ pluginCommands: "none" }).prefs.pluginAccess).toEqual({ mode: "none" });
  });

  it("changes nothing for a missing config", () => {
    const result = mapConfig(undefined);
    expect(result.imported).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});

describe("apply", () => {
  it("copies preferences, calls, trace and the revision, and writes the marker", async () => {
    const { bb, harness } = await load(fixture);
    const before = hashOf(fixture.dbPath);
    const report = (await harness.callRpc("importHandsfree", { dryRun: false, includeLegacyUsage: false })) as ImportReport;
    expect(report.dryRun).toBe(false);

    const prefs = await bb.storage.kv.get<{ agentName: string; hotkeys: { toggle: string } }>("preferences");
    expect(prefs?.agentName).toBe("Oak");
    expect(prefs?.hotkeys.toggle).toBe("Mod+Shift+K");

    const db = bb.storage.database();
    const calls = db.prepare("SELECT * FROM calls ORDER BY started_at").all() as Array<Record<string, unknown>>;
    expect(calls.map((c) => [c.channel, c.started_at, c.ended_at, c.billed_seconds, c.unclean, c.close_reason])).toEqual([
      ["app", 1_700_000_200_000, 1_700_000_266_000, 65, 0, "user"],
      ["phone", 1_700_001_000_000, 1_700_001_050_000, 0, 0, null],
      ["app", 1_700_002_000_000, 1_700_002_005_000, 0, 1, null],
    ]);
    expect(JSON.parse(calls[0]!.device_json as string)).toMatchObject({ runtime: "browser", label: "Chrome on Linux" });
    expect(JSON.parse(calls[1]!.device_json as string)).toMatchObject({ runtime: "sip", label: "Phone" });

    const kinds = (db.prepare("SELECT kind FROM call_trace WHERE call_id = ? ORDER BY at, id").all(calls[0]!.id) as Array<{ kind: string }>).map((row) => row.kind);
    expect(kinds).toEqual(["call.started", "legacy.transcript.user", "tool.call", "usage.seconds", "usage.seconds", "call.closed"]);
    const odd = db.prepare("SELECT payload_json FROM call_trace WHERE kind = 'legacy.weird.event'").get() as { payload_json: string };
    expect(JSON.parse(odd.payload_json)).toEqual({ value: "not json" });

    const revisions = db.prepare("SELECT author, note, body FROM instruction_revisions").all() as Array<{ author: string; note: string; body: string }>;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.author).toBe("import");
    expect(revisions[0]!.note).toBe("imported from Handsfree: no filler before acting; act, then report");
    expect(revisions[0]!.body).not.toContain("OLD PROMPT TEXT");

    const marker = await bb.storage.kv.get<{ at: number; report: ImportReport }>("import.handsfree");
    expect(marker?.report).toEqual(report);
    expect(marker?.at).toBeGreaterThan(0);

    const channels = harness.inspection.realtimeSignals.map((signal) => signal.channel);
    expect(channels).toContain("preferences-updated");
    expect(channels).toContain("instructions-updated");
    expect(hashOf(fixture.dbPath)).toBe(before);
  });

  it("skips legacy token usage unless it is flagged", async () => {
    const { bb, harness } = await load(fixture);
    const report = (await harness.callRpc("importHandsfree", { dryRun: false, includeLegacyUsage: false })) as ImportReport;
    expect(report.legacyTokenRows).toBe(0);
    expect(count(bb, "legacy_token_usage")).toBe(0);
  });

  it("copies legacy token usage whole when flagged", async () => {
    const { bb, harness } = await load(fixture);
    const dry = (await harness.callRpc("importHandsfree", { dryRun: true, includeLegacyUsage: true })) as ImportReport;
    expect(dry.legacyTokenRows).toBe(3);
    expect(count(bb, "legacy_token_usage")).toBe(0);

    const report = (await harness.callRpc("importHandsfree", { dryRun: false, includeLegacyUsage: true })) as ImportReport;
    expect(report.legacyTokenRows).toBe(3);
    const rows = (bb.storage.database().prepare("SELECT row_json, imported_at FROM legacy_token_usage ORDER BY id").all() as Array<{ row_json: string; imported_at: number }>);
    expect(rows.map((row) => JSON.parse(row.row_json))).toEqual([
      { id: 1, session_id: SESSION_1, input_tokens: 100, output_tokens: 200 },
      { id: 2, session_id: SESSION_1, input_tokens: 300, output_tokens: 400 },
      { id: 3, session_id: SESSION_2, input_tokens: 5, output_tokens: 6 },
    ]);
    expect(rows[0]!.imported_at).toBeGreaterThan(0);
    expect(report.skipped.join(" ")).not.toContain("Legacy token usage skipped");
  });

  it("refuses to run a second time", async () => {
    const { bb, harness } = await load(fixture);
    await harness.callRpc("importHandsfree", { dryRun: false, includeLegacyUsage: false });
    await expect(harness.callRpc("importHandsfree", { dryRun: false, includeLegacyUsage: false })).rejects.toThrow(/already ran/);
    await expect(harness.callRpc("importHandsfree", { dryRun: true, includeLegacyUsage: false })).rejects.toThrow(/already ran/);
    const again = await harness.runCli(["import", "--from", "handsfree", "--apply"]);
    expect(again.exitCode).not.toBe(0);
    expect(count(bb, "calls")).toBe(3);
  });

  it("keeps stored preferences the old config does not mention", async () => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    fixture = buildFixture({ notifications: false });
    const { bb, harness } = await load(fixture);
    await bb.storage.kv.set("preferences", { agentName: "Kept", voice: "marin", hotkeys: { toggle: "Mod+Shift+J" } });
    await harness.callRpc("importHandsfree", { dryRun: false, includeLegacyUsage: false });
    const prefs = await bb.storage.kv.get<{ agentName: string; voice: string; announcements: boolean; hotkeys: { toggle: string; mute: string } }>("preferences");
    expect(prefs).toMatchObject({ agentName: "Kept", voice: "marin", announcements: false, hotkeys: { toggle: "Mod+Shift+J", mute: "Mod+Shift+U" } });
  });

  it("copes with a missing history database and a missing config", async () => {
    fs.rmSync(path.join(fixture.dir, "plugins", "handsfree", "data.db"));
    fs.rmSync(path.join(fixture.dir, "bb.db"));
    const { bb, harness } = await load(fixture);
    const report = (await harness.callRpc("importHandsfree", { dryRun: false, includeLegacyUsage: false })) as ImportReport;
    expect(report.calls).toBe(0);
    expect(report.instructions.imported).toBe(0);
    expect(report.preferences.imported).toEqual([]);
    expect(report.skipped.join(" ")).toContain("No earlier history database");
    expect(count(bb, "calls")).toBe(0);
  });
});

describe("secrets", () => {
  it("reports copied, absent or invalid and never the value", async () => {
    const { harness, settings: readSettings } = await load(fixture);
    const dry = (await harness.callRpc("importHandsfree", { dryRun: true, includeLegacyUsage: false })) as ImportReport;
    expect(dry.secrets).toEqual({
      openaiKey: "copied",
      twilioSid: "copied",
      twilioToken: "invalid",
      twilioCallerNumber: "absent",
      yourPhoneNumber: "invalid",
      openaiSipProject: "copied",
    });
    expect(Object.keys(dry.secrets)).toEqual([...SECRET_IDS]);

    const report = (await harness.callRpc("importHandsfree", { dryRun: false, includeLegacyUsage: false })) as ImportReport;
    expect(report.secrets).toEqual(dry.secrets);
    const settings = await readSettings();
    expect(settings.openaiKey).toBe(SECRET_VALUES.openaiApiKey);
    expect(settings.twilioSid).toBe(SID);
    expect(settings.openaiSipProject).toBe("proj_Abc123");
    // A value that fails its format check is left unset.
    expect(settings.twilioToken).toBeFalsy();
    expect(settings.yourPhoneNumber).toBeFalsy();
    expect(settings.twilioCallerNumber).toBeFalsy();
  });

  it("prints no secret value in a report, the CLI output or the logs", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))),
    );
    const { bb, harness } = await load(fixture);
    const outputs: string[] = [];
    for (const argv of [
      ["import", "--from", "handsfree"],
      ["import", "--from", "handsfree", "--json"],
      ["import", "--from", "handsfree", "--apply"],
    ]) {
      const result = await harness.runCli(argv);
      outputs.push(result.stdout, result.stderr);
    }
    outputs.push(JSON.stringify(await bb.storage.kv.get("import.handsfree")));
    outputs.push(...logs, JSON.stringify(harness.inspection.realtimeSignals));
    for (const spy of spies) spy.mockRestore();
    const everything = outputs.join("\n");
    for (const value of [...Object.values(SECRET_VALUES), "token-with", "4155550100"]) expect(everything).not.toContain(value);
  });
});
