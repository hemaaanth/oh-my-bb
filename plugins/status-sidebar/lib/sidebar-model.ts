import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { SANDBOX_PROVIDER_LABELS, type SandboxThreadStatus, type TaskRunPhase, type ThreadTaskRun } from "../shared";
import type { CanonicalTone } from "./status-colors";

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

/** A persistent error status is not fresh attention after it has been read. */
export function hasUnseenFailure(thread: PluginSidebarThread): boolean {
  return thread.queuedWork === "failed" || thread.indicator === "unread-error" ||
    (thread.status === "error" && (thread.lastReadAt === null || thread.latestAttentionAt > thread.lastReadAt));
}

const AUTONOMOUS_TASK_PHASES = new Set<TaskRunPhase>([
  "scoping",
  "building",
  "capturing",
  "checking",
  "babysitting",
  "deploying",
]);

export const SETTLED_IDLE_MS = 7 * 86_400_000;

export const TASK_PHASE_LABELS: Record<TaskRunPhase, string> = {
  scoping: "Scoping",
  building: "Building",
  capturing: "Capturing",
  checking: "Checking",
  waiting: "Waiting",
  babysitting: "PR Review",
  deploying: "Deploying",
  live: "Live",
  blocked: "Blocked",
};

export function taskRunBadgeLabel(run: ThreadTaskRun): string | null {
  if (run.phase === "blocked") return "Blocked";
  if (run.hasWaitingUnit) return "Unit ready";
  if (run.phase === "waiting" && run.proofPageId) return "Proof ready";
  if (run.proposedStatus === "done" && run.taskStatus !== "done") return "Ready to close";
  if (run.phase) return TASK_PHASE_LABELS[run.phase];
  if (run.taskStatus === "review" && run.proofPageId) return "Proof ready";
  return null;
}

export type FocusBandKey = "attention" | "current" | "library" | "settled";

export interface ThreadPresentation {
  band: FocusBandKey;
  bandLabel: string;
  bandRank: number;
  tone: CanonicalTone;
  reason: string | null;
  isFactory: boolean;
  prominent: boolean;
}

const BAND_META: Record<FocusBandKey, { label: string; rank: number }> = {
  attention: { label: "Needs you", rank: 0 },
  current: { label: "In flight", rank: 1 },
  library: { label: "Recent", rank: 2 },
  settled: { label: "Settled", rank: 3 },
};

/**
 * Single source of truth for Focus sidebar placement, color tone, and badge
 * label. Header summary pills and row glyphs/badges MUST read from this
 * presentation so they can never drift out of sync.
 */
