// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    metadata, usage: { totalTokens: 42 }, contextUsage: { usedTokens: 21 }, children: [] };
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
