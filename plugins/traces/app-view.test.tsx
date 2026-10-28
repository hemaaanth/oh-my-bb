// @vitest-environment jsdom
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "./server";
import type { TraceResult, TraceSpan } from "./spans";
import type { PromptResult } from "./prompt-contract";

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels.find(({ id }) => id === "waterfall")!;

function trace(threadId: string, reveal: boolean): TraceResult {
  const metadata = { model: "test-model", provider: "codex", reasoningLevel: null, permissionMode: null, environment: null, initiator: null };
  const turn: TraceSpan = { id: "turn-1", threadId, turnId: "turn-t1", itemId: null, kind: "turn", name: "turn-t1",
    start: 1_000, end: 2_000, durationMs: 1_000, status: "completed", error: null,
    input: reveal ? "sensitive-waterfall" : null, output: null, inputSize: 19, outputSize: null,
    metadata, usage: { totalTokens: 42 }, contextUsage: { usedTokens: 21 },
    children: [{ id: "tool-1", threadId, turnId: "turn-t1", itemId: "item-1", kind: "toolCall", name: "fetch",
      start: 1_200, end: 1_500, durationMs: 300, status: "completed", error: null,
      input: null, output: null, inputSize: null, outputSize: null, metadata, usage: null, contextUsage: null,
      children: [{ id: "nested-1", threadId, turnId: "turn-t1", itemId: "nested-1", kind: "fileRead", name: "Child file",
        start: 1_250, end: 1_300, durationMs: 50, status: "completed", error: null, input: null, output: null,
        inputSize: null, outputSize: null, metadata, usage: null, contextUsage: null, children: [] }] }] };
  return { tree: { ...turn, id: "root", kind: "thread", name: "Test thread", turnId: null, input: null, inputSize: null, usage: null,
    contextUsage: null, children: [turn] }, summary: { elapsedMs: 1_000, activeMs: 1_000, counts: {}, timeMs: { wait: 100 },
    slowest: [], errors: [{ id: "error", kind: "toolCall", name: "Failed tool", error: null }] }, lastSeq: 2, eventCount: 2 };
}

function prompt(threadId: string, call: number | null, reveal: boolean): PromptResult {
  const index = call ?? 2;
  return { status: "available", reason: null, threadId, provider: "codex", sessionId: null, callCount: 2,
    selectedIndex: index, selected: { index, at: 1_000, model: "test-model", requestId: null, turnId: null, durationMs: 100,
      usage: null, system: [{ id: "system-1", label: "System block", kind: "system", chars: 20, estimatedTokens: 5,
        text: reveal ? `sensitive-context-${index}` : null, truncated: false }], tools: [], injected: [],
      params: { maxTokens: null, thinking: null, effort: null }, contextUsedTokens: 10, contextWindowTokens: 100,
      diff: { previousCall: index === 1 ? null : 1, systemChanged: false, modelChanged: false,
        toolsAdded: [], toolsRemoved: [], injectedAdded: [], injectedRemoved: [] } },
    ledger: [], ledgerStart: 1, totals: null, scan: { bytesRead: 100, linesRead: 2, malformedLines: 0, oversizedLines: 0, limited: false } };
}

