// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { REALTIME_CHANNEL as CONTRACT_CHANNEL, directive } from "./contract.js";
import { parseDirective } from "./app/directives.js";

// The real Share popover belongs to T4. This stand-in exposes the props the card passes.
vi.mock("./app/share/SharePopover.js", () => ({
  ShareButton: ({ pageId, onNeedsPage, compact }: { pageId: string | null; onNeedsPage?: () => Promise<string>; compact?: boolean }) =>
    <button type="button" data-page-id={pageId ?? ""} onClick={() => void onNeedsPage?.()}>{compact ? "share-icon" : "Share"}</button>,
  SharePopover: () => null,
  registerShareSlots: () => undefined,
}));

// Node's experimental global localStorage shadows jsdom's and is unusable without a file.
const stored: Record<string, string> = {};
Object.defineProperty(window, "localStorage", { configurable: true, value: {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string, value: string) => { stored[key] = value; },
  clear: () => { for (const key of Object.keys(stored)) delete stored[key]; },
} });

const app = await loadPluginApp(() => import("./app.js"));
// These import the SDK app runtime, which loadPluginApp installs.
const { REALTIME_CHANNEL, pageDirective, resetPagesCache } = await import("./app/data.js");
const { directiveComponent } = await import("./app/PageCard.js");
const pageId = "123e4567-e89b-42d3-a456-426614174000";
const v1 = "123e4567-e89b-42d3-a456-426614174001";
const v2 = "123e4567-e89b-42d3-a456-426614174002";
const message = { id: "m1", threadId: "thread-a", turnId: "t1", projectId: "project-1" };
const summaries = [{ id: v1, n: 1, label: "draft", createdAt: "2026-09-20T00:00:00.000Z" }, { id: v2, n: 2, label: null, createdAt: "2026-09-24T00:00:00.000Z" }];
function detail(versionId = v2, overrides: Record<string, unknown> = {}) {
  const summary = summaries.find(({ id }) => id === versionId)!;
  return {
    page: { id: pageId, title: "Landing intent", kind: "file", projectId: "project-1", sourceKey: null, producer: null, producerKey: null, currentVersionId: v2, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" },
    version: { ...summary, pageId, sourcePath: null, sha256: "x", threadId: "thread-a", provenance: null, document: null, hasCharts: false },
    versions: summaries,
    share: null,
    previewUrl: `/api/v1/plugins/pages/http/v?id=${versionId}`,
    ...overrides,
  };
}
const getPage = ({ versionId }: { versionId?: string }) => detail(versionId ?? v2);
const pageSlot = app.messageDirectives.find(({ id }) => id === "page")!;
const panel = app.threadPanelActions.find(({ id }) => id === "page")!;

afterEach(() => { cleanup(); window.localStorage.clear(); resetPagesCache(); });

describe("directive parsing", () => {
  it("reads each alias into one card reference", () => {
    expect(parseDirective("page", { id: pageId, version: v1, height: "600" })).toEqual({ ok: true, ref: { kind: "page", pageId, versionId: v1, height: 600 } });
    expect(parseDirective("artifact", { id: pageId, revision: v1 })).toEqual({ ok: true, ref: { kind: "page", pageId, versionId: v1, height: 240 } });
    expect(parseDirective("inline-vis", { file: "reports/a.html", source: "thread-storage" })).toEqual({ ok: true, ref: { kind: "file", file: "reports/a.html", source: "thread-storage", height: 240 } });
    expect(parseDirective("inline-vis", { file: "a.md" })).toMatchObject({ ok: true, ref: { source: "workspace" } });
  });

  it("rejects bad ids, heights, paths, and sources", () => {
    expect(parseDirective("page", { id: "not-a-uuid", version: v1 }).ok).toBe(false);
    expect(parseDirective("page", { id: pageId, version: "v1" }).ok).toBe(false);
    expect(parseDirective("artifact", { id: pageId, revision: "123" }).ok).toBe(false);
    for (const height of ["119", "1201", "2.5", "-200", "tall"]) expect(parseDirective("page", { id: pageId, height }).ok).toBe(false);
    expect(parseDirective("page", { id: pageId, height: "120" }).ok).toBe(true);
    expect(parseDirective("page", { id: pageId, height: "1200" }).ok).toBe(true);
    for (const file of ["/etc/passwd", "../secret.html", "a/../../b.html", "a\\..\\b.html", "~/x.html", "C:/x.html", ""]) expect(parseDirective("inline-vis", { file }).ok).toBe(false);
    expect(parseDirective("inline-vis", { file: "a.html", source: "host" }).ok).toBe(false);
  });

  it("keeps the app's copies of contract values in step", () => {
    expect(REALTIME_CHANNEL).toBe(CONTRACT_CHANNEL);
    expect(pageDirective(pageId, v1)).toBe(directive(pageId, v1));
  });

  it("owns ::page and the legacy ::artifact and ::inline-vis ids after the switch-over", () => {
    expect(app.messageDirectives.map(({ id }) => id)).toEqual(["page", "artifact", "inline-vis"]);
  });
});

describe("inline card", () => {
  it("shows the pinned version, how many exist, and the preview in the app theme", async () => {
    const slot = renderSlot(pageSlot, { attributes: { id: pageId, version: v1, height: "300" }, message, source: "::page{}", openWorkspaceFile: null }, { rpc: { getPage } as never, codeTheme: { mode: "dark" } });
    const frame = await slot.findByTitle("Preview: Landing intent");
    expect(slot.getByText("v1 of 2")).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(`/api/v1/plugins/pages/http/v?id=${v1}&theme=dark&frame=card`);
    expect((frame.parentElement as HTMLElement).style.height).toBe("300px");
    expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "getPage", input: { pageId, versionId: v1 } });
    fireEvent.click(slot.getByRole("button", { name: "Open Landing intent in panel" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "openThreadPanel", options: { actionId: "page", params: { pageId, versionId: v1 } } });
    slot.lifecycle.unmount();
  });

  it("remembers the collapsed state", async () => {
    const slot = renderSlot(pageSlot, { attributes: { id: pageId, version: v2 }, message, source: "::page{}", openWorkspaceFile: null }, { rpc: { getPage } as never });
    await slot.findByText("v2");
    fireEvent.click(slot.getByRole("button", { name: "Collapse Landing intent" }));
    expect(slot.queryByTitle("Preview: Landing intent")).toBeNull();
    expect(window.localStorage.getItem("bb.pages.collapsed")).toBe("true");
    slot.lifecycle.unmount();
  });

  it("shows loading, missing, and error as one quiet line", async () => {
    // tsconfig targets ES2022, so Promise.withResolvers is not typed here.
    let resolve: (value: null) => void = () => undefined;
    const promise = new Promise<null>((done) => { resolve = done; });
    const pending = renderSlot(pageSlot, { attributes: { id: pageId, version: v1 }, message, source: "::page{a}", openWorkspaceFile: null }, { rpc: { getPage: () => promise } as never });
    expect(pending.getByRole("status").textContent).toContain("Loading page");
    await act(async () => resolve(null));
    await pending.findByText("This page version no longer exists.");
    pending.lifecycle.unmount();

    const failed = renderSlot(pageSlot, { attributes: { id: pageId }, message, source: "::page{b}", openWorkspaceFile: null }, { rpc: { getPage: () => { throw new Error("database locked"); } } as never });
    const alert = await failed.findByRole("alert");
    expect(alert.textContent).toContain("database locked");
    expect(alert.textContent).toContain("::page{b}");
    failed.lifecycle.unmount();

    const invalid = renderSlot(pageSlot, { attributes: { id: pageId, height: "5000" }, message, source: "::page{c}", openWorkspaceFile: null }, { rpc: {} as never });
    expect(invalid.getByRole("alert").textContent).toContain("::page{c}");
    expect(invalid.inspection.rpcCalls).toHaveLength(0);
    invalid.lifecycle.unmount();
  });

  it("refreshes only when its own page changes", async () => {
    const calls = vi.fn(getPage);
    const slot = renderSlot(pageSlot, { attributes: { id: pageId, version: v2 }, message, source: "::page{}", openWorkspaceFile: null }, { rpc: { getPage: calls } as never });
    await slot.findByText("v2");
    await slot.behavior.emitRealtime(REALTIME_CHANNEL, { pageId: "123e4567-e89b-42d3-a456-426614174999" });
    expect(calls).toHaveBeenCalledTimes(1);
    await slot.behavior.emitRealtime(REALTIME_CHANNEL, { pageId, versionId: v2 });
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
    slot.lifecycle.unmount();
  });

  it("renders the ::artifact alias as the same card", async () => {
    const slot = renderSlot({ component: directiveComponent("artifact") }, { attributes: { id: pageId, revision: v2 }, message, source: "::artifact{}", openWorkspaceFile: null }, { rpc: { getPage } as never });
    await slot.findByTitle("Preview: Landing intent");
    expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "getPage", input: { pageId, versionId: v2 } });
    slot.lifecycle.unmount();
  });

  it("previews a live ::inline-vis file and snapshots it when Share needs a page", async () => {
    const liveUrl = "/api/v1/plugins/pages/http/file?threadId=thread-a&source=thread-storage&file=t3%2Fdemo.md";
    const publishFile = vi.fn(() => ({ ...detail(v1), directive: "", created: true }));
    const slot = renderSlot({ component: directiveComponent("inline-vis") }, { attributes: { file: "t3/demo.md", source: "thread-storage" }, message, source: "::inline-vis{}", openWorkspaceFile: null }, {
      rpc: { resolveFile: () => ({ sourceKey: "storage:thread-a:t3/demo.md", previewUrl: liveUrl, page: null }), publishFile } as never,
      codeTheme: { mode: "light" },
    });
    const frame = await slot.findByTitle("Preview: t3/demo.md");
    expect(frame.getAttribute("src")).toBe(`${liveUrl}&theme=light&frame=card`);
    expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "resolveFile", input: { threadId: "thread-a", file: "t3/demo.md", source: "thread-storage" } });
    fireEvent.click(slot.getByRole("button", { name: "share-icon" }));
    await waitFor(() => expect(publishFile).toHaveBeenCalledWith({ threadId: "thread-a", file: "t3/demo.md", source: "thread-storage" }));
    await slot.findByText("v1");
    expect(slot.getByRole("button", { name: "share-icon" }).getAttribute("data-page-id")).toBe(pageId);
    slot.lifecycle.unmount();
  });
});

