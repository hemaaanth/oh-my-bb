import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";
import type { ComponentProps } from "react";

// Resolve through BB so app-wide icon overrides also apply to this plugin.
const ICON_MAP = {
  "AlertCircle": "AlertCircle",
  "AlertTriangle": "AlertTriangle",
  "Archive": "Archive",
  "ArrowUp": "ArrowUp",
  "Calendar": "Calendar",
  "Check": "Check",
  "ChevronDown": "ChevronDown",
  "ChevronLeft": "ChevronLeft",
  "ChevronRight": "ChevronRight",
  "ChevronUp": "ChevronUp",
  "Circle": "Circle",
  "CircleCheck": "CircleCheck",
  "CircleDashed": "task-workspaces/circle-dashed",
  "CircleQuestion": "CircleQuestion",
  "CircleX": "CircleX",
  "Clock": "Clock",
  "ComputerTerminal01": "ComputerTerminal01",
  "DragDropVertical": "DragDropVertical",
  "Edit": "Edit",
  "Eye": "Eye",
  "EyeOff": "EyeOff",
  "ExternalLink": "ExternalLink",
  "Folder": "Folder",
  "GitBranch": "GitBranch",
  "GitMerge": "GitMerge",
  "GridView": "GridView",
  "Laptop": "Laptop",
  "Layers": "Layers",
  "ListView": "ListView",
  "ListTodo": "ListTodo",
  "Loading": "Loading",
  "Mail": "Mail",
  "MailOpen": "MailOpen",
  "MessageSquarePlus": "MessageSquarePlus",
  "MessageSquare": "MessageSquare",
  "MoreHorizontal": "MoreHorizontal",
  "Palette": "Palette",
  "Paperclip": "Paperclip",
  "Plus": "Plus",
  "Printer": "task-workspaces/printer",
  "Repeat": "Repeat",
  "RotateCcw": "RotateCcw",
  "Search": "Search",
  "Settings": "Settings",
  "SlidersHorizontal": "SlidersHorizontal",
  "TaskAdd": "task-workspaces/task-add",
  "Trash2": "Trash2",
  "Unlink": "task-workspaces/unlink",
  "UserRound": "UserRound",
  "X": "X",
} as const;

export type IconName = keyof typeof ICON_MAP;
export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];
export type IconProps = Omit<ComponentProps<typeof HostIcon>, "name"> & { name: IconName };

export function Icon({ name, ...props }: IconProps) {
  return <HostIcon {...props} name={ICON_MAP[name]} />;
}
