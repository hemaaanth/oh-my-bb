// @vitest-environment jsdom
import { act, fireEvent, screen, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useState } from "react";
import { SummaryFrame, ThreadBriefSection } from "./thread-brief";
import { rpcContract, type ThreadBrief } from "./server";

const app = await loadPluginApp(() => import("./app.js"));
const section = app.threadInfoSections.find(({ id }) => id === "summary")!;
const props = { threadId: "thr_a", projectId: "proj", environment: null };

const brief = {
  goal: "Ship subscription briefings", done: ["Adapter written"], remaining: ["Frontend tests"],
  current: "Waiting for review", decisions: ["Default stays OpenRouter"], openDecisions: [],
};
const saved = (overrides: Partial<ThreadBrief> = {}): ThreadBrief => ({
  threadId: "thr_a", rootThreadId: "thr_a", visible: true, title: "Journal work", brief, generatedAt: Date.now() - 5 * 60_000,
  model: "subscription:gpt-6-luna", stale: false, lastActivityAt: null, running: false, error: null, retryAt: null, pending: false, automatic: true,
  coverage: { fromSeq: 1, toSeq: 9, historyClipped: false, excerptClipped: false, startRead: true, passes: 1, workDays: 1, workDaysTotal: 1, children: 0, childrenTotal: 0 },
  ...overrides,
});
describe("thread Summary section", () => {
  it("replaces the thread menu and popup with a native Info section", () => {
    expect(section.group).toBe("1_related");
    expect(app.threadActions.some(({ id }) => id === "thread-brief")).toBe(false);
    expect(app.appOverlays.some(({ id }) => id === "thread-brief")).toBe(false);
  });
  it("reads saved data on mount and generates only when requested", async () => {
    const rendered = renderSlot(section, props,
      { rpc: { journal_thread_brief: (input) => saved(rpcContract.journal_thread_brief.input.parse(input)), journal_refresh_thread_brief: () => saved() } });
    expect(await screen.findByTitle("Ship subscription briefings")).toBeTruthy();
    for (const title of ["Original goal", "Done so far", "Remaining work", "Where it stopped", "Decisions made"])
      expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText("Open decisions")).toBeNull();
    expect(screen.getByTitle(/Update summary.*Updated 5m ago/)).toBeTruthy();
    expect(screen.getByText("5m ago").closest("h3")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update summary" })); });
    expect(rendered.inspection.rpcCalls.map((call) => call.method)).toEqual(["journal_thread_brief", "journal_refresh_thread_brief"]);
    expect(rendered.inspection.rpcCalls.every((call) => JSON.stringify(call.input) === JSON.stringify({ threadId: "thr_a" }))).toBe(true);
    rendered.lifecycle.unmount();
  });

  it("keeps the timestamp, content and expansion stable during refresh", async () => {
    const pending = Promise.withResolvers<ThreadBrief>();
    const rendered = renderSlot(section, props, { rpc: {
      journal_thread_brief: () => saved(), journal_refresh_thread_brief: () => pending.promise,
    } });
    const goal = await screen.findByTitle("Ship subscription briefings");
    const body = goal.closest("[aria-busy]")!;
    const refreshHint = screen.getByTitle(/Updated 5m ago/);
    expect(screen.getByText("5m ago").closest("h3")).toBeTruthy();
    const details = goal.closest("details")!;
    details.open = false;
    const before = body.innerHTML;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update summary" })); });
    expect(body.innerHTML).toBe(before);
    expect(screen.getByTitle(/Updated 5m ago/)).toBe(refreshHint);
    expect(screen.queryByText(/Updating|Generating summary/)).toBeNull();
    expect(document.querySelector(".animate-spin")).toBeTruthy();
    await act(async () => { pending.resolve(saved({ generatedAt: Date.now() })); });
    expect(screen.getByTitle(/Updated now/)).toBe(refreshHint);
    expect(details.open).toBe(false);
    expect(document.querySelector(".animate-spin")).toBeNull();
    rendered.lifecycle.unmount();
  });

  it("collapses history independently and keeps bullet rows noninteractive", async () => {
    const rendered = renderSlot(section, props, { rpc: { journal_thread_brief: () => saved({ brief: { ...brief, olderHistory: ["Earlier work retired"] } }) } });
    await screen.findByTitle("Ship subscription briefings");
    const history = screen.getByText("Older history").closest("details")!;
    const goal = screen.getByText("Original goal").closest("details")!;
    expect(history.open).toBe(false);
    expect(goal.open).toBe(true);
    goal.open = false;
    expect(history.open).toBe(false);
    expect(screen.getByTitle("Ship subscription briefings").tagName).toBe("LI");
    expect(screen.getByTitle("Ship subscription briefings").querySelector("details, summary, button")).toBeNull();
    rendered.lifecycle.unmount();
  });

  it("keeps pending reads visible and surfaces a failed read", async () => {
    const pending = Promise.withResolvers<ThreadBrief>();
    const rendered = renderSlot(section, props,
      { rpc: { journal_thread_brief: () => pending.promise } });
    expect(screen.getByTestId("brief-loading")).toBeTruthy();
    await act(async () => { pending.resolve(saved({ brief: null, generatedAt: null, coverage: null, automatic: false })); });
    rendered.lifecycle.unmount();

    const failing = renderSlot(section, props,
      { rpc: { journal_thread_brief: () => { throw new Error("database busy"); } } });
    expect((await screen.findByRole("alert")).textContent).toContain("database busy");
    failing.lifecycle.unmount();

  });

  it("drops a late answer for the previous thread and re-reads stored rows on turn signals", async () => {
    const first = Promise.withResolvers<ThreadBrief>();
    const rendered = renderSlot(section, props, { rpc: {
      journal_thread_brief: (input) => rpcContract.journal_thread_brief.input.parse(input).threadId === "thr_a" ? first.promise
        : saved({ threadId: "thr_b", rootThreadId: "thr_b", title: "Thread B", running: true, brief: { ...brief, goal: "Thread B goal" } }),
    } });
    await act(async () => { rendered.lifecycle.rerender(<ThreadBriefSection threadId="thr_b" />); });
    expect(await screen.findByTitle("Thread B goal")).toBeTruthy();
    await act(async () => { first.resolve(saved({ title: "Thread A" })); });
    expect(screen.getByTitle("Thread B goal")).toBeTruthy();
    // A turn signal re-reads stored rows only.
    const before = rendered.inspection.rpcCalls.length;
    await rendered.behavior.emitRealtime("journal-calendar", { at: Date.now() });
    expect(rendered.inspection.rpcCalls.slice(before).map((call) => call.method)).toEqual(["journal_thread_brief"]);
    rendered.lifecycle.unmount();
  });

  it("shows the missing-summary reason, blocks duplicate clicks, and surfaces generation failure", async () => {
    const pending = Promise.withResolvers<ThreadBrief>();
    const rendered = renderSlot(section, props, { rpc: {
      journal_thread_brief: () => saved({ brief: null, generatedAt: null, automaticNotice: "Automatic summaries paused: daily limit reached." }),
      journal_refresh_thread_brief: () => pending.promise,
    } });
    await screen.findByText("Generate a summary to catch up on this thread.");
    expect(screen.queryByText(/No summary yet/)).toBeNull();
    expect(screen.queryByText(/daily limit reached/)).toBeNull();
    expect(screen.getByTitle(/Generate summary.*daily limit reached/)).toBeTruthy();
    expect(screen.getByText("Generate a summary to catch up on this thread.").className).toContain("text-foreground");
    const button = screen.getByRole("button", { name: "Generate summary" });
    await act(async () => { fireEvent.click(button); fireEvent.click(button); });
    expect(screen.queryByText("Generating summary…")).toBeNull();
    expect(screen.getByText("Generate a summary to catch up on this thread.")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(rendered.inspection.rpcCalls.filter(call => call.method === "journal_refresh_thread_brief")).toHaveLength(1);
    await act(async () => { pending.reject(new Error("Model unavailable")); });
    expect((await screen.findByRole("alert")).textContent).toContain("Model unavailable");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    rendered.lifecycle.unmount();
  });

  it("re-reads stored rows after reconnecting", async () => {
    const rendered = renderSlot(section, props, { rpc: { journal_thread_brief: () => saved() }, realtimeConnectionState: "connected" });
    await screen.findByTitle("Ship subscription briefings");
    const before = rendered.inspection.rpcCalls.length;
    await rendered.behavior.setRealtimeConnectionState("reconnecting");
    await rendered.behavior.setRealtimeConnectionState("connected");
    expect(rendered.inspection.rpcCalls.length).toBe(before + 1);
    rendered.lifecycle.unmount();
  });
});


it("keeps the age inside the collapse button, including while collapsed", () => {
  function NativeHeading() {
    const [open, setOpen] = useState(true);
    return <SummaryFrame age="33m ago"><section><h3><button aria-expanded={open} onClick={() => setOpen(!open)}>Summary</button></h3>{open ? <p>Summary body</p> : null}</section></SummaryFrame>;
  }
  const mounted = render(<NativeHeading />);
  const pill = screen.getByText("33m ago");
  const toggle = screen.getByRole("button", { name: "Summary 33m ago" });
  expect(toggle.contains(pill)).toBe(true);
  expect(pill.className).toContain("pointer-events-none");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.contains(screen.getByText("33m ago"))).toBe(true);
  expect(screen.queryByText("Summary body")).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText("Summary body")).toBeTruthy();
  mounted.unmount();
});
