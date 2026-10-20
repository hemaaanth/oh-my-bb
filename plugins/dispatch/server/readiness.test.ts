import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, SETUP_LABELS, WEBHOOK_ROUTE_LABEL } from "../shared/constants.js";
import type { SetupStatus } from "../shared/contract.js";
import { FULL_SETUP, loadPlugin, makeContext, published } from "./core-test-host.js";
import { RELOAD_DELAY_MS, readSetupStatus } from "./readiness.js";
import { needsKeyMessage } from "./settings.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const webhooks = { plugins: { list: async () => ({ plugins: [{ id: "webhooks", enabled: true, status: "running", cliCommand: null }] }) } };

afterEach(() => {
  vi.useRealTimers();
});

describe("readiness", () => {
  it("lists the label of each missing field", async () => {
    for (const id of Object.keys(FULL_SETUP) as Array<keyof typeof FULL_SETUP>) {
      const { [id]: _gone, ...rest } = FULL_SETUP;
      const { ctx } = await makeContext(rest, webhooks);
      const status = await readSetupStatus(ctx);
      expect(status.fields[id]).toBe(false);
      expect(status.phone.missing).toEqual([SETUP_LABELS[id]]);
      expect(status.phone.ready).toBe(false);
      expect(status.voice.ready).toBe(id !== "openaiKey");
      expect(status.voice.missing).toEqual(id === "openaiKey" ? [SETUP_LABELS.openaiKey] : []);
    }
  });

  it("is ready for both modes with every field and the Webhooks plugin", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP }, webhooks);
    const status = await readSetupStatus(ctx);
    expect(status.voice).toEqual({ ready: true, missing: [] });
    expect(status.phone).toEqual({ ready: true, missing: [], webhooksPlugin: "present" });
  });

  it("adds the webhook route when the Webhooks plugin is absent", async () => {
    const { ctx } = await makeContext({ ...FULL_SETUP });
    const status = await readSetupStatus(ctx);
    expect(status.phone.webhooksPlugin).toBe("absent");
    expect(status.phone.missing).toEqual([WEBHOOK_ROUTE_LABEL]);
    expect(status.voice.ready).toBe(true);
  });

  it("counts a disabled or unlisted Webhooks plugin as absent", async () => {
    const disabled = { plugins: { list: async () => ({ plugins: [{ id: "webhooks", enabled: false }] }) } };
    const { ctx } = await makeContext({ ...FULL_SETUP }, disabled);
    expect((await readSetupStatus(ctx)).phone.webhooksPlugin).toBe("absent");
    const failing = { plugins: { list: async () => Promise.reject(new Error("down")) } };
    const second = await makeContext({ ...FULL_SETUP }, failing);
    expect((await readSetupStatus(second.ctx)).phone.webhooksPlugin).toBe("absent");
  });

  it("publishes setup-updated once at load and on every change", async () => {
    const { harness } = await loadPlugin({ openaiKey: FULL_SETUP.openaiKey });
    await flush();
    expect(published(harness, CHANNELS.setupUpdated)).toHaveLength(1);
    await harness.setSettings({ twilioSid: FULL_SETUP.twilioSid });
    await flush();
    await harness.setSettings({ yourPhoneNumber: FULL_SETUP.yourPhoneNumber });
    await flush();
    const updates = published(harness, CHANNELS.setupUpdated) as SetupStatus[];
    expect(updates).toHaveLength(3);
    expect(updates[2]!.fields.yourPhoneNumber).toBe(true);
  });
});

describe("needs-configuration banner and self-reload", () => {
  it("is set at load without a key, with the label, the settings path, and the CLI form", async () => {
    const { harness } = await loadPlugin();
    expect(harness.inspection.needsConfigurationMessages).toEqual([needsKeyMessage()]);
    const message = needsKeyMessage();
    expect(message).toContain(SETUP_LABELS.openaiKey);
    expect(message).toContain("Dispatch settings");
    expect(message).toContain("bb plugin config dispatch set openaiKey");
  });

  it("is not set when only phone fields are missing", async () => {
    const { harness } = await loadPlugin({ openaiKey: FULL_SETUP.openaiKey });
    expect(harness.inspection.needsConfigurationMessages).toEqual([]);
  });

  it("reloads the plugin after the key arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness } = await loadPlugin();
    await harness.setSettings({ openaiKey: FULL_SETUP.openaiKey });
    expect(harness.inspection.sdk.callsTo("plugins.reload")).toEqual([]);
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    await flush();
    expect(harness.inspection.sdk.callsTo("plugins.reload")).toEqual([[{ pluginId: "dispatch" }]]);
  });

  it("does not reload while a call is live, and publishes reloadPending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { bb, harness } = await loadPlugin();
    bb.storage
      .database()
      .prepare("INSERT INTO calls (id, channel, device_json, started_at) VALUES (?, 'app', '{}', ?)")
      .run("call_live", Date.now());
    await harness.setSettings({ openaiKey: FULL_SETUP.openaiKey });
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    await flush();
    expect(harness.inspection.sdk.callsTo("plugins.reload")).toEqual([]);
    const last = published(harness, CHANNELS.setupUpdated).at(-1) as SetupStatus;
    expect(last.reloadPending).toBe(true);
    expect(await harness.callRpc("setupStatus", {})).toMatchObject({ reloadPending: true });
  });

  it("publishes reloadPending when the reload is refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const refused = { plugins: { reload: async () => Promise.reject(new Error("not allowed")) } };
    const { harness } = await loadPlugin(undefined, refused);
    await harness.setSettings({ openaiKey: FULL_SETUP.openaiKey });
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    await flush();
    expect(harness.inspection.sdk.callsTo("plugins.reload")).toHaveLength(1);
    const last = published(harness, CHANNELS.setupUpdated).at(-1) as SetupStatus;
    expect(last.reloadPending).toBe(true);
  });

  it("does not reload when the key was already set at load", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { harness } = await loadPlugin({ openaiKey: FULL_SETUP.openaiKey });
    await harness.setSettings({ openaiKey: "sk-another-key" });
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    expect(harness.inspection.sdk.callsTo("plugins.reload")).toEqual([]);
  });
});
