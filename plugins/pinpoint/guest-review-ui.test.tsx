// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import plugin, { rpcContract } from "./server";
import { disposeAll } from "./lib/session-registry";
import { PICKER_PROTOCOL_VERSION } from "./lib/protocol";

afterEach(() => { cleanup(); disposeAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("separates guest requests from finished work and approves only the owner's edited snapshot", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 844));
  const send = vi.fn(async (_input: unknown) => ({}));
  const { bb, harness } = createFakePluginHost({
    pluginId: "pinpoint", settings: { autoDispatch: false, relayMode: "thread" },
    sdk: { threads: { get: async () => ({ projectId: "project-test", environmentId: null }), send } },
  });
  await plugin(bb);
  const threadId = "thread-test", url = "https://preview.example.test/";
  const guest = rpcContract.captureGuest.output.parse(await harness.behavior.callRpc("captureGuest", {
    isolationVersion: 1, threadId, url, reviewRef: "synthetic-review", participantRef: "synthetic-participant", comment: "Raw visitor suggestion",
  }));
  const ready = rpcContract.capture.output.parse(await harness.behavior.callRpc("capture", { threadId, url, comment: "Finished agent change" }));
  await harness.behavior.callAgentTool("pinpoint_resolve", { id: ready.captureId, outcome: "ready", summary: "Ready to check" });
  const question = rpcContract.capture.output.parse(await harness.behavior.callRpc("capture", { threadId, url, comment: "Needs clarification" }));
  await harness.behavior.callAgentTool("pinpoint_resolve", { id: question.captureId, outcome: "question", question: "Which button?" });
  const rows = async () => rpcContract.list.output.parse(await harness.behavior.callRpc("list", { threadId })).rows;
  const app = await loadPluginApp(() => import("./app"));
  const panel = app.threadPanelActions.find((entry) => entry.id === "browser")!;
  const rpc = Object.fromEntries(["config", "list", "setLiveTarget", "clearLiveTarget", "update", "remove", "approveGuestFeedback"].map((method) => [method, (input: unknown) => harness.behavior.callRpc(method, input)]));
  const slot = renderSlot(panel, { threadId, projectId: "project-test", params: { url } } as never, { rpc });
  try {
    fireEvent.keyDown(await screen.findByRole("button", { name: "Pinpoint feedback" }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Agent feedback" }).textContent).toBe("1");
    expect(screen.getByRole("button", { name: "User feedback" }).textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Guest feedback" }));
    await screen.findByText("Raw visitor suggestion");
    expect(screen.queryByRole("button", { name: "Approve", exact: true })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    const draft = await screen.findByRole("textbox", { name: "Edit guest comment" });
    fireEvent.change(draft, { target: { value: "Unsent draft" } });
    fireEvent.keyDown(draft, { key: "Escape" });
    expect((await rows()).find((row) => row.annotation.id === guest.captureId)!.annotation.comment).toBe("Raw visitor suggestion");
    expect(send).not.toHaveBeenCalled();
    const frame = document.querySelector("iframe")!;
    const previewIntent = async (action: string) => act(async () => window.dispatchEvent(new MessageEvent("message", {
      origin: "null", source: frame.contentWindow,
      data: { source: "bb-pinpoint", authToken: "synthetic-picker", type: "intent", id: guest.captureId, action },
    })));
    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      origin: "null", source: frame.contentWindow,
      data: { source: "bb-pinpoint", authToken: "synthetic-picker", type: "ready", url, protocol: PICKER_PROTOCOL_VERSION },
    })));
    await previewIntent("approve-guest");
    const confirmation = await screen.findByRole("dialog");
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await previewIntent("edit-guest");
    fireEvent.change(await screen.findByRole("textbox", { name: "Edit guest comment" }), { target: { value: "Owner-approved request" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve guest feedback" }));
    await waitFor(async () => expect((await rows()).find((row) => row.annotation.id === guest.captureId)).toMatchObject({ guestPending: false, workflowState: "dispatched" }));
    expect(JSON.stringify(send.mock.calls)).toContain("Owner-approved request");
    expect(JSON.stringify(send.mock.calls)).not.toContain("Raw visitor suggestion");
    expect(screen.getByRole("button", { name: "Agent feedback" }).textContent).toBe("1");
  } finally {
    await act(async () => slot.unmount());
    await harness.lifecycle.dispose();
  }
});