describe("window cache", () => {
  const Page = directiveComponent("page");
  const cardProps = { attributes: { id: pageId, version: v2 }, message, source: "::page{}", openWorkspaceFile: null };
  const Cards = ({ count }: { count: number }) => <>{Array.from({ length: count }, (_, index) => <Page key={index} {...cardProps} />)}</>;
  const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 20)); });

  it("fetches a page once for all its cards, not again on remount, and once per change", async () => {
    const calls = vi.fn(getPage);
    const slot = renderSlot({ component: Cards }, { count: 3 } as never, { rpc: { getPage: calls } as never });
    await waitFor(() => expect(slot.getAllByTitle("Preview: Landing intent")).toHaveLength(3));
    expect(calls).toHaveBeenCalledTimes(1);
    // A card scrolled out and back in while another stays mounted reads the cache.
    slot.rerender(<Cards count={1} />);
    slot.rerender(<Cards count={3} />);
    expect(slot.getAllByTitle("Preview: Landing intent")).toHaveLength(3);
    await settle();
    expect(calls).toHaveBeenCalledTimes(1);
    await slot.behavior.emitRealtime(REALTIME_CHANNEL, { pageId, versionId: v2 });
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
    await settle();
    expect(calls).toHaveBeenCalledTimes(2);
    slot.lifecycle.unmount();
  });

  it("refetches after a realtime reconnect, when signals may have been missed", async () => {
    const calls = vi.fn(getPage);
    const slot = renderSlot(pageSlot, cardProps, { rpc: { getPage: calls } as never });
    await slot.findByText("v2");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
    slot.lifecycle.unmount();
  });

  it("refreshes a live file card only for its own file or page", async () => {
    const resolveFile = vi.fn(() => ({ sourceKey: "storage:thread-a:t3/demo.md", previewUrl: "/api/v1/plugins/pages/http/file?x", page: null }));
    const slot = renderSlot({ component: directiveComponent("inline-vis") }, { attributes: { file: "t3/demo.md", source: "thread-storage" }, message, source: "::inline-vis{}", openWorkspaceFile: null }, { rpc: { resolveFile } as never });
    await slot.findByTitle("Preview: t3/demo.md");
    await slot.behavior.emitRealtime(REALTIME_CHANNEL, { pageId: "123e4567-e89b-42d3-a456-426614174999", sourceKey: "storage:thread-a:other.md" });
    await settle();
    expect(resolveFile).toHaveBeenCalledTimes(1);
    await slot.behavior.emitRealtime(REALTIME_CHANNEL, { pageId: "123e4567-e89b-42d3-a456-426614174999", sourceKey: "storage:thread-a:t3/demo.md" });
    await waitFor(() => expect(resolveFile).toHaveBeenCalledTimes(2));
    slot.lifecycle.unmount();
  });
});

