// @vitest-environment jsdom
import { act, fireEvent, screen, within } from "@testing-library/react";
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
    rowsTruncated: 2, histogram: Array.from({ length: 25 }, (_, index) => ({ from: index * 40, to: (index + 1) * 40, count: index === 0 ? 3 : 0, errors: 0 })),
    facets: { provider: [{ value: "codex", count: 3 }, { value: "other", count: 4 }] },
    metrics: { turns: 1, toolCalls: 2, failedTools: 1, errorRate: 0.5, toolP50Ms: 500, toolP95Ms: 1_000,
      toolLatencyPartial: false, providerRetries: 1, modelFallbacks: 0, activeThreads: 2,
      slowTools: [{ name: "executor_execute", count: 2, measured: 2, unknown: 0, p50Ms: 500, p95Ms: 1_000, partial: false },
        { name: "other tools", count: 1, measured: 1, unknown: 0, p50Ms: 200, p95Ms: 200, partial: false }],
      slowProviders: [], errors: [{ category: "item-failed", count: 1 }, { category: "other", count: 2 }],
      errorProviders: [], errorTools: [], ttft: [], spawnTree: [], tokenUsage: null,
      tokenCoverage: { threadsWithSnapshot: 0, threadsWithoutSnapshot: 2, reason: "No window totals stored" } },
    freshness: "snapshot", liveSince: null, lastLiveEventAt: null, liveEnabled: false, limited: false, retries: 0,
    limitReasons: [{ code: "rows", count: 2, detail: "2 matching rows omitted by display cap" }],
  };
}

