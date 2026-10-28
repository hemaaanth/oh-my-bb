// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const app = await loadPluginApp(() => import("./app"));
const sidebar = { component: app.navPanels.find(({ id }) => id === "waterfall")!.experimental_sidebar! };

const base: PluginSidebarThread = {
  id: "thr_one", projectId: "proj_alpha", title: "First run", titleFallback: null, displayTitle: "First run",
  parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null, sectionId: null,
  originKind: null, originPluginId: null, providerId: "codex", status: "idle", runtimeStatus: "idle",
  queuedWork: "none", hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
  indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null,
  isArchived: false, archivedAt: null, href: "/projects/proj_alpha/threads/thr_one", isHidden: false,
  environment: null, host: null, createdAt: 100, updatedAt: 200, lastReadAt: null, latestAttentionAt: 200,
};
const rows: PluginSidebarThread[] = [
  base,
  { ...base, id: "thr_two", projectId: "proj_beta", title: "Second run", displayTitle: "Second run", parentThreadId: "thr_missing", updatedAt: 300 },
  { ...base, id: "thr_hidden", title: "Hidden worker", displayTitle: "Hidden worker", isHidden: true },
  { ...base, id: "thr_archived", title: "Older work", displayTitle: "Older work", isArchived: true, archivedAt: 400 },
];
const projects = [
  { id: "proj_alpha", name: "Alpha", isPersonal: false, href: "/projects/proj_alpha", settingsHref: "/projects/proj_alpha/settings" },
  { id: "proj_beta", name: "Beta", isPersonal: false, href: "/projects/proj_beta", settingsHref: "/projects/proj_beta/settings" },
];

describe("Traces native sidebar", () => {
  it("groups live BB identities by project and opens the same thread ID in Waterfall", async () => {
    const rendered = renderSlot(sidebar, { subPath: "thr_one" }, { sidebarThreads: { threads: rows, projects } });
    expect(screen.getByRole("complementary", { name: "Traces threads" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Beta" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /First run, thr_one/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /Second run, thr_two/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Hidden worker/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Older work/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Second run, thr_two/ })); });
    expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "waterfall", options: { subPath: "thr_two" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Log Explorer" })); });
    expect(rendered.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "" } });
    rendered.lifecycle.unmount();
  });

  it("searches BB titles and IDs, and reveals hidden and archived threads only on request", async () => {
    const rendered = renderSlot(sidebar, { subPath: "context/thr_archived" }, { sidebarThreads: { threads: rows, projects } });
    expect(screen.getByText(/Selected thread is hidden, archived, or unavailable/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Hidden" })); });
    expect(screen.getByRole("button", { name: /Hidden worker, thr_hidden, hidden/ })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Archived" })); });
    expect(screen.getByRole("button", { name: /Older work, thr_archived, archived/ }).getAttribute("aria-current")).toBe("page");
    const search = screen.getByRole("searchbox", { name: "Search Traces threads" });
    await act(async () => { fireEvent.change(search, { target: { value: "thr_two" } }); });
    expect(screen.getByRole("button", { name: /Second run, thr_two/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /First run, thr_one/ })).toBeNull();
    await act(async () => { fireEvent.keyDown(search, { key: "Escape" }); });
    expect(screen.getByRole("button", { name: /First run, thr_one/ })).toBeTruthy();
    rendered.lifecycle.unmount();
  });

  it("keeps unavailable and loading list states explicit", () => {
    const loading = renderSlot(sidebar, { subPath: "thr_unknown" }, { sidebarThreads: { status: "loading" } });
    expect(screen.getByRole("status").textContent).toContain("Loading BB threads");
    loading.lifecycle.unmount();
    const failing = renderSlot(sidebar, { subPath: "thr_unknown" }, { sidebarThreads: { status: "error" } });
    expect(screen.getByRole("alert").textContent).toContain("BB thread list unavailable");
    failing.lifecycle.unmount();
  });
});
