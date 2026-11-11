import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";
import type { ComponentProps } from "react";

// Resolve through BB so app-wide icon overrides also apply to this plugin.
const ICON_MAP = {
  "Archive": "Archive",
  "ArchiveRestore": "ArchiveRestore",
  "AudioLines": "status-sidebar/audio-lines",
  "BubbleChatQuestion": "status-sidebar/bubble-chat-question",
  "CalendarSync": "status-sidebar/calendar-sync",
  "ChatFeedback": "status-sidebar/chat-feedback",
  "Check": "Check",
  "ChevronDown": "ChevronDown",
  "ChevronRight": "ChevronRight",
  "Circle": "Circle",
  "Bot": "Bot",
  "CircleCheck": "CircleCheck",
  "CircleDashed": "status-sidebar/circle-dashed",
  "CircleQuestion": "CircleQuestion",
  "Clock": "Clock",
  "Copy": "Copy",
  "Github": "Github",
  "Edit": "Edit",
  "Eye": "Eye",
  "EyeOff": "EyeOff",
  "FileX2": "status-sidebar/file-x2",
  "Folder": "Folder",
  "Layers": "Layers",
  "SectionAdd": "SectionAdd",
  "ListTodo": "ListTodo",
  "Loading": "Loading",
  "Mail": "Mail",
  "MailOpen": "MailOpen",
  "MessageSquarePlus": "MessageSquarePlus",
  "MessageSquare": "MessageSquare",
  "Mic": "Mic",
  "MoreHorizontal": "MoreHorizontal",
  "Palette": "Palette",
  "Paperclip": "Paperclip",
  "Pin": "Pin",
  "PinOff": "PinOff",
  "Plus": "Plus",
  "Puzzle": "Puzzle",
  "Rows3": "status-sidebar/rows3",
  "Search": "Search",
  "Idea": "status-sidebar/idea",
  "LightbulbOff": "status-sidebar/lightbulb-off",
  "Trash2": "Trash2",
  "UserRound": "UserRound",
  "UserRoundPlus": "UserRoundPlus",
  "X": "X",
} as const;

export type IconName = keyof typeof ICON_MAP;
export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];
export type IconProps = Omit<ComponentProps<typeof HostIcon>, "name"> & { name: IconName };

export function Icon({ name, ...props }: IconProps) {
  return <HostIcon {...props} name={ICON_MAP[name]} />;
}
