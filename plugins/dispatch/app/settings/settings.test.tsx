// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_NAME_MAX, defaultPreferences, INSTRUCTIONS_LIMIT } from "../../shared/constants.js";
import type { InstructionRevision } from "../../shared/contract.js";
import { installFakeLocalStorage, makePrefsRpc, makeStatus } from "./support.js";
import { SAMPLE_COST_NOTE, SAMPLE_PROGRESS } from "./voice.js";

const stored = installFakeLocalStorage();
const app = await loadPluginApp(() => import("../index.js"));

const registration = (id: string) => {
  const found = app.settingsSections.find((section) => section.id === id);
  if (!found) throw new Error(`no settings section ${id}`);
  return found;
};
const mount = (id: string, rpc: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  renderSlot(registration(id), {}, { rpc: rpc as never, pluginId: "dispatch", ...extra });

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
});
afterEach(() => cleanup());

describe("Readiness", () => {
  it("shows one line per mode from the status", async () => {
    const status = makeStatus({
      voice: { ready: true, missing: [] },
      phone: { ready: false, missing: ["Phone calls — Twilio Account SID", "Phone calls — Twilio Auth Token"], webhooksPlugin: "absent" },
    });
    mount("readiness", { setupStatus: async () => status });
    const voice = (await screen.findByText("In-app voice")).parentElement!;
    expect(within(voice).getByText("Ready")).toBeTruthy();
    expect(screen.getByText(/Needs: Twilio Account SID, Twilio Auth Token/)).toBeTruthy();
    expect(screen.getByText("Webhooks plugin not found.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up phone calls" }).getAttribute("href")).toContain("docs/phone-calls.md");
    expect(screen.queryByText("bb dispatch status")).toBeNull();
  });

  it("reports the Webhooks plugin when it is present", async () => {
    mount("readiness", { setupStatus: async () => makeStatus({ phone: { ready: true, missing: [], webhooksPlugin: "present" } }) });
    const toggle = await screen.findByRole("button", { name: "Phone setup" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Webhooks plugin found. Endpoint not verified.")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Webhooks plugin found. Endpoint not verified.")).toBeTruthy();
  });

  it("never renders a value, even one that sneaks into the payload", async () => {
    const leaky = { ...makeStatus(), openaiKey: "sk-live-do-not-show", extra: { twilioToken: "tok-do-not-show" } };
    const view = mount("readiness", { setupStatus: async () => leaky });
    await screen.findByText("In-app voice");
    expect(view.container.textContent).not.toContain("sk-live-do-not-show");
    expect(view.container.textContent).not.toContain("tok-do-not-show");
  });

  it("shows the Reload to apply row only while a reload is pending, and the button reloads dispatch", async () => {
    const reload = vi.fn(async () => ({ reloaded: true }));
    const view = mount("readiness", { setupStatus: async () => makeStatus({ reloadPending: true }) }, { sdk: { plugins: { reload } } as never });
    const button = await screen.findByRole("button", { name: "Reload to apply" });
    fireEvent.click(button);
    await waitFor(() => expect(reload).toHaveBeenCalledWith({ pluginId: "dispatch" }));
    expect(view.inspection.sdkCalls.some((call) => call.method === "plugins.reload")).toBe(true);
  });

  it("hides the Reload to apply row when nothing is pending", async () => {
    mount("readiness", { setupStatus: async () => makeStatus({ reloadPending: false }) });
    await screen.findByText("In-app voice");
    expect(screen.queryByRole("button", { name: "Reload to apply" })).toBeNull();
  });

  it("follows setup-updated without polling", async () => {
    const view = mount("readiness", { setupStatus: async () => makeStatus() });
    await screen.findByText(/Needs: OpenAI API key/);
    await view.emitRealtime("setup-updated", makeStatus({ voice: { ready: true, missing: [] }, reloadPending: true }));
    await waitFor(() => expect(screen.queryByText(/Needs: OpenAI API key/)).toBeNull());
    expect(screen.getByRole("button", { name: "Reload to apply" })).toBeTruthy();
    expect(view.inspection.rpcCalls.filter((call) => call.method === "setupStatus")).toHaveLength(1);
  });
});

