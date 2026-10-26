export const LATER_CHANNEL = "later-threads";
export const THREAD_ORDER_CHANNEL = "thread-order";
export const WORKSPACES_CHANNEL = "workspaces";
export const SHORTCUT_SLOTS_CHANNEL = "shortcut-slots";
export const CHANNELS_CHANGED_CHANNEL = "channels-changed";
export const AGENTS_CHANGED_CHANNEL = "agents-changed";
export const INTEGRATIONS_CHANGED_CHANNEL = "integrations-changed";
export const PROJECT_WORKSPACE_DRAG_TYPE =
  "application/x-bb-status-sidebar-project";
export const THREAD_WORKSPACE_DRAG_TYPE =
  "application/x-bb-status-sidebar-thread";
export const WORKSPACE_REORDER_DRAG_TYPE =
  "application/x-bb-status-sidebar-workspace";
export const DEFAULT_WORKSPACE_ID = "ws_personal";
export const workspaceColorValues = [
  "amber",
  "blue",
  "violet",
  "green",
  "rose",
  "gray",
] as const;
export type WorkspaceColor = (typeof workspaceColorValues)[number];

export interface SidebarWorkspace {
  id: string;
  name: string;
  color: WorkspaceColor;
  isDefault: boolean;
  projectIds: readonly string[];
  threadIds: readonly string[];
}

export const shortcutSlotStatusValues = [
  "needs-input",
  "active",
  "drafting",
  "unread",
  "idle",
  "archived",
] as const;
export type ShortcutSlotStatus = (typeof shortcutSlotStatusValues)[number];

export interface ShortcutSlot {
  threadId: string;
  title: string;
  status: ShortcutSlotStatus;
}

export interface AgentSidebarSnapshot {
  agents: { id: string; name: string; avatar: string; dmThreadId: string | null }[];
  excludedThreadIds: string[];
}

export interface ChannelSummary {
  id: string;
  name: string;
  pinned: boolean;
  unread: boolean;
  active: boolean;
  memberCount: number;
  updatedAt: number;
}

/** The realtime payload that carries fresh channel rows to every window. */
export interface ChannelsChangedSignal {
  channels: readonly ChannelSummary[] | null;
}

/**
 * The lifecycle values this sidebar knows how to paint. The Sandboxes plugin
 * owns the list and may add to it, so a status arriving from it is typed as a
 * plain string and unknown values fall back to neutral rendering rather than
 * voiding the whole response.
 */
export const sandboxLifecycleStatusValues = [
  "live",
  "idle",
  "stopped",
  "unreachable",
  "unrecoverable",
] as const;
export type SandboxLifecycleStatus =
  (typeof sandboxLifecycleStatusValues)[number];

/**
 * Native machine providers register under the id `sandbox-<vendor>`. This is
 * the vendor set the sidebar paints; a host whose vendor is not one of these
 * is treated as a non-sandbox host and produces no status row (matching how
 * the Sandboxes plugin resolved these before the sidebar sourced hosts itself).
 */
export const NATIVE_SANDBOX_PROVIDER_PREFIX = "sandbox-";
export const sandboxProviderValues = [
  "daytona",
  "modal",
  "e2b",
  "box",
  "freestyle",
  "nirvana",
] as const;
export type SandboxProvider = (typeof sandboxProviderValues)[number];
/** Vendor names as they appear in sandbox host names, e.g. "Daytona · bb". */
export const SANDBOX_PROVIDER_LABELS: Record<SandboxProvider, string> = {
  daytona: "Daytona",
  modal: "Modal",
  e2b: "E2B",
  box: "Box",
  freestyle: "Freestyle",
  nirvana: "Nirvana",
};

export interface SandboxThreadStatus {
  threadId: string;
  sandboxId: string;
  provider: string;
  status: SandboxLifecycleStatus | (string & {});
  label: string;
}
