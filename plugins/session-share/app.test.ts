// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createElement, useState } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CapturedPluginApp, RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareStatus } from "./contract";
import { rpcContract } from "./contract";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { sessionShareAction } from "./share-menu";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function makeShare(overrides: Partial<ShareStatus> = {}): ShareStatus {
  return {
    id: "share-1", threadId: "thread-1", title: "Shared review", mode: "view", tunnelMode: "quick",
    publicUrl: "https://share.example.test/session", localUrl: "http://127.0.0.1:3000", accessCode: "ABC123",
    previewUrl: null, ready: true, startedAt: Date.now(), expiresAt: null, ...overrides,
  };
}
const configuration = { share: null, customHostname: "share.example.test", customConfigured: true, cloudflaredAvailable: true, pinpointTargetUrl: null };

async function mountMenu(app: CapturedPluginApp, options: RenderSlotOptions) {
  const action = app.threadActions.find(({ id }) => id === "session-share")! as typeof sessionShareAction;
  function Choices() {
    const data = action.useData!({ threadIds: ["thread-1", "thread-2"] });
    const navigate = useBbNavigate();
    const [threadId, setThreadId] = useState("thread-1");
    const item = action.item({ thread: { id: threadId }, data, navigate } as Parameters<typeof action.item>[0])!;
    return createElement("div", null,
      createElement("button", { onClick: () => setThreadId(current => current === "thread-1" ? "thread-2" : "thread-1") }, "Switch thread"),
      createElement("p", { role: "status" }, item.choices?.hint),
      ...item.choices!.items.map(choice => createElement("button", {
        key: choice.id, disabled: item.disabled || choice.disabled, "aria-pressed": choice.selected,
        onClick: () => { void item.run({ value: choice.id, requestRename: () => {} }); },
      }, choice.label)),
    );
  }
  return renderSlot({ component: Choices }, {}, options);
}
async function advance(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

// The SDK installs its test runtime before evaluating each deferred plugin entry.
describe("Session Share native choices", () => {
  it("waits for configuration before allowing a share and uses the configured tunnel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const pending = Promise.withResolvers<typeof configuration>();
    const slot = await mountMenu(app, { rpc: {
      status: () => pending.promise, list: () => ({ shares: [] }), start: () => ({ share: makeShare() }),
    } });
    expect(slot.queryByRole("button", { name: "Start sharing" })).toBeNull();
    expect(slot.inspection.rpcCalls.some(call => call.method === "start")).toBe(false);
    pending.resolve(configuration);
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Start sharing" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Start sharing" }));
    await vi.waitFor(() => expect(slot.inspection.rpcCalls.find(call => call.method === "start")?.input).toMatchObject({ threadId: "thread-1", tunnelMode: "custom" }));
  });

  it("keeps each thread's choices across refreshes without starting a share", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let current = configuration;
    const slot = await mountMenu(app, { rpc: { status: () => current, list: () => ({ shares: [] }), start: () => ({ share: makeShare() }) } });
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Duration: 6 hours" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Duration: 6 hours" }));
    fireEvent.click(slot.getByRole("button", { name: "Switch thread" }));
    fireEvent.click(slot.getByRole("button", { name: "Duration: 1 hour" }));
    fireEvent.click(slot.getByRole("button", { name: "Switch thread" }));
    current = { ...configuration, customConfigured: false };
    await slot.behavior.emitRealtime("session-share", { threadId: "thread-2", state: "active" });
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Start sharing" }).hasAttribute("disabled")).toBe(true));
    expect(slot.getByRole("button", { name: "Duration: 6 hours" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByRole("button", { name: "Tunnel: Custom" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.inspection.rpcCalls.some(call => call.method === "start")).toBe(false);
    current = configuration;
    await slot.behavior.emitRealtime("session-share", { state: "settings" });
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Start sharing" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Start sharing" }));
    await vi.waitFor(() => expect(slot.inspection.rpcCalls.find(call => call.method === "start")?.input).toMatchObject({ threadId: "thread-1", durationMinutes: 360 }));
  });

  it("does not contact Pinpoint until Review is selected and retains View if unavailable", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = await mountMenu(app, { rpc: { status: () => configuration, list: () => ({ shares: [] }), reviewTarget: () => ({ url: null }) } });
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Access: Review" })).toBeTruthy());
    expect(slot.inspection.rpcCalls.some(call => call.method === "reviewTarget")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Access: Review" }));
    await vi.waitFor(() => expect(slot.inspection.rpcCalls.find(call => call.method === "reviewTarget")?.input).toEqual({ threadId: "thread-1" }));
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Access: View" }).hasAttribute("disabled")).toBe(false));
    expect(slot.getByRole("button", { name: "Access: View" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.inspection.rpcCalls.some(call => call.method === "start")).toBe(false);
  });

  it("opens and copies the selected thread's share rather than another thread's credentials", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const selected = makeShare();
    const other = makeShare({ id: "share-2", threadId: "thread-2", publicUrl: "https://other.example.test/", accessCode: "OTHER-CODE" });
    const slot = await mountMenu(app, { context: { threadId: "thread-2" }, rpc: { status: () => configuration, list: () => ({ shares: [other, selected] }) }, openUrl: () => true });
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Open viewer" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Open viewer" }));
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Copy access code" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Copy access code" }));
    await vi.waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: selected.accessCode }]));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: selected.publicUrl });
  });

  it("refreshes preparing shares and reflects a ready viewer", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let share = makeShare({ ready: false });
    const slot = await mountMenu(app, { rpc: { status: () => configuration, list: () => ({ shares: [share] }) } });
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(true));
    share = { ...share, ready: true };
    await advance(15_000);
    expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(false);
  });

  it("requires confirmation and revokes the captured resource, not a replacement share", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const original = makeShare();
    let shares = [original];
    const revoked: string[] = [];
    const options: RenderSlotOptions = { rpc: {
      status: () => configuration, list: () => ({ shares }),
      revoke: input => { revoked.push(rpcContract.revoke.input.parse(input).shareId); return { stopped: false }; },
    } };
    const overlay = renderSlot(app.appOverlays[0]!, {}, options);
    const menu = await mountMenu(app, options);
    await vi.waitFor(() => expect(menu.getByRole("button", { name: "Revoke…" })).toBeTruthy());
    fireEvent.click(menu.getByRole("button", { name: "Revoke…" }));
    await advance();
    expect(overlay.getByRole("alertdialog").textContent).toContain(original.title);
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(revoked).toEqual([]);
    fireEvent.click(overlay.getByRole("button", { name: "Cancel" }));
    await advance();
    expect(revoked).toEqual([]);
    fireEvent.click(menu.getByRole("button", { name: "Revoke…" }));
    await advance();
    shares = [makeShare({ id: "replacement", title: "Replacement" })];
    await menu.behavior.emitRealtime("session-share", { state: "active" });
    fireEvent.click(overlay.getByRole("button", { name: "Revoke" }));
    await vi.waitFor(() => expect(revoked).toEqual([original.id]));
    expect(revoked).not.toContain("replacement");
  });

  it("keeps the created share available if the follow-up refresh fails", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let reads = 0;
    const slot = await mountMenu(app, { rpc: {
      status: () => configuration,
      list: () => { if (++reads > 1) throw new Error("Read failed"); return { shares: [] }; },
      start: () => ({ share: makeShare() }),
    } });
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Start sharing" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Start sharing" }));
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(false));
    expect(slot.queryByRole("button", { name: "Start sharing" })).toBeNull();
  });

  it("starts Review only after checking the selected thread and prevents duplicate starts", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const pending = Promise.withResolvers<{ share: ShareStatus }>();
    const slot = await mountMenu(app, { rpc: {
      status: () => configuration, list: () => ({ shares: [] }),
      reviewTarget: () => ({ url: "http://127.0.0.1:43210/" }), start: () => pending.promise,
    } });
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Access: Review" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Access: Review" }));
    await vi.waitFor(() => expect(slot.getByRole("button", { name: "Access: Review" }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(slot.getByRole("button", { name: "Tunnel: Quick" }));
    fireEvent.click(slot.getByRole("button", { name: "Duration: 8 hours" }));
    fireEvent.click(slot.getByRole("button", { name: "Start sharing" }));
    fireEvent.click(slot.getByRole("button", { name: "Start sharing" }));
    const starts = slot.inspection.rpcCalls.filter(call => call.method === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.input).toEqual({ threadId: "thread-1", mode: "review", tunnelMode: "quick", durationMinutes: 480 });
    pending.resolve({ share: makeShare({ mode: "review" }) });
    await advance();
  });

  it("refreshes stored shares on any share signal", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let shares: ShareStatus[] = [];
    const slot = renderSlot(app.settingsSections.find(({ id }) => id === "more")!, {}, { rpc: { list: () => ({ shares }) } });
    fireEvent.click(slot.getByText("Shared sessions").closest("summary")!);
    await vi.waitFor(() => expect(slot.inspection.rpcCalls.filter(call => call.method === "list")).toHaveLength(1));
    shares = [makeShare({ title: "Signalled share" })];
    await slot.behavior.emitRealtime("session-share", { threadId: "thread-9", state: "active" });
    await vi.waitFor(() => expect(slot.getByText("Signalled share")).toBeTruthy());
  });
});
