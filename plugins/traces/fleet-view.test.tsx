// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fleetContract, type FleetSnapshot } from "./fleet-contract";
import { matchesFleetFilter, parseFleetQuery } from "./fleet-query";

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels.find(({ id }) => id === "waterfall")!;

function snapshot(view: "metrics" | "explorer", query: string): FleetSnapshot {
  return {
    jobId: "scan_abc", view, mode: "events", query, since: "24h", status: "complete", error: null,
    from: 1_000, to: 2_000, startedAt: 1_000, updatedAt: 2_000, completedAt: 2_000,
    scannedThreads: 2, totalThreads: 2, scannedEvents: 9, matchedEvents: 3,
    rows: [{ id: "evt_1", seq: 1, at: 1_500, threadId: "thr_abc", turnId: "turn-t1", itemId: "item_1",
      projectId: "proj_1", provider: "codex", model: "gpt", environmentId: null, worktree: true, child: false,
      kind: "toolCall", type: "item/completed", status: "failed", tool: "executor_execute", category: "item-failed",
      durationMs: 1_000, retry: false, name: "toolCall · executor_execute" }],
    rowsTruncated: 0, histogram: Array.from({ length: 25 }, (_, index) => ({ from: index * 40, to: (index + 1) * 40, count: index === 0 ? 3 : 0, errors: 0 })),
    facets: { provider: [{ value: "codex", count: 3 }, { value: "other", count: 4 }] },
    metrics: { turns: 1, toolCalls: 2, failedTools: 1, errorRate: 0.5, toolP50Ms: 500, toolP95Ms: 1_000,
      toolLatencyPartial: false, providerRetries: 1, modelFallbacks: 0, activeThreads: 2,
      slowTools: [{ name: "executor_execute", count: 2, measured: 2, unknown: 0, p50Ms: 500, p95Ms: 1_000, partial: false },
        { name: "other tools", count: 1, measured: 1, unknown: 0, p50Ms: 200, p95Ms: 200, partial: false }],
      slowProviders: [], errors: [{ category: "item-failed", count: 1 }, { category: "other", count: 2 }],
      errorProviders: [], errorTools: [], ttft: [], spawnTree: [], tokenUsage: null,
      tokenCoverage: { threadsWithSnapshot: 0, threadsWithoutSnapshot: 2, reason: "No window totals stored" } },
    freshness: "snapshot", liveSince: null, lastLiveEventAt: null, liveEnabled: false, limited: true, retries: 0,
    limitReasons: [{ code: "rows", count: 1, detail: "1 matching row omitted by display cap" }],
  };
}

describe("fleet UI", () => {
  it("renders aggregate facets without a filter action and selects rows accessibly", async () => {
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: (input) => snapshot("explorer", fleetContract.traces_fleet_start.input.parse(input).query),
      traces_fleet_cancel: () => snapshot("explorer", ""),
      traces_fleet_status: () => snapshot("explorer", ""),
    } });
    await screen.findByRole("button", { name: /Inspect toolCall/ });
    expect(screen.getByText("Other values (grouped)").closest("button")).toBeNull();
    expect(screen.getByRole("list", { name: "Scan limits and omitted data" }).textContent).toContain("1 matching row omitted");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Inspect toolCall/ })); });
    expect(screen.getByRole("button", { name: /Inspect toolCall/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("row", { selected: true })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Filter provider to codex/ })); });
    expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_fleet_start").at(-1)?.input).toMatchObject({ query: "provider:codex" });
    expect(screen.getByRole("button", { name: /Filter provider to codex/ }).getAttribute("aria-pressed")).toBe("true");
    rendered.lifecycle.unmount();
  });

  it("preserves the active Metrics filter when drilling into failed tools", async () => {
    const query = "provider:codex";
    const encoded = `q${btoa(query).replace(/=+$/, "")}`;
    const rendered = renderSlot(panel, { subPath: `metrics/${encoded}/24h` }, { rpc: {
      traces_fleet_start: (input) => snapshot("metrics", fleetContract.traces_fleet_start.input.parse(input).query),
      traces_fleet_cancel: () => snapshot("metrics", query),
      traces_fleet_status: () => snapshot("metrics", query),
    } });
    await screen.findByRole("button", { name: /Tool failure rate/ });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Tool failure rate/ })); });
    const last = rendered.inspection.navigateCalls.at(-1);
    const path = last?.method === "toPluginPanel" ? last.options?.subPath : undefined;
    expect(path?.startsWith("explorer/q")).toBe(true);
    const parts = path!.split("/");
    const filter = atob(parts[1]!.slice(1).replace(/-/g, "+").replace(/_/g, "/"));
    expect(filter).toBe("provider:codex metric:tool-failed");
    expect(matchesFleetFilter({ ...snapshot("explorer", "").rows[0]!, projectName: "Test project" }, parseFleetQuery(filter))).toBe(true);
    expect(screen.getAllByText("other tools").every((element) => element.closest("button") === null)).toBe(true);
    expect(screen.getAllByText("other").every((element) => element.closest("button") === null)).toBe(true);
    rendered.lifecycle.unmount();
  });
  it("coalesces terminal announcements into one status read", async () => {
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: () => snapshot("explorer", ""),
      traces_fleet_cancel: () => snapshot("explorer", ""),
      traces_fleet_status: () => snapshot("explorer", ""),
    } });
    await screen.findByRole("button", { name: /Inspect toolCall/ });
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 20; i++) await rendered.behavior.emitRealtime("traces-fleet", { jobId: "scan_abc", status: "complete" });
      expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_fleet_status")).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_fleet_status")).toHaveLength(1);
    } finally { vi.useRealTimers(); rendered.lifecycle.unmount(); }
  });
});
