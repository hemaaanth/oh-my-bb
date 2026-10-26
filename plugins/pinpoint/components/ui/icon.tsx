import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  BotIcon,
  CheckmarkCircle02Icon,
  Camera01Icon,
  CameraOff01Icon,
  Cancel01Icon,
  ChatFeedback01Icon,
  Delete02Icon,
  PinIcon,
  PencilEdit02Icon,
  PinOffIcon,
  Refresh01Icon,
  Settings01Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffIcon,
  UserGroupIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";

import { cn } from "../../lib/utils";

// Only the glyphs Pinpoint renders. This started as a copy of BB's shared
// icon set (~150 glyphs), which put ~100 KB of unused artwork in the app
// bundle; add a name here when the UI needs a new one.
const ICON_MAP = {
  ArrowRight: ArrowRight02Icon,
  Camera: Camera01Icon,
  CameraOff: CameraOff01Icon,
  ChatFeedback: ChatFeedback01Icon,
  Agent: BotIcon,
  CheckCircle: CheckmarkCircle02Icon,
  Check: Tick02Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  Eye: ViewIcon,
  EyeOff: ViewOffIcon,
  Guests: UserGroupIcon,
  Edit: PencilEdit02Icon,
  Pin: PinIcon,
  PinOff: PinOffIcon,
  RotateCcw: Refresh01Icon,
  Settings: Settings01Icon,
  Trash2: Delete02Icon,
  User: UserIcon,
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
