import {
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "./ui/icon";
import { MachineMarker, machineStateClassName } from "./MachineMarker";
import { SidebarRow } from "./SidebarRow";
import { SubagentBadge } from "./SubagentBadge";
import { ThreadContextMenu, type ThreadMenuProps } from "./ThreadMenu";
import { AttachTaskDialog } from "./AttachTaskDialog";
import { cn } from "../lib/utils";
import { STATUS_DESIGN, STATUS_MARKER, TONE_PALETTE } from "../lib/status-colors";
import { useThreadRowActions } from "../lib/thread-row-actions";
import type { SandboxThreadStatus, SettledThreadSafety, ThreadTaskRun } from "../shared";
import { THREAD_WORKSPACE_DRAG_TYPE } from "../shared";
import {
  dropPlacementForEvent,
  hasUnseenFailure,
  sandboxProviderLabel,
  statusForThread,
  threadTitle,
  type DropPlacement,
  type ThreadPresentation,
  type ThreadStatusBucket,
} from "../lib/sidebar-model";

const NO_CHILDREN: readonly PluginSidebarThread[] = [];

// Memoized: a row re-renders only when its own props change, not when the
// sidebar re-renders for another row, a poll, or a selection change elsewhere.
export const ThreadRow = memo(function ThreadRow({
  thread,
  effectiveStatus,
  focusView = false,
  cleanupCandidate = false,
  taskRun,
  presentation,
  settledSafety,
  projectName,
  isSelected,
  snoozedUntil,
  sandboxStatus,
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
  effectiveStatus?: ThreadStatusBucket;
  focusView?: boolean;
  cleanupCandidate?: boolean;
  taskRun?: ThreadTaskRun;
  presentation?: ThreadPresentation;
  settledSafety?: SettledThreadSafety;
  projectName: string;
  isSelected: boolean;
  snoozedUntil: number | null;
  sandboxStatus?: SandboxThreadStatus;
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
  const title = threadTitle(thread);

  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

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
        !nested && !focusView && "@max-[22rem]/thread-row:hidden",
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
  const workingStatus = effectiveStatus ?? statusForThread(thread);
  const workingTone = STATUS_MARKER[workingStatus];
  const workingLabel =
    STATUS_DESIGN.find((entry) => entry.status === workingStatus)?.label ??
    workingStatus;
  const failed = thread.status === "error" || thread.queuedWork === "failed" || thread.indicator === "unread-error";
  const tone = presentation?.tone ?? "idle";
  const palette = TONE_PALETTE[tone];
  const isFactory = presentation?.isFactory ?? Boolean(taskRun);
  const stageLabel = isFactory ? (presentation?.reason ?? null) : null;
  const prominent = focusView && !nested && (presentation ? presentation.prominent : (workingStatus === "needs-input" || failed || workingStatus === "unread"));
  const attentionReason = presentation?.reason ?? (failed ? "Failed" : workingStatus === "needs-input" ? "Needs input" : "Unread");
  const ageMinutes = Math.max(0, Math.floor((Date.now() - thread.latestAttentionAt) / 60_000));
  const age = ageMinutes < 1 ? "now" : ageMinutes < 60 ? `${ageMinutes}m` : ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)}h` : `${Math.floor(ageMinutes / 1440)}d`;
  const attentionDetail = `${attentionReason} · ${age}`;
  const attentionTooltip = workingStatus === "needs-input" ? (thread.hasPendingInteraction ? thread.indicatorLabel || "This thread needs input" : "A child thread needs input") : attentionReason;
  const staleLabel = "Inactive for at least 14 days. Review or snooze; save work before archiving. BB archive removes the workspace and worktree.";
  const leadingGlyph = focusView && !nested ? (
    isFactory ? (
      <span
        data-factory-glyph=""
        data-tone={tone}
        title={stageLabel ? `Factory run · ${stageLabel}` : "Task thread"}
        className="inline-flex size-3.5 shrink-0 items-center justify-center"
      >
        <span className={cn("inline-flex size-2.5 items-center justify-center rounded-[3px] border-[1.5px]", palette.borderClass)}>
          {tone !== "idle" ? <span className={cn("size-1 rounded-full", palette.dotClass)} /> : null}
        </span>
      </span>
    ) : (
      <span
        data-chat-dot=""
        data-tone={tone}
        title={presentation?.reason ?? (failed ? "Failed" : workingLabel)}
        className="inline-flex size-3.5 shrink-0 items-center justify-center"
      >
        <span className={cn("size-1.5 rounded-full", palette.dotClass)} />
      </span>
    )
  ) : null;
  const settledBadge = settledSafety && !settledSafety.safe ? (
    <span
      data-settled-unsaved=""
      title={`${settledSafety.dirtyCount} uncommitted files, ${settledSafety.aheadCount} unpushed commits — protected from bulk archive`}
      className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
    >
      {settledSafety.dirtyCount > 0 ? `${settledSafety.dirtyCount} unsaved` : `${settledSafety.aheadCount} unpushed`}
    </span>
  ) : null;
  const stagePill = focusView && !nested && isFactory && stageLabel ? (
    <span
      data-task-stage=""
      data-tone={tone}
      className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none", palette.pillClass)}
    >
      {stageLabel}
    </span>
  ) : focusView && !nested && !isFactory && (tone === "draft" || tone === "attention" || tone === "critical") && presentation?.reason ? (
    <span data-tone={tone} className={cn("shrink-0 text-[10px] font-medium", palette.textClass)}>
      {presentation.reason === "Needs input" ? "Input" : presentation.reason}
    </span>
  ) : null;
  const focusMarker = !focusView ? null : stagePill;
  const focusStateText = focusView && !nested
    ? (isFactory && stageLabel
      ? stageLabel
      : (tone !== "idle" ? (presentation?.reason ?? attentionReason) : null))
    : null;
  const focusHasMetaLine = focusView && !nested && Boolean(
    focusStateText || childThreads.length > 0 || settledBadge,
  );
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
            onDragEnd();
          }}
        >
          <ThreadRowSurface
            threadId={thread.id}
            anchorProps={{
              "data-sidebar-thread-shortcut-target": nested ? undefined : "",
              "data-sidebar-thread-id": nested ? undefined : thread.id,
              href: thread.href,
              "aria-label": focusView ? `${title}, ${failed ? "failed" : workingLabel}${cleanupCandidate ? `. ${staleLabel}` : ""}` : title,
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
            prominent={prominent || focusHasMetaLine}
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
          ) : focusHasMetaLine ? (
            <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                {leadingGlyph}
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
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">
                  {age}
                </span>
              </span>
              <span className="flex min-w-0 items-center justify-between gap-2 ps-5">
                <span className="flex min-w-0 items-center gap-1 text-[10px] leading-tight">
                  {focusStateText ? (
                    <span
                      data-attention-detail=""
                      data-task-stage={isFactory ? "" : undefined}
                      data-tone={tone}
                      title={attentionTooltip}
                      className={cn("shrink-0 font-medium", palette.textClass)}
                    >
                      {focusStateText}
                    </span>
                  ) : null}
                  {focusStateText && showProjectName && projectName ? (
                    <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">·</span>
                  ) : null}
                  {showProjectName && projectName ? (
                    <span
                      data-project-metadata=""
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {projectName}
                    </span>
                  ) : null}
                  {settledBadge}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  {subagentBadge}
                  {machineMetadata}
                  {thread.indicatorLabel ? (
                    <span className="sr-only">{thread.indicatorLabel}</span>
                  ) : null}
                </span>
              </span>
            </span>
          ) : (
          <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-1.5">
            {leadingGlyph}
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
            {settledBadge}
            {focusMarker}
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