describe("Traces thread UI", () => {
  it("opens the Waterfall reveal by default, uses a BB-styled turn picker, and clears content when disabled", async () => {
    const rendered = renderSlot(panel, { subPath: "thr_abc" }, { rpc: {
      traces_thread: (input) => { const { threadId, reveal } = rpcContract.traces_thread.input.parse(input); return trace(threadId, reveal); },
    } });
    expect(screen.getByRole("button", { name: "Waterfall" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByText("sensitive-waterfall")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Reveal sensitive data" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("combobox", { name: "Turn" }).className).toContain("traces-turn-trigger");
    expect(screen.queryByRole("checkbox", { name: "Children" })).toBeNull();
    expect(rendered.inspection.rpcCalls.find((call) => call.method === "traces_thread")?.input).toMatchObject({ reveal: true, includeChildren: false });
    expect(screen.queryByText(/error spans.*Select a red bar/)).toBeNull();
    expect(screen.queryByText(/Model \/ uninstrumented time is/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Reveal sensitive data" })); });
    expect(screen.queryByText("sensitive-waterfall")).toBeNull();
    expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_thread").at(-1)?.input).toMatchObject({ reveal: false });
    rendered.lifecycle.unmount();
  });

  it("summarizes the focused turn and folds nested spans with keyboard navigation", async () => {
    const rendered = renderSlot(panel, { subPath: "thr_abc/turn/turn-t1" }, { rpc: {
      traces_thread: (input) => { const { threadId, reveal } = rpcContract.traces_thread.input.parse(input); return trace(threadId, reveal); },
    } });
    const region = await screen.findByRole("region", { name: "Waterfall spans" });
    expect(screen.getByRole("region", { name: "Turn summary" }).textContent).toContain("2 tools");
    expect(screen.getByRole("button", { name: "Collapse toolCall fetch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Child file/ })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Collapse toolCall fetch" })); });
    expect(screen.queryByRole("button", { name: /Child file/ })).toBeNull();
    region.focus();
    await act(async () => { fireEvent.keyDown(region, { key: "ArrowRight" }); });
    expect(screen.getByRole("button", { name: /Child file/ })).toBeTruthy();
    await act(async () => { fireEvent.keyDown(region, { key: "ArrowDown" }); });
    expect(screen.getByRole("button", { name: /Child file/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Previous turn" })).toHaveProperty("disabled", true);
    rendered.lifecycle.unmount();
  });

  it("keeps explicit turn URLs without changing the BB thread ID", async () => {
    const rendered = renderSlot(panel, { subPath: "thr_abc/turn/turn-t1" }, { rpc: {
      traces_thread: (input) => { const { threadId, reveal } = rpcContract.traces_thread.input.parse(input);
        const original = trace(threadId, reveal);
        const next = { ...original.tree.children[0]!, id: "turn-2", turnId: "turn-t2", name: "turn-t2",
          start: 3_000, end: 4_000, children: [] };
        return { ...original, tree: { ...original.tree, children: [...original.tree.children, next] } }; },
    } });
    await screen.findByRole("region", { name: "Turn summary" });
    expect(screen.getByRole("region", { name: "Turn summary" }).textContent).toContain("Turn 1 of 2");
    expect(screen.getByRole("button", { name: "Waterfall" }).getAttribute("aria-current")).toBe("page");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next turn" })); });
    expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "waterfall", options: { subPath: "thr_abc/turn/turn-t2" } });
    rendered.lifecycle.unmount();
  });

  it("expands exact command runs, compares turns, and navigates a long timeline by zoom and minimap", async () => {
    const rendered = renderSlot(panel, { subPath: "thr_abc/turn/turn-t2" }, { rpc: {
      traces_thread: (input) => { const { threadId, reveal } = rpcContract.traces_thread.input.parse(input);
        const base = trace(threadId, reveal);
        const first = { ...base.tree.children[0]!, usage: { last: { inputTokens: 100, outputTokens: 10 } } };
        const children = Array.from({ length: 30 }, (_, index): TraceSpan => ({ ...first.children[0]!, id: `command-${index}`,
          turnId: "turn-t2", kind: "commandExecution", name: index < 25 ? "Command · git" : "Command · npm",
          start: 3_000 + index * 300, end: 3_100 + index * 300, durationMs: index === 24 ? 800 : 100,
          children: index === 24 ? [{ ...first.children[0]!.children[0]!, id: "nested-command", turnId: "turn-t2" }] : [] }));
        const second: TraceSpan = { ...first, id: "turn-2", turnId: "turn-t2", name: "turn-t2", start: 3_000,
          end: 18_000, durationMs: 15_000, usage: { last: { inputTokens: 200, outputTokens: 20 } }, children };
        return { ...base, tree: { ...base.tree, end: 18_000, durationMs: 17_000, children: [first, second] }, eventCount: 40 }; },
    } });
    expect((await screen.findByRole("region", { name: "Turn summary" })).textContent).toContain("31 tools");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Pan zoomed timeline" })).toHaveProperty("disabled", true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Compare with previous turn" })); });
    const comparison = screen.getByRole("region", { name: "Turn comparison" });
    expect(comparison.textContent).toContain("Turn 1 → Turn 2");
    expect(comparison.textContent).toContain("Last stored input tokens100200snapshot only");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Calls by command/tool" })); });
    const groups = screen.getByRole("region", { name: "Calls by command or tool" });
    expect(groups.textContent).toContain("Command · git25 runs");
    await act(async () => { fireEvent.click(within(groups).getByText("Command · git")); });
    expect(within(groups).getByRole("button", { name: "Show 5 more runs" })).toBeTruthy();
    await act(async () => { fireEvent.click(within(groups).getByRole("button", { name: "Show 5 more runs" })); });
    expect(within(groups).getByRole("button", { name: /Run 25 · 1 child spans/ })).toBeTruthy();
    await act(async () => { fireEvent.click(within(groups).getByRole("button", { name: /Run 25 · 1 child spans/ })); });
    expect(screen.queryByRole("region", { name: "Calls by command or tool" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Span detail" }).textContent).toContain("Command · git");
    expect((screen.getByRole("slider", { name: "Pan zoomed timeline" }) as HTMLInputElement).disabled).toBe(false);
    const timeline = screen.getByRole("region", { name: "Waterfall spans" });
    timeline.focus();
    await act(async () => { fireEvent.keyDown(timeline, { key: "ArrowDown" }); });
    expect(timeline.querySelector(".traces-row-selected")?.getAttribute("data-span-id")).toBe("nested-command");
    const before = screen.getByRole("slider", { name: "Pan zoomed timeline" }) as HTMLInputElement;
    const original = Number(before.value);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pan right" })); });
    expect(Number((screen.getByRole("slider", { name: "Pan zoomed timeline" }) as HTMLInputElement).value)).toBeGreaterThanOrEqual(original);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reset zoom" })); });
    expect((screen.getByRole("slider", { name: "Pan zoomed timeline" }) as HTMLInputElement).disabled).toBe(true);
    rendered.lifecycle.unmount();
  });

  it("marks a running comparison incomplete and bounds a large turn's mounted rows", async () => {
    const rendered = renderSlot(panel, { subPath: "thr_abc" }, { rpc: {
      traces_thread: (input) => { const { threadId, reveal } = rpcContract.traces_thread.input.parse(input);
        const base = trace(threadId, reveal);
        const old = base.tree.children[0]!;
        const start = Date.now() - 10_000;
        const current: TraceSpan = { ...old, id: "turn-new", turnId: "t2", name: "t2", start, end: null, durationMs: null,
          usage: null, status: "running", children: Array.from({ length: 180 }, (_, index) => ({ ...old.children[0]!,
            id: `call-${index}`, kind: "commandExecution", name: "Command · git", start: start + index * 40,
            end: start + index * 40 + 15, durationMs: 15, children: [] })) };
        return { ...base, tree: { ...base.tree, end: start + 8_000, children: [old, current] }, eventCount: 200 }; },
    } });
    const region = await screen.findByRole("region", { name: "Waterfall spans" });
    expect(region.querySelectorAll(".traces-row").length).toBeLessThanOrEqual(55);
    expect(screen.getByRole("region", { name: "Turn summary" }).textContent).toContain("running");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Compare with previous turn" })); });
    const compare = screen.getByRole("region", { name: "Turn comparison" });
    expect(compare.textContent).toContain("duration and time allocation are incomplete");
    expect(within(compare).getByRole("row", { name: /Duration/ }).textContent).toContain("not measured");
    expect(compare.textContent).toContain("incomplete");
    rendered.lifecycle.unmount();
  });

  it("reports no turns before a thread begins instead of Turn 0 of 0", async () => {
    const rendered = renderSlot(panel, { subPath: "thr_empty" }, { rpc: {
      traces_thread: (input) => { const { threadId, reveal } = rpcContract.traces_thread.input.parse(input);
        const initial = trace(threadId, reveal); return { ...initial, tree: { ...initial.tree, children: [] }, eventCount: 0 }; },
    } });
    expect((await screen.findByRole("region", { name: "Turn summary" })).textContent).toContain("No turns yet");
    expect(screen.queryByText(/Turn 0 of 0/)).toBeNull();
    rendered.lifecycle.unmount();
  });

  it("coalesces live append signals and catches up after socket reconnection", async () => {
    let version = 2;
    const rendered = renderSlot(panel, { subPath: "thr_abc/turn/turn-t1" }, { rpc: {
      traces_thread: (input) => { const { threadId, reveal } = rpcContract.traces_thread.input.parse(input);
        return { ...trace(threadId, reveal), eventCount: version }; },
    } });
    await screen.findByRole("region", { name: "Turn summary" });
    expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_thread")).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      version = 8;
      for (let index = 0; index < 10; index++) await rendered.behavior.emitRealtime("traces-changed", { threadId: "thr_abc" });
      await rendered.behavior.emitRealtime("traces-changed", { threadId: "thr_other" });
      expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_thread")).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });
      expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_thread")).toHaveLength(2);
      expect(screen.getByText(/Span · 8 events/)).toBeTruthy();
      version = 9;
      await rendered.behavior.setRealtimeConnectionState("reconnecting");
      await rendered.behavior.setRealtimeConnectionState("connected");
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });
      expect(screen.getByText(/Span · 9 events/)).toBeTruthy();
      expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_thread")).toHaveLength(3);
    } finally { vi.useRealTimers(); rendered.lifecycle.unmount(); }
  });

  it("hides Context payload immediately on call switch or Reveal off", async () => {
    const rendered = renderSlot(panel, { subPath: "context/thr_abc" }, { rpc: {
      traces_prompt: (input) => { const { threadId, call, reveal } = rpcContract.traces_prompt.input.parse(input); return prompt(threadId, call, reveal); },
    } });
    expect(screen.getByRole("button", { name: "Context Inspector" }).getAttribute("aria-current")).toBe("page");
    const section = await screen.findByText("System block");
    expect((screen.getByRole("checkbox", { name: "Reveal sensitive data" }) as HTMLInputElement).checked).toBe(true);
    expect(rendered.inspection.rpcCalls.find((call) => call.method === "traces_prompt")?.input).toMatchObject({ reveal: true });
    await act(async () => { fireEvent.click(section.closest("summary")!); });
    expect(screen.getByText("sensitive-context-2")).toBeTruthy();
    const previous = screen.getByRole("button", { name: "Previous API call" });
    await act(async () => { fireEvent.click(previous); });
    expect(screen.queryByText("sensitive-context-2")).toBeNull();
    expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_prompt").at(-1)?.input).toMatchObject({ call: 1, reveal: true });
    await screen.findByText("System block");
    const checkbox = screen.getByRole("checkbox", { name: "Reveal sensitive data" });
    await act(async () => { fireEvent.click(checkbox); });
    expect(screen.queryByText("sensitive-context-1")).toBeNull();
    expect(rendered.inspection.rpcCalls.filter((call) => call.method === "traces_prompt").at(-1)?.input).toMatchObject({ reveal: false });
    rendered.lifecycle.unmount();
  });

  it("opens the sidebar panel root in Explorer, including an unknown subPath", async () => {
    for (const subPath of ["", "unknown"]) {
      const rendered = renderSlot(panel, { subPath }, { rpc: { traces_fleet_start: () => { throw new Error("Route test does not scan storage."); } } });
      expect(screen.getByRole("button", { name: "Log Explorer" }).getAttribute("aria-current")).toBe("page");
      expect(screen.getByRole("textbox", { name: "Filter" })).toBeTruthy();
      expect(screen.queryByText(/Select a thread in Log Explorer/)).toBeNull();
      rendered.lifecycle.unmount();
    }
  });

  it("retains explicit empty Waterfall and Context routes without manual ID forms", async () => {
    for (const [subPath, tab] of [["waterfall", "Waterfall"], ["context", "Context Inspector"]]) {
      const rendered = renderSlot(panel, { subPath }, {});
      expect(screen.getByRole("button", { name: tab }).getAttribute("aria-current")).toBe("page");
      expect(screen.queryByRole("textbox", { name: "Thread ID" })).toBeNull();
      expect(screen.getByText(/Select a thread in Log Explorer/)).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open Log Explorer" })); });
      expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "explorer/_/24h" } });
      rendered.lifecycle.unmount();
    }
  });
});
