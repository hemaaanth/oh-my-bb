import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  useBbNavigate,
  useSdk,
  useRpc,
  useSidebarThreadDraftIds,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "./ui/icon";
import { Input } from "./ui/input";
import { ThreadRow } from "./ThreadRow";
import { SidebarRow } from "./SidebarRow";
import { DeleteSectionDialog } from "./DeleteSectionDialog";
import { SectionContextMenu, type SectionMenuAction } from "./SectionMenu";
import { useLaterThreads } from "../hooks/useLaterThreads";
import { useSandboxStatuses } from "../hooks/useSandboxStatuses";
import { useChannels } from "../hooks/useChannels";
import { useAgents } from "../hooks/useAgents";
import { useShortcutSlots } from "../hooks/useShortcutSlots";
import { useIntegrations } from "../hooks/useIntegrations";
import type { rpcContract } from "../server";
import {
  GENERAL_THREAD_ORDER_SCOPE,
  STATUS_ALL_THREAD_ORDER_SCOPE,
  useWorkspaceThreadOrders,
} from "../hooks/useWorkspaceThreadOrders";
import { useWorkspaces } from "../hooks/useWorkspaces";
import {
  PROJECT_WORKSPACE_DRAG_TYPE,
  THREAD_WORKSPACE_DRAG_TYPE,
  WORKSPACE_REORDER_DRAG_TYPE,
  type AgentSidebarSnapshot,
  type ChannelSummary,
  type SandboxThreadStatus,
  type SidebarWorkspace,
} from "../shared";
import {
  followSelectedBucket,
  bucketForThread,
  dropPlacementForEvent,
  matchesSearch,
  mostNeedyStatus,
  moveThreadGroup,
  moveThreadIds,
  statusForThread,
  threadTitle,
  type DropPlacement,
  type SidebarBucket,
  type SidebarGroup,
  type ThreadStatusBucket,
} from "../lib/sidebar-model";
import { cn } from "../lib/utils";
import {
  persistViewOptions,
  readViewOptions,
  type GroupDimension,
  type SidebarViewOptions,
} from "../lib/sidebar-view";
import {
  buildSidebarTree,
  countTreeThreads,
  mergeManualOrder,
  sortThreadsBy,
  type SidebarGroupKey,
  type SidebarTreeNode,
} from "../lib/sidebar-tree";
import { STATUS_DESIGN } from "../lib/status-colors";
import {
  ThreadRowActionsContext,
  useStableCallback,
  type ThreadRowActions,
} from "../lib/thread-row-actions";

const COLLAPSE_STORAGE_KEY = "status-sidebar:hierarchy-collapse:v1";
const AGENT_PROFILES_CHANNELS_ROUTE = "/plugins/agent-profiles/channels";

function channelPanelHref(subPath: string) {
  return `${AGENT_PROFILES_CHANNELS_ROUTE}/${encodeURIComponent(subPath)}`;
}

function channelIdForPathname(pathname: string): string | null {
  const prefix = `${AGENT_PROFILES_CHANNELS_ROUTE}/`;
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length).split("/")[0];
  if (!segment || segment === "new") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function useActiveChannelId() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const syncPathname = () => setPathname(window.location.pathname);
    const navigation = (
      window as Window & { navigation?: EventTarget }
    ).navigation;
    window.addEventListener("popstate", syncPathname);
    navigation?.addEventListener("navigatesuccess", syncPathname);
    return () => {
      window.removeEventListener("popstate", syncPathname);
      navigation?.removeEventListener("navigatesuccess", syncPathname);
    };
  }, []);
  return channelIdForPathname(pathname);
}

const statusSections: readonly { bucket: SidebarBucket; label: string }[] = [
  { bucket: "pinned", label: "Pinned" },
  { bucket: "unread", label: "Unread" },
  { bucket: "drafting", label: "Drafting" },
  { bucket: "active", label: "Active" },
  { bucket: "needs-input", label: "Needs input" },
  { bucket: "idle", label: "Idle" },
  { bucket: "later", label: "Later" },
  { bucket: "archived", label: "Archived" },
];

const statusSectionIcon: Record<SidebarBucket, IconName> = {
  pinned: "Pin",
  unread: "CircleCheck",
  active: "CircleDashed",
  "needs-input": "CircleQuestion",
  drafting: "Edit",
  idle: "Circle",
  later: "Clock",
  archived: "Archive",
};

function readCollapsed(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(COLLAPSE_STORAGE_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function useCollapsedHierarchy() {
  const [collapsed, setCollapsed] =
    useState<Record<string, boolean>>(readCollapsed);
  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = { ...current };
      if (current[key]) delete next[key];
      else next[key] = true;
      try {
        window.localStorage.setItem(
          COLLAPSE_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // Keep the in-memory interaction working when browser storage is full
        // or unavailable; persistence is a convenience, not a prerequisite.
      }
      return next;
    });
  };
  return { collapsed, toggle };
}

function threadChildrenCollapseKey(threadId: string) {
  return `thread-children:${threadId}`;
}


function ThreadStatusSummary({
  threads,
  statusByThreadId,
}: {
  threads: readonly PluginSidebarThread[];
  statusByThreadId: ReadonlyMap<string, ThreadStatusBucket>;
}) {
  const segments = STATUS_DESIGN.flatMap((design) => {
    const count = threads.filter(
      (thread) => statusByThreadId.get(thread.id) === design.status,
    ).length;
    return count > 0 ? [{ ...design, count }] : [];
  });
  if (segments.length === 0) return null;
  return (
    <span
      aria-label={segments
        .map((segment) => `${segment.count} ${segment.label}`)
        .join(", ")}
      className="inline-flex h-4 overflow-hidden rounded-full"
    >
      {segments.map((segment) => (
        <span
          key={segment.status}
          data-status-count={segment.status}
          className={cn(
            "inline-flex min-w-4 items-center justify-center border-e border-sidebar-border/50 px-1 text-[9px] font-medium tabular-nums last:border-e-0",
            segment.className,
          )}
          style={segment.style}
        >
          {segment.count}
        </span>
      ))}
    </span>
  );
}

