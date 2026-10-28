// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it } from "vitest";

afterEach(cleanup);

it("keeps Pinpoint in the thread panel and opens its guide without a rail page", async () => {
  const app = await loadPluginApp(() => import("./app"));
  expect(app.navPanels).toEqual([]);
  expect(app.threadPanelActions.map((action) => action.id)).toContain("browser");
  const more = app.settingsSections.find((section) => section.id === "more")!;
  const slot = renderSlot(more, {} as never);
  expect(slot.queryByRole("dialog")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Open guide" }));
  expect(await slot.findByRole("dialog", { name: "Pinpoint setup guide" })).toBeTruthy();
  expect(slot.inspection.navigateCalls).toEqual([]);
});