describe("side panel", () => {
  async function openMenu(slot: RenderedSlot) {
    const trigger = await slot.findByRole("button", { name: "Version 2. Page menu" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    return slot.findByRole("menu");
  }

  it("previews an older version from the version menu and returns to latest", async () => {
    const slot = renderSlot(panel, { threadId: "thread-a", params: { pageId } }, { rpc: { getPage } as never, codeTheme: { mode: "dark" } });
    expect((await slot.findByTitle("Landing intent, version 2")).getAttribute("src")).toContain(`id=${v2}&theme=dark`);
    await openMenu(slot);
    fireEvent.click(slot.getByRole("menuitemradio", { name: /v1.*draft/u }));
    const older = await slot.findByTitle("Landing intent, version 1");
    expect(older.getAttribute("src")).toContain(`id=${v1}`);
    expect(slot.getByText("Viewing v1")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Back to latest" }));
    await slot.findByTitle("Landing intent, version 2");
    slot.lifecycle.unmount();
  });

  it("renames the page inline", async () => {
    const renamePage = vi.fn(({ title }: { title: string }) => detail(v2, { page: { ...detail().page, title } }));
    const slot = renderSlot(panel, { threadId: "thread-a", params: { pageId } }, { rpc: { getPage, renamePage } as never });
    await openMenu(slot);
    fireEvent.click(slot.getByRole("menuitem", { name: "Rename" }));
    const input = await slot.findByRole("textbox", { name: "Page title" });
    fireEvent.change(input, { target: { value: "  Visitor intent  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(renamePage).toHaveBeenCalledTimes(1));
    expect(renamePage).toHaveBeenCalledWith({ pageId, title: "Visitor intent" });
    slot.lifecycle.unmount();
  });

  it("deletes only after confirmation", async () => {
    const deletePage = vi.fn(() => ({ ok: true }));
    const slot = renderSlot(panel, { threadId: "thread-a", params: { pageId } }, { rpc: { getPage, deletePage } as never });
    await openMenu(slot);
    fireEvent.click(slot.getByRole("menuitem", { name: "Delete…" }));
    const dialog = await slot.findByRole("alertdialog");
    expect(dialog.textContent).toContain("2 versions");
    expect(deletePage).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    await slot.findByText("Page deleted.");
    expect(deletePage).toHaveBeenCalledWith({ pageId });
    slot.lifecycle.unmount();
  });
});

describe("library", () => {
  const library = app.navPanels.find(({ id }) => id === "pages")!;
  const item = { page: detail().page, version: summaries[1], share: null, previewUrl: `/api/v1/plugins/pages/http/v?id=${v2}` };

  it("filters by project and pages through results", async () => {
    const listPages = vi.fn(({ offset }: { offset: number }) => ({ pages: [{ ...item, page: { ...item.page, id: offset ? v1 : pageId, title: offset ? "Second" : "First" } }], nextOffset: offset ? null : 1 }));
    const slot = renderSlot(library, { subPath: "" }, { rpc: { listPages } as never, sidebarThreads: { projects: [{ id: "project-1", name: "Growth", isPersonal: false, href: "", settingsHref: "" }] } });
    await slot.findByText("First");
    expect(slot.getByText("Growth", { selector: "h2" })).toBeTruthy();
    const preview = await slot.findByTitle("Preview of First");
    expect(preview.getAttribute("src")).toContain("frame=card");
    expect(preview.getAttribute("scrolling")).toBe("no");
    fireEvent.click(slot.getByRole("button", { name: "Load more" }));
    await slot.findByText("Second");
    fireEvent.change(slot.getByLabelText("Project"), { target: { value: "project-1" } });
    await waitFor(() => expect(listPages).toHaveBeenLastCalledWith({ offset: 0, projectId: "project-1" }));
    fireEvent.click(await slot.findByRole("button", { name: "Open First" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "pages", options: { subPath: pageId } });
    slot.lifecycle.unmount();
  });

  it("shows logical folders and filters within a project", async () => {
    const listPages = vi.fn(() => ({ pages: [{ ...item, page: { ...item.page, folderPath: "Reports/Weekly" } }], nextOffset: null }));
    const listFolders = vi.fn(() => ({ folders: [{ projectId: "project-1", path: "Reports/Weekly", count: 1 }] }));
    const slot = renderSlot(library, { subPath: "" }, { rpc: { listPages, listFolders } as never, sidebarThreads: { projects: [{ id: "project-1", name: "Growth", isPersonal: false, href: "", settingsHref: "" }] } });
    await slot.findByText("Growth / Reports/Weekly");
    fireEvent.change(slot.getByLabelText("Project"), { target: { value: "project-1" } });
    const folder = await slot.findByLabelText("Folder");
    expect(folder.textContent).toContain("Reports/Weekly (1)");
    fireEvent.change(folder, { target: { value: "Reports/Weekly" } });
    await waitFor(() => expect(listPages).toHaveBeenLastCalledWith({ offset: 0, projectId: "project-1", folder: "Reports/Weekly" }));
    slot.lifecycle.unmount();
  });

  it("opens the ?page= deep link in the panel view and shows an empty state", async () => {
    window.history.replaceState({}, "", `/plugins/pages/pages?page=${pageId}`);
    try {
      const linked = renderSlot(library, { subPath: "" }, { rpc: { getPage, listPages: () => ({ pages: [], nextOffset: null }) } as never });
      await linked.findByTitle("Landing intent, version 2");
      linked.lifecycle.unmount();
    } finally {
      window.history.replaceState({}, "", "/");
    }
    const empty = renderSlot(library, { subPath: "" }, { rpc: { listPages: () => ({ pages: [], nextOffset: null }) } as never });
    await empty.findByText(/No pages yet/u);
    empty.lifecycle.unmount();
  });
});