export function StatusSidebar({
  activeThreadId,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const { status, threads: sidebarThreads, projects } = useSidebarThreads();
  const { data: integrationPreferences } = useIntegrations();
  const botsEnabled = integrationPreferences?.values.agentsIntegration === true;
  const tasksEnabled = integrationPreferences?.values.tasksIntegration === true;
  const channelSnapshot = useChannels();
  const agentSnapshot = useAgents();
  const channels = botsEnabled ? channelSnapshot : null;
  const agents = botsEnabled ? agentSnapshot : null;
  const threads = useMemo(
    () => sidebarThreads.filter((thread) => !agents?.excludedThreadIds.includes(thread.id)),
    [sidebarThreads, agents],
  );
  const rpc = useRpc<typeof rpcContract>();
  const [activeTab, setActiveTab] = useState<"code" | "bots">("code");
  const [agentError, setAgentError] = useState<string | null>(null);
  const [openingAgentId, setOpeningAgentId] = useState<string | null>(null);
  const visibleTab = botsEnabled ? activeTab : "code";
  const activeChannelId = useActiveChannelId();
  const navigate = useBbNavigate();
  useEffect(() => {
    if (activeChannelId || (activeThreadId && agents?.agents.some((agent) => agent.dmThreadId === activeThreadId))) {
      setActiveTab("bots");
    } else if (activeThreadId && !agents?.excludedThreadIds.includes(activeThreadId)) {
      setActiveTab("code");
    }
  }, [activeChannelId, activeThreadId, agents]);
  const openAgent = useStableCallback(async (profileId: string) => {
    if (openingAgentId) return;
    setAgentError(null);
    // A known DM opens at once, like a thread row. The server round trip still runs behind it to
    // unarchive or repair the DM, and moves there only if it answers with a different thread.
    const knownThreadId = agents?.agents.find((agent) => agent.id === profileId)?.dmThreadId ?? null;
    if (knownThreadId) {
      setActiveTab("bots");
      openThread(knownThreadId, false);
    } else {
      setOpeningAgentId(profileId);
    }
    try {
      const { threadId } = await rpc.call("openAgent", { profileId });
      if (threadId === knownThreadId) return;
      setActiveTab("bots");
      openThread(threadId, false);
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : "Could not open agent DM.");
    } finally {
      setOpeningAgentId(null);
    }
  });
  const sdk = useSdk();
  const later = useLaterThreads();
  const workspaceState = useWorkspaces();
  const draftThreadIds = useSidebarThreadDraftIds();
  const workspaceIds = useMemo(
    () => workspaceState.workspaces.map((workspace) => workspace.id),
    [workspaceState.workspaces],
  );
  const threadOrders = useWorkspaceThreadOrders(workspaceIds);
  const collapseState = useCollapsedHierarchy();
  // The host renders the opened thread in the same task as the navigation,
  // which can take hundreds of milliseconds. Highlight the clicked row first,
  // let the browser paint it, then navigate, so the click answers at once.
  const [openingThreadId, setOpeningThreadId] = useState<string | null>(null);
  const selectedThreadId = openingThreadId ?? activeThreadId;
  useLayoutEffect(() => {
    setOpeningThreadId(null);
  }, [activeThreadId]);
  useEffect(() => {
    if (!openingThreadId) return;
    // A navigation that never lands must not leave the highlight behind.
    const timer = window.setTimeout(() => setOpeningThreadId(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [openingThreadId]);
  const openThread = useStableCallback((threadId: string, split: boolean) => {
    if (split || threadId === activeThreadId) {
      navigate.toThread(threadId, { split });
      onNavigate();
      return;
    }
    flushSync(() => setOpeningThreadId(threadId));
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        navigate.toThread(threadId, { split: false });
        onNavigate();
      }, 0);
    });
  });
  const renameThread = useStableCallback(async (threadId: string, title: string) => {
    await sdk.threads.update({ threadId, title });
  });
  const setThreadLater = useStableCallback(
    (threadId: string, value: boolean) => {
      void later.setLater(threadId, value);
    },
  );
  const toggleThreadChildren = useStableCallback((threadId: string) =>
    collapseState.toggle(threadChildrenCollapseKey(threadId)),
  );
  const rowActions = useMemo<ThreadRowActions>(
    () => ({
      open: openThread,
      rename: renameThread,
      setLater: setThreadLater,
      toggleChildren: toggleThreadChildren,
      tasksEnabled,
    }),
    [
      openThread,
      renameThread,
      setThreadLater,
      toggleThreadChildren,
      tasksEnabled,
    ],
  );
  const [view, setView] = useState(readViewOptions);
  const changeView = useStableCallback((next: SidebarViewOptions) => {
    setView(next);
    persistViewOptions(next);
  });
  const [draggedHeader, setDraggedHeader] = useState<DraggedHeader | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<SidebarWorkspace | null>(null);
  const [workspaceEditor, setWorkspaceEditor] = useState<
    | { kind: "create" }
    | { kind: "rename"; workspace: SidebarWorkspace }
    | null
  >(null);

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const explicitProjectIds = useMemo(
    () =>
      new Set(
        projects
          .filter((project) => !project.isPersonal)
          .map((project) => project.id),
      ),
    [projects],
  );
  const standaloneThreadIds = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => !explicitProjectIds.has(thread.projectId))
          .map((thread) => thread.id),
      ),
    [explicitProjectIds, threads],
  );

  const standaloneWorkspaceByThreadId = useMemo(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const resolved = new Map<string, string | null>();
    const resolve = (threadId: string, seen: Set<string>): string | null => {
      if (resolved.has(threadId)) return resolved.get(threadId) ?? null;
      const explicit = workspaceState.threadWorkspaceById.get(threadId);
      if (explicit) {
        resolved.set(threadId, explicit);
        return explicit;
      }
      if (seen.has(threadId)) return null;
      seen.add(threadId);
      const parentId = threadById.get(threadId)?.parentThreadId;
      const inherited =
        parentId && standaloneThreadIds.has(parentId)
          ? resolve(parentId, seen)
          : null;
      resolved.set(threadId, inherited);
      return inherited;
    };
    for (const threadId of standaloneThreadIds) resolve(threadId, new Set());
    return resolved;
  }, [standaloneThreadIds, threads, workspaceState.threadWorkspaceById]);

  const sandboxCandidates = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        hostId: thread.host?.id ?? null,
      })),
    [threads],
  );
  const sandboxStatuses = useSandboxStatuses(
    sandboxCandidates,
    // Host state is re-read fresh on every poll, so this key only needs to
    // capture which threads/hosts are relevant, not per-turn activity
    // (updatedAt, indicator) — those changed on every message and re-fired
    // the poll continuously. Sorted, since activity also reorders `threads`.
    threads
      .map((thread) => `${thread.id}:${thread.host?.id ?? ""}:${thread.isArchived}`)
      .sort()
      .join("\0"),
  );
  const laterIds = useMemo(
    () => new Set(later.placedAtByThreadId.keys()),
    [later.placedAtByThreadId],
  );

  const childrenByParent = useMemo(() => {
    const present = new Set(threads.map((thread) => thread.id));
    const map = new Map<string, PluginSidebarThread[]>();
    for (const thread of threads) {
      const parentId = thread.parentThreadId;
      if (!parentId || !present.has(parentId) || thread.isArchived) continue;
      const siblings = map.get(parentId);
      if (siblings) siblings.push(thread);
      else map.set(parentId, [thread]);
    }
    return map;
  }, [threads]);
  const childIds = useMemo(
    () =>
      new Set(
        [...childrenByParent.values()].flatMap((children) =>
          children.map((thread) => thread.id),
        ),
      ),
    [childrenByParent],
  );
  const topThreads = useMemo(
    () => threads.filter((thread) => !childIds.has(thread.id)),
    [childIds, threads],
  );

  const selectedStatusRef = useRef<{
    threadId: string;
    status: ThreadStatusBucket;
  } | null>(null);
  const selectedThread = threads.find((thread) => thread.id === activeThreadId);
  if (!selectedThread || activeThreadId === null) {
    selectedStatusRef.current = null;
  } else {
    const naturalStatus = statusForThread(selectedThread, draftThreadIds.has(selectedThread.id));
    const previous = selectedStatusRef.current;
    selectedStatusRef.current = {
      threadId: activeThreadId,
      status:
        previous?.threadId === activeThreadId
          ? followSelectedBucket(previous.status, naturalStatus)
          : naturalStatus,
    };
  }

  const statusByThreadId = useMemo(
    () =>
      new Map(
        threads.map((thread) => {
          const naturalStatus = statusForThread(
            thread,
            draftThreadIds.has(thread.id),
          );
          const retainSelected =
            thread.id === activeThreadId &&
            !thread.isPinned &&
            !laterIds.has(thread.id);
          return [
            thread.id,
            retainSelected && selectedStatusRef.current?.threadId === thread.id
              ? selectedStatusRef.current.status
              : naturalStatus,
          ] as const;
        }),
      ),
    [activeThreadId, draftThreadIds, laterIds, searchQuery, threads],
  );
  const effectiveStatusByThreadId = useMemo(() => {
    const gather = (
      id: string,
      statuses: ThreadStatusBucket[],
      seen: Set<string>,
    ) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const child of childrenByParent.get(id) ?? []) {
        statuses.push(statusByThreadId.get(child.id) ?? "idle");
        gather(child.id, statuses, seen);
      }
    };
    const result = new Map<string, ThreadStatusBucket>();
    for (const thread of topThreads) {
      const statuses: ThreadStatusBucket[] = [
        statusByThreadId.get(thread.id) ?? "idle",
      ];
      gather(thread.id, statuses, new Set());
      result.set(thread.id, mostNeedyStatus(statuses));
    }
    return result;
  }, [childrenByParent, statusByThreadId, topThreads]);

  const threadMatches = (
    thread: PluginSidebarThread,
    projectName: string,
  ) => {
    if (!searchQuery.trim()) return true;
    if (matchesSearch(thread, searchQuery, projectName)) return true;
    const pending = [...(childrenByParent.get(thread.id) ?? [])];
    while (pending.length > 0) {
      const child = pending.shift()!;
      if (matchesSearch(child, searchQuery, projectName)) return true;
      pending.push(...(childrenByParent.get(child.id) ?? []));
    }
    return false;
  };
  const searching = Boolean(searchQuery.trim());
  // One manual order covers every thread, so a drag keeps its place when the
  // grouping changes. Orders saved per workspace by older versions seed it.
  const manualIndex = useMemo(() => {
    const saved = threadOrders.indexByWorkspace.get(STATUS_ALL_THREAD_ORDER_SCOPE);
    if (saved?.size) return saved;
    const merged = new Map<string, number>();
    for (const scope of [...workspaceIds, GENERAL_THREAD_ORDER_SCOPE]) {
      for (const threadId of threadOrders.indexByWorkspace.get(scope)?.keys() ?? []) {
        if (!merged.has(threadId)) merged.set(threadId, merged.size);
      }
    }
    return merged;
  }, [threadOrders.indexByWorkspace, workspaceIds]);
  const sortForView = (candidates: readonly PluginSidebarThread[]) =>
    sortThreadsBy(view.sort, candidates, effectiveStatusByThreadId, manualIndex);

  const projectIdsByWorkspace = useMemo(() => {
    const unassigned = projects
      .filter(
        (project) =>
          !project.isPersonal &&
          !workspaceState.projectWorkspaceById.has(project.id),
      )
      .map((project) => project.id);
    return new Map(
      workspaceState.workspaces.map((workspace) => {
        const listed = workspace.projectIds.filter((projectId) => {
          const assigned = workspaceState.projectWorkspaceById.get(projectId);
          return !assigned || assigned === workspace.id;
        });
        const projectIds = workspace.isDefault
          ? [...listed, ...unassigned.filter((id) => !listed.includes(id))]
          : listed;
        return [workspace.id, projectIds] as const;
      }),
    );
  }, [projects, workspaceState.projectWorkspaceById, workspaceState.workspaces]);
  const projectRank = useMemo(() => {
    const rank = new Map<string, number>();
    for (const projectIds of projectIdsByWorkspace.values()) {
      for (const projectId of projectIds) {
        if (!rank.has(projectId)) rank.set(projectId, rank.size);
      }
    }
    return rank;
  }, [projectIdsByWorkspace]);
  const workspaceById = new Map(
    workspaceState.workspaces.map((workspace, index) => [
      workspace.id,
      { workspace, index },
    ]),
  );
  const workspaceIdForThread = (thread: PluginSidebarThread): string | null =>
    standaloneThreadIds.has(thread.id)
      ? (standaloneWorkspaceByThreadId.get(thread.id) ?? null)
      : (workspaceState.projectWorkspaceById.get(thread.projectId) ??
        workspaceState.defaultWorkspaceId);
  const workspaceIdForProject = (projectId: string) =>
    workspaceState.projectWorkspaceById.get(projectId) ??
    workspaceState.defaultWorkspaceId;

  const describe = (
    dimension: GroupDimension,
    thread: PluginSidebarThread,
  ): SidebarGroupKey => {
    if (dimension === "status") {
      const bucket = bucketForThread(
        thread,
        laterIds,
        effectiveStatusByThreadId.get(thread.id),
      );
      const rank = statusSections.findIndex((section) => section.bucket === bucket);
      return { key: bucket, label: statusSections[rank]!.label, rank };
    }
    if (dimension === "workspace") {
      const workspaceId = workspaceIdForThread(thread);
      const entry = workspaceId ? workspaceById.get(workspaceId) : undefined;
      return entry
        ? { key: entry.workspace.id, label: entry.workspace.name, rank: entry.index }
        : { key: GENERAL_KEY, label: "General", rank: Number.MAX_SAFE_INTEGER };
    }
    if (standaloneThreadIds.has(thread.id)) {
      return { key: NO_PROJECT_KEY, label: "No project", rank: Number.MAX_SAFE_INTEGER };
    }
    return {
      key: thread.projectId,
      label: projectNameById.get(thread.projectId) ?? "Unknown project",
      rank: projectRank.get(thread.projectId) ?? Number.MAX_SAFE_INTEGER - 1,
    };
  };

  const tree = buildSidebarTree({
    threads: topThreads.filter((thread) =>
      threadMatches(
        thread,
        standaloneThreadIds.has(thread.id)
          ? ""
          : (projectNameById.get(thread.projectId) ?? ""),
      ),
    ),
    options: view,
    describe,
    sort: sortForView,
    // Empty workspaces stay visible as drop targets for projects and threads.
    keepEmpty:
      view.group === "workspace" && !searching
        ? workspaceState.workspaces.map((workspace, index) => ({
            key: workspace.id,
            label: workspace.name,
            rank: index,
          }))
        : [],
  });

  const isCollapsed = (key: string) =>
    !searching && collapseState.collapsed[key];
  const visibleThreads: PluginSidebarThread[] = [];
  const collectVisible = (nodes: readonly SidebarTreeNode[]) => {
    for (const node of nodes) {
      if (isCollapsed(node.collapseKey)) continue;
      if (node.children) collectVisible(node.children);
      else visibleThreads.push(...node.groups.flatMap((group) => group.threads));
    }
  };
  collectVisible(tree);
  useShortcutSlots(
    visibleThreads.slice(0, 10).map((thread) => ({
      threadId: thread.id,
      title: threadTitle(thread),
      status:
        effectiveStatusByThreadId.get(thread.id) ??
        statusByThreadId.get(thread.id) ??
        "idle",
    })),
  );

  if (
    status === "loading" ||
    later.status === "loading" ||
    workspaceState.status === "loading"
  ) {
    return null;
  }
  if (
    status === "error" ||
    later.status === "error" ||
    workspaceState.status === "error"
  ) {
    return (
      <p
        role="status"
        className="px-3 py-8 text-center text-xs text-muted-foreground"
      >
        Could not load threads.
      </p>
    );
  }

  const threadChildCollapseProps = {
    isThreadChildrenCollapsed: (threadId: string) =>
      Boolean(isCollapsed(threadChildrenCollapseKey(threadId))),
  };
  const reorderEnabled = view.sort === "manual" && !searching;
  const persistManualOrder = (groupIds: readonly string[]) => {
    const allIds = sortThreadsBy(
      "manual",
      topThreads,
      effectiveStatusByThreadId,
      manualIndex,
    ).map((thread) => thread.id);
    void threadOrders.setOrder(
      STATUS_ALL_THREAD_ORDER_SCOPE,
      mergeManualOrder(allIds, groupIds),
    );
  };

  const workspaceOrder = workspaceState.workspaces.map((workspace) => workspace.id);
  const headerDrag: HeaderDragApi = {
    enabled: !searching,
    dragged: draggedHeader,
    start: setDraggedHeader,
    end: () => setDraggedHeader(null),
    reorder: (kind, sourceId, targetId, placement) => {
      setDraggedHeader(null);
      if (kind === "workspace") {
        return workspaceState.reorderWorkspaces(
          moveThreadIds(workspaceOrder, sourceId, targetId, placement),
        );
      }
      const targetWorkspaceId = workspaceIdForProject(targetId);
      if (workspaceIdForProject(sourceId) !== targetWorkspaceId) {
        return workspaceState.assignProject(sourceId, targetWorkspaceId);
      }
      return workspaceState.reorderProjects(
        targetWorkspaceId,
        moveThreadIds(
          projectIdsByWorkspace.get(targetWorkspaceId) ?? [],
          sourceId,
          targetId,
          placement,
        ),
      );
    },
    assignProject: workspaceState.assignProject,
    assignThread: workspaceState.assignThread,
    clearThread: workspaceState.clearThreadWorkspace,
  };

  const targetForNode = (node: SidebarTreeNode): SectionTarget => {
    if (node.dimension === "status") return { kind: "status" };
    if (node.dimension === "workspace") {
      const workspace = workspaceById.get(node.key)?.workspace;
      return workspace ? { kind: "workspace", workspace } : { kind: "general" };
    }
    return node.key === NO_PROJECT_KEY
      ? { kind: "no-project" }
      : { kind: "project", projectId: node.key };
  };
  const actionsForTarget = (target: SectionTarget): SectionMenuAction[] => {
    if (target.kind === "project") {
      return [
        {
          key: "new-thread",
          label: "New thread",
          icon: "MessageSquarePlus",
          onSelect: () =>
            navigate.toCompose({ projectId: target.projectId, focusPrompt: true }),
        },
      ];
    }
    if (target.kind !== "workspace") return [];
    const { workspace } = target;
    return [
      {
        key: "rename",
        label: "Rename",
        icon: "Edit",
        onSelect: () => setWorkspaceEditor({ kind: "rename", workspace }),
      },
      ...(workspace.isDefault
        ? []
        : [
            {
              key: "delete",
              label: "Delete section",
              icon: "Trash2" as const,
              destructive: true,
              onSelect: () => setDeletingWorkspace(workspace),
            },
          ]),
    ];
  };
  const showProjectName =
    view.group !== "project" && view.subgroup !== "project";

  const renderNode = (node: SidebarTreeNode, depth: 0 | 1): ReactNode => {
    const target = targetForNode(node);
    const collapsed = Boolean(isCollapsed(node.collapseKey));
    return (
      <GroupSection
        key={node.collapseKey}
        node={node}
        depth={depth}
        target={target}
        icon={iconForNode(node, target)}
        statusByThreadId={statusByThreadId}
        effectiveStatusByThreadId={effectiveStatusByThreadId}
        collapsed={collapsed}
        onToggle={() => collapseState.toggle(node.collapseKey)}
        headerDrag={headerDrag}
        actions={actionsForTarget(target)}
        view={view}
        onViewChange={changeView}
      >
        {collapsed ? null : node.children ? (
          node.children.map((child) => renderNode(child, 1))
        ) : (
          <ThreadGroups
            groups={node.groups}
            activeThreadId={selectedThreadId}
            statusByThreadId={statusByThreadId}
            effectiveStatusByThreadId={effectiveStatusByThreadId}
            childrenByParent={childrenByParent}
            {...threadChildCollapseProps}
            projectNameById={projectNameById}
            standaloneThreadIds={standaloneThreadIds}
            laterIds={laterIds}
            sandboxStatuses={sandboxStatuses}
            showProjectName={showProjectName}
            reorderEnabled={reorderEnabled}
            workspaceMoveEnabled={!searching}
            onReorder={persistManualOrder}
          />
        )}
      </GroupSection>
    );
  };

  return (
    <ThreadRowActionsContext.Provider value={rowActions}>
    <div
      className="min-h-0 min-w-0 flex-1 overflow-y-auto px-1.5 pb-3 [scrollbar-gutter:stable]"
    >
      {botsEnabled ? <div role="tablist" aria-label="Sidebar" className="sticky top-0 z-10 flex gap-1 bg-sidebar px-1 py-1">
        {(["code", "bots"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" id={`sidebar-${tab}-tab`}
            aria-controls={`sidebar-${tab}-panel`} aria-selected={visibleTab === tab}
            tabIndex={visibleTab === tab ? 0 : -1}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "code" : event.key === "End" ? "bots" : tab === "code" ? "bots" : "code";
              setActiveTab(next);
              document.getElementById(`sidebar-${next}-tab`)?.focus();
            }}
            onClick={() => setActiveTab(tab)}
            className={cn("flex-1 rounded-md px-2 py-1 text-xs font-medium", visibleTab === tab ? "bg-sidebar-accent text-sidebar-foreground" : "text-muted-foreground hover:text-sidebar-foreground")}>
            {tab === "code" ? "Code" : "Bots"}
          </button>
        ))}
      </div> : null}
      {workspaceState.error ? <p role="alert" className="px-2 py-2 text-xs text-destructive-text">{workspaceState.error} <button type="button" className="underline" onClick={() => navigate.toPluginPanel("status-sidebar", { subPath: "setup" })}>Open guide</button></p> : null}
      <div role={botsEnabled ? "tabpanel" : undefined} id="sidebar-code-panel" aria-labelledby={botsEnabled ? "sidebar-code-tab" : undefined} hidden={visibleTab !== "code"}>
        {tree.map((node) => renderNode(node, 0))}
        {countTreeThreads(tree) === 0 ? (
          <p role="status" className="px-3 py-8 text-center text-xs text-muted-foreground">
            {searching ? "No threads found" : "No threads yet"}
          </p>
        ) : null}
        <WorkspaceEditor
          editor={workspaceEditor}
          onDismiss={() => setWorkspaceEditor(null)}
          onCreate={workspaceState.create}
          onRename={workspaceState.rename}
        />
        {!workspaceEditor ? (
          <button type="button" aria-label="New section"
            onClick={() => setWorkspaceEditor({ kind: "create" })}
            className="mt-2 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground">
            <Icon name="Plus" className="size-3.5" aria-hidden="true" />
            <span>Section</span>
          </button>
        ) : null}
      </div>
      {botsEnabled ? <div role="tabpanel" id="sidebar-bots-panel" aria-labelledby="sidebar-bots-tab" hidden={visibleTab !== "bots"}>
        {agents ? (
          <AgentsSection snapshot={agents} activeThreadId={selectedThreadId}
            openingAgentId={openingAgentId} error={agentError} onOpen={openAgent}
            collapsed={Boolean(isCollapsed("agents"))}
            onToggle={() => collapseState.toggle("agents")} />
        ) : null}
        {channels ? (
          <ChannelsSection channels={channels} activeChannelId={activeChannelId}
            collapsed={Boolean(isCollapsed("channels"))}
            onToggle={() => collapseState.toggle("channels")}
            view={view} onViewChange={changeView} />
        ) : null}
        {!agents && !channels ? (
          <p role="status" className="px-3 py-8 text-center text-xs text-muted-foreground">
            Bots are unavailable.
          </p>
        ) : null}
      </div> : null}
      <button type="button" onClick={() => { navigate.toPluginPanel("status-sidebar", { subPath: "setup" }); onNavigate(); }} className="mt-2 px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline">Setup guide</button>
      {deletingWorkspace ? <DeleteSectionDialog workspace={deletingWorkspace} onDismiss={() => setDeletingWorkspace(null)} onRemove={workspaceState.remove} /> : null}
    </div>
    </ThreadRowActionsContext.Provider>
  );
}

