// @vitest-environment jsdom
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";

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

const app = await loadPluginApp(() => import("./index.js"));

describe("app registration", () => {
  it("registers the footer pet", () => {
    expect(app.experimentalSidebarFooterItems.map((item) => item.id)).toEqual(["pet"]);
  });

  it("registers the pointer ghost and bindings overlays", () => {
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["pointer-ghost", "bindings"]);
  });

  it("registers call controls in the composer", () => {
    expect(app.composerCustomizations.map((entry) => entry.actions?.map((action) => action.id))).toEqual([["call-controls"]]);
  });

  it("registers the console panel with the Views tab and the Views thread panel action", () => {
    expect(app.navPanels.map((panel) => [panel.id, panel.title, panel.fixedTabs?.map((tab) => tab.title)])).toEqual([
      ["console", "Dispatch", ["Views"]],
    ]);
    expect(app.threadPanelActions.map((action) => action.title)).toEqual(["Views"]);
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

  it("registers the hotkeys content script", () => {
    expect(app.contentScripts.map((script) => script.id)).toEqual(["hotkeys"]);
  });
});
