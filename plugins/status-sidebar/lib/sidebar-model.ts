import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { SANDBOX_PROVIDER_LABELS, type SandboxThreadStatus } from "../shared";

export type ThreadStatusBucket =
  | "unread"
  | "active"
  | "needs-input"
  | "drafting"
  | "recent"
  | "idle"
  | "archived";

export type SidebarBucket = "pinned" | ThreadStatusBucket;

export const THREAD_STATUS_ORDER: readonly ThreadStatusBucket[] = [
  "unread",
  "drafting",
  "needs-input",
  "recent",
  "idle",
  "active",
  "archived",
];

export interface SidebarGroup {
  key: string;
  grouped: boolean;
  threads: readonly PluginSidebarThread[];
}

const ACTIVE_INDICATORS = new Set([
  "working-draft",
  "workflow",
  "background-agent",
  "plan-mode",
  "goal",
  "runtime",
]);

export function threadTitle(thread: PluginSidebarThread): string {
  return (
    thread.title?.trim() || thread.titleFallback?.trim() || "Untitled thread"
  );
}

/**
 * The provider to mark a row with, or null when the row is not on a sandbox.
 * A resolved status is authoritative and covers every thread sharing the
 * machine — forks and plugin-spawned subagents included. Without one, only the
 * thread the sandboxes plugin created can be recognized, from its host name.
 */
export function sandboxProviderLabel(
  thread: PluginSidebarThread,
  status?: SandboxThreadStatus,
): string | null {
  if (status !== undefined) {
    return (SANDBOX_PROVIDER_LABELS as Record<string, string>)[status.provider] ?? "Sandbox";
  }
  if (thread.originPluginId !== "sandboxes") return null;
  const hostName = thread.host?.name ?? "";
  const named = Object.values(SANDBOX_PROVIDER_LABELS).find((label) =>
    hostName.startsWith(`${label} ·`),
  );
  return named ?? "Sandbox";
}

export function isThreadActive(thread: PluginSidebarThread): boolean {
  const activity = thread.activity;
  return (
    activity.workflows +
      activity.backgroundAgents +
      activity.planMode +
      activity.goals >
      0 || ACTIVE_INDICATORS.has(thread.indicator) ||
    (activity.backgroundCommands > 0 && thread.status !== "idle" && thread.status !== "error")
  );
}

export function needsInput(thread: PluginSidebarThread): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.indicator === "unread-error"
  );
}

export function statusForThread(
  thread: PluginSidebarThread,
  hasDraft = false,
  recentHours = 3,
  now = Date.now(),
): ThreadStatusBucket {
  if (thread.isArchived) return "archived";
  if (needsInput(thread)) return "needs-input";
  if (isThreadActive(thread)) return "active";
  if (hasDraft) return "drafting";
  if (thread.isUnread && !thread.parentThreadId && !thread.lifecycleOwnerThreadId) return "unread";
  return thread.updatedAt >= now - recentHours * 3_600_000 ? "recent" : "idle";
}

// Neediness precedence for rolling a parent thread's bucket up from its
// descendants: a parent sits in the group of its most-attention-hungry agent.
// Mirrors statusForThread's own ordering
// (needs-input > active > drafting > unread > idle); archived never pulls a parent.
export const STATUS_NEEDINESS: Record<ThreadStatusBucket, number> = {
  "needs-input": 5,
  active: 4,
  drafting: 3.5,
  unread: 3,
  recent: 2,
  idle: 1,
  archived: 0,
};

export const ORGANIZATIONAL_STATUS_RANK: Record<ThreadStatusBucket, number> = {
  "needs-input": 0,
  unread: 1,
  drafting: 2,
  recent: 3,
  idle: 4,
  active: 5,
  archived: 6,
};

export function mostNeedyStatus(
  statuses: readonly ThreadStatusBucket[],
): ThreadStatusBucket {
  let best: ThreadStatusBucket = "idle";
  let bestRank = -1;
  for (const status of statuses) {
    const rank = STATUS_NEEDINESS[status];
    if (rank > bestRank) {
      bestRank = rank;
      best = status;
    }
  }
  return best;
}

export function bucketForThread(
  thread: PluginSidebarThread,
  effectiveStatus?: ThreadStatusBucket,
): SidebarBucket {
  if (thread.isArchived) return "archived";
  if (thread.isPinned) return "pinned";
  return effectiveStatus ?? statusForThread(thread);
}

