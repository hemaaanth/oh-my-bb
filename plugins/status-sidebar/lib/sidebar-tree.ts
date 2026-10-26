import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  groupByEnvironment,
  ORGANIZATIONAL_STATUS_RANK,
  statusForThread,
  type SidebarGroup,
  type ThreadStatusBucket,
} from "./sidebar-model";
import type {
  GroupDimension,
  SidebarViewOptions,
  SortMode,
} from "./sidebar-view";

export interface SidebarGroupKey {
  key: string;
  label: string;
  rank: number;
}

export interface SidebarTreeNode {
  dimension: GroupDimension;
  key: string;
  label: string;
  collapseKey: string;
  /** Every thread under this node, sorted. */
  threads: readonly PluginSidebarThread[];
  /** Worktree groups of `threads`; rendered only when there are no children. */
  groups: readonly SidebarGroup[];
  children: readonly SidebarTreeNode[] | null;
}

/**
 * Archived threads always sink to the bottom of their group. Inside that
 * split, `recent` uses the latest activity, `status` puts the threads that
 * need attention first, and `manual` follows the saved order with threads
 * that were never placed on top.
 */
export function sortThreadsBy(
  mode: SortMode,
  threads: readonly PluginSidebarThread[],
  statusByThreadId: ReadonlyMap<string, ThreadStatusBucket>,
  manualIndex: ReadonlyMap<string, number>,
): PluginSidebarThread[] {
  const status = (thread: PluginSidebarThread) =>
    statusByThreadId.get(thread.id) ?? statusForThread(thread);
  return [...threads].sort((left, right) => {
    if (left.isArchived !== right.isArchived) return left.isArchived ? 1 : -1;
    if (mode === "status") {
      const difference =
        ORGANIZATIONAL_STATUS_RANK[status(left)] -
        ORGANIZATIONAL_STATUS_RANK[status(right)];
      if (difference !== 0) return difference;
    }
    if (mode === "manual") {
      const leftOrder = manualIndex.get(left.id);
      const rightOrder = manualIndex.get(right.id);
      if (leftOrder !== undefined || rightOrder !== undefined) {
        if (leftOrder === undefined) return -1;
        if (rightOrder === undefined) return 1;
        return leftOrder - rightOrder;
      }
    }
    return right.updatedAt - left.updatedAt;
  });
}

/**
 * One group was reordered by drag. Put its new order back into the slots its
 * threads held in the full manual order, and leave every other thread alone.
 */
export function mergeManualOrder(
  allIds: readonly string[],
  groupIds: readonly string[],
): string[] {
  const moved = new Set(groupIds);
  let next = 0;
  return allIds.map((id) => (moved.has(id) ? groupIds[next++]! : id));
}

export function buildSidebarTree({
  threads,
  options,
  describe,
  sort,
  keepEmpty = [],
}: {
  threads: readonly PluginSidebarThread[];
  options: SidebarViewOptions;
  describe: (
    dimension: GroupDimension,
    thread: PluginSidebarThread,
  ) => SidebarGroupKey;
  sort: (threads: readonly PluginSidebarThread[]) => PluginSidebarThread[];
  /** Top-level groups to show even without threads, such as empty drop targets. */
  keepEmpty?: readonly SidebarGroupKey[];
}): SidebarTreeNode[] {
  const level = (
    dimension: GroupDimension,
    candidates: readonly PluginSidebarThread[],
    parentKey: string | null,
    empty: readonly SidebarGroupKey[],
    subgroup: GroupDimension | null,
  ): SidebarTreeNode[] => {
    const buckets = new Map<
      string,
      { group: SidebarGroupKey; threads: PluginSidebarThread[] }
    >();
    for (const group of empty) buckets.set(group.key, { group, threads: [] });
    for (const thread of candidates) {
      const group = describe(dimension, thread);
      const bucket = buckets.get(group.key);
      if (bucket) bucket.threads.push(thread);
      else buckets.set(group.key, { group, threads: [thread] });
    }
    return [...buckets.values()]
      .sort(
        (left, right) =>
          left.group.rank - right.group.rank ||
          left.group.label.localeCompare(right.group.label),
      )
      .map(({ group, threads: grouped }) => {
        const ownKey = `${dimension}:${group.key}`;
        const collapseKey = parentKey ? `${parentKey}>${ownKey}` : ownKey;
        const sorted = sort(grouped);
        return {
          dimension,
          key: group.key,
          label: group.label,
          collapseKey,
          threads: sorted,
          groups: subgroup ? [] : groupByEnvironment(sorted),
          children: subgroup
            ? level(subgroup, sorted, collapseKey, [], null)
            : null,
        };
      });
  };
  return level(options.group, threads, null, keepEmpty, options.subgroup);
}

export function countTreeThreads(nodes: readonly SidebarTreeNode[]) {
  return nodes.reduce((sum, node) => sum + node.threads.length, 0);
}
