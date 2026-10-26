// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import plugin, { rpcContract } from "./server";
import { PICKER_PROTOCOL_VERSION } from "./lib/protocol";
import { disposeAll } from "./lib/session-registry";

afterEach(() => { cleanup(); disposeAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requires BB confirmation for a scoped preview approval and never treats it as learning consent", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 767px)", media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true; },
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 844));
  const learning = vi.fn(async () => { throw new Error("No live integration is available in this fixture"); });
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint", settings: { autoDispatch: false },
    sdk: {
      threads: { get: async () => ({ projectId: "project-test", environmentId: null }) },
      plugins: { callRpc: learning },
    },
  });
  await plugin(bb);
  const row = rpcContract.capture.output.parse(await harness.behavior.callRpc("capture", {
    threadId: "thread-test", url: "https://preview.example.test/", comment: "Align the account buttons",
  })).row;
  const other = rpcContract.capture.output.parse(await harness.behavior.callRpc("capture", {
    threadId: "other-thread", url: "https://preview.example.test/", comment: "Private feedback in another thread",
  })).row;
  for (const item of [row, other]) await harness.behavior.callAgentTool("pinpoint_resolve", {
    id: item.annotation.id, outcome: "ready", summary: "Aligned",
    proposedLearning: { topic: "design", logicalKey: "quiet-buttons", text: "Prefer quiet secondary buttons in account settings." },
  });
  const app = await loadPluginApp(() => import("./app"));
  const panel = app.threadPanelActions.find((action) => action.id === "browser")!;
  const rpc = Object.fromEntries(["config", "list", "setLiveTarget", "clearLiveTarget", "update", "remove"].map((method) => [method, (input: unknown) => harness.behavior.callRpc(method, input)]));
  const slot = renderSlot(panel, { threadId: "thread-test", projectId: "project-test", isCompactViewport: true, params: { url: "https://preview.example.test/" } } as never, { rpc });
  const stored = async (threadId: string) => rpcContract.list.output.parse(await harness.behavior.callRpc("list", { threadId })).rows[0]!;
  try {
    fireEvent.keyDown(await screen.findByRole("button", { name: "Pinpoint feedback" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Agent feedback" }));
    await screen.findByText("Align the account buttons");
    const frame = document.querySelector("iframe")!;
    const send = async (data: Record<string, unknown>) => act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source: frame.contentWindow, data: { source: "bb-pinpoint", authToken: "synthetic-picker", ...data } }));
    });
    await send({ type: "ready", url: "https://preview.example.test/", protocol: PICKER_PROTOCOL_VERSION });
    await send({ type: "intent", id: other.annotation.id, action: "approve" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await stored("other-thread")).workflowState).toBe("ready");
    await send({ type: "intent", id: row.annotation.id, action: "approve" });
    let dialog = await screen.findByRole("dialog");
    expect((await stored("thread-test")).workflowState).toBe("ready");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await stored("thread-test")).workflowState).toBe("ready");
    await send({ type: "intent", id: row.annotation.id, action: "approve" });
    dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Approve", exact: true }));
    await waitFor(async () => expect((await stored("thread-test")).workflowState).toBe("approved"));
    expect((await stored("other-thread")).workflowState).toBe("ready");
    expect(learning).not.toHaveBeenCalled();
  } finally {
    await act(async () => { slot.unmount(); });
    await harness.lifecycle.dispose();
  }
});
