// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShareStatus } from "./contract";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

const headerProps = {
  threadId: "thread-1",
  projectId: "project-1",
  isCompactViewport: false,
};

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
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "thread-1", projectId: "project-1", isCompactViewport: false },
      { rpc: { status: () => promise } },
    );

    fireEvent.click(slot.getByRole("button", { name: "Session Share" }));
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

    const custom = await slot.findByRole("button", {
      name: "Custom share.example.test",
    });
    expect(custom.getAttribute("aria-pressed")).toBe("true");
    expect(slot.queryByRole("status")).toBeNull();
  });

  it("opens viewers through BB's configured URL handler", async () => {
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
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "thread-1", projectId: "project-1", isCompactViewport: false },
      { rpc: { status: () => status }, openUrl: (url) => url === publicUrl },
    );

    fireEvent.click(slot.getByRole("button", { name: /Session Share/u }));
    fireEvent.click(await slot.findByRole("button", { name: "Open viewer" }));

    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openUrl",
      url: publicUrl,
    });
  });

  it("follows share signals instead of polling while the dialog is closed", async () => {
    vi.useFakeTimers();
    const app = await loadPluginApp(() => import("./app"));
    let current: ShareStatus | null = null;
    const slot = renderSlot(app.threadHeaderActions[0]!, headerProps, {
      rpc: { share: () => ({ share: current }) },
    });
    const shareCalls = () =>
      slot.inspection.rpcCalls.filter((call) => call.method === "share").length;

    await vi.waitFor(() => expect(shareCalls()).toBe(1));
    await advance(5 * 60_000);
    expect(shareCalls()).toBe(1);
    expect(slot.inspection.rpcCalls.map((call) => call.method)).not.toContain(
      "status",
    );

    await slot.behavior.emitRealtime("session-share", {
      shareId: "share-other",
      threadId: "thread-2",
      state: "active",
    });
    expect(shareCalls()).toBe(1);

    current = makeShare();
    await slot.behavior.emitRealtime("session-share", {
      shareId: "share-1",
      threadId: "thread-1",
      state: "ready",
    });
    expect(shareCalls()).toBe(2);

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await vi.waitFor(() => expect(shareCalls()).toBe(3));
  });

  it("re-checks a preparing share until it is live", async () => {
    vi.useFakeTimers();
    const app = await loadPluginApp(() => import("./app"));
    let current: ShareStatus | null = makeShare({ ready: false });
    const slot = renderSlot(app.threadHeaderActions[0]!, headerProps, {
      rpc: { share: () => ({ share: current }) },
    });
    const shareCalls = () =>
      slot.inspection.rpcCalls.filter((call) => call.method === "share").length;

    await vi.waitFor(() => expect(shareCalls()).toBe(1));
    // Let the preparing response land so the fallback timer is armed.
    await advance(1);
    current = makeShare({ ready: true });
    await advance(15_000);
    expect(shareCalls()).toBe(2);
    await advance(5 * 60_000);
    expect(shareCalls()).toBe(2);
  });

  it("refreshes the open panel on signals and only slowly otherwise", async () => {
    vi.useFakeTimers();
    const app = await loadPluginApp(() => import("./app"));
    let current: ShareStatus | null = null;
    const slot = renderSlot(app.threadHeaderActions[0]!, headerProps, {
      rpc: {
        share: () => ({ share: current }),
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

    fireEvent.click(slot.getByRole("button", { name: "Session Share" }));
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
    vi.useFakeTimers();
    const app = await loadPluginApp(() => import("./app"));
    let shares: ShareStatus[] = [];
    const slot = renderSlot(app.settingsSections.find(({ id }) => id === "credentials")!, {}, {
      rpc: { list: () => ({ shares }) },
    });
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
