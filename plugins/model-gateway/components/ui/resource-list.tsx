import { Icon } from "./icon";

// ResourceRowDetailChevron only, copied verbatim from shared-ui
// `components/ui/resource/row.tsx` (re-exported by `resource-list.tsx`).
export function ResourceRowDetailChevron() {
  return (
    <Icon
      name="ChevronRight"
      className="size-3.5 text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      aria-hidden
    />
  );
}
