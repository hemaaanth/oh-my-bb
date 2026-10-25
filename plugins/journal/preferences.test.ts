import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server";

const read = rpcContract.journal_preferences.output;
const LEGACY = {
  aiBackend: "subscription", gatewayModel: "gpt-5.6-luna", openRouterModel: "example/model",
  intelligenceEnabled: false, automaticDailyBudgetUsd: 1.75, workTimeZone: "Asia/Tokyo", showDispatchCalls: true,
} as const;
const fixtureThread = makeThreadResponse({ id: "thr_preferences_fixture", projectId: "proj_fixture", title: "Harmless saved work", visibility: "visible" });
function world(settings: Record<string, string | number | boolean> = {}) {
  return createFakePluginHost({ pluginId: "journal", settings, sdk: {
    projects: { list: async () => [{ id: "proj_fixture", name: "Fixture" }] as never },
    threads: { list: async () => [], get: async () => fixtureThread },
    plugins: { callRpc: async () => { throw new Error("Integration unavailable in this isolated fixture"); } },
  } });
}
afterEach(() => { vi.restoreAllMocks(); });

describe("Journal preferences cutover", () => {
  it("imports all legacy values once, retains saved work and budget rows, and keeps the key out of preferences", async () => {
    const { bb, harness } = world({ ...LEGACY, openRouterApiKey: "fixture-secret-not-public" });
    await plugin(bb);
    const db = bb.storage.database();
    await harness.behavior.emitThreadEvent("thread.created", { thread: fixtureThread });
    db.prepare(`INSERT INTO journal_work_days (thread_id, day_start, first_activity_at, last_activity_at, message_count, source_seq_end, summary, category)
      VALUES ('thr_preferences_fixture', 1000, 1001, 1002, 2, 2, 'Saved work', 'feature')`).run();
    db.prepare(`INSERT INTO journal_auto_ai_budget (day_start, work_timezone, attempts, spent_usd, reserved_usd)
      VALUES (1000, 'Asia/Tokyo', 17, 0.42, 0.03)`).run();
    db.prepare(`INSERT INTO journal_thread_briefs (thread_id, brief_json, source_mark, generated_at)
      VALUES ('thr_preferences_fixture', '{}', 'fixture-mark', 1000)`).run();
    const before = ["journal_work_days", "journal_auto_ai_budget", "journal_thread_briefs"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    expect(read.parse(await harness.behavior.callRpc("journal_preferences", null)))
      .toEqual({ values: LEGACY, migrationPending: true });
    const next = await harness.lifecycle.reload(plugin);
    try {
      const view = read.parse(await next.harness.behavior.callRpc("journal_preferences", null));
      expect(view).toEqual({ values: LEGACY, migrationPending: false });
      expect(JSON.stringify(view)).not.toContain("fixture-secret-not-public");
      expect(JSON.stringify(await next.bb.storage.kv.get("journal.preferences"))).not.toContain("openRouterApiKey");
      expect(["journal_work_days", "journal_auto_ai_budget", "journal_thread_briefs"].map((table) => next.bb.storage.database().prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      await next.harness.behavior.setSettings({ openRouterApiKey: "replacement-fixture-secret" });
      await expect(next.harness.behavior.setSettings({ showDispatchCalls: false })).rejects.toThrow(/unknown setting/);
      expect(read.parse(await next.harness.behavior.callRpc("journal_preferences", null)).values).toEqual(LEGACY);
      expect(next.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await next.harness.lifecycle.dispose(); }
  });

  it("preserves preference writes and native edits during the import generation without copying secret changes", async () => {
    const { bb, harness } = world();
    await plugin(bb);
    try {
      await harness.behavior.callRpc("journal_preferences_update", { showDispatchCalls: true, automaticDailyBudgetUsd: 2 });
      await harness.behavior.setSettings({ openRouterApiKey: "fixture-key" });
      expect(read.parse(await harness.behavior.callRpc("journal_preferences", null)).values)
        .toMatchObject({ showDispatchCalls: true, automaticDailyBudgetUsd: 2 });
      await harness.behavior.setSettings({ workTimeZone: "UTC" });
      await vi.waitFor(async () => expect(read.parse(await harness.behavior.callRpc("journal_preferences", null)).values.workTimeZone).toBe("UTC"));
      expect(read.parse(await harness.behavior.callRpc("journal_preferences", null)).values)
        .toMatchObject({ showDispatchCalls: true, automaticDailyBudgetUsd: 2 });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("merges concurrent disjoint updates and retains them across reload", async () => {
    const { bb, harness } = world();
    await plugin(bb);
    await Promise.all([
      harness.behavior.callRpc("journal_preferences_update", { automaticDailyBudgetUsd: 3 }),
      harness.behavior.callRpc("journal_preferences_update", { showDispatchCalls: true, aiBackend: "subscription", gatewayModel: "gpt-5.6-luna" }),
    ]);
    const next = await harness.lifecycle.reload(plugin);
    try {
      expect(read.parse(await next.harness.behavior.callRpc("journal_preferences", null)).values)
        .toMatchObject({ automaticDailyBudgetUsd: 3, showDispatchCalls: true, aiBackend: "subscription", gatewayModel: "gpt-5.6-luna" });
    } finally { await next.harness.lifecycle.dispose(); }
  });

  it.each([
    { automaticDailyBudgetUsd: -1 }, { automaticDailyBudgetUsd: 101 }, { workTimeZone: "Not/A_Timezone" },
    { aiBackend: "paid-fallback" }, { gatewayModel: "unknown-model" }, { showDispatchCalls: "yes" }, { openRouterApiKey: "not-a-preference" },
  ])("rejects invalid updates without changing saved preferences: %j", async (patch) => {
    const { bb, harness } = world({ ...LEGACY });
    await plugin(bb);
    try {
      await expect(harness.behavior.callRpc("journal_preferences_update", patch)).rejects.toThrow();
      expect(read.parse(await harness.behavior.callRpc("journal_preferences", null)).values).toEqual(LEGACY);
      expect(await bb.storage.kv.get("journal.preferences")).toEqual(LEGACY);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("keeps the previous effective values on a failed write and accepts a later valid update", async () => {
    const { bb, harness } = world();
    await plugin(bb);
    const previous = read.parse(await harness.behavior.callRpc("journal_preferences", null));
    vi.spyOn(bb.storage.kv, "set").mockRejectedValueOnce(new Error("fixture storage failure"));
    try {
      await expect(harness.behavior.callRpc("journal_preferences_update", { aiBackend: "subscription" })).rejects.toThrow(/fixture storage failure/);
      expect(read.parse(await harness.behavior.callRpc("journal_preferences", null))).toEqual(previous);
      await harness.behavior.callRpc("journal_preferences_update", { workTimeZone: "UTC" });
      expect(read.parse(await harness.behavior.callRpc("journal_preferences", null)).values)
        .toMatchObject({ aiBackend: "openrouter", workTimeZone: "UTC" });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("updates typed values through the replacement CLI and rejects ambiguous booleans and secret keys", async () => {
    const { bb, harness } = world({ openRouterApiKey: "fixture-secret-not-in-cli" });
    await plugin(bb);
    try {
      const result = await harness.behavior.runCli(["preferences", "set", "automaticDailyBudgetUsd", "2.25", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout!)).toMatchObject({ values: { automaticDailyBudgetUsd: 2.25, showDispatchCalls: false } });
      expect((await harness.behavior.runCli(["preferences", "set", "showDispatchCalls", "true"])).exitCode).toBe(0);
      expect((await harness.behavior.runCli(["preferences", "set", "showDispatchCalls", "yes"])).exitCode).toBe(1);
      expect((await harness.behavior.runCli(["preferences", "set", "openRouterApiKey", "forbidden"])).exitCode).toBe(1);
      const list = await harness.behavior.runCli(["preferences", "--json"]);
      expect(list.stdout).not.toContain("fixture-secret-not-in-cli");
      expect(JSON.parse(list.stdout!)).toMatchObject({ values: { automaticDailyBudgetUsd: 2.25, showDispatchCalls: true } });
    } finally { await harness.lifecycle.dispose(); }
  });
});
