// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

describe("Pinpoint app registration", () => {
  it("keeps Pinpoint in the thread panel without adding a text-selection action", () => {
    expect(app.threadPanelActions.map((action) => action.id)).toContain("browser");
    expect(app.messageActions).toEqual([]);
  });
});