export function resolveThreadPresentation(
  thread: PluginSidebarThread,
  status: ThreadStatusBucket,
  options?: { taskRun?: ThreadTaskRun | null; hasActiveChild?: boolean; now?: number },
): ThreadPresentation {
  const taskRun = options?.taskRun ?? null;
  const hasActiveChild = options?.hasActiveChild === true;
  const now = options?.now ?? Date.now();
  const isFactory = Boolean(taskRun);
  const stageLabel = taskRun ? taskRunBadgeLabel(taskRun) : null;
  const isAutonomousRun = Boolean(taskRun?.phase && AUTONOMOUS_TASK_PHASES.has(taskRun.phase));
  const delegated = thread.lifecycleOwnerThreadId !== null || (thread.parentThreadId !== null && thread.originKind !== "fork");
  const failed = hasUnseenFailure(thread);

  const make = (band: FocusBandKey, tone: CanonicalTone, reason: string | null, prominent = false): ThreadPresentation => ({
    band,
    bandLabel: BAND_META[band].label,
    bandRank: BAND_META[band].rank,
    tone,
    reason,
    isFactory,
    prominent,
  });

  // 1. Explicit pending interaction or unseen failure always surfaces in Needs you.
  if (failed) return make("attention", "critical", "Failed", true);
  if (status === "needs-input") return make("attention", "attention", "Needs input", true);

  // 2. Actively working RIGHT NOW (including after user replied) ALWAYS lives in In flight.
  if (status === "active" || hasActiveChild) {
    const isPrReview = taskRun?.phase === "babysitting";
    const activeTone: CanonicalTone = isPrReview ? "review" : "active";
    const activeReason = isFactory ? (isAutonomousRun ? stageLabel : "Working") : "Working";
    return make("current", activeTone, activeReason, false);
  }

  // 3. Factory run explicitly awaiting the owner (Proof ready, Unit ready, Blocked, Ready to close).
  if (taskRun?.needsAttention) {
    const tone: CanonicalTone = taskRun.phase === "blocked" ? "critical" : "attention";
    return make("attention", tone, stageLabel ?? "Needs you", true);
  }

  // 4. Regular non-factory chat with an unread finished reply.
  const topLevelUnread = status === "unread" && !thread.lifecycleOwnerThreadId && (!thread.parentThreadId || thread.originKind === "fork");
  if (topLevelUnread && !isAutonomousRun) {
    return make("attention", "unread", "Unread", true);
  }

  // 5. Autonomous factory phase (e.g. PR Review / Building / Checking) stays in In flight.
  if (isAutonomousRun && taskRun) {
    const tone: CanonicalTone = taskRun.phase === "babysitting" ? "review" : "active";
    return make("current", tone, stageLabel, false);
  }

  // 6. Unsent draft in composer gets its own distinct orange tone in In flight.
  if (status === "drafting") {
    return make("current", "draft", "Draft", false);
  }

  // 7. Pinned or queued work stays in In flight.
  if (thread.isPinned || thread.queuedWork === "waiting") {
    return make("current", "idle", thread.isPinned ? "Pinned" : "Queued", false);
  }

  // 8. Settled: idle >= 7 days or linked task is done/cancelled.
  const lastActivity = Math.max(thread.updatedAt, thread.latestAttentionAt, thread.createdAt);
  const taskDone = taskRun?.taskStatus === "done" || taskRun?.taskStatus === "cancelled";
  if (!delegated && (taskDone || (status === "idle" && now - lastActivity >= SETTLED_IDLE_MS))) {
    return make("settled", "idle", null, false);
  }

  // 9. Recent: idle < 7 days.
  return make("library", "idle", null, false);
}

/** Focus is a working set; quiet execution and autonomous factory runs are not attention requests. */
export function focusGroup(
  thread: PluginSidebarThread,
  status: ThreadStatusBucket,
  options?: { taskRun?: ThreadTaskRun | null; hasActiveChild?: boolean; now?: number },
) {
  const p = resolveThreadPresentation(thread, status, options);
  return { key: p.band, label: p.bandLabel, rank: p.bandRank };
}

/** A review suggestion only. BB archive can remove the workspace and worktree. */
export function isCleanupCandidate(thread: PluginSidebarThread, status: ThreadStatusBucket, now: number): boolean {
  return !thread.isArchived && !thread.isPinned && status === "idle" &&
    thread.status === "idle" && thread.queuedWork === "none" && !thread.isUnread &&
    !needsInput(thread) && !isThreadActive(thread) && thread.activity.backgroundCommands === 0 &&
    Math.max(thread.updatedAt, thread.latestAttentionAt, thread.createdAt) < now - 14 * 86_400_000;
}

/** Wake an entire visible ancestry for a request or failure, including snoozed parents. */
export function attentionWakeIds(threads: readonly PluginSidebarThread[]): Set<string> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const result = new Set<string>();
  for (const thread of threads) {
    if (thread.isArchived || !(needsInput(thread) || hasUnseenFailure(thread))) continue;
    let current: PluginSidebarThread | undefined = thread;
    const seen = new Set<string>();
    while (current && !current.isArchived && !seen.has(current.id)) {
      seen.add(current.id);
      result.add(current.id);
      current = current.parentThreadId ? byId.get(current.parentThreadId) : undefined;
    }
  }
  return result;
}

/** Status bands stay together; attention timestamps only order peers. */
export function sortFocusThreads(
  threads: readonly PluginSidebarThread[],
  statuses: ReadonlyMap<string, ThreadStatusBucket>,
): PluginSidebarThread[] {
  const rank: Record<ThreadStatusBucket, number> = {
    "needs-input": 0, unread: 1, drafting: 2, recent: 3, idle: 3, active: 4, archived: 5,
  };
  return [...threads].sort((left, right) =>
    rank[statuses.get(left.id) ?? "idle"] - rank[statuses.get(right.id) ?? "idle"] ||
    Number(right.isPinned) - Number(left.isPinned) ||
    right.latestAttentionAt - left.latestAttentionAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}
