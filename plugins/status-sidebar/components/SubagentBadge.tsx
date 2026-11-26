import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./ui/icon";
import { cn } from "../lib/utils";
import {
  mostNeedyStatus,
  sandboxProviderLabel,
  STATUS_NEEDINESS,
  statusForThread,
} from "../lib/sidebar-model";
import { STATUS_DESIGN, STATUS_MARKER } from "../lib/status-colors";
import type { SandboxThreadStatus } from "../shared";
import { MachineShape } from "./MachineMarker";

// Compact, weight-matched inline trigger for attached sub-agents: one status
// marker for the neediest child, total count, and a subtle chevron. Sits at
// the exact same 10px visual weight as repo/age metadata instead of a heavy pill.
export function SubagentBadge({
  threads,
  title,
  collapsed,
  onToggle,
  sandboxStatuses,
}: {
  threads: readonly PluginSidebarThread[];
  sandboxStatuses?: ReadonlyMap<string, SandboxThreadStatus>;
  title: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const statuses = new Map(
    threads.map((thread) => [thread.id, statusForThread(thread)]),
  );
  const status = mostNeedyStatus([...statuses.values()]);
  const neediest = [...threads].sort(
    (left, right) =>
      STATUS_NEEDINESS[statuses.get(right.id)!] -
      STATUS_NEEDINESS[statuses.get(left.id)!],
  )[0];
  const tone = STATUS_MARKER[status];
  const design = STATUS_DESIGN.find((entry) => entry.status === status);
  const count = threads.length;
  const noun = count === 1 ? "sub-agent" : "sub-agents";
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Expand" : "Collapse"} sub-agents for ${title}`}
      title={`${count} ${noun}${status === "idle" ? "" : `, ${design?.label}`}`}
      data-subagent-status={status}
      className={cn(
        "pointer-events-auto relative z-10 inline-flex h-4 shrink-0 items-center gap-1 rounded px-1 text-[10px] font-medium leading-none text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/80 hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring",
        !collapsed && "bg-sidebar-accent/70 text-sidebar-foreground",
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      {neediest ? (
        <MachineShape
          machine={
            sandboxProviderLabel(neediest, sandboxStatuses?.get(neediest.id))
              ? "sandbox"
              : "local"
          }
          className={cn("size-1.5", tone.className)}
          style={tone.style}
        />
      ) : null}
      <span className="tabular-nums" aria-hidden="true">{count}</span>
      <Icon
        name="ChevronDown"
        className={cn(
          "size-2.5 text-muted-foreground/80 transition-transform",
          collapsed && "-rotate-90",
        )}
        aria-hidden="true"
      />
    </button>
  );
}
