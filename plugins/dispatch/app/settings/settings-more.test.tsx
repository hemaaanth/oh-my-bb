// @vitest-environment jsdom
import { setTimeout as delay } from "node:timers/promises";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences, LOCAL_KEYS, REASONING_MODELS } from "../../shared/constants.js";
import { chooseSetting, installFakeLocalStorage, makePrefsRpc, makeStatus, openSetting } from "./support.js";

const stored = installFakeLocalStorage();
const app = await loadPluginApp(() => import("../index.js"));

const mount = (section: (typeof app.settingsSections)[number], rpc: Record<string, unknown>) => renderSlot(section, {}, { rpc: rpc as never, pluginId: "dispatch" });
const byId = (id: string) => {
  const found = app.settingsSections.find((section) => section.id === id);
  if (!found) throw new Error(`no settings section ${id}`);
  return found;
};

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("Appearance", () => {
  it("sets the preview mood from the picker", async () => {
    mount(byId("appearance"), makePrefsRpc().handlers);
    const preview = await screen.findByRole("img", { name: /Pet preview/ });
    expect(preview.getAttribute("data-mood")).toBe("awake");
    await chooseSetting("Preview mood", "Asleep");
    const asleep = screen.getByRole("img", { name: /Pet preview/ });
    expect(asleep.getAttribute("data-mood")).toBe("asleep");
    // The preview is the footer's own pet, showing the matching face.
    expect(asleep.querySelector(".dispatch-pet")?.getAttribute("data-mood")).toBe("sleep");
    expect(asleep.querySelector("agent-robot-avatar")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Preview mood" }).textContent).toBe("Asleep");
  });

  it("writes a whole normalised pet for each look change", async () => {
    const prefs = makePrefsRpc();
    mount(byId("appearance"), prefs.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Solid" }));
    await waitFor(() => expect(prefs.writes).toHaveLength(1));
    expect(prefs.writes[0]).toEqual({ pet: { ...prefs.current.pet, style: "solid" } });

    fireEvent.click(screen.getByRole("button", { name: "Colour #30a46c" }));
    await waitFor(() => expect(prefs.writes).toHaveLength(2));
    expect(prefs.writes[1]).toEqual({ pet: { ...prefs.current.pet, style: "solid", color: "#30a46c" } });

    fireEvent.change(screen.getByLabelText("Head shape"), { target: { value: "20" } });
    await waitFor(() => expect(prefs.current.pet.roundness).toBe(20));
    expect(prefs.current.pet).toMatchObject({ style: "solid", color: "#30a46c", roundness: 20 });
    expect(Object.keys(prefs.current.pet).sort()).toEqual(["antennaFlash", "color", "followPointer", "roundness", "style"]);

    const flashBefore = prefs.current.pet.antennaFlash;
    fireEvent.click(screen.getByRole("switch", { name: "Flash the antenna" }));
    await waitFor(() => expect(prefs.current.pet.antennaFlash).toBe(!flashBefore));
  });

  it("commits complete custom colours, rejects incomplete input and cancels edits", async () => {
    const prefs = makePrefsRpc();
    const originalLook = prefs.current.pet;
    mount(byId("appearance"), prefs.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Custom colour" }));
    const input = screen.getByRole("textbox", { name: "Hex colour" });
    fireEvent.change(input, { target: { value: "#12" } });
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(prefs.writes).toEqual([]);
    fireEvent.change(input, { target: { value: "A1B2C3" } });
    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(prefs.current.pet.color).toBe("#a1b2c3"));
    expect(prefs.current.pet).toEqual({ ...originalLook, color: "#a1b2c3" });
    const writes = prefs.writes.length;
    fireEvent.change(input, { target: { value: "#ffffff" } });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Custom colour" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Custom colour" }));
    expect((screen.getByRole("textbox", { name: "Hex colour" }) as HTMLInputElement).value).toBe("#a1b2c3");
    expect(prefs.writes).toHaveLength(writes);
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));
    await waitFor(() => expect(prefs.current.pet.color).toBe("theme"));
    expect((screen.getByRole("textbox", { name: "Hex colour" }) as HTMLInputElement).value).toBe("");
  });

  it("keeps a complete hex edit when the popover is dismissed outside", async () => {
    const prefs = makePrefsRpc();
    mount(byId("appearance"), prefs.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Custom colour" }));
    const input = screen.getByRole("textbox", { name: "Hex colour" });
    input.focus();
    fireEvent.change(input, { target: { value: "#123abc" } });
    // Radix attaches its outside-pointer listener after the opening event.
    await act(() => delay(0));
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(prefs.current.pet.color).toBe("#123abc"));
    expect(screen.queryByRole("dialog", { name: "Custom colour" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Custom colour" }));
    expect((screen.getByRole("textbox", { name: "Hex colour" }) as HTMLInputElement).value).toBe("#123abc");
  });

  it("previews visual colour changes and persists the final choice across remounts", async () => {
    const originalLook = { ...defaultPreferences().pet, color: "#ff0000" };
    const prefs = makePrefsRpc({ pet: originalLook });
    const section = mount(byId("appearance"), prefs.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Custom colour" }));
    expect(prefs.writes).toEqual([]);
    const hue = screen.getByRole("slider", { name: "Hue" });
    fireEvent.keyDown(hue, { key: "ArrowRight", keyCode: 39, which: 39 });
    expect((section.container.querySelector(".dispatch-pet-preview") as HTMLElement).style.color).toBe("rgb(255, 77, 0)");
    expect(prefs.current.pet.color).toBe("#ff0000");
    fireEvent.keyUp(hue, { key: "ArrowRight", keyCode: 39, which: 39 });
    await waitFor(() => expect(prefs.current.pet).toEqual({ ...originalLook, color: "#ff4d00" }));
    section.unmount();
    mount(byId("appearance"), prefs.handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Custom colour" }));
    expect((screen.getByRole("textbox", { name: "Hex colour" }) as HTMLInputElement).value).toBe("#ff4d00");
  });

  it("keeps the pointer ghost on this device", async () => {
    const prefs = makePrefsRpc();
    mount(byId("appearance"), prefs.handlers);
    const toggle = await screen.findByRole("switch", { name: "Pointer ghost" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(stored[LOCAL_KEYS.pointerGhost]).toBe("off"));
    expect(prefs.writes).toEqual([]);
    fireEvent.click(screen.getByRole("switch", { name: "Pointer ghost" }));
    await waitFor(() => expect(stored[LOCAL_KEYS.pointerGhost]).toBeUndefined());
  });
});

function keydown(init: KeyboardEventInit & { key: string }) {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("Calls", () => {
  it("refuses reserved and weak shortcuts and accepts a good one", async () => {
    const prefs = makePrefsRpc();
    mount(byId("calls"), prefs.handlers);
    await screen.findByText("Start or stop a call");
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);

    keydown({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
    expect((await screen.findByRole("alert")).textContent).toContain("BB command palette");
    keydown({ key: "k", code: "KeyK" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Hold Ctrl"));
    keydown({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already uses"));
    expect(prefs.writes).toEqual([]);

    keydown({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(prefs.writes).toEqual([{ hotkeys: { toggle: "Mod+Shift+K", mute: "Mod+Shift+U" } }]));
    expect(screen.queryByText("Press the new keys…")).toBeNull();
  });

  it("cancels recording on a bare Escape", async () => {
    const prefs = makePrefsRpc();
    mount(byId("calls"), prefs.handlers);
    await screen.findByText("Mute or unmute");
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[1]!);
    keydown({ key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByText("Press the new keys…")).toBeNull());
    expect(prefs.writes).toEqual([]);
  });

  it("hides microphone names until access is granted", async () => {
    let granted = false;
    const stop = vi.fn();
    const labelled = [
      { kind: "audioinput", deviceId: "mic-a", label: "Desk mic", groupId: "g" },
      { kind: "audioinput", deviceId: "mic-b", label: "Headset", groupId: "g" },
    ];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => labelled.map((device) => ({ ...device, label: granted ? device.label : "" })),
        getUserMedia: async () => {
          granted = true;
          return { getTracks: () => [{ stop }] };
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    mount(byId("calls"), makePrefsRpc().handlers);
    await openSetting("Microphone");
    const anonymous = await screen.findByRole("option", { name: "Microphone 1" });
    expect(screen.queryByRole("option", { name: "Desk mic" })).toBeNull();
    fireEvent.keyDown(anonymous, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Grant access" })).toBeNull());
    expect(stop).toHaveBeenCalled();

    await openSetting("Microphone");
    expect(await screen.findByRole("option", { name: "Desk mic" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Headset" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved for this device.")).toBeTruthy();
    expect(JSON.parse(stored[LOCAL_KEYS.audio]!)).toMatchObject({ inputDeviceId: "mic-b" });
    await chooseSetting("Microphone", "System default");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(JSON.parse(stored[LOCAL_KEYS.audio]!)).toMatchObject({ inputDeviceId: null }));
  });

  it("leaves out devices without an id, as some browsers list them before access", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [{ kind: "audioinput", deviceId: "", label: "", groupId: "" }],
        getUserMedia: async () => ({ getTracks: () => [] }),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    mount(byId("calls"), makePrefsRpc().handlers);
    await openSetting("Microphone");
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["System default"]);
  });

  it("shows system default for a missing saved microphone without overwriting the device choice", async () => {
    stored[LOCAL_KEYS.audio] = JSON.stringify({ inputDeviceId: "unplugged", outputDeviceId: null });
    mount(byId("calls"), makePrefsRpc().handlers);
    expect((await screen.findByRole("combobox", { name: "Microphone" })).textContent).toBe("System default");
    expect(JSON.parse(stored[LOCAL_KEYS.audio]!).inputDeviceId).toBe("unplugged");
  });

  it("keeps an unsupported speaker picker disabled", async () => {
    mount(byId("calls"), makePrefsRpc().handlers);
    const speaker = await screen.findByRole("combobox", { name: "Speaker" }) as HTMLButtonElement;
    expect(speaker.disabled).toBe(true);
    expect(speaker.textContent).toBe("System default");
  });

  it("writes announcements and the drawer behaviour", async () => {
    const prefs = makePrefsRpc();
    mount(byId("calls"), prefs.handlers);
    fireEvent.click(await screen.findByRole("switch", { name: "Announcements" }));
    await waitFor(() => expect(prefs.writes).toContainEqual({ announcements: false }));
    await chooseSetting("Mobile drawer behaviour", "Open a new view");
    await waitFor(() => expect(prefs.current.mobileDrawerBehavior).toBe("new"));
  });

  it("shows only the mobile rows on the mobile page", async () => {
    mount(app.settingsSections.find((section) => section.experimental_page === "mobile")!, makePrefsRpc().handlers);
    await screen.findByLabelText("Microphone");
    expect(screen.getByRole("switch", { name: "Announcements" })).toBeTruthy();
    expect(screen.getByLabelText("Mobile drawer behaviour")).toBeTruthy();
    expect(screen.queryByText("Start or stop a call")).toBeNull();
    expect(screen.queryByLabelText("Speaker")).toBeNull();
  });
});

describe("Tools", () => {
  const plugins = async () => ({
    plugins: [
      { id: "dispatch", name: "Dispatch", command: "dispatch", summary: "self" },
      { id: "linear", name: "Linear", command: "linear", summary: "Issues" },
      { id: "notes", name: "Notes", command: "notes", summary: "Notes" },
    ],
  });

  it("writes plugin access and the checklist", async () => {
    const prefs = makePrefsRpc();
    mount(byId("tools"), { ...prefs.handlers, pluginsWithCommands: plugins });
    await chooseSetting("Plugins the agent may run", "None");
    await waitFor(() => expect(prefs.writes.at(-1)).toEqual({ pluginAccess: { mode: "none" } }));
    await chooseSetting("Plugins the agent may run", "Selected plugins");
    await waitFor(() => expect(prefs.writes.at(-1)).toEqual({ pluginAccess: { mode: "selected", ids: [] } }));

    expect(await screen.findByRole("checkbox", { name: "Linear" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Dispatch" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Linear" }));
    await waitFor(() => expect(prefs.writes.at(-1)).toEqual({ pluginAccess: { mode: "selected", ids: ["linear"] } }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));
    await waitFor(() => expect(prefs.writes.at(-1)).toEqual({ pluginAccess: { mode: "selected", ids: ["linear", "notes"] } }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Linear" }));
    await waitFor(() => expect(prefs.writes.at(-1)).toEqual({ pluginAccess: { mode: "selected", ids: ["notes"] } }));
  });

  it("preserves saved plugin choices while discovery loads, including unavailable plugins", async () => {
    const prefs = makePrefsRpc({ pluginAccess: { mode: "selected", ids: ["linear", "unavailable"] } });
    type PluginList = { plugins: Array<{ id: string; name: string; command: string; summary: string }> };
    let resolve!: (value: PluginList) => void;
    // This package targets ES2022, which has no Promise.withResolvers.
    const discovery = new Promise<PluginList>((done) => { resolve = done; });
    const Settings = byId("tools").component;
    const view = renderSlot({ component: () => <form><Settings /></form> }, {}, {
      rpc: { ...prefs.handlers, pluginsWithCommands: () => discovery } as never,
      pluginId: "dispatch",
    });
    await screen.findByLabelText("Plugins the agent may run");
    await act(async () => { fireEvent.change(view.container.querySelector("select")!, { target: { value: "" } }); });
    expect(prefs.writes).toEqual([]);
    resolve(await plugins());
    const linear = await screen.findByRole("checkbox", { name: "Linear" });
    expect(linear.getAttribute("aria-checked")).toBe("true");
    expect(prefs.writes).toEqual([]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));
    await waitFor(() => expect(prefs.writes.at(-1)).toEqual({ pluginAccess: { mode: "selected", ids: ["linear", "unavailable", "notes"] } }));
  });

  it("shows an empty state when no plugins offer commands", async () => {
    mount(byId("tools"), { ...makePrefsRpc({ pluginAccess: { mode: "selected", ids: [] } }).handlers, pluginsWithCommands: async () => ({ plugins: [] }) });
    expect(await screen.findByText("No other plugin offers a command the agent could run.")).toBeTruthy();
  });
});

describe("Advanced", () => {
  it("writes the reasoning model and marks the recommended one", async () => {
    const prefs = makePrefsRpc();
    mount(byId("advanced"), prefs.handlers);
    await openSetting("Reasoning model");
    expect(await screen.findByRole("option", { name: `${REASONING_MODELS[0]} (recommended)` })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: REASONING_MODELS[1] }));
    await waitFor(() => expect(prefs.writes).toContainEqual({ reasoningModel: REASONING_MODELS[1] }));
    expect(screen.queryByLabelText("Voice model")).toBeNull();
  });

  it("keeps an unexpected saved voice model visible and lets the user restore it", async () => {
    const prefs = makePrefsRpc({ voiceModel: "older-model" });
    mount(byId("advanced"), prefs.handlers);
    await chooseSetting("Voice model", "gpt-live-1");
    await waitFor(() => expect(prefs.writes).toContainEqual({ voiceModel: "gpt-live-1" }));
  });

  it("does not fetch or render duplicate credentials", async () => {
    const view = mount(byId("advanced"), makePrefsRpc().handlers);
    await screen.findByLabelText("Reasoning model");
    expect(screen.queryByText("Credentials")).toBeNull();
    expect(view.inspection.rpcCalls.some((call) => call.method === "setupStatus")).toBe(false);
  });

  it("keeps reset confirmation open when the reset fails", async () => {
    mount(byId("advanced"), { ...makePrefsRpc().handlers, preferencesReset: async () => { throw new Error("Reset failed."); } });
    fireEvent.click(await screen.findByRole("button", { name: "Reset preferences" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Reset failed.");
    expect(screen.getByRole("button", { name: "Confirm reset" })).toBeTruthy();
  });

  it("resets preferences only after a confirmation", async () => {
    const prefs = makePrefsRpc({ agentName: "Mira" });
    const reset = vi.spyOn(prefs.handlers, "preferencesReset");
    mount(byId("advanced"), { ...prefs.handlers, setupStatus: async () => makeStatus() });
    fireEvent.click(await screen.findByRole("button", { name: "Reset preferences" }));
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Reset preferences" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset preferences" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(prefs.current.agentName).toBe("Juno");
  });
});
