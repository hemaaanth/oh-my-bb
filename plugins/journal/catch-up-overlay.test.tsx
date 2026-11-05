// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app"));

describe("workspace catch-up visibility", () => {
  it("makes no requests while closed, including after changes and polling intervals", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const slot = renderSlot(app.appOverlays.find(item => item.id === "catch-up")!, {}, { rpc: {
      journal_catch_up: () => ({ entries: [] }),
      journal_catch_up_narrative: () => ({ paragraphs: [] }),
    } });
    try {
      await slot.behavior.emitRealtime("journal-changed", {});
      await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
      expect(slot.inspection.rpcCalls).toEqual([]);
      await act(async () => { window.dispatchEvent(new Event("journal:open-catch-up")); });
      expect(slot.inspection.rpcCalls.map(call => call.method)).toEqual(["journal_catch_up", "journal_catch_up_narrative"]);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close" })); });
      const count = slot.inspection.rpcCalls.length;
      await slot.behavior.emitRealtime("journal-changed", {});
      await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
      expect(slot.inspection.rpcCalls).toHaveLength(count);
    } finally { slot.lifecycle.unmount(); vi.useRealTimers(); }
  });
});
