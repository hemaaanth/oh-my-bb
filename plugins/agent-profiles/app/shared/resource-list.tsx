// Vendored collection primitives from BB shared-ui's resource/{toolbar,row}.
// Keep the native row, input, spacing, and theme classes; omit unused actions.
import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { EmptyStatePanel } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";

export function ResourceToolbar({
  value,
  onChange,
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  controls?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search agents"
          aria-label="Search agents"
          className="h-8 pl-8"
        />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{controls}</div>
    </div>
  );
}

export function ResourceListPanel({ children }: { children: ReactNode }) {
  return (
    <div data-resource-list-panel className="overflow-hidden rounded-lg border border-border bg-card px-4 py-1">
      <div className="cursor-default divide-y divide-border">{children}</div>
    </div>
  );
}
export function ResourceListState({
  state,
  message,
  action,
  loadingRows = 4,
}: {
  state: "loading" | "empty" | "error";
  message: string;
  action?: ReactNode;
  loadingRows?: number;
}) {
  if (state === "loading") {
    return (
      <ResourceListPanel>
        <span role="status" className="sr-only">{message}</span>
        <div aria-hidden>
          {Array.from({ length: loadingRows }, (_, index) => (
            <div
              key={index}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-3 py-3"
            >
              <span className="size-6 animate-pulse rounded-sm bg-muted" />
              <span className="space-y-1.5">
                <span className="block h-3.5 w-36 animate-pulse rounded-sm bg-muted" />
                <span className="block h-3 w-56 max-w-full animate-pulse rounded-sm bg-muted" />
              </span>
            </div>
          ))}
        </div>
      </ResourceListPanel>
    );
  }
  return (
    <EmptyStatePanel role={state === "error" ? "alert" : "status"} className="py-6">
      <div className="flex flex-col items-center gap-2">
        <span>{message}</span>
        {action}
      </div>
    </EmptyStatePanel>
  );
}

export function ResourceRow({
  leading,
  title,
  titleMeta,
  description,
  state,
  onOpen,
}: {
  leading: ReactNode;
  title: string;
  titleMeta: string;
  description: string;
  state: ReactNode;
  onOpen: () => void;
}) {
  return (
    <div
      data-resource-row
      className="group grid min-w-0 cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 bg-transparent py-3 text-left"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        onOpen();
      }}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-xl" aria-hidden>{leading}</span>
      <span className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          className="block w-full min-w-0 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
            <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{titleMeta}</span>
          </span>
        </button>
        {description ? (
          <span className="mt-0.5 block truncate text-xs leading-snug text-muted-foreground" title={description}>
            {description}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {state}
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md">
          <Icon
            name="ChevronRight"
            className="size-3.5 text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            aria-hidden
          />
        </span>
      </span>
    </div>
  );
}
