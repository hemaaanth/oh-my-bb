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
  isLater: boolean;
  editing: boolean;
  dragging: boolean;
  onRename: () => void;
  onSetLater: (later: boolean) => void;
  onAttachTask: () => void;
};

export function ThreadContextMenu({ children, ...props }: ThreadMenuProps & { children: ReactElement }) {
  const { tasksEnabled } = useThreadRowActions();
  const renameSelected = useRef(false);
  const inline: PluginThreadActionsInlineItem[] = [];
  if (!props.thread.isArchived) inline.push({
    key: "status-sidebar/later",
    group: groups.organize,
    action: {
      label: props.isLater ? "Move to idle" : "Move to later",
      icon: "Clock",
      run: () => props.onSetLater(!props.isLater),
    },
  });
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
