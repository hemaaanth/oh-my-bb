// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot, type TestThreadActionsResolver } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type {
  AgentSidebarSnapshot,
  ChannelSummary,
  SandboxThreadStatus,
  SidebarWorkspace,
} from "../shared";

const localStorageValues = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return localStorageValues.size;
    },
    clear: () => localStorageValues.clear(),
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    key: (index: number) => [...localStorageValues.keys()][index] ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) =>
      localStorageValues.set(key, String(value)),
  } satisfies Storage,
});
Object.defineProperty(document, "hasFocus", {
  configurable: true,
  value: () => true,
});

const app = await loadPluginApp(() => import("../app"));
const sidebar = app.threadLists[0]!;

const VIEW_KEY = "status-sidebar:view:v3";

function setView(view: { sort?: string; group?: string; subgroup?: string | null }) {
  window.localStorage.setItem(
    VIEW_KEY,
    JSON.stringify({ sort: "recent", group: "workspace", subgroup: "project", ...view }),
  );
}

function storedView() {
  return JSON.parse(window.localStorage.getItem(VIEW_KEY) ?? "null");
}

async function pickViewOption(header: HTMLElement, submenu: string, choice: string) {
  fireEvent.contextMenu(header);
  const trigger = await screen.findByRole("menuitem", {
    name: new RegExp(`^${submenu}`),
  });
  fireEvent.click(trigger);
  const content = await screen.findByRole("menu", { name: new RegExp(`^${submenu}`) });
  fireEvent.click(within(content).getByRole("menuitemradio", { name: choice }));
}

function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    displayTitle: "A thread",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: "/threads/thr_1",
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

const props = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
};

const workspaces: SidebarWorkspace[] = [
  {
    id: "ws_personal",
    name: "Personal",
    color: "amber",
    isDefault: true,
    projectIds: ["proj_1"],
    threadIds: [],
  },
  {
    id: "ws_work",
    name: "Work",
    color: "blue",
    isDefault: false,
    projectIds: ["proj_2"],
    threadIds: [],
  },
];

function renderSidebar({
  threads,
  snoozedRows = [],
  projects = [
    { id: "proj_1", name: "bb", isPersonal: false, href: "/projects/proj_1", settingsHref: "/projects/proj_1/settings" },
    { id: "proj_2", name: "sandbox", isPersonal: false, href: "/projects/proj_2", settingsHref: "/projects/proj_2/settings" },
  ],
  workspaceRows = workspaces,
  sandboxStatuses = [],
  channels = [],
  agents = null,
  openAgent,
  shortcutPublications,
  searchQuery = "",
  activeThreadId = null,
  draftThreadIds = [],
  threadActions,
  onNavigate = () => {},
  isCompactViewport = false,
  integrations = true,
}: {
  threads: PluginSidebarThread[];
  snoozedRows?: { threadId: string; untilAt: number }[];
  projects?: PluginSidebarProject[];
  workspaceRows?: SidebarWorkspace[];
  sandboxStatuses?: readonly SandboxThreadStatus[];
  shortcutPublications?: string[][];
  channels?: readonly ChannelSummary[] | null;
  agents?: AgentSidebarSnapshot | null;
  openAgent?: (profileId: string) => Promise<{ threadId: string }>;
  searchQuery?: string;
  activeThreadId?: string | null;
  draftThreadIds?: string[];
  threadActions?: TestThreadActionsResolver;
  onNavigate?: () => void;
  isCompactViewport?: boolean;
  integrations?: boolean;
}) {
  return renderSlot(sidebar, { ...props, activeThreadId, searchQuery, onNavigate, isCompactViewport }, {
    sidebarThreads: { status: "ready", threads, projects },
    sidebarDraftThreadIds: draftThreadIds,
    threadActions,
    rpc: {
      getIntegrations: () => ({ values: { agentsIntegration: integrations, projectsIntegration: integrations, tasksIntegration: integrations }, migrationPending: false }),
      listSnoozed: () => ({ rows: snoozedRows }),
      setSnoozed: () => ({ ok: true as const }),
      listThreadOrder: () => ({ threadIds: [] }),
      setThreadOrder: () => ({ ok: true as const }),
      setProjectOrder: () => ({ ok: true as const }),
      listWorkspaces: () => ({ workspaces: workspaceRows }),
      createWorkspace: () => ({ workspaceId: "ws_new" }),
      renameWorkspace: () => ({ ok: true as const }),
      deleteWorkspace: () => ({ ok: true as const }),
      setWorkspaceOrder: () => ({ ok: true as const }),
      setProjectWorkspace: () => ({ ok: true as const }),
      setThreadWorkspace: () => ({ ok: true as const }),
      clearThreadWorkspace: () => ({ ok: true as const }),
      listSandboxStatuses: () => ({ statuses: sandboxStatuses }),
      listChannels: () => channels,
      listAgents: () => agents,
      openAgent: (input) => {
        if (!input || typeof input !== "object" || !("profileId" in input) || typeof input.profileId !== "string")
          throw new Error("Expected profile ID");
        return openAgent?.(input.profileId) ?? Promise.resolve({ threadId: "dm" });
      },
      publishShortcutSlots: (input) => {
        const { slots } = input as { slots: Array<{ threadId: string }> };
        shortcutPublications?.push(slots.map((slot) => slot.threadId));
        return { ok: true as const };
      },
    },
  });
}

function createDataTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none",
    dropEffect: "none",
    get types() {
      return [...values.keys()];
    },
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? "",
    setDragImage: () => {},
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});


describe("Status Sidebar", () => {
  it("keeps every native thread visible when Agents is disabled and hides integration actions", async () => {
    const mounted = renderSidebar({
      integrations: false,
      threads: [thread({ id: "dm", title: "Existing conversation" })],
      agents: { agents: [], excludedThreadIds: ["dm"] },
    });
    const link = await screen.findByRole("link", { name: "Existing conversation" });
    expect(screen.queryByRole("tab", { name: "Bots" })).toBeNull();
    fireEvent.contextMenu(link.closest("li")!);
    expect(await screen.findByRole("menuitem", { name: "Snooze" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Snooze for 1 hour" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Attach to task" })).toBeNull();
    expect(mounted.inspection.sdkCalls).toEqual([]);
    expect(mounted.inspection.navigateCalls).toEqual([]);
  });
  it("starts with idle above collapsed Working and keeps archived at the bottom", async () => {
    renderSidebar({ threads: [
      thread({ id: "busy", title: "Working thread", indicator: "runtime" }),
      thread({ id: "quiet", title: "Idle thread" }),
      thread({ id: "recent", title: "Recent archive", isArchived: true, archivedAt: Date.now() - 86_400_000 }),
      thread({ id: "old", title: "Old archive", isArchived: true, archivedAt: Date.now() - 8 * 86_400_000 }),
    ] });
    const idle = await screen.findByRole("region", { name: "Idle" });
    const working = screen.getByRole("region", { name: "Working" });
    const archived = screen.getByRole("region", { name: "Archived" });
    expect(idle.compareDocumentPosition(working) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(working.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Working thread" })).toBeNull();
    fireEvent.click(within(working).getByRole("button"));
    expect(screen.getByRole("link", { name: "Working thread" })).toBeDefined();
    fireEvent.click(within(archived).getByRole("button"));
    expect(screen.getByRole("link", { name: "Recent archive" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Old archive" })).toBeNull();
    await pickViewOption(within(archived).getByRole("button"), "Group by", "Status");
    fireEvent.contextMenu(within(archived).getByRole("button"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archived: past 30 days" }));
    expect(screen.getByRole("link", { name: "Old archive" })).toBeDefined();
  });

  it("keeps snoozed threads out of active groups and lets them wake early", async () => {
    const untilAt = Date.now() + 60_000;
    renderSidebar({ threads: [thread({ id: "sleeping", title: "Sleeping thread" })],
      snoozedRows: [{ threadId: "sleeping", untilAt }] });
    const snoozed = await screen.findByRole("region", { name: "Snoozed" });
    const archived = screen.getByRole("region", { name: "Archived" });
    expect(snoozed.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Idle" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sleeping thread" })).toBeNull();
    fireEvent.click(within(snoozed).getByRole("button"));
    const link = within(snoozed).getByRole("link", { name: "Sleeping thread" });
    fireEvent.contextMenu(link.closest("li")!);
    expect(await screen.findByRole("menuitem", { name: "Wake now" })).toBeDefined();
  });

  it("keeps Code and Bots separate and opens canonical DMs without changing channel links", async () => {
    setView({ group: "status", subgroup: null });
    const agentId = "00000000-0000-4000-8000-000000000003";
    const channelId = "00000000-0000-4000-8000-000000000004";
    const calls: string[] = [];
    const slots: string[][] = [];
    let navigated = 0;
    const mounted = renderSidebar({
      agents: {
        agents: [{ id: agentId, name: "Fixture agent", avatar: "🤖", dmThreadId: "dm" }],
        excludedThreadIds: ["dm", "channel", "history"],
      },
      channels: [{ id: channelId, name: "shipping", pinned: false, unread: false,
        active: false, memberCount: 2, updatedAt: 1 }],
      threads: [
        thread({ id: "dm", title: "DM", projectId: "proj_1", isPinned: true }),
        thread({ id: "channel", title: "Channel work", projectId: "proj_1", isPinned: true }),
        thread({ id: "history", title: "Old DM", isArchived: true }),
        thread({ id: "parent", title: "Code parent" }),
        thread({ id: "child", title: "Delegated", parentThreadId: "parent", providerId: "agents" }),
      ],
      shortcutPublications: slots,
      openAgent: async (id) => { calls.push(id); return { threadId: "dm" }; },
      onNavigate: () => { navigated += 1; },
      isCompactViewport: true,
    });
    await waitFor(() => expect(slots.at(-1)).toEqual(["parent"]));
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    expect(screen.getByRole("region", { name: "Archived" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Delegated" })).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    const bots = screen.getByRole("tabpanel", { name: "Bots" });
    expect(within(bots).getByRole("region", { name: "Channels" })).toBeDefined();
    expect(within(bots).getByRole("link", { name: "Open #shipping" }).getAttribute("href"))
      .toBe(`/plugins/agent-profiles/channels/${channelId}`);
    fireEvent.click(within(bots).getByRole("button", { name: "Open Fixture agent" }));
    await waitFor(() => expect(calls).toEqual([agentId]));
    await waitFor(() => expect(mounted.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "dm", options: { split: false },
    }));
    expect(navigated).toBe(1);
    fireEvent.click(within(bots).getByRole("button", { name: /^Agents/ }));
    expect(within(bots).queryByRole("button", { name: "Open Fixture agent" })).toBeNull();
    fireEvent.click(within(bots).getByRole("button", { name: /^Agents/ }));
    expect(within(bots).getByRole("button", { name: "Open Fixture agent" })).toBeDefined();
  });

  it("reacts on the clicked agent only while its DM opens", async () => {
    let finish: (value: { threadId: string }) => void = () => {};
    renderSidebar({
      agents: { agents: [
        { id: "00000000-0000-4000-8000-000000000004", name: "First agent", avatar: "S", dmThreadId: null },
        { id: "00000000-0000-4000-8000-000000000005", name: "Second agent", avatar: "A", dmThreadId: null },
      ], excludedThreadIds: [] },
      threads: [],
      openAgent: () => new Promise((resolve) => { finish = resolve; }),
    });
    fireEvent.click(await screen.findByRole("tab", { name: "Bots" }));
    const sdr = await screen.findByRole("button", { name: "Open First agent" });
    const am = screen.getByRole("button", { name: "Open Second agent" });
    fireEvent.click(sdr);
    await waitFor(() => expect(sdr.classList.contains("bg-sidebar-accent")).toBe(true));
    expect(am.classList.contains("bg-sidebar-accent")).toBe(false);
    expect((sdr as HTMLButtonElement).disabled).toBe(false);
    expect((am as HTMLButtonElement).disabled).toBe(false);
    finish({ threadId: "dm" });
  });

  it("opens a known DM before the server answers", async () => {
    let finish: (value: { threadId: string }) => void = () => {};
    const mounted = renderSidebar({
      agents: { agents: [{ id: "00000000-0000-4000-8000-000000000006", name: "First agent", avatar: "S", dmThreadId: "dm" }],
        excludedThreadIds: ["dm"] },
      threads: [thread({ id: "dm", title: "DM" })],
      openAgent: () => new Promise((resolve) => { finish = resolve; }),
    });
    fireEvent.click(await screen.findByRole("tab", { name: "Bots" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open First agent" }));
    await waitFor(() => expect(mounted.inspection.navigateCalls).toContainEqual({
      method: "toThread", threadId: "dm", options: { split: false },
    }));
    finish({ threadId: "dm" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mounted.inspection.navigateCalls.filter((call) => call.method === "toThread")).toHaveLength(1);
  });

  it("selects Bots for an active DM and keeps manual tab changes", async () => {
    const agentId = "00000000-0000-4000-8000-000000000003";
    renderSidebar({
      agents: { agents: [{ id: agentId, name: "Fixture agent", avatar: "D", dmThreadId: "dm" }],
        excludedThreadIds: ["dm"] },
      activeThreadId: "dm",
      threads: [thread({ id: "dm", title: "DM" }), thread({ id: "code", title: "Code" })],
    });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Bots" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("button", { name: "Open Fixture agent" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("link", { name: "Code" })).toBeDefined();
  });

  it("leaves Code usable when Agents is unavailable", async () => {
    renderSidebar({ channels: null, agents: null, threads: [thread()] });
    expect(await screen.findByRole("link", { name: "A thread" })).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Bots are unavailable");
  });

  it.each(["draft", "other"])("groups an unsent draft while selected thread is %s, then returns to idle when cleared", async (activeThreadId) => {
    setView({ group: "status", subgroup: null });
    const draftedThread = thread({ id: "draft", title: "Unsent message" });
    renderSidebar({ threads: [draftedThread], activeThreadId, draftThreadIds: ["draft"] });
    expect(within(await screen.findByRole("region", { name: "Drafting" })).getByRole("link", { name: "Unsent message" })).toBeDefined();
    expect(document.querySelector("[data-fingerprint], .status-orb-shell")).toBeNull();
    cleanup();
    renderSidebar({ threads: [draftedThread], activeThreadId });
    expect(within(await screen.findByRole("region", { name: "Idle" })).getByRole("link", { name: "Unsent message" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Drafting" })).toBeNull();
  });

  it("changes group, subgroup and sort from a section header's right-click menu", async () => {
    setView({ group: "workspace", subgroup: "project" });
    const shortcutPublications: string[][] = [];
    renderSidebar({
      threads: [
        thread({ id: "personal", title: "Personal idle" }),
        thread({ id: "work", projectId: "proj_2", title: "Work active", indicator: "runtime" }),
      ],
      shortcutPublications,
    });
    const personal = await screen.findByRole("region", { name: "Personal section" });
    expect(within(personal).getByRole("region", { name: "bb" })).toBeDefined();
    await waitFor(() =>
      expect(shortcutPublications.at(-1)).toEqual(["personal", "work"]),
    );

    // Grouping by the current subgroup swaps the two levels.
    await pickViewOption(within(personal).getAllByRole("button")[0]!, "Group by", "Project");
    const bb = await screen.findByRole("region", { name: "bb" });
    expect(within(bb).getByRole("region", { name: "Personal section" })).toBeDefined();
    expect(storedView()).toEqual({ sort: "recent", group: "project", subgroup: "workspace", archivedDays: 7 });

    await pickViewOption(within(bb).getAllByRole("button")[0]!, "Subgroup by", "None");
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Personal section" })).toBeNull(),
    );
    expect(storedView()).toEqual({ sort: "recent", group: "project", subgroup: null, archivedDays: 7 });

    await pickViewOption(
      within(screen.getByRole("region", { name: "bb" })).getAllByRole("button")[0]!,
      "Group by",
      "Status",
    );
    const active = await screen.findByRole("region", { name: "Working" });
    expect(screen.getByRole("region", { name: "Idle" })).toBeDefined();
    await waitFor(() =>
      expect(shortcutPublications.at(-1)).toEqual(["personal"]),
    );

    // Status is never offered as a subgroup.
    fireEvent.contextMenu(within(active).getAllByRole("button")[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Subgroup by/ }));
    const subgroups = await screen.findByRole("menu", { name: /^Subgroup by/ });
    expect(
      within(subgroups).getAllByRole("menuitemradio").map((item) => item.textContent),
    ).toEqual(["None", "Workspace", "Project"]);
    fireEvent.keyDown(subgroups, { key: "Escape" });
    cleanup();

    renderSidebar({ threads: [thread()] });
    await pickViewOption(
      within(await screen.findByRole("region", { name: "Idle" })).getAllByRole("button")[0]!,
      "Sort by",
      "Manual",
    );
    expect(storedView()).toEqual({ sort: "manual", group: "status", subgroup: null, archivedDays: 7 });
  });

  it("reorders project groups without an inline section creator", async () => {
    setView({ group: "workspace", subgroup: "project" });
    const mounted = renderSidebar({ threads: [thread()] });
    const personal = await screen.findByRole("region", { name: "Personal section" });
    const work = screen.getByRole("region", { name: "Work section" });
    const personalHeader = within(personal).getAllByRole("button")[0]!;
    const workHeader = within(work).getAllByRole("button")[0]!;
    workHeader.getBoundingClientRect = () => ({ top: 0, height: 32 }) as DOMRect;
    const transfer = createDataTransfer();
    fireEvent.dragStart(personalHeader, { dataTransfer: transfer });
    fireEvent.dragOver(workHeader, { clientY: 31, dataTransfer: transfer });
    fireEvent.drop(workHeader, { clientY: 31, dataTransfer: transfer });
    await waitFor(() => expect(mounted.inspection.rpcCalls).toContainEqual({
      method: "setWorkspaceOrder",
      input: { workspaceIds: ["ws_work", "ws_personal"] },
    }));

    expect(screen.queryByRole("button", { name: "New section" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete section" })).toBeNull();
  });

  it("renders every workspace with its projects, and a General catch-all for loose threads", async () => {
    setView({ group: "workspace", subgroup: "project" });
    const shortcutPublications: string[][] = [];
    renderSidebar({
      threads: [
        thread({ id: "personal-thread", title: "Personal thread" }),
        thread({
          id: "work-thread",
          projectId: "proj_2",
          title: "Work thread",
        }),
        thread({
          id: "workspace-loose",
          projectId: "proj_personal",
          title: "Workspace loose",
        }),
        thread({
          id: "general-loose",
          projectId: "proj_personal",
          title: "General loose",
        }),
      ],
      projects: [
        { id: "proj_1", name: "bb", isPersonal: false, href: "/projects/proj_1", settingsHref: "/projects/proj_1/settings" },
        { id: "proj_2", name: "sandbox", isPersonal: false, href: "/projects/proj_2", settingsHref: "/projects/proj_2/settings" },
        { id: "proj_personal", name: "Personal", isPersonal: true, href: "/projects/proj_personal", settingsHref: "/projects/proj_personal/settings" },
      ],
      workspaceRows: [
        workspaces[0]!,
        { ...workspaces[1]!, threadIds: ["workspace-loose"] },
      ],
      shortcutPublications,
    });

    const personal = await screen.findByRole("region", {
      name: "Personal section",
    });
    const work = screen.getByRole("region", { name: "Work section" });
    const general = screen.getByRole("region", { name: "General" });
    expect(within(personal).getByRole("region", { name: "bb" })).toBeDefined();
    expect(within(work).getByRole("region", { name: "sandbox" })).toBeDefined();
    expect(
      within(work).getByRole("region", { name: "No project" }).textContent,
    ).toContain("Workspace loose");
    expect(
      within(general).getByRole("region", { name: "No project" }).textContent,
    ).toContain("General loose");
    expect(general.textContent).not.toContain("Workspace loose");
    await waitFor(() =>
      expect(shortcutPublications.at(-1)).toEqual([
        "personal-thread",
        "work-thread",
        "workspace-loose",
        "general-loose",
      ]),
    );

    fireEvent.click(within(general).getAllByRole("button")[0]!);
    await waitFor(() =>
      expect(shortcutPublications.at(-1)).toEqual([
        "personal-thread",
        "work-thread",
        "workspace-loose",
      ]),
    );
  });

  it("persists collapsed hierarchy nodes and removes hidden rows from keyboard slots", async () => {
    setView({ group: "workspace", subgroup: "project" });
    const shortcutPublications: string[][] = [];
    renderSidebar({
      threads: [
        thread({ id: "personal", title: "Personal" }),
        thread({ id: "work", projectId: "proj_2", title: "Work" }),
      ],
      shortcutPublications,
    });
    const personalWorkspace = await screen.findByRole("region", {
      name: "Personal section",
    });
    fireEvent.click(within(personalWorkspace).getAllByRole("button")[0]!);

    expect(screen.queryByText("Personal", { selector: "span[title]" })).toBeNull();
    expect(window.localStorage.getItem("status-sidebar:hierarchy-collapse:v1")).toContain(
      '"workspace:ws_personal":true',
    );
    await waitFor(() =>
      expect(shortcutPublications.at(-1)).toEqual(["work"]),
    );
  });

  it("republishes the visible keyboard slots when this window regains focus", async () => {
    const shortcutPublications: string[][] = [];
    renderSidebar({
      threads: [thread({ id: "visible", title: "Visible" })],
      shortcutPublications,
    });
    await waitFor(() =>
      expect(shortcutPublications.at(-1)).toEqual(["visible"]),
    );
    shortcutPublications.length = 0;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(shortcutPublications).toEqual([]);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });

    fireEvent.focus(window);

    await waitFor(() =>
      expect(shortcutPublications.at(-1)).toEqual(["visible"]),
    );
  });

  it("disables thread and project reordering while search hides siblings", async () => {
    setView({ group: "workspace", subgroup: "project" });
    renderSidebar({
      threads: [thread({ id: "visible", title: "Visible" })],
      searchQuery: "Visible",
    });
    const row = (await screen.findByText("Visible")).closest("li")!;
    expect(row.getAttribute("draggable")).toBe("false");
    const project = screen.getByRole("region", { name: "bb" });
    expect(within(project).getAllByRole("button")[0]?.getAttribute("draggable"))
      .toBe("false");
  });

  it("starts a new thread with a right-clicked project already selected", async () => {
    setView({ group: "workspace", subgroup: "project" });
    const mounted = renderSidebar({ threads: [thread()] });
    const project = await screen.findByRole("region", { name: "bb" });
    fireEvent.contextMenu(within(project).getAllByRole("button")[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "New thread" }));

    expect(mounted.inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: { projectId: "proj_1", focusPrompt: true },
    });
  });

  it("moves projects and projectless threads onto workspace headers", async () => {
    setView({ group: "workspace", subgroup: "project" });
    const mounted = renderSidebar({
      threads: [
        thread({ id: "project-thread" }),
        thread({
          id: "loose-thread",
          projectId: "proj_personal",
          title: "Loose",
        }),
      ],
      projects: [
        { id: "proj_1", name: "bb", isPersonal: false, href: "/projects/proj_1", settingsHref: "/projects/proj_1/settings" },
        { id: "proj_2", name: "sandbox", isPersonal: false, href: "/projects/proj_2", settingsHref: "/projects/proj_2/settings" },
        { id: "proj_personal", name: "Personal", isPersonal: true, href: "/projects/proj_personal", settingsHref: "/projects/proj_personal/settings" },
      ],
    });
    const work = await screen.findByRole("region", { name: "Work section" });
    const workHeader = within(work).getByRole("button");
    const projectHeader = within(
      screen.getByRole("region", { name: "bb" }),
    ).getAllByRole("button")[0]!;
    const projectTransfer = createDataTransfer();
    fireEvent.dragStart(projectHeader, { dataTransfer: projectTransfer });
    fireEvent.dragOver(workHeader, { dataTransfer: projectTransfer });
    fireEvent.drop(workHeader, { dataTransfer: projectTransfer });

    const looseRow = document.querySelector<HTMLElement>(
      '[data-reorder-thread-id="loose-thread"]',
    )!;
    const threadTransfer = createDataTransfer();
    fireEvent.dragStart(looseRow, { dataTransfer: threadTransfer });
    fireEvent.dragOver(workHeader, { dataTransfer: threadTransfer });
    fireEvent.drop(workHeader, { dataTransfer: threadTransfer });

    await waitFor(() => {
      expect(mounted.inspection.rpcCalls).toContainEqual({
        method: "setProjectWorkspace",
        input: { projectId: "proj_1", workspaceId: "ws_work" },
      });
      expect(mounted.inspection.rpcCalls).toContainEqual({
        method: "setThreadWorkspace",
        input: { threadId: "loose-thread", workspaceId: "ws_work" },
      });
    });
  });

  it("moves a workspace-specific projectless thread back to General", async () => {
    setView({ group: "workspace", subgroup: "project" });
    const mounted = renderSidebar({
      threads: [
        thread({
          id: "loose-thread",
          projectId: "proj_personal",
          title: "Loose",
        }),
        thread({
          id: "general-thread",
          projectId: "proj_personal",
          title: "General thread",
        }),
      ],
      projects: [
        { id: "proj_1", name: "bb", isPersonal: false, href: "/projects/proj_1", settingsHref: "/projects/proj_1/settings" },
        { id: "proj_personal", name: "Personal", isPersonal: true, href: "/projects/proj_personal", settingsHref: "/projects/proj_personal/settings" },
      ],
      workspaceRows: [
        { ...workspaces[0]!, threadIds: ["loose-thread"] },
        { ...workspaces[1]!, projectIds: [] },
      ],
    });
    const looseRow = (await screen.findByText("Loose")).closest("li");
    expect(looseRow).not.toBeNull();
    const general = screen.getByRole("region", { name: "General" });
    const generalHeader = within(general).getAllByRole("button")[0]!;
    const transfer = createDataTransfer();
    fireEvent.dragStart(looseRow!, { dataTransfer: transfer });
    fireEvent.dragOver(generalHeader, { dataTransfer: transfer });
    fireEvent.drop(generalHeader, { dataTransfer: transfer });

    await waitFor(() =>
      expect(mounted.inspection.rpcCalls).toContainEqual({
        method: "clearThreadWorkspace",
        input: { threadId: "loose-thread" },
      }),
    );
  });

  it("uses one-line top-level rows while preserving bb's keyboard and open contracts", async () => {
    let navigated = 0;
    const mounted = renderSlot(
      sidebar,
      { ...props, onNavigate: () => (navigated += 1) },
      {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "open-me", title: "Open me" })],
          projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "/projects/proj_1", settingsHref: "/projects/proj_1/settings" }],
        },
        rpc: {
          listSnoozed: () => ({ rows: [] }),
          listThreadOrder: () => ({ threadIds: [] }),
          listWorkspaces: () => ({ workspaces: [workspaces[0]!] }),
          listSandboxStatuses: () => ({ statuses: [] }),
        },
      },
    );
    const link = await screen.findByRole("link", { name: "Open me" });
    const row = link.parentElement!;
    expect(
      Array.from(row.querySelector("[data-execution-metadata]")!.children).map(
        (marker) => marker.getAttribute("aria-label"),
      ),
    ).toEqual(["Local machine"]);
    const local = within(row)
      .getByLabelText("Local machine")
      .querySelector("[data-machine-marker]")!;
    expect(local.getAttribute("data-machine-marker")).toBe("local");
    expect(local.getAttribute("class")).toContain("text-success");
    expect(link.getAttribute("data-sidebar-thread-id")).toBe("open-me");
    expect(link.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    fireEvent.click(link);
    // The row highlights before the host navigates, which waits for a paint.
    expect(link.getAttribute("aria-current")).toBe("page");
    await waitFor(() =>
      expect(mounted.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "open-me",
        options: { split: false },
      }),
    );
    expect(navigated).toBe(1);
  });

  it("collapses subthreads from the parent chevron without blocking drag", async () => {
    setView({ sort: "manual" });
    const shortcutPublications: string[][] = [];
    renderSidebar({
      threads: [
        thread({ id: "parent", title: "Parent" }),
        thread({
          id: "child",
          title: "Child",
          parentThreadId: "parent",
          projectId: "proj_2",
          host: { id: "host_daytona", name: "Daytona · bb" },
        }),
      ],
      sandboxStatuses: [
        {
          threadId: "child",
          sandboxId: "host_daytona",
          provider: "daytona",
          status: "live",
          label: "Daytona child machine live",
        },
      ],
      shortcutPublications,
    });
    const collapse = await screen.findByRole("button", {
      name: "Collapse sub-agents for Parent",
    });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    const transfer = createDataTransfer();
    fireEvent.dragStart(collapse, { dataTransfer: transfer });
    expect(transfer.getData("text/plain")).toBe("parent");
    fireEvent.dragEnd(collapse, { dataTransfer: transfer });

    fireEvent.click(collapse);
    expect(screen.queryByRole("group", { name: "Attached agents" })).toBeNull();
    const expand = screen.getByRole("button", {
      name: "Expand sub-agents for Parent",
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);

    const attached = await screen.findByRole("group", {
      name: "Attached agents",
    });
    const childLink = within(attached).getByRole("link", { name: "Child" });
    expect(childLink.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(
      false,
    );
    // The child left the parent's project, so its row names that project.
    expect(within(attached).getByText("sandbox")).toBeDefined();
    // A sub-agent marker keeps the machine shape but takes the working colour.
    const childMarker = within(attached)
      .getByLabelText("Daytona child machine live, idle")
      .querySelector("[data-machine-marker]")!;
    expect(childMarker.getAttribute("data-machine-marker")).toBe("sandbox");
    expect(childMarker.getAttribute("class")).toContain("text-muted-foreground");
    const pillDot = collapse.querySelector("[data-machine-marker]")!;
    expect(pillDot.getAttribute("data-machine-marker")).toBe("sandbox");
    expect(pillDot.getAttribute("class")).toContain("text-muted-foreground");
    await waitFor(() =>
      expect(shortcutPublications.at(-1)).toEqual(["parent"]),
    );
  });

  it("rolls a subthread's needier status into its project summary", async () => {
    setView({ group: "workspace", subgroup: "project" });
    renderSidebar({
      threads: [
        thread({ id: "parent", title: "Parent" }),
        thread({
          id: "child",
          title: "Child",
          parentThreadId: "parent",
          hasPendingInteraction: true,
        }),
      ],
    });
    const project = await screen.findByRole("region", { name: "bb" });
    expect(
      within(project).getByLabelText("1 waiting on you"),
    ).toBeDefined();
    expect(within(project).queryByRole("img", { name: "Needs input status" })).toBeNull();
  });

  it("colours a local sub-agent by its working status and hides its matching project", async () => {
    setView({ group: "project", subgroup: null });
    renderSidebar({
      threads: [
        thread({ id: "parent", title: "Parent" }),
        thread({
          id: "child",
          title: "Child",
          parentThreadId: "parent",
          indicator: "runtime",
        }),
      ],
    });
    const attached = await screen.findByRole("group", { name: "Attached agents" });
    const marker = within(attached)
      .getByLabelText("Local machine, working")
      .querySelector("[data-machine-marker]")!;
    expect(marker.getAttribute("data-machine-marker")).toBe("local");
    expect(marker.getAttribute("class")).toContain("text-timeline-accent");
    expect(attached.querySelector("[data-project-metadata]")).toBeNull();
    const pill = screen.getByRole("button", { name: "Collapse sub-agents for Parent" });
    expect(
      pill.querySelector("[data-machine-marker]")?.getAttribute("class"),
    ).toContain("text-timeline-accent");
  });

  it("shows at most three sub-agent markers, neediest first, then the overflow", async () => {
    setView({ group: "project", subgroup: null });
    renderSidebar({
      threads: [
        thread({ id: "parent", title: "Parent" }),
        ...["a", "b", "c", "d"].map((id) =>
          thread({ id, title: id, parentThreadId: "parent" }),
        ),
        thread({ id: "busy", title: "busy", parentThreadId: "parent", indicator: "runtime" }),
      ],
    });
    const pill = await screen.findByRole("button", {
      name: "Collapse sub-agents for Parent",
    });
    const markers = pill.querySelectorAll("[data-machine-marker]");
    expect(markers).toHaveLength(3);
    expect(markers[0]!.getAttribute("class")).toContain("text-timeline-accent");
    expect(pill.textContent).toContain("+2");
    expect(pill.getAttribute("title")).toBe("5 sub-agents, working");
  });

  it("groups sessions sharing one worktree with a quiet outline", async () => {
    const environment = {
      id: "env_shared",
      name: "feature-secret-name",
      branchName: "feature/secret-branch",
      providerId: null,
      path: null,
      isWorktree: true,
      workspaceDisplayKind: "managed-worktree" as const,
    };
    renderSidebar({
      threads: [
        thread({ id: "a", title: "First", environment }),
        thread({ id: "b", title: "Second", environment }),
      ],
    });
    const grouped = await screen.findByRole("group", {
      name: "2 threads in the same worktree",
    });
    expect(screen.queryByText("feature-secret-name")).toBeNull();
    expect(screen.queryByText("feature/secret-branch")).toBeNull();
  });

  it("persists manual thread ordering in one sidebar-wide order", async () => {
    setView({ sort: "manual" });
    const mounted = renderSidebar({
      threads: [
        thread({ id: "first", title: "First", updatedAt: 300 }),
        thread({ id: "second", title: "Second", updatedAt: 200 }),
      ],
    });
    await screen.findByText("First");
    const source = document.querySelector<HTMLElement>(
      '[data-reorder-thread-id="first"]',
    )!;
    const target = document.querySelector<HTMLElement>(
      '[data-reorder-thread-id="second"]',
    )!;
    target.getBoundingClientRect = () => ({ top: 0, height: 32 }) as DOMRect;
    const transfer = createDataTransfer();
    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(target, { clientY: 2, dataTransfer: transfer });
    fireEvent.drop(target, { clientY: 2, dataTransfer: transfer });

    await waitFor(() =>
      expect(mounted.inspection.rpcCalls).toContainEqual({
        method: "setThreadOrder",
        input: {
          threadIds: ["second", "first"],
          workspaceId: "__status_all__",
        },
      }),
    );
  });

  it("shows only the sandbox machine marker", async () => {
    renderSidebar({
      threads: [
        thread({
          id: "daytona",
          originPluginId: "sandboxes",
          host: { id: "host_daytona", name: "Daytona · bb" },
          environment: {
            id: "env_daytona",
            name: null,
            branchName: "main",
            providerId: null,
            path: null,
            isWorktree: true,
            workspaceDisplayKind: "unmanaged-worktree",
          },
        }),
      ],
      sandboxStatuses: [
        {
          threadId: "daytona",
          sandboxId: "sbx_daytona",
          provider: "daytona",
          status: "live",
          label: "Daytona sandbox live",
        },
      ],
    });
    const sandbox = await screen.findByLabelText("Daytona sandbox live");
    const marker = sandbox.querySelector("[data-machine-marker]")!;
    expect(marker.getAttribute("data-machine-marker")).toBe("sandbox");
    expect(marker.getAttribute("class")).toContain("text-success");
    const metadata = sandbox.closest("[data-execution-metadata]");
    expect(
      Array.from(metadata!.children).map((marker) =>
        marker.getAttribute("aria-label"),
      ),
    ).toEqual(["Daytona sandbox live"]);
  });

  it("filters across workspace, project, thread, and subthread content", async () => {
    renderSidebar({
      threads: [
        thread({ id: "alpha", title: "Alpha" }),
        thread({ id: "parent", title: "Parent" }),
        thread({
          id: "needle",
          title: "Nested needle",
          parentThreadId: "parent",
        }),
        thread({ id: "work", projectId: "proj_2", title: "Work" }),
      ],
      searchQuery: "needle",
    });
    expect(await screen.findByText("Parent")).toBeDefined();
    expect(screen.getByText("Nested needle")).toBeDefined();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.queryByText("Work", { selector: "span[title]" })).toBeNull();
  });

  it("has no per-row actions button; the context menu is the only entry", async () => {
    renderSidebar({ threads: [thread({ id: "no-menu-button" })] });
    await screen.findByText("A thread");
    expect(screen.queryByRole("button", { name: "Actions for A thread" })).toBeNull();
  });

});
