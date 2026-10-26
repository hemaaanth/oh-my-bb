import type {
  AnchorHTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "../lib/utils";
import type { DropPlacement } from "../lib/sidebar-model";

type SidebarRowAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  "data-sidebar-thread-id"?: string;
  "data-sidebar-thread-shortcut-target"?: string;
};

export function SidebarRow({
  children,
  anchorProps,
  isSelected = false,
  hasOpenPane = false,
  nested = false,
  reorderEnabled = false,
  isDragging = false,
  dropPlacement = null,
}: {
  children: ReactNode;
  anchorProps: SidebarRowAnchorProps;
  isSelected?: boolean;
  hasOpenPane?: boolean;
  nested?: boolean;
  reorderEnabled?: boolean;
  isDragging?: boolean;
  dropPlacement?: DropPlacement | null;
}) {
  const { className: anchorClassName, ...linkProps } = anchorProps;
  return (
    <div
      className={cn(
        "@container/thread-row group/row relative flex h-8 items-center gap-1.5 rounded-md pe-1.5",
        nested
          ? "cursor-pointer ps-7 active:cursor-pointer"
          : "cursor-grab ps-1.5 active:cursor-grabbing",
        !reorderEnabled && "cursor-default active:cursor-default",
        isSelected
          ? "bg-sidebar-accent"
          : hasOpenPane
            ? "bg-sidebar-accent/35 hover:bg-sidebar-accent/60"
            : "hover:bg-sidebar-accent/60",
        isDragging && "opacity-45",
        dropPlacement === "before" &&
          "before:pointer-events-none before:absolute before:inset-x-1 before:top-0 before:z-20 before:h-0.5 before:rounded-full before:bg-primary",
        dropPlacement === "after" &&
          "after:pointer-events-none after:absolute after:inset-x-1 after:bottom-0 after:z-20 after:h-0.5 after:rounded-full after:bg-primary",
      )}
    >
      <a
        {...linkProps}
        className={cn(
          "absolute inset-0 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring",
          anchorClassName,
        )}
      />
      {children}
    </div>
  );
}
