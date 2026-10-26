// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import plugin, { rpcContract } from "./server";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("mobile deletion starts on Cancel, preserves feedback on dismissal, and deletes only after confirmation", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 767px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 844));
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint", settings: { autoDispatch: false },
    sdk: { threads: { get: async () => ({ projectId: "project-test", environmentId: null }) } },
  });
  await plugin(bb);
  const captured = rpcContract.capture.output.parse(await harness.behavior.callRpc("capture", {
    threadId: "thread-test", url: "https://preview.example.test/", comment: "Align the account buttons",
  }));
  await harness.behavior.callAgentTool("pinpoint_resolve", { id: captured.row.annotation.id, outcome: "ready", summary: "Aligned" });
  const app = await loadPluginApp(() => import("./app"));
  const panel = app.threadPanelActions.find((action) => action.id === "browser")!;
  const rpc = Object.fromEntries(["config", "list", "setLiveTarget", "clearLiveTarget", "update", "remove"].map((method) => [method, (input: unknown) => harness.behavior.callRpc(method, input)]));
  const slot = renderSlot(panel, { threadId: "thread-test", projectId: "project-test", isCompactViewport: true, params: { url: "https://preview.example.test/" } } as never, { rpc });
  const stored = async () => rpcContract.list.output.parse(await harness.behavior.callRpc("list", { threadId: "thread-test" })).rows;
  try {
    const launcher = await screen.findByRole("button", { name: "Pinpoint feedback" });
    fireEvent.keyDown(launcher, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Agent feedback" }));
    const trigger = await screen.findByRole("button", { name: "Delete", exact: true });
    trigger.focus(); fireEvent.click(trigger);
    let dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(dialog.textContent).toContain("Align the account buttons");
    expect(await stored()).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(await stored()).toHaveLength(1);
    fireEvent.click(trigger);
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await stored()).toHaveLength(1);
    fireEvent.click(trigger);
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete", exact: true }));
    await waitFor(async () => expect(await stored()).toHaveLength(0));
  } finally {
    await act(async () => { slot.unmount(); });
    await harness.lifecycle.dispose();
  }
});