const revision = (id: number, body: string, over: Partial<InstructionRevision> = {}): InstructionRevision => ({ id, at: Date.UTC(2026, 9, 19, 12), author: "user", note: "", body, ...over });

function agentRpc(prefs = makePrefsRpc(), current: InstructionRevision | null = revision(3, "Be brief.\nNo emoji."), hasKey = true) {
  const writeInstructions = vi.fn(async ({ body }: { body: string }) => revision(9, body));
  const restore = vi.fn(async ({ id }: { id: number }) => revision(10, id === 2 ? "Old text" : "x", { author: "user", note: `restored ${id}` }));
  const history = [revision(3, "Be brief.\nNo emoji."), revision(2, "Old text", { author: "agent", note: "agent edit" })];
  const sample = vi.fn(async (_input: { voice: string; style: string }) => ({ audio: "UklGRg==", mime: "audio/wav", source: "live" as const }));
  const create = vi.fn(async ({ name, prompt }: { name: string; prompt: string }) =>
    prefs.handlers.preferencesWrite({ customVoices: [...prefs.current.customVoices, { id: "voice_1", name, prompt, createdAt: "2026-10-20T00:00:00.000Z" }] }),
  );
  return {
    prefs,
    writeInstructions,
    restore,
    sample,
    create,
    handlers: {
      ...prefs.handlers,
      setupStatus: async () => makeStatus({ fields: { ...makeStatus().fields, openaiKey: hasKey } }),
      voiceSample: sample,
      voiceCreate: create,
      voiceRemove: async ({ id }: { id: string }) => prefs.handlers.preferencesWrite({ customVoices: prefs.current.customVoices.filter((voice) => voice.id !== id) }),
      instructionsRead: async () => ({ current, limit: INSTRUCTIONS_LIMIT }),
      instructionsWrite: writeInstructions,
      instructionsHistory: async () => ({ revisions: history }),
      instructionsRestore: restore,
      promptPreview: async () => ({
        voice: { builtIn: "VOICE-BUILTIN", runtime: "VOICE-RUNTIME", yours: "VOICE-YOURS", assembled: "all" },
        backend: { builtIn: "BACK-BUILTIN", runtime: "BACK-RUNTIME", yours: "BACK-YOURS", assembled: "all" },
      }),
    },
  };
}

