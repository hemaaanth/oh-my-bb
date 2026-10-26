// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { createElement } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareStatus } from "./contract";
import { rpcContract } from "./contract";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeShare(overrides: Partial<ShareStatus> = {}): ShareStatus {
  return {
    id: "share-1",
    threadId: "thread-1",
    title: "Review",
    mode: "view",
    tunnelMode: "quick",
    publicUrl: "https://share.example.test/session",
    localUrl: "http://127.0.0.1:3000",
    accessCode: "ABC123",
    previewUrl: null,
    ready: true,
    startedAt: Date.now(),
    expiresAt: null,
    ...overrides,
  };
}

/** Advance fake time inside act so rpc responses commit before timers run. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openSharing(app: CapturedPluginApp, threadId = "thread-1") {
  const action = app.threadActions.find(({ id }) => id === "session-share")!;
  const item = action.item({ thread: { id: threadId } } as Parameters<typeof action.item>[0])!;
  await act(async () => {
    await item.run({ requestRename: () => {} });
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("Session Share frontend registration", () => {

  it("does not show a temporary tunnel before configuration loads", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const { promise, resolve } = Promise.withResolvers<{
      share: null;
      customHostname: string;
      customConfigured: boolean;
      cloudflaredAvailable: boolean;
      pinpointTargetUrl: null;
    }>();
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { status: () => promise },
    });

    await openSharing(app);
    expect(
      slot.queryByRole("button", { name: "Quick Temporary URL" }),
    ).toBeNull();
    expect(slot.getByRole("status").textContent).toBe(
      "Loading share settings",
    );

    resolve({
      share: null,
      customHostname: "share.example.test",
      customConfigured: true,
      cloudflaredAvailable: true,
      pinpointTargetUrl: null,
    });

    await vi.waitFor(() =>
      expect(slot.getByRole("button", { name: "Custom share.example.test" }).getAttribute("aria-pressed")).toBe("true"),
    );
    expect(slot.queryByRole("status")).toBeNull();
  });

  it("opens the selected thread's viewer through BB's configured URL handler", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const publicUrl = "https://share.example.test/session";
    const status = {
      share: {
        id: "share-1",
        threadId: "thread-1",
        title: "Review",
        mode: "view" as const,
        tunnelMode: "quick" as const,
        publicUrl,
        localUrl: "http://127.0.0.1:3000",
        accessCode: "ABC123",
        previewUrl: null,
        ready: true,
        startedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      customHostname: "bb.example.test",
      customConfigured: true,
      cloudflaredAvailable: true,
      pinpointTargetUrl: null,
    };
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      context: { threadId: "another-thread", projectId: "project-1" },
      rpc: {
        status: (input) => rpcContract.status.input.parse(input).threadId === "thread-1"
          ? status : { ...status, share: null },
      },
      openUrl: (url) => url === publicUrl,
    });

    await openSharing(app);
    await vi.waitFor(() =>
      expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(slot.getByRole("button", { name: "Open viewer" }));

    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openUrl",
      url: publicUrl,
    });
  });

  it("returns focus after the native menu unmounts before the dialog opens", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const action = app.threadActions.find(({ id }) => id === "session-share")!;
    const item = action.item({ thread: { id: "thread-1" } } as Parameters<typeof action.item>[0])!;
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: { status: () => ({
        share: null, customHostname: "", customConfigured: false,
        cloudflaredAvailable: true, pinpointTargetUrl: null,
      }) },
    });
    const nativeMenu = render(createElement(DropdownMenu.Root, null,
      createElement(DropdownMenu.Trigger, null, "Thread menu"),
      createElement(DropdownMenu.Portal, null,
        createElement(DropdownMenu.Content, null,
          createElement(DropdownMenu.Item, {
            onSelect: () => { void item.run({ requestRename: () => {} }); },
          }, "Session Share"),
        ),
      ),
    ));
    const trigger = nativeMenu.getByRole("button", { name: "Thread menu" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    await advance(0);
    fireEvent.click(nativeMenu.getByRole("menuitem", { name: "Session Share" }));
    await advance(0);
    expect(nativeMenu.queryByRole("menuitem")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Done" }));
    await advance(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("does not read share data while the menu dialog is closed", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.appOverlays[0]!, {}, {});
    await advance(5 * 60_000);
    expect(slot.inspection.rpcCalls).toEqual([]);
    expect(slot.queryByRole("dialog")).toBeNull();
  });

  it("enables the viewer when a preparing share becomes live", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let current = makeShare({ ready: false });
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: {
        status: () => ({
          share: current, customHostname: "", customConfigured: false,
          cloudflaredAvailable: true, pinpointTargetUrl: null,
        }),
      },
    });
    await openSharing(app);
    expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(true);
    current = makeShare({ ready: true });
    await advance(15_000);
    expect(slot.getByRole("button", { name: "Open viewer" }).hasAttribute("disabled")).toBe(false);
  });

  it("refreshes the open panel on signals and only slowly otherwise", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let current: ShareStatus | null = null;
    const slot = renderSlot(app.appOverlays[0]!, {}, {
      rpc: {
        status: () => ({
          share: current,
          customHostname: "bb.example.test",
          customConfigured: true,
          cloudflaredAvailable: true,
          pinpointTargetUrl: null,
        }),
      },
    });
    const statusCalls = () =>
      slot.inspection.rpcCalls.filter((call) => call.method === "status")
        .length;

    await openSharing(app);
    await vi.waitFor(() => expect(statusCalls()).toBe(1));
    await advance(29_000);
    expect(statusCalls()).toBe(1);
    await advance(1_000);
    expect(statusCalls()).toBe(2);

    current = makeShare();
    await slot.behavior.emitRealtime("session-share", {
      shareId: "share-1",
      threadId: "thread-1",
      state: "active",
    });
    await vi.waitFor(() => expect(statusCalls()).toBe(3));
    await vi.waitFor(() =>
      expect(slot.getByRole("button", { name: "Open viewer" })).toBeTruthy(),
    );
  });

  it("refreshes stored shares on any share signal", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let shares: ShareStatus[] = [];
    const slot = renderSlot(app.settingsSections.find(({ id }) => id === "more")!, {}, {
      rpc: { list: () => ({ shares }) },
    });
    fireEvent.click(slot.getByText("Shared sessions").closest("summary")!);
    const listCalls = () =>
      slot.inspection.rpcCalls.filter((call) => call.method === "list").length;

    await vi.waitFor(() => expect(listCalls()).toBe(1));
    await advance(59_000);
    expect(listCalls()).toBe(1);

    shares = [makeShare({ title: "Signalled share" })];
    await slot.behavior.emitRealtime("session-share", {
      shareId: "share-1",
      threadId: "thread-9",
      state: "active",
    });
    await vi.waitFor(() =>
      expect(slot.getByText("Signalled share")).toBeTruthy(),
    );
    expect(listCalls()).toBe(2);
  });
});
