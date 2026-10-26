// @vitest-environment jsdom
import { act, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LIVE_TARGET_HEARTBEAT_MS } from "./lib/live-target";

// jsdom lacks ResizeObserver; the panel only uses it for layout.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Pinpoint live target heartbeat", () => {
  it("renews the mounted panel's lease on the heartbeat, not faster", async () => {
    const app = await loadPluginApp(() => import("./app"));
    // Resolve the lazily imported panel module before faking timers.
    await import("./panel");
    vi.useFakeTimers();
    const panel = app.threadPanelActions.find(
      (action) => action.id === "browser",
    )!;
    const slot = renderSlot(
      panel,
      {
        threadId: "thread-1",
        projectId: "project-1",
        params: { url: "https://app.example.test/" },
        isCompactViewport: false,
      } as never,
      {
        rpc: {
          config: () => ({
            defaultUrl: "",
            relayMode: "thread",
            autoDispatch: false,
            proxyBase: "/proxy/",
          }),
          list: () => ({ rows: [] }),
          setLiveTarget: () => ({ ok: true }),
          clearLiveTarget: () => ({ ok: true }),
        },
      },
    );
    const renewals = () =>
      slot.inspection.rpcCalls.filter(
        (call) => call.method === "setLiveTarget",
      ).length;

    // The panel is lazy-loaded; wait for it to mount and publish once.
    await vi.waitFor(() => expect(renewals()).toBe(1));
    // The previous 5 s cadence would have renewed three times by now.
    await advance(LIVE_TARGET_HEARTBEAT_MS - 1_000);
    expect(renewals()).toBe(1);
    await advance(1_000);
    expect(renewals()).toBe(2);
    await advance(60_000);
    expect(renewals()).toBe(2 + Math.floor(60_000 / LIVE_TARGET_HEARTBEAT_MS));

    slot.unmount();
    await advance(1);
    expect(
      slot.inspection.rpcCalls.filter(
        (call) => call.method === "clearLiveTarget",
      ),
    ).toHaveLength(1);
    await advance(60_000);
    expect(renewals()).toBe(2 + Math.floor(60_000 / LIVE_TARGET_HEARTBEAT_MS));
  });
});