describe("Agent", () => {
  it("limits the name and saves on Enter", async () => {
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(input.maxLength).toBe(AGENT_NAME_MAX);
    fireEvent.change(input, { target: { value: "N".repeat(40) } });
    expect(input.value).toHaveLength(AGENT_NAME_MAX);
    fireEvent.change(input, { target: { value: "Mira" } });
    expect(screen.getByText(/Say “Mira, …”/)).toBeTruthy();
    // Enter blurs a focused field, and the blur saves once.
    act(() => input.focus());
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(document.activeElement).not.toBe(input);
    await waitFor(() => expect(rpc.prefs.writes).toEqual([{ agentName: "Mira" }]));
  });

  it("reverts the name on Escape and ignores an empty name", async () => {
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    const input = (await screen.findByLabelText("Name")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Zed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("Juno");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(input.value).toBe("Juno");
    expect(rpc.prefs.writes).toEqual([]);
  });

  it("shows the instructions counter and blocks Save over the limit", async () => {
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    const box = (await screen.findByLabelText("Your instructions")) as HTMLTextAreaElement;
    expect(screen.getByText("19 / 4,000")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "a".repeat(INSTRUCTIONS_LIMIT + 1) } });
    expect(screen.getByText("4,001 / 4,000")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Short." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rpc.writeInstructions).toHaveBeenCalledWith({ body: "Short." }));
  });

  it("reverts the draft to the saved text", async () => {
    mount("agent", agentRpc().handlers);
    const box = (await screen.findByLabelText("Your instructions")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(box.value).toBe("Be brief.\nNo emoji.");
  });

  it("takes instructions-updated into an untouched draft", async () => {
    const view = mount("agent", agentRpc().handlers);
    const box = (await screen.findByLabelText("Your instructions")) as HTMLTextAreaElement;
    await view.emitRealtime("instructions-updated", revision(11, "From the agent", { author: "agent" }));
    await waitFor(() => expect(box.value).toBe("From the agent"));
  });

  it("previews the prompt in three parts for both layers", async () => {
    mount("agent", agentRpc().handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Full prompt" }));
    const voice = await screen.findByRole("region", { name: "Voice prompt" });
    expect(within(voice).getAllByRole("heading", { level: 5 }).map((h) => h.textContent)).toEqual(["Built in", "Runtime context (sample)", "Your instructions"]);
    expect(within(voice).getByText("VOICE-BUILTIN")).toBeTruthy();
    expect(within(voice).getByText("VOICE-RUNTIME")).toBeTruthy();
    expect(within(voice).getByText("VOICE-YOURS")).toBeTruthy();
    const backend = screen.getByRole("region", { name: "Backend prompt" });
    expect(within(backend).getByText("BACK-YOURS")).toBeTruthy();
  });

  it("lists the history and restores a revision", async () => {
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Instruction history (2)" }));
    expect(screen.getByText("agent edit")).toBeTruthy();
    expect(screen.getByText("Old text")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Restore" }) as HTMLButtonElement[];
    expect(buttons[0]!.disabled).toBe(true); // the current text
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(rpc.restore).toHaveBeenCalledWith({ id: 2 }));
    await waitFor(() => expect((screen.getByLabelText("Your instructions") as HTMLTextAreaElement).value).toBe("Old text"));
  });

  it("keeps empty history hidden", async () => {
    const rpc = agentRpc();
    mount("agent", { ...rpc.handlers, instructionsHistory: async () => ({ revisions: [] }) });
    await screen.findByLabelText("Your instructions");
    expect(screen.queryByText(/Instruction history/)).toBeNull();
  });

  it("lists the voices in groups with their details and saves a choice", async () => {
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    const live = await screen.findByRole("region", { name: "GPT-Live" });
    const gleam = within(live).getByRole("button", { name: /^Gleam/ });
    expect(gleam.getAttribute("aria-pressed")).toBe("true");
    expect(gleam.textContent).toContain("English, North American · Feminine");
    expect(within(live).getByRole("button", { name: /^Marin/ }).textContent).toContain("GPT-Live default");
    const realtime = screen.getByRole("region", { name: "Realtime (unconfirmed)" });
    expect(within(realtime).getByText(/GPT-Live may refuse them/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Nova/ })).toBeNull();
    fireEvent.click(within(realtime).getByRole("button", { name: /^Sage/ }));
    await waitFor(() => expect(rpc.prefs.writes).toEqual([{ voice: "sage" }]));
  });

  it("keeps an unknown saved voice visible and chosen", async () => {
    const rpc = agentRpc(makePrefsRpc({ voice: "nova" }));
    mount("agent", rpc.handlers);
    const saved = await screen.findByRole("region", { name: "Saved voice" });
    const nova = within(saved).getByRole("button", { name: /^nova/ });
    expect(nova.getAttribute("aria-pressed")).toBe("true");
    expect(nova.textContent).toContain("No longer listed");
    expect(rpc.prefs.writes).toEqual([]);
  });

  it("plays one sample at a time and stops on a second press", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    expect(await screen.findByText(SAMPLE_COST_NOTE)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Play Gleam" }));
    await waitFor(() => expect(rpc.sample).toHaveBeenCalledWith({ voice: "gleam", style: "default" }));
    const stop = await screen.findByRole("button", { name: "Stop Gleam" });
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Play Ripple" }));
    expect(pause).toHaveBeenCalled();
    await screen.findByRole("button", { name: "Stop Ripple" });
    expect(screen.queryByRole("button", { name: "Stop Gleam" })).toBeNull();
    expect(stop.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop Ripple" }));
    expect(await screen.findByRole("button", { name: "Play Ripple" })).toBeTruthy();
    play.mockRestore();
    pause.mockRestore();
  });

  it("plays the built-in samples without an OpenAI key and disables the rest", async () => {
    const calm = { id: "voice_1", name: "Calm", prompt: "A calm voice.", createdAt: "2026-10-20T00:00:00.000Z" };
    const rpc = agentRpc(makePrefsRpc({ customVoices: [calm] }), undefined, false);
    mount("agent", rpc.handlers);
    expect(await screen.findByText(/Add an OpenAI API key in Setup/)).toBeTruthy();
    const enabled = (name: string) => !(screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
    expect(enabled("Play Gleam")).toBe(true);
    expect(enabled("Play Calm")).toBe(false);
    expect(enabled("Preview with this style")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Design a voice" }));
    expect(enabled("Create voice")).toBe(false);
  });

  it("needs a key to preview a changed style", async () => {
    const rpc = agentRpc(makePrefsRpc({ voiceStyle: { ...defaultPreferences().voiceStyle, pace: "brisk" } }), undefined, false);
    mount("agent", rpc.handlers);
    expect(((await screen.findByRole("button", { name: "Preview with this style" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says a new sample is being made, but not for a built-in one", async () => {
    const calm = { id: "voice_1", name: "Calm", prompt: "A calm voice.", createdAt: "2026-10-20T00:00:00.000Z" };
    const rpc = agentRpc(makePrefsRpc({ customVoices: [calm] }));
    const pending = vi.fn(() => new Promise<never>(() => {}));
    mount("agent", { ...rpc.handlers, voiceSample: pending });
    fireEvent.click(await screen.findByRole("button", { name: "Play Gleam" }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByText(SAMPLE_PROGRESS)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play Calm" }));
    expect(await screen.findByText(SAMPLE_PROGRESS)).toBeTruthy();
    expect(pending).toHaveBeenLastCalledWith({ voice: "voice_1", style: "default" });
  });

  it("saves a voice style choice and the notes on blur", async () => {
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    const pace = await screen.findByRole("group", { name: "Pace" });
    fireEvent.click(within(pace).getByRole("button", { name: "Brisk" }));
    await waitFor(() => expect(rpc.prefs.writes[0]?.voiceStyle?.pace).toBe("brisk"));
    await waitFor(() => expect(within(pace).getByRole("button", { name: "Brisk" }).getAttribute("aria-pressed")).toBe("true"));
    const notes = screen.getByLabelText("Style notes") as HTMLTextAreaElement;
    expect(notes.maxLength).toBe(500);
    fireEvent.change(notes, { target: { value: "Spell out numbers." } });
    fireEvent.blur(notes);
    await waitFor(() => expect(rpc.prefs.writes[1]?.voiceStyle).toMatchObject({ pace: "brisk", notes: "Spell out numbers." }));
  });

  it("designs a voice and lists it under Your voices", async () => {
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Design a voice" }));
    const prompt = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(prompt.placeholder).toMatch(/^A calm, reassuring adult voice/);
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Calm" } });
    fireEvent.change(prompt, { target: { value: "A calm voice." } });
    fireEvent.click(screen.getByRole("button", { name: "Create voice" }));
    await waitFor(() => expect(rpc.create).toHaveBeenCalledWith({ name: "Calm", prompt: "A calm voice." }));
    const yours = await screen.findByRole("region", { name: "Your voices" });
    expect(within(yours).getByRole("button", { name: /^Calm/ })).toBeTruthy();
  });

  it("shows the voice design error", async () => {
    const rpc = agentRpc();
    mount("agent", { ...rpc.handlers, voiceCreate: async () => Promise.reject(new Error("Your OpenAI key cannot create voices.")) });
    fireEvent.click(await screen.findByRole("button", { name: "Design a voice" }));
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Calm" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A calm voice." } });
    fireEvent.click(screen.getByRole("button", { name: "Create voice" }));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot create voices");
  });
});

