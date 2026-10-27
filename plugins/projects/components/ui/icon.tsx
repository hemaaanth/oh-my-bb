import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "../../lib/utils";

// Trimmed from the vendored BB icon registry to the glyphs this plugin renders.
// Every map entry is bundled into app.js and parsed in every BB window at
// startup, so add a name here only when a component uses it.
const ICON_MAP = {
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronUp: ArrowUp01Icon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

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
