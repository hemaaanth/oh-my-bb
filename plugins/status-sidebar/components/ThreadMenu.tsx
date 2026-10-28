import { useRef, type ReactElement } from "react";
import {
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_THREAD_ACTION_GROUPS as groups,
  type PluginSidebarThread,
  type PluginThreadActionsInlineItem,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { useThreadRowActions } from "../lib/thread-row-actions";

export type ThreadMenuProps = {
  thread: PluginSidebarThread;
  snoozedUntil: number | null;
  editing: boolean;
  dragging: boolean;
  onRename: () => void;
  onSetSnoozed: (untilAt: number | null) => void;
  onAttachTask: () => void;
};

export function ThreadContextMenu({ children, ...props }: ThreadMenuProps & { children: ReactElement }) {
  const { tasksEnabled } = useThreadRowActions();
  const renameSelected = useRef(false);
  const inline: PluginThreadActionsInlineItem[] = [];
  if (!props.thread.isArchived) {
    const now = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
    if (tomorrow.getTime() <= now.getTime()) tomorrow.setDate(tomorrow.getDate() + 1);
    const snoozeTimes = {
      hour: now.getTime() + 60 * 60_000,
      tomorrow: tomorrow.getTime(),
      week: now.getTime() + 7 * 24 * 60 * 60_000,
    };
    inline.push({
      key: "status-sidebar/snooze", group: groups.organize,
      action: {
        label: "Snooze", icon: "Clock",
        choices: { items: [
          { id: "hour", label: "For 1 hour" },
          { id: "tomorrow", label: "Until tomorrow" },
          { id: "week", label: "For 1 week" },
        ] },
        run: ({ value }) => {
          if (value && Object.hasOwn(snoozeTimes, value)) props.onSetSnoozed(snoozeTimes[value as keyof typeof snoozeTimes]);
        },
      },
    });
    if (props.snoozedUntil) inline.push({
      key: "status-sidebar/wake", group: groups.organize,
      action: { label: "Wake now", icon: "Clock", run: () => props.onSetSnoozed(null) },
    });
  }
  if (tasksEnabled) inline.push({
    key: "status-sidebar/attach-task",
    group: groups.organize,
    action: { label: "Attach to task", icon: "Paperclip", run: props.onAttachTask },
  });
  return <ThreadActionsContextMenu
    thread={{ ...props.thread, environment: props.thread.environment?.id ? { id: props.thread.environment.id, path: props.thread.environment.path } : null }}
    disabled={props.editing}
    dragging={props.dragging}
    inline={inline}
    requestRename={() => { renameSelected.current = true; }}
    onCloseAutoFocus={(event) => {
      if (!renameSelected.current) return;
      renameSelected.current = false;
      event.preventDefault();
      window.setTimeout(props.onRename, 0);
    }}
  >{children}</ThreadActionsContextMenu>;
}

export function menuItemClass(destructive = false) {
  return cn(
    "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none data-[highlighted]:bg-state-hover data-[highlighted]:text-foreground",
    destructive && "text-destructive-text data-[highlighted]:bg-destructive/15 data-[highlighted]:text-destructive-text",
  );
}
