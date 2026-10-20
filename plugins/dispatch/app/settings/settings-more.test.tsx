// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_KEYS, REASONING_MODELS, SECRET_IDS } from "../../shared/constants.js";
import type { ToolSpec } from "../../shared/contract.js";
import { installFakeLocalStorage, makePrefsRpc, makeStatus } from "./support.js";

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
  it("sets the preview mood from the chips", async () => {
    mount(byId("appearance"), makePrefsRpc().handlers);
    const preview = await screen.findByRole("img", { name: /Pet preview/ });
    expect(preview.getAttribute("data-mood")).toBe("awake");
    fireEvent.click(screen.getByRole("button", { name: "Asleep" }));
    expect(screen.getByRole("img", { name: /Pet preview/ }).getAttribute("data-mood")).toBe("asleep");
    expect(screen.getByRole("button", { name: "Asleep" }).getAttribute("aria-pressed")).toBe("true");
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
    expect(await screen.findByRole("option", { name: "Microphone 1" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Desk mic" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    expect(await screen.findByRole("option", { name: "Desk mic" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Headset" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Grant access" })).toBeNull();
    expect(stop).toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "mic-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved for this device.")).toBeTruthy();
    expect(JSON.parse(stored[LOCAL_KEYS.audio]!)).toMatchObject({ inputDeviceId: "mic-b" });
  });

  it("writes announcements and the drawer behaviour", async () => {
    const prefs = makePrefsRpc();
    mount(byId("calls"), prefs.handlers);
    fireEvent.click(await screen.findByRole("switch", { name: "Announcements" }));
    await waitFor(() => expect(prefs.writes).toContainEqual({ announcements: false }));
    fireEvent.change(screen.getByLabelText("Mobile drawer behaviour"), { target: { value: "new" } });
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

const tool = (name: string, runsOn: ToolSpec["runsOn"]): ToolSpec => ({ name, description: `${name} does a thing`, parameters: {}, runsOn });

describe("Tools", () => {
  const catalog = async (input: { channel: string }) => ({
    tools: input.channel === "phone" ? [tool("send_message", "server")] : [tool("send_message", "server"), tool("focus_thread", "app"), tool("read_screen", "both")],
  });
  const plugins = async () => ({
    plugins: [
      { id: "dispatch", name: "Dispatch", command: "dispatch", summary: "self" },
      { id: "linear", name: "Linear", command: "linear", summary: "Issues" },
      { id: "notes", name: "Notes", command: "notes", summary: "Notes" },
    ],
  });

  it("writes plugin access and the checklist", async () => {
    const prefs = makePrefsRpc();
    mount(byId("tools"), { ...prefs.handlers, toolCatalog: catalog, pluginsWithCommands: plugins });
    const select = await screen.findByLabelText("Plugins the agent may run");
    fireEvent.change(select, { target: { value: "none" } });
    await waitFor(() => expect(prefs.writes.at(-1)).toEqual({ pluginAccess: { mode: "none" } }));
    fireEvent.change(select, { target: { value: "selected" } });
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

  it("lists the built-in tools from the catalog with where they run", async () => {
    mount(byId("tools"), { ...makePrefsRpc().handlers, toolCatalog: catalog, pluginsWithCommands: plugins });
    const send = (await screen.findByText("send_message")).closest("li")!;
    expect(within(send).getByText("server")).toBeTruthy();
    expect(within(send).getByText("phone")).toBeTruthy();
    const read = screen.getByText("read_screen").closest("li")!;
    expect(within(read).getByText("app")).toBeTruthy();
    expect(within(read).getByText("server")).toBeTruthy();
    expect(within(read).queryByText("phone")).toBeNull();
    expect(screen.getByText("focus_thread does a thing")).toBeTruthy();
  });
});

describe("Advanced", () => {
  it("writes both model choices and marks the recommended one", async () => {
    const prefs = makePrefsRpc();
    mount(byId("advanced"), { ...prefs.handlers, setupStatus: async () => makeStatus() });
    const reasoning = await screen.findByLabelText("Reasoning model");
    expect(screen.getByRole("option", { name: `${REASONING_MODELS[0]} (recommended)` })).toBeTruthy();
    fireEvent.change(reasoning, { target: { value: REASONING_MODELS[1] } });
    await waitFor(() => expect(prefs.writes).toContainEqual({ reasoningModel: REASONING_MODELS[1] }));
    fireEvent.change(screen.getByLabelText("Voice model"), { target: { value: "gpt-live-1" } });
    await waitFor(() => expect(prefs.writes).toContainEqual({ voiceModel: "gpt-live-1" }));
  });

  it("shows which credentials are set without any value", async () => {
    const fields = Object.fromEntries(SECRET_IDS.map((id, index) => [id, index === 0])) as never;
    const view = mount(byId("advanced"), { ...makePrefsRpc().handlers, setupStatus: async () => ({ ...makeStatus({ fields }), secret: "sk-hidden" }) });
    await screen.findByText("Credentials");
    expect(screen.getAllByText("set")).toHaveLength(1);
    expect(screen.getAllByText("not set")).toHaveLength(SECRET_IDS.length - 1);
    expect(view.container.textContent).not.toContain("sk-hidden");
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
