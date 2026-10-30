// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { type Task } from "./task-layout";

afterEach(() => vi.unstubAllGlobals());

it("marks task titles while keeping Now, Later, and task actions readable", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  const app = await loadPluginApp(() => import("./app"));
  const task: Task = { id: "private-task", identifier: "PRIVATE-1", title: "Private task title", status: "todo", projectId: "p1", threadIds: [], owner: { isMe: true }, refs: [{ priority: "urgent", url: null }] };
  const panel = app.navPanels.find(({ id }) => id === "tasks")!;
  const rendered = renderSlot(panel, { subPath: "" }, {
    rpc: { boardTasks: () => ({ tasks: [task], hiddenProjectIds: [], linkedThreadIds: [] }), providerHealth: () => [], taskChats: () => ({}) } as never,
    sidebarThreads: { status: "ready", projects: [], threads: [] },
  });
  try {
    const title = await rendered.findByText("Private task title");
    expect(title.closest("[data-bb-demo-sensitive]")).not.toBeNull();
    expect(title.closest("[data-bb-demo-ready]")).not.toBeNull();
    expect(rendered.getByText("Now").closest("[data-bb-demo-sensitive]")).toBeNull();
    expect(rendered.getByText("Later").closest("[data-bb-demo-sensitive]")).toBeNull();
    expect(rendered.getByRole("button", { name: "More actions: Private task title" }).hasAttribute("data-bb-demo-label")).toBe(true);
  } finally { rendered.unmount(); }
});
