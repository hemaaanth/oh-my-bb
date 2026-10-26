// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ChannelSummary } from "../shared";

// The hook's `@get-bb/plugin-sdk/app` import resolves against this runtime,
// so it has to be installed before the hook module loads.
installTestPluginRuntime();
const { useChannels } = await import("./useChannels");

function Harness() {
  const channels = useChannels();
  return (
    <p>
      {channels === null
        ? "none"
        : channels.map((channel) => `${channel.name}${channel.unread ? "*" : ""}`).join(",") || "empty"}
    </p>
  );
}

function channel(name: string, unread = false): ChannelSummary {
  return {
    id: `00000000-0000-4000-8000-${name.padStart(12, "0")}`,
    name,
    pinned: false,
    unread,
    active: false,
    memberCount: 1,
    updatedAt: 1,
  };
}

async function mount() {
  let rows: ChannelSummary[] = [channel("ops")];
  let calls = 0;
  const rendered = renderSlot({ component: Harness }, {}, {
    rpc: {
      listChannels: () => {
        calls += 1;
        return rows;
      },
    },
  });
  await act(async () => {});
  return {
    rendered,
    calls: () => calls,
    setRows: (next: ChannelSummary[]) => {
      rows = next;
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("useChannels", () => {
  it("applies rows pushed in the change signal without calling back", async () => {
    const { rendered, calls } = await mount();
    expect(screen.getByText("ops")).toBeTruthy();
    expect(calls()).toBe(1);

    await rendered.behavior.emitRealtime("channels-changed", {
      channels: [channel("ops", true), channel("eng")],
    });
    expect(screen.getByText("ops*,eng")).toBeTruthy();
    await rendered.behavior.emitRealtime("channels-changed", { channels: null });
    expect(screen.getByText("none")).toBeTruthy();
    expect(calls()).toBe(1);
  });

  it("reloads for a signal without rows and after a reconnect", async () => {
    const { rendered, calls, setRows } = await mount();
    setRows([channel("eng")]);

    await rendered.behavior.emitRealtime("channels-changed", null);
    await act(async () => {});
    expect(screen.getByText("eng")).toBeTruthy();
    expect(calls()).toBe(2);

    setRows([]);
    await rendered.behavior.setRealtimeConnectionState("reconnecting");
    expect(calls()).toBe(2);
    await rendered.behavior.setRealtimeConnectionState("connected");
    await act(async () => {});
    expect(screen.getByText("empty")).toBeTruthy();
    expect(calls()).toBe(3);
  });
});
