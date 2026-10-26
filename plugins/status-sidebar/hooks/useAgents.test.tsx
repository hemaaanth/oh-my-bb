// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { AgentSidebarSnapshot } from "../shared";

installTestPluginRuntime();
// SDK app hooks require the test runtime before this module is evaluated.
const { useAgents } = await import("./useAgents");

function Harness() {
  const snapshot = useAgents();
  return <p>{snapshot?.excludedThreadIds.join(",") ?? "unavailable"}</p>;
}

afterEach(cleanup);

describe("useAgents", () => {
  it("uses pushed mappings and reloads after reconnect", async () => {
    let rows: AgentSidebarSnapshot = { agents: [], excludedThreadIds: ["first"] };
    let calls = 0;
    const mounted = renderSlot({ component: Harness }, {}, {
      rpc: { listAgents: () => { calls += 1; return rows; } },
    });
    await act(async () => {});
    expect(screen.getByText("first")).toBeDefined();
    await mounted.behavior.emitRealtime("agents-changed", { agents: [], excludedThreadIds: ["second"] });
    expect(screen.getByText("second")).toBeDefined();
    expect(calls).toBe(1);
    rows = { agents: [], excludedThreadIds: ["third"] };
    await mounted.behavior.setRealtimeConnectionState("reconnecting");
    await mounted.behavior.setRealtimeConnectionState("connected");
    await act(async () => {});
    expect(screen.getByText("third")).toBeDefined();
    expect(calls).toBe(2);
  });
});
