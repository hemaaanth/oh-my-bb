// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_NAME_MAX, INSTRUCTIONS_LIMIT } from "../../shared/constants.js";
import type { InstructionRevision } from "../../shared/contract.js";
import { installFakeLocalStorage, makePrefsRpc, makeStatus } from "./support.js";

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
    const voice = (await screen.findByText("In-app voice")).closest("div.flex-col, div")!.parentElement!;
    expect(within(voice).getByText("Ready")).toBeTruthy();
    const phoneLine = screen.getByText("Phone calls").parentElement!.parentElement!;
    expect(phoneLine.textContent).toContain("Needs: Twilio Account SID, Twilio Auth Token");
    expect(screen.getByText("Webhooks plugin not found")).toBeTruthy();
    expect(screen.getByText("bb dispatch status")).toBeTruthy();
  });

  it("reports the Webhooks plugin when it is present", async () => {
    mount("readiness", { setupStatus: async () => makeStatus({ phone: { ready: true, missing: [], webhooksPlugin: "present" } }) });
    expect(await screen.findByText("Webhooks plugin found")).toBeTruthy();
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

function agentRpc(prefs = makePrefsRpc(), current: InstructionRevision | null = revision(3, "Be brief.\nNo emoji.")) {
  const writeInstructions = vi.fn(async ({ body }: { body: string }) => revision(9, body));
  const restore = vi.fn(async ({ id }: { id: number }) => revision(10, id === 2 ? "Old text" : "x", { author: "user", note: `restored ${id}` }));
  const history = [revision(3, "Be brief.\nNo emoji."), revision(2, "Old text", { author: "agent", note: "agent edit" })];
  return {
    prefs,
    writeInstructions,
    restore,
    handlers: {
      ...prefs.handlers,
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
    fireEvent.click(await screen.findByRole("button", { name: "Show full prompt" }));
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
    expect(await screen.findByText("agent edit")).toBeTruthy();
    expect(screen.getByText("Old text")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Restore" }) as HTMLButtonElement[];
    expect(buttons[0]!.disabled).toBe(true); // the current text
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(rpc.restore).toHaveBeenCalledWith({ id: 2 }));
    await waitFor(() => expect((screen.getByLabelText("Your instructions") as HTMLTextAreaElement).value).toBe("Old text"));
  });

  it("saves the voice", async () => {
    const rpc = agentRpc();
    mount("agent", rpc.handlers);
    fireEvent.change(await screen.findByLabelText("Voice"), { target: { value: "sage" } });
    await waitFor(() => expect(rpc.prefs.writes).toEqual([{ voice: "sage" }]));
  });
});