function WorkspaceEditor({
  editor,
  onDismiss,
  onCreate,
  onRename,
}: {
  editor:
    | { kind: "create" }
    | { kind: "rename"; workspace: SidebarWorkspace }
    | null;
  onDismiss: () => void;
  onCreate: (name: string) => Promise<string>;
  onRename: (workspaceId: string, name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef(0);
  useEffect(() => {
    operationRef.current += 1;
    setDraft(editor?.kind === "rename" ? editor.workspace.name : "");
    setBusy(false);
    setError(null);
  }, [editor]);
  if (!editor) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    const operation = ++operationRef.current;
    const action = editor.kind === "create"
      ? onCreate(name).then(() => undefined)
      : onRename(editor.workspace.id, name);
    void action.then(() => {
      if (operation === operationRef.current) onDismiss();
    }, (reason) => {
      if (operation !== operationRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    });
  };
  return (
    <form onSubmit={submit} className="mt-2 px-1">
      <Input
        autoFocus
        aria-label={editor.kind === "create" ? "Section name" : `Rename ${editor.workspace.name} section`}
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") onDismiss(); }}
        placeholder="Section name"
        className={cn("h-7 px-2 text-xs", error && "border-destructive")}
      />
      {error ? <p role="alert" className="px-1 pt-1 text-[10px] text-destructive-text">{error}</p> : null}
    </form>
  );
}

const GENERAL_KEY = "__general__";
const NO_PROJECT_KEY = "__none__";

type SectionTarget =
  | { kind: "status" }
  | { kind: "general" }
  | { kind: "no-project" }
  | { kind: "workspace"; workspace: SidebarWorkspace }
  | { kind: "project"; projectId: string };

interface DraggedHeader {
  kind: "workspace" | "project";
  id: string;
}

interface HeaderDragApi {
  enabled: boolean;
  dragged: DraggedHeader | null;
  start: (header: DraggedHeader) => void;
  end: () => void;
  reorder: (
    kind: DraggedHeader["kind"],
    sourceId: string,
    targetId: string,
    placement: DropPlacement,
  ) => Promise<void>;
  assignProject: (projectId: string, workspaceId: string) => Promise<void>;
  assignThread: (threadId: string, workspaceId: string) => Promise<void>;
  clearThread: (threadId: string) => Promise<void>;
}

function iconForNode(node: SidebarTreeNode, target: SectionTarget): IconName {
  switch (target.kind) {
    case "status":
      return statusSectionIcon[node.key as SidebarBucket];
    case "workspace":
    case "general":
      return "Layers";
    case "project":
      return "Folder";
    case "no-project":
      return "MessageSquare";
  }
}

function draggedHeaderFor(target: SectionTarget): DraggedHeader | null {
  if (target.kind === "workspace") {
    return { kind: "workspace", id: target.workspace.id };
  }
  if (target.kind === "project") return { kind: "project", id: target.projectId };
  return null;
}

function GroupSection({
  node,
  depth,
  target,
  icon,
  statusByThreadId,
  effectiveStatusByThreadId,
  collapsed,
  onToggle,
  headerDrag,
  actions,
  view,
  onViewChange,
  children,
}: {
  node: SidebarTreeNode;
  depth: 0 | 1;
  target: SectionTarget;
  icon: IconName;
  statusByThreadId: ReadonlyMap<string, ThreadStatusBucket>;
  effectiveStatusByThreadId: ReadonlyMap<string, ThreadStatusBucket>;
  collapsed: boolean;
  onToggle: () => void;
  headerDrag: HeaderDragApi;
  actions: readonly SectionMenuAction[];
  view: SidebarViewOptions;
  onViewChange: (next: SidebarViewOptions) => void;
  children: ReactNode;
}) {
  const [placement, setPlacement] = useState<DropPlacement | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const own = draggedHeaderFor(target);
  const dragged = headerDrag.dragged;
  const reorderable = Boolean(
    own && dragged && dragged.kind === own.kind && dragged.id !== own.id,
  );
  // Workspace headers take projects and threads; General takes threads back.
  const accepts = (types: readonly string[]) =>
    target.kind === "workspace"
      ? types.includes(PROJECT_WORKSPACE_DRAG_TYPE) ||
        types.includes(THREAD_WORKSPACE_DRAG_TYPE)
      : target.kind === "general" && types.includes(THREAD_WORKSPACE_DRAG_TYPE);
  const run = (action: Promise<void>) => {
    setMutationError(null);
    void action.catch((reason) => {
      setMutationError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  const summary = new Map(
    node.threads.map((thread) => [
      thread.id,
      effectiveStatusByThreadId.get(thread.id) ??
        statusByThreadId.get(thread.id) ??
        "idle",
    ]),
  );
  const isParent = node.children !== null;
  const label = target.kind === "workspace" ? `${node.label} section` : node.label;
  return (
    <section
      aria-label={label}
      data-reorder-project-id={
        target.kind === "project" ? target.projectId : undefined
      }
      className={isParent ? "mt-2 first:mt-1" : "mt-1 first:mt-0.5"}
    >
      <SectionContextMenu
        label={node.label}
        actions={actions}
        view={view}
        onViewChange={onViewChange}
      >
        <SidebarSectionHeader
          label={node.label}
          icon={<Icon name={icon} className="size-3.5" aria-hidden="true" />}
          summary={
            <ThreadStatusSummary
              threads={node.threads}
              statusByThreadId={summary}
            />
          }
          variant={isParent ? "parent" : "section"}
          depth={depth}
          collapsed={collapsed}
          onClick={onToggle}
          draggable={headerDrag.enabled && own !== null}
          onDragStart={(event) => {
            if (!own || !headerDrag.enabled) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(
              own.kind === "workspace"
                ? WORKSPACE_REORDER_DRAG_TYPE
                : PROJECT_WORKSPACE_DRAG_TYPE,
              own.id,
            );
            headerDrag.start(own);
          }}
          onDragOver={(event) => {
            if (reorderable) {
              event.preventDefault();
              event.stopPropagation();
              setPlacement(dropPlacementForEvent(event));
              return;
            }
            if (!accepts(Array.from(event.dataTransfer.types))) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
              return;
            }
            setPlacement(null);
            setDropTarget(false);
          }}
          onDrop={(event) => {
            if (reorderable && own && dragged) {
              event.preventDefault();
              event.stopPropagation();
              setPlacement(null);
              run(
                headerDrag.reorder(
                  own.kind,
                  dragged.id,
                  own.id,
                  dropPlacementForEvent(event),
                ),
              );
              return;
            }
            if (!accepts(Array.from(event.dataTransfer.types))) return;
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(false);
            const projectId = event.dataTransfer.getData(PROJECT_WORKSPACE_DRAG_TYPE);
            const threadId = event.dataTransfer.getData(THREAD_WORKSPACE_DRAG_TYPE);
            if (target.kind === "workspace") {
              if (projectId) {
                run(headerDrag.assignProject(projectId, target.workspace.id));
              } else if (threadId) {
                run(headerDrag.assignThread(threadId, target.workspace.id));
              }
            } else if (threadId) {
              run(headerDrag.clearThread(threadId));
            }
          }}
          onDragEnd={() => {
            setPlacement(null);
            setDropTarget(false);
            headerDrag.end();
          }}
          className={cn(
            own && headerDrag.enabled && "cursor-grab active:cursor-grabbing",
            own && dragged?.kind === own.kind && dragged.id === own.id && "opacity-45",
            dropTarget && "bg-sidebar-accent ring-1 ring-primary",
            placement === "before" &&
              "before:absolute before:inset-x-1 before:top-0 before:h-0.5 before:bg-primary",
            placement === "after" &&
              "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-primary",
          )}
        />
      </SectionContextMenu>
      {mutationError ? (
        <p role="alert" className="px-2 pb-1 text-[10px] text-destructive-text">
          {mutationError}
        </p>
      ) : null}
      {isParent && !collapsed ? <div className="ms-2 ps-1">{children}</div> : children}
    </section>
  );
}

function SidebarSectionHeader({
  label,
  icon,
  summary,
  collapsed,
  action,
  variant = "section",
  depth = 0,
  className,
  ...buttonProps
}: {
  label: string;
  icon: ReactNode;
  summary?: ReactNode;
  collapsed: boolean;
  action?: ReactNode;
  /** A parent holds subgroups and reads as the stronger heading. */
  variant?: "parent" | "section";
  depth?: 0 | 1;
} & Omit<ComponentPropsWithoutRef<"button">, "children" | "type">) {
  return (
    // Sticky inside its own <section>, so the next section's header pushes it
    // off. A subgroup header sticks just below its parent's h-8 header.
    // Opaque so rows scroll under it rather than through it.
    <div
      className={cn(
        "group/section-header sticky bg-sidebar",
        depth === 0 ? "top-0 z-30" : "top-8 z-20",
      )}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        {...buttonProps}
        className={cn(
          "relative flex w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs",
          variant === "parent"
            ? "h-8 text-sidebar-foreground hover:bg-sidebar-accent/60"
            : "h-7 text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
          className,
        )}
      >
        <span className={cn("shrink-0", variant === "parent" && "text-muted-foreground")}>
          {icon}
        </span>
        <span
          className={cn(
            "min-w-0 truncate",
            variant === "parent" ? "font-semibold" : "font-medium",
          )}
        >
          {label}
        </span>
        {summary}
        <Icon
          name="ChevronDown"
          className={cn(
            "ms-auto size-3 shrink-0 transition-transform",
            collapsed && "-rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
      {action ? (
        <span className="absolute end-6 top-0">{action}</span>
      ) : null}
    </div>
  );
}

// Like thread rows, only the clicked row reacts: it highlights while its DM opens, then stays
// highlighted as the active thread. The other rows keep working instead of dimming.
function isSelectedAgent(agent: { id: string; dmThreadId: string | null }, openingAgentId: string | null, activeThreadId: string | null) {
  if (openingAgentId) return agent.id === openingAgentId;
  return Boolean(agent.dmThreadId) && agent.dmThreadId === activeThreadId;
}

function AgentsSection({
  snapshot, activeThreadId, openingAgentId, error, onOpen, collapsed, onToggle,
}: {
  snapshot: AgentSidebarSnapshot;
  activeThreadId: string | null;
  openingAgentId: string | null;
  error: string | null;
  onOpen: (profileId: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const count = snapshot.agents.length;
  return (
    <section aria-label="Agents" className="mt-1 first:mt-0.5">
      <SidebarSectionHeader
        label="Agents"
        icon={<Icon name="Bot" className="size-3.5" aria-hidden="true" />}
        summary={
          <span
            aria-label={`${count} ${count === 1 ? "agent" : "agents"}`}
            data-status-count="agents"
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-sidebar-foreground/10 px-1 text-[9px] font-medium tabular-nums text-sidebar-foreground"
          >
            {count}
          </span>
        }
        collapsed={collapsed}
        onClick={onToggle}
      />
      {error ? <p role="alert" className="px-2 text-xs text-destructive">{error}</p> : null}
      {!collapsed ? (
        <div data-sidebar-agent-rail="" className="ms-2 mt-px ps-1">
          <ul className="space-y-px">
            {snapshot.agents.map((agent) => (
              <li key={agent.id} className="relative list-none" data-sidebar-agent-id={agent.id}>
                <button type="button" onClick={() => onOpen(agent.id)}
                  aria-label={`Open ${agent.name}`}
                  aria-current={agent.dmThreadId && agent.dmThreadId === activeThreadId ? "page" : undefined}
                  className={cn("flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-start text-sidebar-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-1 focus-visible:ring-ring",
                    isSelectedAgent(agent, openingAgentId, activeThreadId) && "bg-sidebar-accent")}>
                  <span aria-hidden="true" className="w-5 shrink-0 text-center">{agent.avatar}</span>
                  <span className="min-w-0 flex-1 truncate text-xs">{agent.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ChannelsSection({
  channels,
  activeChannelId,
  collapsed,
  onToggle,
  view,
  onViewChange,
}: {
  channels: readonly ChannelSummary[];
  activeChannelId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  view: SidebarViewOptions;
  onViewChange: (next: SidebarViewOptions) => void;
}) {
  return (
    <section
      aria-label="Channels"
      className="mt-1 first:mt-0.5"
    >
      <SectionContextMenu label="Channels" view={view} onViewChange={onViewChange}>
      <SidebarSectionHeader
        label="Channels"
        icon={
          <Icon
            name="MessageSquare"
            className="size-3.5"
            aria-hidden="true"
          />
        }
        summary={
          <span
            aria-label={`${channels.length} ${channels.length === 1 ? "channel" : "channels"}`}
            data-status-count="channels"
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-sidebar-foreground/10 px-1 text-[9px] font-medium tabular-nums text-sidebar-foreground"
          >
            {channels.length}
          </span>
        }
        collapsed={collapsed}
        onClick={onToggle}
        action={
          <a
            href={channelPanelHref("new")}
            aria-label="New channel"
            title="New channel"
            className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/section-header:opacity-100"
          >
            <Icon name="Plus" className="size-3.5" aria-hidden="true" />
          </a>
        }
      />
      </SectionContextMenu>
      {!collapsed ? (
        <div
          data-sidebar-channel-rail=""
          className="ms-2 mt-px ps-1"
        >
          <ul className="space-y-px">
            {channels.length === 0 ? (
              <li className="relative list-none">
                <SidebarRow
                  anchorProps={{
                    href: channelPanelHref("new"),
                    "aria-label": "New channel",
                  }}
                >
                  <span className="pointer-events-none relative grid size-5 shrink-0 place-items-center text-muted-foreground">
                    <Icon
                      name="Plus"
                      className="size-3.5"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="pointer-events-none relative min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    New channel
                  </span>
                </SidebarRow>
              </li>
            ) : (
              channels.map((channel) => {
                const selected = channel.id === activeChannelId;
                return (
                  <li
                    key={channel.id}
                    data-sidebar-channel-id={channel.id}
                    className="relative list-none"
                  >
                    <SidebarRow
                      anchorProps={{
                        href: channelPanelHref(channel.id),
                        "aria-label": `Open #${channel.name}`,
                        "aria-current": selected ? "page" : undefined,
                        title: `${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`,
                      }}
                      isSelected={selected}
                    >
                      <span
                        className={cn("pointer-events-none relative min-w-0 flex-1 truncate text-xs text-sidebar-foreground", channel.unread && "font-semibold")}
                        title={channel.name}
                      >
                        {channel.name}
                      </span>
                      <span className="pointer-events-none relative flex max-w-24 shrink-0 items-center gap-1 text-[10px] text-muted-foreground @max-[22rem]/thread-row:hidden">
                        {channel.memberCount}{" "}
                        {channel.memberCount === 1 ? "member" : "members"}
                      </span>
                    </SidebarRow>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

interface ThreadGroupsProps {
  groups: readonly SidebarGroup[];
  activeThreadId: string | null;
  statusByThreadId: ReadonlyMap<string, ThreadStatusBucket>;
  effectiveStatusByThreadId: ReadonlyMap<string, ThreadStatusBucket>;
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  isThreadChildrenCollapsed: (threadId: string) => boolean;
  projectNameById: ReadonlyMap<string, string>;
  standaloneThreadIds: ReadonlySet<string>;
  laterIds: ReadonlySet<string>;
  sandboxStatuses: ReadonlyMap<string, SandboxThreadStatus>;
  onReorder: (threadIds: readonly string[]) => void;
  showProjectName?: boolean;
  reorderEnabled?: boolean;
  /** Lets threads without a project be dragged onto a workspace header. */
  workspaceMoveEnabled?: boolean;
}

function ThreadGroups(props: ThreadGroupsProps) {
  const { groups, onReorder } = props;
  const orderedThreads = groups.flatMap((group) => group.threads);
  const orderedIds = orderedThreads.map((thread) => thread.id);
  const groupByThreadId = new Map(
    groups.flatMap((group) =>
      group.threads.map((thread) => [thread.id, group] as const),
    ),
  );
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    threadId: string;
    placement: DropPlacement;
  } | null>(null);
  const reorder = (targetId: string, placement: DropPlacement) => {
    if (!draggedId || draggedId === targetId) return;
    const movingGroup = groupByThreadId.get(draggedId);
    const targetGroup = groupByThreadId.get(targetId);
    if (!movingGroup || !targetGroup) return;
    onReorder(
      movingGroup.key === targetGroup.key
        ? moveThreadIds(orderedIds, draggedId, targetId, placement)
        : moveThreadGroup(
            orderedIds,
            movingGroup.threads.map((thread) => thread.id),
            targetGroup.threads.map((thread) => thread.id),
            placement,
          ),
    );
  };
  // Stable, so memoized rows are not re-rendered by a new closure each time.
  const onDragStart = useStableCallback((threadId: string) => {
    setDraggedId(threadId);
    setDropTarget(null);
  });
  const onDragOver = useStableCallback(
    (threadId: string, placement: DropPlacement) => {
      const next =
        draggedId && draggedId !== threadId
          ? { threadId, placement }
          : null;
      // dragover fires continuously; only re-render when the target moves.
      setDropTarget((current) =>
        current?.threadId === next?.threadId &&
        current?.placement === next?.placement
          ? current
          : next,
      );
    },
  );
  const onDrop = useStableCallback(
    (threadId: string, placement: DropPlacement) => {
      reorder(threadId, placement);
      setDraggedId(null);
      setDropTarget(null);
    },
  );
  const onDragEnd = useStableCallback(() => {
    setDraggedId(null);
    setDropTarget(null);
  });
  return (
    <div className="ms-2 mt-px ps-1">
      {groups.map((group) => (
        <EnvironmentGroup
          key={group.key}
          {...props}
          group={group}
          draggedId={draggedId}
          draggedGroupKey={
            draggedId ? groupByThreadId.get(draggedId)?.key ?? null : null
          }
          dropTarget={dropTarget}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
        />
      ))}
    </div>
  );
}

function EnvironmentGroup({
  group,
  activeThreadId,
  childrenByParent,
  isThreadChildrenCollapsed,
  projectNameById,
  standaloneThreadIds,
  laterIds,
  sandboxStatuses,
  showProjectName = false,
  reorderEnabled = true,
  workspaceMoveEnabled = true,
  draggedId,
  draggedGroupKey,
  dropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: Omit<ThreadGroupsProps, "groups" | "onReorder"> & {
  group: SidebarGroup;
  draggedId: string | null;
  draggedGroupKey: string | null;
  dropTarget: { threadId: string; placement: DropPlacement } | null;
  onDragStart: (threadId: string) => void;
  onDragOver: (threadId: string, placement: DropPlacement) => void;
  onDrop: (threadId: string, placement: DropPlacement) => void;
  onDragEnd: () => void;
}) {
  const isDraggedGroup = group.grouped && draggedGroupKey === group.key;
  const containsDropTarget = group.threads.some(
    (thread) => thread.id === dropTarget?.threadId,
  );
  const groupDropPlacement =
    containsDropTarget && draggedGroupKey && draggedGroupKey !== group.key
      ? dropTarget?.placement ?? null
      : null;
  return (
    <div
      data-sidebar-worktree-group={group.grouped ? "" : undefined}
      data-sidebar-thread-group={group.key}
      role={group.grouped ? "group" : undefined}
      aria-label={
        group.grouped
          ? `${group.threads.length} threads in the same worktree`
          : undefined
      }
      className={cn(
        "relative",
        group.grouped &&
          "my-0.5 rounded-md bg-sidebar-accent/15 ring-1 ring-inset ring-sidebar-border/60 first:mt-0 last:mb-0",
        isDraggedGroup && "opacity-45",
        groupDropPlacement === "before" &&
          "before:absolute before:inset-x-0 before:-top-0.5 before:h-0.5 before:bg-primary",
        groupDropPlacement === "after" &&
          "after:absolute after:inset-x-0 after:-bottom-0.5 after:h-0.5 after:bg-primary",
      )}
    >
      <ul className="space-y-px">
        {group.threads.map((thread) => (
          <Fragment key={thread.id}>
            <ThreadRow
              thread={thread}
              projectName={
                projectNameById.get(thread.projectId) ?? "Unknown project"
              }
              showProjectName={showProjectName}
              reorderEnabled={reorderEnabled}
              workspaceMovable={
                workspaceMoveEnabled && standaloneThreadIds.has(thread.id)
              }
              childThreads={childrenByParent.get(thread.id)}
              childrenCollapsed={isThreadChildrenCollapsed(thread.id)}
              childSandboxStatuses={
                childrenByParent.has(thread.id) ? sandboxStatuses : undefined
              }
              isSelected={thread.id === activeThreadId}
              isLater={laterIds.has(thread.id)}
              sandboxStatus={sandboxStatuses.get(thread.id)}
              isGrouped={group.grouped}
              isDragging={draggedId === thread.id && !isDraggedGroup}
              dropPlacement={
                dropTarget?.threadId === thread.id &&
                draggedGroupKey === group.key
                  ? dropTarget.placement
                  : null
              }
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
            />
            <SidecarThreads
              parentId={thread.id}
              parentProjectId={thread.projectId}
              childrenByParent={childrenByParent}
              isThreadChildrenCollapsed={isThreadChildrenCollapsed}
              activeThreadId={activeThreadId}
              projectNameById={projectNameById}
              laterIds={laterIds}
              sandboxStatuses={sandboxStatuses}
            />
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

const noop = () => {};

function SidecarThreads({
  parentId,
  parentProjectId,
  childrenByParent,
  isThreadChildrenCollapsed,
  activeThreadId,
  projectNameById,
  laterIds,
  sandboxStatuses,
}: {
  parentId: string;
  parentProjectId: string;
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  isThreadChildrenCollapsed: (threadId: string) => boolean;
  activeThreadId: string | null;
  projectNameById: ReadonlyMap<string, string>;
  laterIds: ReadonlySet<string>;
  sandboxStatuses: ReadonlyMap<string, SandboxThreadStatus>;
}) {
  const children = childrenByParent.get(parentId) ?? [];
  if (children.length === 0 || isThreadChildrenCollapsed(parentId)) return null;
  return (
    <ul
      role="group"
      aria-label="Attached agents"
      className="relative mt-px space-y-px before:absolute before:inset-y-0 before:start-3 before:w-px before:bg-sidebar-border/60 [[aria-label='Attached_agents']_&]:ms-4"
    >
      {children.map((child) => (
        <Fragment key={child.id}>
          <ThreadRow
            thread={child}
            projectName={
              projectNameById.get(child.projectId) ?? "Unknown project"
            }
            showProjectName={child.projectId !== parentProjectId}
            isSelected={child.id === activeThreadId}
            isLater={laterIds.has(child.id)}
            sandboxStatus={sandboxStatuses.get(child.id)}
            childThreads={childrenByParent.get(child.id)}
            childrenCollapsed={isThreadChildrenCollapsed(child.id)}
            childSandboxStatuses={
              childrenByParent.has(child.id) ? sandboxStatuses : undefined
            }
            isGrouped={false}
            isDragging={false}
            dropPlacement={null}
            onDragStart={noop}
            onDragOver={noop}
            onDrop={noop}
            onDragEnd={noop}
            nested
          />
          <SidecarThreads
            parentId={child.id}
            parentProjectId={child.projectId}
            childrenByParent={childrenByParent}
            isThreadChildrenCollapsed={isThreadChildrenCollapsed}
            activeThreadId={activeThreadId}
            projectNameById={projectNameById}
            laterIds={laterIds}
            sandboxStatuses={sandboxStatuses}
          />
        </Fragment>
      ))}
    </ul>
  );
}