describe("fleet UI", () => {
  it("shows a selected detail pane only until close, refresh, or filter", async () => {
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: (input) => snapshot("explorer", fleetContract.traces_fleet_start.input.parse(input).query),
      traces_fleet_cancel: () => snapshot("explorer", ""),
      traces_fleet_status: () => snapshot("explorer", ""),
      traces_fleet_detail: () => ({ threadId: "thr_abc", seq: 1, type: "item/completed", at: 1_500,
        input: null, output: null, inputSize: null, outputSize: null }),
    } });
    const inspect = await screen.findByRole("button", { name: /Inspect toolCall/ });
    expect(screen.queryByRole("complementary", { name: "Selected event detail" })).toBeNull();
    expect(screen.getByText(/Showing newest 1 of 3 scanned matches/)).toBeTruthy();
    expect(screen.queryByLabelText("Scan coverage and limits")).toBeNull();
    expect(screen.getByText("Other values (grouped)").closest("button")).toBeNull();
    await act(async () => { fireEvent.click(inspect); });
    expect(screen.getByRole("complementary", { name: "Selected event detail" })).toBeTruthy();
    expect(screen.getByRole("row", { selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inspect toolCall/ }).getAttribute("aria-current")).toBe("true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close event detail" })); });
    expect(screen.queryByRole("complementary", { name: "Selected event detail" })).toBeNull();
    expect(document.activeElement).toBe(inspect);
    await act(async () => { fireEvent.click(inspect); fireEvent.click(screen.getByRole("button", { name: "Rescan" })); });
    expect(screen.queryByRole("complementary", { name: "Selected event detail" })).toBeNull();
    await screen.findByRole("button", { name: /Filter provider to codex/ });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Inspect toolCall/ }));
      fireEvent.click(screen.getByRole("button", { name: /Filter provider to codex/ })); });
    expect(screen.queryByRole("complementary", { name: "Selected event detail" })).toBeNull();
    expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "waterfall",
      options: { subPath: "explorer/qcHJvdmlkZXI6Y29kZXg/24h" } });
    rendered.lifecycle.unmount();
  });

  it("opens Waterfall from a thread ID without selecting the row, then exposes Context Inspector in detail", async () => {
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: () => snapshot("explorer", ""),
      traces_fleet_cancel: () => snapshot("explorer", ""),
      traces_fleet_detail: () => ({ threadId: "thr_abc", seq: 1, type: "item/completed", at: 1_500,
        input: null, output: null, inputSize: null, outputSize: null }),
    } });
    await screen.findByRole("button", { name: "Open Waterfall for thr_abc" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open Waterfall for thr_abc" })); });
    expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "waterfall", options: { subPath: "thr_abc" } });
    expect(screen.queryByRole("complementary", { name: "Selected event detail" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Inspect toolCall/ })); });
    await act(async () => { fireEvent.click(within(screen.getByRole("complementary", { name: "Selected event detail" })).getByRole("button", { name: "Context Inspector" })); });
    expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "waterfall", options: { subPath: "context/thr_abc" } });
    rendered.lifecycle.unmount();
  });

  it("opens detail from non-link cells and navigates rows with bounded j/k keys", async () => {
    const base = snapshot("explorer", "");
    const rows = [base.rows[0]!, { ...base.rows[0]!, id: "evt_2", threadId: "thr_def", at: 1_600 }];
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: () => ({ ...base, rows }),
      traces_fleet_cancel: () => ({ ...base, rows }),
      traces_fleet_detail: (input) => { const { threadId, seq, reveal } = fleetContract.traces_fleet_detail.input.parse(input);
        return { threadId, seq, type: "item/completed", at: 1_500, input: reveal ? `sensitive-${threadId}` : null, output: null, inputSize: 4, outputSize: null }; },
    } });
    const region = await screen.findByRole("region", { name: "Explorer results" });
    const [first, second] = within(region).getAllByRole("row").slice(1);
    const original = HTMLElement.prototype.scrollIntoView;
    const scrolled = vi.fn(); HTMLElement.prototype.scrollIntoView = scrolled;
    try {
      await act(async () => { fireEvent.click(second!.querySelector("td:last-child")!); });
      expect(second!.getAttribute("aria-selected")).toBe("true");
      expect(within(screen.getByRole("complementary", { name: "Selected event detail" })).getByText("sensitive-thr_def")).toBeTruthy();
      expect((within(screen.getByRole("complementary", { name: "Selected event detail" })).getByRole("checkbox", { name: "Reveal sensitive data" }) as HTMLInputElement).checked).toBe(true);
      const reveal = within(screen.getByRole("complementary", { name: "Selected event detail" })).getByRole("checkbox", { name: "Reveal sensitive data" });
      await act(async () => { fireEvent.click(reveal); });
      expect(screen.queryByText("sensitive-thr_def")).toBeNull();
      expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_fleet_detail").at(-1)?.input).toMatchObject({ reveal: false });
      region.focus();
      await act(async () => { fireEvent.keyDown(region, { key: "k" }); });
      expect(first!.getAttribute("aria-selected")).toBe("true");
      expect(screen.queryByText("sensitive-thr_def")).toBeNull();
      expect(await screen.findByText("sensitive-thr_abc")).toBeTruthy();
      expect((screen.getByRole("checkbox", { name: "Reveal sensitive data" }) as HTMLInputElement).checked).toBe(true);
      expect(document.activeElement).toBe(first);
      expect(scrolled).toHaveBeenCalled();
      await act(async () => { fireEvent.keyDown(first!, { key: "k" }); });
      expect(first!.getAttribute("aria-selected")).toBe("true");
      await act(async () => { fireEvent.keyDown(first!, { key: "j" }); });
      expect(second!.getAttribute("aria-selected")).toBe("true");
      await act(async () => { fireEvent.keyDown(second!, { key: "j" }); });
      expect(second!.getAttribute("aria-selected")).toBe("true");
      const filter = screen.getByRole("textbox", { name: "Filter" }); filter.focus();
      await act(async () => { fireEvent.keyDown(filter, { key: "k" }); });
      expect(second!.getAttribute("aria-selected")).toBe("true");
      await act(async () => { fireEvent.click(within(second!).getByRole("button", { name: "Open Waterfall for thr_def" })); });
      expect(second!.getAttribute("aria-selected")).toBe("true");
      expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "thr_def" } });
    } finally { HTMLElement.prototype.scrollIntoView = original; rendered.lifecycle.unmount(); }
  });

  it("keeps sustained keyboard traversal windowed and reads detail only after selection settles", async () => {
    const base = snapshot("explorer", "");
    const rows = Array.from({ length: 250 }, (_, index) => ({ ...base.rows[0]!, id: `evt_${index}`, at: 1_500 + index }));
    const data = { ...base, rows, matchedEvents: rows.length };
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: () => data, traces_fleet_cancel: () => data,
      traces_fleet_detail: (input) => { const { threadId, seq } = fleetContract.traces_fleet_detail.input.parse(input);
        return { threadId, seq, type: "item/completed", at: 1_500, input: null, output: null, inputSize: null, outputSize: null }; },
    } });
    const region = await screen.findByRole("region", { name: "Explorer results" });
    Object.defineProperty(region, "clientHeight", { value: 270, configurable: true });
    expect(region.querySelectorAll("tbody tr").length).toBeLessThan(55);
    vi.useFakeTimers();
    try {
      region.focus();
      for (let index = 0; index < 70; index++) await act(async () => { fireEvent.keyDown(region, { key: "j" }); });
      expect(region.scrollTop).toBeGreaterThan(0);
      expect(region.querySelectorAll("tbody tr").length).toBeLessThan(55);
      expect(document.activeElement?.getAttribute("data-row-index")).toBe("69");
      expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_fleet_detail")).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(180); });
      expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_fleet_detail")).toHaveLength(1);
    } finally { rendered.lifecycle.unmount(); vi.useRealTimers(); }
  });

  it("keeps query grammar behind an accessible info disclosure without an Explorer title strip", async () => {
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: () => snapshot("explorer", ""),
      traces_fleet_cancel: () => snapshot("explorer", ""),
    } });
    await screen.findByRole("button", { name: /Inspect toolCall/ });
    expect(screen.getByLabelText("Query syntax help").closest("details")?.open).toBe(false);
    expect(screen.queryByRole("heading", { name: "Log Explorer" })).toBeNull();
    expect(screen.getByRole("img", { name: "Matching event count by time interval" })).toBeTruthy();
    expect(screen.queryByText("Time-bin data table")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByLabelText("Query syntax help")); });
    expect(screen.getByLabelText("Query syntax help").closest("details")?.open).toBe(true);
    expect(screen.getByText(/AND-only/)).toBeTruthy();
    expect(screen.queryByLabelText("Scan coverage and limits")).toBeNull();
    rendered.lifecycle.unmount();
  });
  it("labels a completed scan's row display cap without claiming source incompleteness", async () => {
    const complete = { ...snapshot("explorer", ""), rowsTruncated: 0, limitReasons: [] };
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: () => complete, traces_fleet_cancel: () => complete,
    } });
    await screen.findByRole("button", { name: /Inspect toolCall/ });
    expect(screen.getByRole("status").textContent).toBe("complete");
    expect(screen.getByText(/Showing newest 1 of 3 scanned matches/)).toBeTruthy();
    expect(screen.queryByText(/Source limited/)).toBeNull();
    expect(screen.queryByText(/Latency sampled/)).toBeNull();
    rendered.lifecycle.unmount();
  });
  it("shows sampled latency and source caps as distinct visible reasons", async () => {
    const base = snapshot("explorer", "");
    const sampled = { ...base, limited: true, limitReasons: [...base.limitReasons,
      { code: "samples" as const, count: 2, detail: "Measured tool durations omitted by sample caps; p50/p95 are partial." }] };
    const first = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: () => sampled, traces_fleet_cancel: () => sampled,
    } });
    await screen.findByRole("button", { name: /Inspect toolCall/ });
    expect(screen.getByRole("status").textContent).toBe("complete");
    expect(screen.getByText(/Latency sampled: 2 measured durations omitted/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Source scan limits" })).toBeNull();
    first.lifecycle.unmount();
    const source = { ...base, limited: true, scannedThreads: 1, totalThreads: 2, limitReasons: [...base.limitReasons,
      { code: "thread-cap" as const, count: 1, detail: "Candidate threads beyond the 2,000-thread cap were not scanned." }] };
    const second = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: () => source, traces_fleet_cancel: () => source,
    } });
    await screen.findByRole("button", { name: /Inspect toolCall/ });
    expect(screen.getByRole("list", { name: "Source scan limits" }).textContent).toContain("Source limited: 1 Candidate threads");
    expect(screen.queryByText(/Latency sampled/)).toBeNull();
    second.lifecycle.unmount();
  });
  it("keeps Metrics source and latency limits visible while expanding the unknown-token explanation", async () => {
    const base = snapshot("metrics", "");
    const limited = { ...base, limited: true, limitReasons: [
      { code: "samples" as const, count: 2, detail: "Measured tool durations omitted by sample caps." },
      { code: "thread-cap" as const, count: 1, detail: "Candidate threads beyond the 2,000-thread cap were not scanned." },
    ] };
    const rendered = renderSlot(panel, { subPath: "metrics/_/24h" }, { rpc: {
      traces_fleet_start: () => limited, traces_fleet_cancel: () => limited,
    } });
    await screen.findByRole("button", { name: /Tool failure rate/ });
    expect(screen.getByText(/Latency sampled: 2 measured durations omitted/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Source scan limits" }).textContent).toContain("Source limited: 1 Candidate threads");
    const explanation = screen.getByText("Why token/cache totals are unknown").closest("details")!;
    expect(explanation.hasAttribute("open")).toBe(false);
    await act(async () => { fireEvent.click(screen.getByText("Why token/cache totals are unknown")); });
    expect(explanation.textContent).toContain("No window totals stored");
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
    expect(screen.getByRole("heading", { name: "Fleet Metrics" })).toBeTruthy();
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
  it("lets keyboard users change the Window range through the BB-styled listbox", async () => {
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const rendered = renderSlot(panel, { subPath: "explorer/_/24h" }, { rpc: {
      traces_fleet_start: (input) => { const { query, since } = fleetContract.traces_fleet_start.input.parse(input);
        return { ...snapshot("explorer", query), since }; },
      traces_fleet_cancel: () => snapshot("explorer", ""),
    } });
    try {
      await screen.findByRole("button", { name: /Inspect toolCall/ });
      const trigger = screen.getByRole("combobox", { name: "Window" });
      expect(trigger.textContent).toContain("24 hours");
      trigger.focus();
      await act(async () => { fireEvent.keyDown(trigger, { key: "Enter" }); });
      const choice = await screen.findByRole("option", { name: "6 hours" });
      await act(async () => { fireEvent.click(choice); });
      expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "waterfall",
        options: { subPath: "explorer/_/6h" } });
    } finally { rendered.lifecycle.unmount(); HTMLElement.prototype.scrollIntoView = originalScroll; }
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
