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

const MAX_DOTS = 3;

// Ported from yusuf8834/bb-sidebar's ChildThreadBadge: a right-side pill with
// a few markers, the overflow, and a chevron. Each marker matches that
// sub-agent's row: its shape is the machine, its colour the status. The
// neediest sub-agents come first, and the pill takes the tone of the neediest
// one so a collapsed parent still reports it.
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
  const shown = [...threads]
    .sort(
      (left, right) =>
        STATUS_NEEDINESS[statuses.get(right.id)!] -
        STATUS_NEEDINESS[statuses.get(left.id)!],
    )
    .slice(0, MAX_DOTS);
  const overflow = threads.length - shown.length;
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
        "pointer-events-auto relative z-10 flex h-4 shrink-0 items-center gap-1 rounded-full px-1 text-[10px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring",
        design?.className,
      )}
      style={design?.style}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {shown.map((thread) => {
          const tone = STATUS_MARKER[statuses.get(thread.id)!];
          return (
            <MachineShape
              key={thread.id}
              machine={
                sandboxProviderLabel(thread, sandboxStatuses?.get(thread.id))
                  ? "sandbox"
                  : "local"
              }
              className={cn("size-1.5", tone.className)}
              style={tone.style}
            />
          );
        })}
      </span>
      {overflow > 0 ? (
        <span className="tabular-nums" aria-hidden="true">+{overflow}</span>
      ) : null}
      <Icon
        name="ChevronDown"
        className={cn("size-2.5", !collapsed && "rotate-180")}
        aria-hidden="true"
      />
    </button>
  );
}
