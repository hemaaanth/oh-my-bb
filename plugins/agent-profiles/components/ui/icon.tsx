import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpRight01Icon,
  BotIcon,
  BubbleChatIcon,
  Cancel01Icon,
  Delete02Icon,
  LinkSquare02Icon,
  Tick02Icon,
  UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "../../lib/utils";

// Only the glyphs this plugin renders through <Icon>; other surfaces use the
// host's experimental_Icon. Add a name here (tsc flags unknown names) before
// using it, so the app bundle does not carry the whole shared icon map.
const ICON_MAP = {
  ArrowUpRight: ArrowUpRight01Icon,
  Bot: BotIcon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronUp: ArrowUp01Icon,
  ExternalLink: LinkSquare02Icon,
  MessageSquare: BubbleChatIcon,
  Trash2: Delete02Icon,
  UserRoundPlus: UserAdd01Icon,
  X: Cancel01Icon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];

export interface IconProps {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  return (
    <HugeiconsIcon
      icon={ICON_MAP[name]}
      className={cn(className)}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
    />
  );
}