export function followSelectedBucket(
  previous: ThreadStatusBucket,
  natural: ThreadStatusBucket,
): ThreadStatusBucket {
  if (natural === "archived") return natural;
  if (natural === "active" || natural === "needs-input") return natural;
  if (natural === "drafting") return natural;
  if (previous === "drafting") return natural;
  if (natural === "unread") {
    return previous === "active" || previous === "needs-input"
      ? previous
      : natural;
  }
  if (natural === "recent" || natural === "idle") {
    return previous === "active" ||
      previous === "needs-input" ||
      previous === "unread"
      ? previous
      : natural;
  }
  return natural;
}

export function matchesSearch(
  thread: PluginSidebarThread,
  query: string,
  projectName: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return `${threadTitle(thread)} ${projectName} ${thread.providerId}`
    .toLocaleLowerCase()
    .includes(normalized);
}

export function sortThreads(
  bucket: SidebarBucket,
  threads: readonly PluginSidebarThread[],
  orderIndexByThreadId: ReadonlyMap<string, number> = new Map(),
  statusByThreadId: ReadonlyMap<string, ThreadStatusBucket> = new Map(),
): PluginSidebarThread[] {
  return [...threads].sort((left, right) => {
    if (bucket === "pinned") {
      const leftStatus =
        statusByThreadId.get(left.id) ?? statusForThread(left);
      const rightStatus =
        statusByThreadId.get(right.id) ?? statusForThread(right);
      const statusDifference =
        ORGANIZATIONAL_STATUS_RANK[leftStatus] -
        ORGANIZATIONAL_STATUS_RANK[rightStatus];
      if (statusDifference !== 0) return statusDifference;
    }
    const leftOrder = orderIndexByThreadId.get(left.id);
    const rightOrder = orderIndexByThreadId.get(right.id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return -1;
      if (rightOrder === undefined) return 1;
      return leftOrder - rightOrder;
    }
    if (bucket === "needs-input") {
      return right.latestAttentionAt - left.latestAttentionAt;
    }
    return right.updatedAt - left.updatedAt;
  });
}

export function sortThreadsByStatus(
  threads: readonly PluginSidebarThread[],
  orderIndexByThreadId: ReadonlyMap<string, number> = new Map(),
  statusByThreadId: ReadonlyMap<string, ThreadStatusBucket> = new Map(),
): PluginSidebarThread[] {
  return THREAD_STATUS_ORDER.flatMap((status) =>
    sortThreads(
      status,
      threads.filter(
        (thread) =>
          (statusByThreadId.get(thread.id) ?? statusForThread(thread)) === status,
      ),
      orderIndexByThreadId,
      statusByThreadId,
    ),
  );
}

export type DropPlacement = "before" | "after";

export function dropPlacementForEvent(event: {
  clientY: number;
  currentTarget: {
    getBoundingClientRect(): { top: number; height: number };
  };
}): DropPlacement {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
}

export function moveThreadIds(
  threadIds: readonly string[],
  draggedId: string,
  targetId: string,
  placement: DropPlacement,
): string[] {
  if (draggedId === targetId) return [...threadIds];
  const withoutDragged = threadIds.filter((threadId) => threadId !== draggedId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex < 0 || !threadIds.includes(draggedId)) return [...threadIds];
  const insertIndex = targetIndex + (placement === "after" ? 1 : 0);
  withoutDragged.splice(insertIndex, 0, draggedId);
  return withoutDragged;
}

export function moveThreadGroup(
  threadIds: readonly string[],
  draggedGroupIds: readonly string[],
  targetGroupIds: readonly string[],
  placement: DropPlacement,
): string[] {
  const draggedSet = new Set(draggedGroupIds);
  const targetSet = new Set(targetGroupIds);
  if (
    draggedGroupIds.length === 0 ||
    targetGroupIds.length === 0 ||
    draggedGroupIds.some((threadId) => targetSet.has(threadId))
  ) {
    return [...threadIds];
  }
  const withoutDragged = threadIds.filter((threadId) => !draggedSet.has(threadId));
  const targetIndexes = withoutDragged.flatMap((threadId, index) =>
    targetSet.has(threadId) ? [index] : [],
  );
  if (targetIndexes.length === 0) return [...threadIds];
  const insertIndex =
    placement === "before"
      ? targetIndexes[0]!
      : targetIndexes[targetIndexes.length - 1]! + 1;
  withoutDragged.splice(insertIndex, 0, ...draggedGroupIds);
  return withoutDragged;
}

export function groupByEnvironment(
  threads: readonly PluginSidebarThread[],
): SidebarGroup[] {
  const groups = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    const environmentId = thread.environment?.id;
    const key = environmentId
      ? `${thread.projectId}:${environmentId}`
      : `thread:${thread.id}`;
    const group = groups.get(key) ?? [];
    group.push(thread);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, groupedThreads]) => ({
    key,
    grouped: groupedThreads.length > 1,
    threads: groupedThreads,
  }));
}
