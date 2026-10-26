// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { createElement } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CapturedPluginApp, RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareStatus } from "./contract";
import { rpcContract } from "./contract";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function makeShare(overrides: Partial<ShareStatus> = {}): ShareStatus {
  return {
    id: "share-1", threadId: "thread-1", title: "Shared review", mode: "view", tunnelMode: "quick",
    publicUrl: "https://share.example.test/session", localUrl: "http://127.0.0.1:3000", accessCode: "ABC123",
    previewUrl: null, ready: true, startedAt: Date.now(), expiresAt: null, ...overrides,
  };
}
const configuration = { share: null, customHostname: "share.example.test", customConfigured: true, cloudflaredAvailable: true, pinpointTargetUrl: null };
async function advance(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function openSharing(app: CapturedPluginApp, threadId = "thread-1") {
  const action = app.threadActions.find(({ id }) => id === "session-share")!;
  const item = action.item({ thread: { id: threadId } } as Parameters<typeof action.item>[0])!;
  await act(async () => { await item.run({ requestRename: () => {} }); await vi.advanceTimersByTimeAsync(0); });
}
async function mount(rpc: RenderSlotOptions["rpc"], extra: Omit<RenderSlotOptions, "rpc"> = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(app.appOverlays[0]!, {}, { ...extra, rpc });
  return { app, slot };
}

// The SDK installs its test runtime before evaluating each deferred plugin entry.
describe("Session Share modal", () => {
  it("does not read share data or probe Pinpoint while closed", async () => {
    const { slot } = await mount({});
    await advance(300_000);
    expect(slot.inspection.rpcCalls).toEqual([]);
    expect(slot.queryByRole("dialog")).toBeNull();
  });

  it("waits for settings and defaults to the active thread's Pinpoint review", async () => {
    const settings = Promise.withResolvers<typeof configuration>();
    const start = vi.fn(() => ({ share: makeShare({ mode: "review", tunnelMode: "custom" }) }));
    const { app, slot } = await mount({ status: () => settings.promise, reviewTarget: () => ({ url: "https://app.example.test/" }), start });
    await openSharing(app);
    expect(slot.queryByRole("button", { name: "Start sharing" })).toBeNull();
    settings.resolve(configuration);
    await advance();
    expect(slot.getByRole("button", { name: "Pinpoint review" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Start sharing" }));
    await advance();
    expect(start.mock.calls).toHaveLength(1);
    expect(slot.inspection.rpcCalls.find(call => call.method === "start")?.input).toMatchObject({ threadId: "thread-1", mode: "review", tunnelMode: "custom" });
    expect(slot.getByText("ABC123")).toBeTruthy();
  });

  it("keeps conversation sharing usable without Pinpoint or a custom domain", async () => {
    const { app, slot } = await mount({
      status: () => ({ ...configuration, customHostname: "", customConfigured: false }),
      reviewTarget: () => { throw new Error("Plugin not installed"); },
      start: () => ({ share: makeShare() }),
    });
    await openSharing(app);
    expect(slot.getByRole("button", { name: "Conversation" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Start sharing" }));
    await advance();
    expect(slot.inspection.rpcCalls.find(call => call.method === "start")?.input).toMatchObject({ mode: "view", tunnelMode: "quick" });
    expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(false);
  });

  it("never falls back to a temporary URL when a configured domain lacks its token", async () => {
    const { app, slot } = await mount({ status: () => ({ ...configuration, customConfigured: false }), reviewTarget: () => ({ url: null }) });
    await openSharing(app);
    expect(slot.getByRole("button", { name: "Start sharing" }).hasAttribute("disabled")).toBe(true);
    expect(slot.getByText(/Set the custom hostname and named tunnel token/)).toBeTruthy();
    expect(slot.inspection.rpcCalls.some(call => call.method === "start")).toBe(false);
  });

  it("preserves an explicit conversation choice while Pinpoint finishes loading", async () => {
    const target = Promise.withResolvers<{ url: string | null }>();
    const { app, slot } = await mount({ status: () => configuration, reviewTarget: () => target.promise, start: () => ({ share: makeShare() }) });
    await openSharing(app);
    fireEvent.click(slot.getByRole("button", { name: "Conversation" }));
    expect(slot.getByRole("button", { name: "Start sharing" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Start sharing" }));
    await advance();
    target.resolve({ url: "https://app.example.test/" });
    await advance();
    expect(slot.getByText("ABC123")).toBeTruthy();
    expect(slot.inspection.rpcCalls.find(call => call.method === "start")?.input).toMatchObject({ mode: "view" });
  });

  it("shows only the chosen thread's link and opens it through the configured URL handler", async () => {
    const share = makeShare();
    const { app, slot } = await mount({ status: input => ({ ...configuration, share: rpcContract.status.input.parse(input).threadId === "thread-1" ? share : makeShare({ accessCode: "OTHER-THREAD-SECRET" }) }) }, { context: { threadId: "thread-2" }, openUrl: () => true });
    await openSharing(app);
    expect(slot.queryByText("OTHER-THREAD-SECRET")).toBeNull();
    expect(slot.getByText(share.accessCode)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open viewer" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: share.publicUrl });
    expect(slot.inspection.rpcCalls.some(call => call.method === "reviewTarget")).toBe(false);
  });

  it("enables the viewer after a preparing share becomes ready", async () => {
    let share = makeShare({ ready: false });
    const { app, slot } = await mount({ status: () => ({ ...configuration, share }) });
    await openSharing(app);
    expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(true);
    share = makeShare({ ready: true });
    await slot.behavior.emitRealtime("session-share", { threadId: "thread-1" });
    await advance();
    expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(false);
  });

  it("retains a newly started share when an earlier status request returns stale data", async () => {
    const stale = Promise.withResolvers<typeof configuration>();
    const started = Promise.withResolvers<{ share: ShareStatus }>();
    let reads = 0;
    const { app, slot } = await mount({ status: () => ++reads === 1 ? configuration : stale.promise, reviewTarget: () => ({ url: null }), start: () => started.promise });
    await openSharing(app);
    await slot.behavior.emitRealtime("session-share", { threadId: "thread-1" });
    const button = slot.getByRole("button", { name: "Start sharing" });
    fireEvent.click(button);
    fireEvent.click(button);
    started.resolve({ share: makeShare() });
    await advance();
    stale.resolve(configuration);
    await advance();
    expect(slot.getByText("ABC123")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Start sharing" })).toBeNull();
    expect(slot.inspection.rpcCalls.filter(call => call.method === "start")).toHaveLength(1);
  });

  it("confirms and revokes the captured share, never its replacement", async () => {
    let share = makeShare({ title: "Original session" });
    const revoke = vi.fn(() => ({ stopped: true }));
    const { app, slot } = await mount({ status: () => ({ ...configuration, share }), revoke });
    await openSharing(app);
    fireEvent.click(slot.getByRole("button", { name: "Revoke" }));
    await advance();
    expect(document.activeElement?.textContent).toBe("Cancel");
    share = makeShare({ id: "replacement", title: "Replacement session", accessCode: "REPLACEMENT" });
    await slot.behavior.emitRealtime("session-share", { threadId: "thread-1" });
    await advance();
    expect(slot.getByRole("alertdialog").textContent).toContain("Original session");
    expect(slot.getByRole("alertdialog").textContent).not.toContain("Replacement session");
    fireEvent.click(slot.getByRole("alertdialog").querySelectorAll("button")[1]!);
    await advance();
    expect(revoke).toHaveBeenCalledWith({ shareId: "share-1" });
    expect(slot.getByText("REPLACEMENT")).toBeTruthy();
  });

  it.each([true, false])("returns focus after the menu unmounts (linked trigger: %s)", async linked => {
    const { app, slot } = await mount({ status: () => configuration, reviewTarget: () => ({ url: null }) });
    const action = app.threadActions[0]!;
    const item = action.item({ thread: { id: "thread-1" } } as Parameters<typeof action.item>[0])!;
    const menu = render(createElement(DropdownMenu.Root, null,
      createElement(DropdownMenu.Trigger, linked ? null : { id: "" }, "Thread menu"),
      createElement(DropdownMenu.Portal, null, createElement(DropdownMenu.Content, null,
        createElement(DropdownMenu.Item, { onSelect: () => { void item.run({ requestRename: () => {} }); } }, "Session Share")))));
    const trigger = menu.getByRole("button", { name: "Thread menu" });
    if (linked) { trigger.focus(); fireEvent.keyDown(trigger, { key: "Enter" }); }
    else fireEvent(trigger, new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    await advance();
    fireEvent.click(menu.getByRole("menuitem", { name: "Session Share" }));
    await advance();
    fireEvent.click(slot.getByRole("button", { name: "Done" }));
    await advance();
    expect(document.activeElement).toBe(trigger);
  });

  it("updates stored sessions from another thread's share signal", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let shares: ShareStatus[] = [];
    const slot = renderSlot(app.settingsSections.find(({ id }) => id === "more")!, {}, { rpc: { list: () => ({ shares }) } });
    await advance();
    fireEvent.click(slot.getByText("Shared sessions").closest("summary")!);
    shares = [makeShare({ title: "Another session" })];
    await slot.behavior.emitRealtime("session-share", { threadId: "thread-2" });
    await advance();
    expect(slot.getByText("Another session")).toBeTruthy();
  });
});
