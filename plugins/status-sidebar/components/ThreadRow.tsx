import {
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type DragEvent,
} from "react";
import {
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { MachineMarker, machineStateClassName } from "./MachineMarker";
import { SidebarRow } from "./SidebarRow";
import { SubagentBadge } from "./SubagentBadge";
import { ThreadContextMenu, type ThreadMenuProps } from "./ThreadMenu";
import { AttachTaskDialog } from "./AttachTaskDialog";
import { cn } from "../lib/utils";
import { STATUS_DESIGN, STATUS_MARKER } from "../lib/status-colors";
import { useThreadRowActions } from "../lib/thread-row-actions";
import type { SandboxThreadStatus } from "../shared";
import { THREAD_WORKSPACE_DRAG_TYPE } from "../shared";
import {
  dropPlacementForEvent,
  sandboxProviderLabel,
  statusForThread,
  threadTitle,
  type DropPlacement,
} from "../lib/sidebar-model";

const NO_CHILDREN: readonly PluginSidebarThread[] = [];

// Memoized: a row re-renders only when its own props change, not when the
// sidebar re-renders for another row, a poll, or a selection change elsewhere.
export const ThreadRow = memo(function ThreadRow({
  thread,
  projectName,
  isSelected,
  snoozedUntil,
  sandboxStatus,
  isGrouped,
  isDragging,
  dropPlacement,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  nested = false,
  showProjectName = true,
  reorderEnabled = true,
  childThreads = NO_CHILDREN,
  childrenCollapsed = false,
  childSandboxStatuses,
  workspaceMovable = false,
}: {
  thread: PluginSidebarThread;
  projectName: string;
  isSelected: boolean;
  snoozedUntil: number | null;
  sandboxStatus?: SandboxThreadStatus;
  isGrouped: boolean;
  isDragging: boolean;
  dropPlacement: DropPlacement | null;
  onDragStart: (threadId: string) => void;
  onDragOver: (threadId: string, placement: DropPlacement) => void;
  onDrop: (threadId: string, placement: DropPlacement) => void;
  onDragEnd: () => void;
  nested?: boolean;
  showProjectName?: boolean;
  reorderEnabled?: boolean;
  childThreads?: readonly PluginSidebarThread[];
  childrenCollapsed?: boolean;
  childSandboxStatuses?: ReadonlyMap<string, SandboxThreadStatus>;
  workspaceMovable?: boolean;
}) {
  const actions = useThreadRowActions();
  const [editing, setEditing] = useState(false);
  const [attachTaskOpen, setAttachTaskOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragPreviewRef = useRef<HTMLElement | null>(null);
  const title = threadTitle(thread);

  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

  useEffect(
    () => () => {
      dragPreviewRef.current?.remove();
    },
    [],
  );

  const finishRename = async () => {
    const next = inputRef.current?.value.trim() ?? "";
    setEditing(false);
    if (next && next !== title) await actions.rename(thread.id, next);
  };

  const sandboxProvider = sandboxProviderLabel(thread, sandboxStatus);

  const menuProps: ThreadMenuProps = {
    thread,
    snoozedUntil,
    editing,
    dragging: isDragging,
    onRename: () => setEditing(true),
    onSetSnoozed: (untilAt) => actions.setSnoozed(thread.id, untilAt),
    onAttachTask: () => setAttachTaskOpen(true),
  };

  const projectMetadata = showProjectName ? (
    <span
      data-project-metadata=""
      className={cn(
        "flex max-w-24 shrink-0 items-center gap-1 text-[10px] text-muted-foreground",
        // A sub-agent only names its project when it left the parent's, so
        // that label stays even on a narrow sidebar.
        !nested && "@max-[22rem]/thread-row:hidden",
      )}
    >
      <span className="min-w-0 truncate">{projectName}</span>
    </span>
  ) : null;
  const subagentBadge =
    childThreads.length > 0 ? (
      <SubagentBadge
        threads={childThreads}
        title={title}
        collapsed={childrenCollapsed}
        sandboxStatuses={childSandboxStatuses}
        onToggle={() => actions.toggleChildren(thread.id)}
      />
    ) : null;
  // Square for this machine, circle for a sandbox. A top-level row colours it
  // by machine state; a sub-agent colours it by working state, like the dots
  // in its parent's pill.
  const machine = sandboxProvider ? "sandbox" : "local";
  const machineLabel =
    sandboxStatus?.label ??
    (sandboxProvider ? `${sandboxProvider} sandbox status unavailable` : "Local machine");
  const workingStatus = statusForThread(thread);
  const workingTone = STATUS_MARKER[workingStatus];
  const workingLabel =
    STATUS_DESIGN.find((entry) => entry.status === workingStatus)?.label ??
    workingStatus;
  const machineMetadata = (
    <span data-execution-metadata="" className="inline-flex shrink-0 items-center">
      {nested ? (
        <MachineMarker
          machine={machine}
          label={`${machineLabel}, ${workingLabel}`}
          className={workingTone.className}
          style={workingTone.style}
        />
      ) : (
        <MachineMarker
          machine={machine}
          label={machineLabel}
          className={machineStateClassName(machine, sandboxStatus?.status)}
        />
      )}
    </span>
  );

  const createGroupDragPreview = (event: DragEvent<HTMLElement>) => {
    if (!isGrouped) return;
    const group = event.currentTarget.closest<HTMLElement>(
      "[data-sidebar-worktree-group]",
    );
    if (!group) return;
    dragPreviewRef.current?.remove();
    const preview = group.cloneNode(true) as HTMLElement;
    preview.setAttribute("aria-hidden", "true");
    preview.dataset.sidebarGroupDragPreview = "";
    preview.style.position = "fixed";
    preview.style.left = "0";
    preview.style.top = "0";
    preview.style.width = `${group.getBoundingClientRect().width}px`;
    preview.style.pointerEvents = "none";
    preview.style.opacity = "0.96";
    preview.style.transform = "translate(-120%, -120%)";
    preview.querySelectorAll("button").forEach((button) => button.remove());
    document.body.append(preview);
    dragPreviewRef.current = preview;
    event.dataTransfer.setDragImage(preview, 24, 24);
  };

  return (
    <>
      <ThreadContextMenu {...menuProps}>
        <li
          className="relative list-none"
          data-reorder-thread-id={nested ? undefined : thread.id}
          // A thread with no project can still be dragged onto a workspace
          // header when the current sort does not allow reordering.
          draggable={!editing && !nested && (reorderEnabled || workspaceMovable)}
          onDragStart={(event) => {
            if (!reorderEnabled && !workspaceMovable) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", thread.id);
            if (workspaceMovable) {
              event.dataTransfer.setData(THREAD_WORKSPACE_DRAG_TYPE, thread.id);
            }
            createGroupDragPreview(event);
            if (reorderEnabled) onDragStart(thread.id);
          }}
          onDragOver={(event) => {
            if (!reorderEnabled) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            onDragOver(thread.id, dropPlacementForEvent(event));
          }}
          onDrop={(event) => {
            if (!reorderEnabled) return;
            event.preventDefault();
            onDrop(thread.id, dropPlacementForEvent(event));
          }}
          onDragEnd={() => {
            dragPreviewRef.current?.remove();
            dragPreviewRef.current = null;
            onDragEnd();
          }}
        >
          <ThreadRowSurface
            threadId={thread.id}
            anchorProps={{
              "data-sidebar-thread-shortcut-target": nested ? undefined : "",
              "data-sidebar-thread-id": nested ? undefined : thread.id,
              href: thread.href,
              "aria-label": title,
              "aria-current": isSelected ? "page" : undefined,
              onClick: (event) => {
                if (event.button !== 0 || event.shiftKey || event.altKey) return;
                event.preventDefault();
                if (editing) return;
                actions.open(thread.id, event.metaKey || event.ctrlKey);
              },
              onDoubleClick: (event) => {
                event.preventDefault();
                if (!thread.isArchived) setEditing(true);
              },
            }}
            isSelected={isSelected}
            nested={nested}
            reorderEnabled={reorderEnabled}
            isDragging={isDragging}
            dropPlacement={dropPlacement}
          >

          {nested ? (
            <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-1.5">
              {editing ? (
                <input
                  ref={inputRef}
                  defaultValue={title}
                  aria-label="Thread name"
                  onClick={(event) => event.stopPropagation()}
                  onBlur={() => void finishRename()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void finishRename();
                    if (event.key === "Escape") setEditing(false);
                  }}
                  className="pointer-events-auto h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              ) : (
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-xs text-sidebar-foreground",
                    thread.isUnread && "font-semibold",
                  )}
                  title={title}
                >
                  {title}
                </span>
              )}
              {projectMetadata}
              {subagentBadge}
              {machineMetadata}
              {thread.indicatorLabel ? (
                <span className="sr-only">{thread.indicatorLabel}</span>
              ) : null}
            </span>
          ) : (
          <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-1.5">
            {editing ? (
              <input
                ref={inputRef}
                defaultValue={title}
                aria-label="Thread name"
                onClick={(event) => event.stopPropagation()}
                onBlur={() => void finishRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void finishRename();
                  if (event.key === "Escape") setEditing(false);
                }}
                className="pointer-events-auto h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs text-sidebar-foreground",
                  thread.isUnread && "font-semibold",
                )}
                title={title}
              >
                {title}
              </span>
            )}
            {projectMetadata}
            {subagentBadge}
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
              {machineMetadata}
              {thread.indicatorLabel ? (
                <span className="sr-only">{thread.indicatorLabel}</span>
              ) : null}
            </span>
          </span>
          )}

          </ThreadRowSurface>
        </li>
      </ThreadContextMenu>
      {attachTaskOpen ? (
        <AttachTaskDialog
          thread={thread}
          open
          onOpenChange={setAttachTaskOpen}
        />
      ) : null}
    </>
  );
});

// The host's split hook re-renders on every thread and pane change. Keeping it
// in this small wrapper means those updates repaint only the row surface; the
// row's contents are the same elements and React skips them.
function ThreadRowSurface({
  threadId,
  anchorProps,
  ...rowProps
}: { threadId: string } & Omit<ComponentProps<typeof SidebarRow>, "hasOpenPane">) {
  const { splitProps, layout } = useSidebarThreadSplit(threadId);
  return (
    <SidebarRow
      {...rowProps}
      anchorProps={{ ...splitProps, ...anchorProps }}
      hasOpenPane={layout !== null}
    />
  );
}
