// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type ThreadBrief } from "./server";

const app = await loadPluginApp(() => import("./app.js"));
const overlay = app.appOverlays.find(({ id }) => id === "thread-brief")!;
const action = app.threadActions.find(({ id }) => id === "thread-brief")!;

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
const open = async (threadId = "thr_a", archivedAt: number | null = null) => {
  const item = action.item({ thread: { id: threadId, archivedAt } } as Parameters<typeof action.item>[0])!;
  await act(async () => {
    item.run({ requestRename: () => {} });
    const timer = Promise.withResolvers<void>();
    setTimeout(timer.resolve, 0);
    await timer.promise;
  });
};

describe("thread menu briefing", () => {
  it("keeps Catch up with secondary thread actions", () => {
    expect(action.group).toBe("machine");
  });

  it("reads only the saved briefing for this thread and renders six sections", async () => {
    const rendered = renderSlot(overlay, {},
      { rpc: { journal_thread_brief: (input) => saved(rpcContract.journal_thread_brief.input.parse(input)) } });
    // Mounting the overlay makes no request at all.
    expect(rendered.inspection.rpcCalls).toEqual([]);
    await open();
    expect(await screen.findByText("Ship subscription briefings")).toBeTruthy();
    for (const title of ["Original goal", "Done so far", "Remaining work", "Where it stopped", "Decisions made", "Open decisions"])
      expect(screen.getByRole("region", { name: title })).toBeTruthy();
    expect(screen.getByText("None open.")).toBeTruthy();
    expect(screen.getByText(/Covers the latest activity/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload saved briefing" })); });
    expect(rendered.inspection.rpcCalls.map((call) => call.method)).toEqual(["journal_thread_brief", "journal_thread_brief"]);
    expect(rendered.inspection.rpcCalls.every((call) => JSON.stringify(call.input) === JSON.stringify({ threadId: "thr_a" }))).toBe(true);
    rendered.lifecycle.unmount();
  });

  it("keeps pending reads visible and surfaces a failed read", async () => {
    const pending = Promise.withResolvers<ThreadBrief>();
    const rendered = renderSlot(overlay, {},
      { rpc: { journal_thread_brief: () => pending.promise } });
    await open();
    expect(screen.getByTestId("brief-loading")).toBeTruthy();
    await act(async () => { pending.resolve(saved({ brief: null, generatedAt: null, coverage: null, automatic: false })); });
    rendered.lifecycle.unmount();

    const failing = renderSlot(overlay, {},
      { rpc: { journal_thread_brief: () => { throw new Error("database busy"); } } });
    await open();
    expect((await screen.findByRole("alert")).textContent).toContain("database busy");
    failing.lifecycle.unmount();

  });

  it("drops a late answer for the previous thread and re-reads stored rows on turn signals", async () => {
    const first = Promise.withResolvers<ThreadBrief>();
    const rendered = renderSlot(overlay, {}, { rpc: {
      journal_thread_brief: (input) => rpcContract.journal_thread_brief.input.parse(input).threadId === "thr_a" ? first.promise
        : saved({ threadId: "thr_b", rootThreadId: "thr_b", title: "Thread B", running: true }),
    } });
    await open();
    await open("thr_b", Date.now());
    expect(await screen.findByText("Thread B")).toBeTruthy();
    await act(async () => { first.resolve(saved({ title: "Thread A" })); });
    expect(screen.queryByText("Thread A")).toBeNull();
    // A turn signal re-reads stored rows only.
    const before = rendered.inspection.rpcCalls.length;
    await rendered.behavior.emitRealtime("journal-calendar", { at: Date.now() });
    expect(rendered.inspection.rpcCalls.slice(before).map((call) => call.method)).toEqual(["journal_thread_brief"]);
    rendered.lifecycle.unmount();
  });

  it("restores the native menu trigger on dismiss", async () => {
    const trigger = document.createElement("button");
    trigger.id = "thread-actions-trigger";
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", trigger.id);
    const item = document.createElement("button");
    item.setAttribute("role", "menuitem");
    menu.append(item);
    document.body.append(trigger, menu);
    item.focus();
    const rendered = renderSlot(overlay, {}, {
      context: { threadId: "thr_a", projectId: "proj" },
      rpc: { journal_thread_brief: () => saved() },
    });
    await open();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close" })); });
    await act(async () => {
      const timer = Promise.withResolvers<void>();
      setTimeout(timer.resolve, 0);
      await timer.promise;
    });
    expect(document.activeElement).toBe(trigger);
    rendered.lifecycle.unmount();
    trigger.remove();
    menu.remove();
  });
});
