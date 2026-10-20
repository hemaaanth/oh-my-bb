// @vitest-environment jsdom
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import type { PluginAppDefinition, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences } from "@/shared/constants.js";
import { callStore, IDLE_CALL, updateCall } from "@/voice/call-store.js";
import { prefsStore } from "@/voice/preferences.js";

// Node's experimental global localStorage shadows jsdom's and is unusable without a file.
const stored: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
    removeItem: (key: string) => {
      delete stored[key];
    },
    clear: () => {
      for (const key of Object.keys(stored)) delete stored[key];
    },
  },
});

const engine = vi.hoisted(() => ({
  toggleCall: vi.fn(async () => undefined),
  toggleMute: vi.fn(async () => undefined),
  stopCall: vi.fn(async () => undefined),
  callMyPhone: vi.fn(async () => null),
}));
vi.mock("@/voice/engine.js", () => engine);

const { ConsoleSidebarAccessory } = await import("./console/index.js");
const app = await loadPluginApp(() => import("./index.js"));

/** The test harness does not collect palette commands, so run setup against a recording stand-in. */
async function registeredCommands(): Promise<PluginCommandRegistration[]> {
  const commands: PluginCommandRegistration[] = [];
  // Any other registrar is a no-op that returns a no-op disposer.
  const stand: unknown = new Proxy(() => undefined, { get: () => stand, apply: () => () => undefined });
  const definition = (await import("./index.js")).default as PluginAppDefinition;
  const fake = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) =>
      key === "commands" ? { register: (entry: PluginCommandRegistration) => void commands.push(entry) } : stand,
  });
  definition.setup(fake as never);
  return commands;
}

afterEach(() => {
  callStore.set(IDLE_CALL);
  prefsStore.set(defaultPreferences());
  for (const fn of Object.values(engine)) fn.mockClear();
});

describe("app registration", () => {
  it("registers the footer pet with its live icon", () => {
    expect(app.experimentalSidebarFooterItems.map((item) => item.id)).toEqual(["pet"]);
    expect(app.icons.map((icon) => icon.name)).toContain("dispatch-pet");
  });

  it("registers the pointer ghost, bindings and call-status overlays", () => {
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["pointer-ghost", "bindings", "call-status"]);
  });

  it("registers the composer hook", () => {
    expect(app.composerCustomizations.map((entry) => entry.actions?.map((action) => action.id))).toEqual([["hook"]]);
  });

  it("registers the console with its badge and no Views on desktop", () => {
    expect(app.navPanels.map((panel) => [panel.id, panel.title, panel.fixedTabs ?? []])).toEqual([["console", "Dispatch", []]]);
    expect(app.navPanels[0]!.experimental_sidebarAccessory).toBe(ConsoleSidebarAccessory);
    expect(app.threadPanelActions).toEqual([]);
  });

  it("registers six settings sections in order, then the mobile section", () => {
    expect(app.settingsSections.map((section) => [section.title, section.experimental_page ?? "plugin"])).toEqual([
      ["Readiness", "plugin"],
      ["Agent", "plugin"],
      ["Appearance", "plugin"],
      ["Calls", "plugin"],
      ["Tools", "plugin"],
      ["Advanced", "plugin"],
      ["Dispatch", "mobile"],
    ]);
  });

  it("registers three palette commands; mute is offered only during a call", async () => {
    const commands = await registeredCommands();
    expect(commands.map((command) => command.id)).toEqual(["toggle-call", "toggle-mute", "call-phone"]);
    const [toggle, mute, phone] = commands as [PluginCommandRegistration, PluginCommandRegistration, PluginCommandRegistration];
    expect(toggle.isAvailable).toBeUndefined();
    expect(mute.isAvailable?.({} as never)).toBe(false);
    updateCall({ state: "live", owner: "self", startedAt: Date.now() });
    expect(mute.isAvailable?.({} as never)).toBe(true);
    await toggle.run({} as never);
    await mute.run({} as never);
    await phone.run({} as never);
    expect(engine.toggleCall).toHaveBeenCalledTimes(1);
    expect(engine.toggleMute).toHaveBeenCalledTimes(1);
    expect(engine.callMyPhone).toHaveBeenCalledTimes(1);
  });

  it("runs the saved shortcuts from the hotkeys content script until it is disposed", async () => {
    expect(app.contentScripts.map((script) => script.id)).toEqual(["hotkeys"]);
    const scripts = await mountPluginContentScripts(app, { pluginId: "dispatch" });
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(event);
      return event;
    };
    // jsdom reports a non-Apple platform, so Mod is Ctrl.
    expect(press({ key: "H", code: "KeyH", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(engine.toggleCall).toHaveBeenCalledTimes(1);
    // Mute does nothing without a call, and lets the key through.
    expect(press({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    updateCall({ state: "live", owner: "self", startedAt: Date.now() });
    press({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true });
    expect(engine.toggleMute).toHaveBeenCalledTimes(1);
    // A handler that already took the key (the shortcut recorder) wins.
    const taken = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "H", code: "KeyH", ctrlKey: true, shiftKey: true });
    taken.preventDefault();
    window.dispatchEvent(taken);
    expect(engine.toggleCall).toHaveBeenCalledTimes(1);
    // A changed shortcut applies at once.
    prefsStore.set({ ...defaultPreferences(), hotkeys: { toggle: "Mod+Shift+J", mute: "Mod+Shift+U" } });
    press({ key: "J", code: "KeyJ", ctrlKey: true, shiftKey: true });
    expect(engine.toggleCall).toHaveBeenCalledTimes(2);
    await scripts.lifecycle.dispose();
    press({ key: "J", code: "KeyJ", ctrlKey: true, shiftKey: true });
    expect(engine.toggleCall).toHaveBeenCalledTimes(2);
  });

  it("the footer pet toggles the call and remembers the settings opener", async () => {
    const item = app.experimentalSidebarFooterItems[0] as unknown as { onActivate(context: { openPluginDetails(): void }): void };
    item.onActivate({ openPluginDetails: vi.fn() });
    expect(engine.toggleCall).toHaveBeenCalledTimes(1);
  });
});
