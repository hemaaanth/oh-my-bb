import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";
import type { ComponentProps } from "react";

// Resolve through BB so app-wide icon overrides also apply to this plugin.
const ICON_MAP = {
  "ArrowUpRight": "ArrowUpRight",
  "Bot": "Bot",
  "Check": "Check",
  "ChevronDown": "ChevronDown",
  "ChevronUp": "ChevronUp",
  "ExternalLink": "ExternalLink",
  "MessageSquare": "MessageSquare",
  "Trash2": "Trash2",
  "UserRoundPlus": "UserRoundPlus",
  "X": "X",
} as const;

export type IconName = keyof typeof ICON_MAP;
export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];
export type IconProps = Omit<ComponentProps<typeof HostIcon>, "name"> & { name: IconName };

export function Icon({ name, ...props }: IconProps) {
  return <HostIcon {...props} name={ICON_MAP[name]} />;
}
