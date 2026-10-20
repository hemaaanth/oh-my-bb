import { describe, expect, it } from "vitest";
import { CHANNELS, KV_KEYS, defaultPreferences } from "../shared/constants.js";
import { loadPlugin, makeContext, published } from "./core-test-host.js";
import { normaliseAgentName, normalisePreferences, readPreferences, resetPreferences, writePreferences } from "./preferences.js";

describe("preference normalisation", () => {
  it("drops unknown fields and keeps the defaults for missing ones", () => {
    const result = normalisePreferences({ agentName: "Ivy", favouriteColour: "teal", pet: { size: 9 } });
    expect(result).toEqual({ ...defaultPreferences(), agentName: "Ivy" });
    expect(Object.keys(result)).not.toContain("favouriteColour");
    expect(Object.keys(result.pet)).not.toContain("size");
  });

  it("clamps and rounds the pet roundness", () => {
    expect(normalisePreferences({ pet: { roundness: 140 } }).pet.roundness).toBe(100);
    expect(normalisePreferences({ pet: { roundness: -3 } }).pet.roundness).toBe(0);
    expect(normalisePreferences({ pet: { roundness: 33.6 } }).pet.roundness).toBe(34);
    expect(normalisePreferences({ pet: { roundness: "round" } }).pet.roundness).toBe(50);
  });

  it("keeps the fallback for values outside an enum", () => {
    const result = normalisePreferences({
      voiceModel: "gpt-2",
      reasoningModel: "gpt-5.6-sol",
      mobileDrawerBehavior: "sometimes",
      pet: { style: "glitter", color: "#ABC" },
    });
    expect(result.voiceModel).toBe("gpt-live-1");
    expect(result.reasoningModel).toBe("gpt-5.6-sol");
    expect(result.mobileDrawerBehavior).toBe("reuse");
    expect(result.pet.style).toBe("outline");
    expect(result.pet.color).toBe("#abc");
    expect(normalisePreferences({ pet: { color: "red" } }).pet.color).toBe("theme");
  });

  it("keeps an unknown saved voice and falls back only for a value that is not a name", () => {
    expect(normalisePreferences({ voice: "nova" }).voice).toBe("nova");
    expect(normalisePreferences({ voice: "  robot " }).voice).toBe("robot");
    expect(normalisePreferences({ voice: 7 }).voice).toBe("gleam");
    expect(normalisePreferences({ voice: "   " }).voice).toBe("gleam");
    expect(normalisePreferences({ voice: "x".repeat(65) }, { ...defaultPreferences(), voice: "sage" }).voice).toBe("sage");
  });

  it("checks each voice style choice and trims the notes", () => {
    const style = normalisePreferences({ voiceStyle: { pace: "brisk", energy: "loud", expressiveness: "flat", notes: `  ${"n".repeat(600)}` } }).voiceStyle;
    expect(style).toEqual({ pace: "brisk", energy: "neutral", expressiveness: "flat", length: "balanced", backchannels: "moderate", notes: "n".repeat(500) });
  });

  it("keeps only custom voices with a voice_ id, once each", () => {
    const voices = normalisePreferences({
      customVoices: [
        { id: "voice_a", name: " Calm ", prompt: "A calm voice.", createdAt: "2026-10-20T00:00:00.000Z" },
        { id: "voice_a", name: "Again", prompt: "", createdAt: "" },
        { id: "alloy", name: "Not custom", prompt: "", createdAt: "" },
        { id: "voice_b" },
        "voice_c",
      ],
    }).customVoices;
    expect(voices).toEqual([
      { id: "voice_a", name: "Calm", prompt: "A calm voice.", createdAt: "2026-10-20T00:00:00.000Z" },
      { id: "voice_b", name: "voice_b", prompt: "", createdAt: "" },
    ]);
  });

  it("validates hotkey strings", () => {
    expect(normalisePreferences({ hotkeys: { toggle: "Alt+J" } }).hotkeys.toggle).toBe("Alt+J");
    expect(normalisePreferences({ hotkeys: { toggle: "J" } }).hotkeys.toggle).toBe("Mod+Shift+H");
    expect(normalisePreferences({ hotkeys: { toggle: "Banana+J" } }).hotkeys.toggle).toBe("Mod+Shift+H");
    // Two actions cannot share a combination; the toggle wins.
    const shared = normalisePreferences({ hotkeys: { toggle: "Alt+J", mute: "Alt+J" } }).hotkeys;
    expect(shared.toggle).toBe("Alt+J");
    expect(shared.mute).not.toBe("Alt+J");
  });

  it("checks plugin access", () => {
    expect(normalisePreferences({ pluginAccess: { mode: "none" } }).pluginAccess).toEqual({ mode: "none" });
    expect(normalisePreferences({ pluginAccess: { mode: "selected", ids: [" notes ", "notes", 4, ""] } }).pluginAccess).toEqual({
      mode: "selected",
      ids: ["notes"],
    });
    expect(normalisePreferences({ pluginAccess: { mode: "some" } }).pluginAccess).toEqual({ mode: "all" });
  });

  it("trims the agent name to 24 characters and falls back to Juno", () => {
    expect(normaliseAgentName("  Aurora  ")).toBe("Aurora");
    expect(normaliseAgentName("x".repeat(30))).toHaveLength(24);
    expect(normaliseAgentName("   ")).toBe("Juno");
    expect(normaliseAgentName(42)).toBe("Juno");
  });
});

describe("preference storage", () => {
  it("merges a voice style patch onto the saved style", async () => {
    const { ctx } = await makeContext();
    await writePreferences(ctx, { voiceStyle: { pace: "faster" } });
    const saved = await writePreferences(ctx, { voiceStyle: { energy: "warm" } });
    expect(saved.voiceStyle).toMatchObject({ pace: "faster", energy: "warm", length: "balanced" });
  });

  it("merges a write, stores it, and publishes preferences-updated", async () => {
    const { ctx, harness } = await makeContext();
    const saved = await writePreferences(ctx, { agentName: "Ivy", pet: { roundness: 80 }, unknown: true });
    expect(saved.agentName).toBe("Ivy");
    expect(saved.pet).toEqual({ ...defaultPreferences().pet, roundness: 80 });
    expect(await readPreferences(ctx)).toEqual(saved);
    expect(published(harness, CHANNELS.preferencesUpdated)).toEqual([saved]);
  });

  it("recovers from a bad stored value field by field", async () => {
    const { ctx, bb } = await makeContext();
    await bb.storage.kv.set(KV_KEYS.preferences, { voice: 7, agentName: "Ivy" });
    expect(await readPreferences(ctx)).toEqual({ ...defaultPreferences(), agentName: "Ivy" });
  });

  it("resets to the defaults", async () => {
    const { ctx } = await makeContext();
    await writePreferences(ctx, { agentName: "Ivy" });
    expect(await resetPreferences(ctx)).toEqual(defaultPreferences());
  });

  it("serves the RPC methods", async () => {
    const { harness } = await loadPlugin();
    const written = (await harness.callRpc("preferencesWrite", { announcements: false })) as { announcements: boolean };
    expect(written.announcements).toBe(false);
    expect(await harness.callRpc("preferencesRead", {})).toEqual(written);
    expect(published(harness, CHANNELS.preferencesUpdated)).toHaveLength(1);
  });
});
