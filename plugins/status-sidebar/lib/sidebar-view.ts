export type GroupDimension = "status" | "workspace" | "project";
// Status is a property of one thread, not a container, so it never subgroups.
export type SubgroupDimension = Exclude<GroupDimension, "status">;
export type SortMode = "recent" | "status" | "manual";

export interface SidebarViewOptions {
  sort: SortMode;
  group: GroupDimension;
  subgroup: SubgroupDimension | null;
  archivedDays: 7 | 30;
  recentHours: 1 | 3 | 6 | 12 | 24;
}

export const DEFAULT_VIEW_OPTIONS: SidebarViewOptions = {
  sort: "recent",
  group: "status",
  subgroup: null,
  archivedDays: 7,
  recentHours: 3,
};

export const GROUP_LABELS: Record<GroupDimension, string> = {
  status: "Status",
  workspace: "Workspace",
  project: "Project",
};

export const SORT_LABELS: Record<SortMode, string> = {
  recent: "Recent activity",
  status: "Status",
  manual: "Manual",
};

export const SIDEBAR_VIEW_STORAGE_KEY = "status-sidebar:view:v3";

const GROUPS = Object.keys(GROUP_LABELS) as GroupDimension[];
const SORTS = Object.keys(SORT_LABELS) as SortMode[];
export const RECENT_HOURS = [1, 3, 6, 12, 24] as const;

export function subgroupChoices(group: GroupDimension): SubgroupDimension[] {
  return (["workspace", "project"] as const).filter(
    (dimension) => dimension !== group,
  );
}

/**
 * Changing the group keeps the subgroup when it still fits. When the new
 * group takes the subgroup's dimension, the two swap, so Workspace › Project
 * becomes Project › Workspace.
 */
export function withGroup(
  options: SidebarViewOptions,
  group: GroupDimension,
): SidebarViewOptions {
  if (options.subgroup !== group) return { ...options, group };
  return {
    ...options,
    group,
    subgroup: options.group === "status" ? null : options.group,
  };
}

export function readViewOptions(): SidebarViewOptions {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) ?? "null",
    );
    if (!parsed || typeof parsed !== "object") return DEFAULT_VIEW_OPTIONS;
    const { sort, group, subgroup, archivedDays, recentHours } = parsed as Record<string, unknown>;
    const nextGroup = GROUPS.includes(group as GroupDimension)
      ? (group as GroupDimension)
      : DEFAULT_VIEW_OPTIONS.group;
    return {
      archivedDays: archivedDays === 30 ? 30 : 7,
      recentHours: RECENT_HOURS.includes(recentHours as 1 | 3 | 6 | 12 | 24)
        ? (recentHours as 1 | 3 | 6 | 12 | 24) : 3,
      sort: SORTS.includes(sort as SortMode)
        ? (sort as SortMode)
        : DEFAULT_VIEW_OPTIONS.sort,
      group: nextGroup,
      subgroup: subgroupChoices(nextGroup).includes(subgroup as SubgroupDimension)
        ? (subgroup as SubgroupDimension)
        : null,
    };
  } catch {
    return DEFAULT_VIEW_OPTIONS;
  }
}

export function persistViewOptions(options: SidebarViewOptions) {
  try {
    window.localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify(options),
    );
  } catch {
    // A display preference must never prevent the sidebar from rendering.
  }
}
