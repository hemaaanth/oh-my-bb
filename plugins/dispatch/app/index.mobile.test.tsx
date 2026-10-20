// @vitest-environment jsdom
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it, vi } from "vitest";

const profile = vi.hoisted(() => ({ mobile: true, platform: "iOS", runtime: "safari", standalone: true }));
vi.mock("@/voice/device-profile.js", async (original) => ({
  ...(await original<typeof import("@/voice/device-profile.js")>()),
  deviceProfile: () => profile,
}));

const stored: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => void (stored[key] = value),
    removeItem: (key: string) => void delete stored[key],
    clear: () => undefined,
  },
});

const app = await loadPluginApp(() => import("./index.js"));
const { ViewsDrawer } = await import("./drawer/views-drawer.js");

describe("app registration on a phone", () => {
  it("adds the Views tab to the console and the Views thread panel action", () => {
    expect(app.navPanels.map((panel) => [panel.id, panel.fixedTabs?.map((tab) => [tab.id, tab.title, tab.layout])])).toEqual([
      ["console", [["views", "Views", "flush"]]],
    ]);
    expect(app.navPanels[0]!.fixedTabs?.[0]?.component).toBe(ViewsDrawer);
    expect(app.threadPanelActions.map((action) => [action.id, action.title, action.layout, action.component])).toEqual([
      ["views", "Views", "flush", ViewsDrawer],
    ]);
  });
});
