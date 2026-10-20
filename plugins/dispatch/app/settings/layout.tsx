// Small layout pieces shared by the settings sections. Rows follow BB's own
// settings rows. They switch layout on the row's own width, not the window's,
// because the settings column is narrower than the window on desktop.
import { useId, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { cn } from "../lib/utils";

/**
 * Where a row puts its control.
 * - "inline": right of the label in a wide column, under it in a narrow one.
 * - "trailing": always right of the label. For switches and other small controls.
 * - "below": always under the label, full width.
 */
export type Placement = "inline" | "trailing" | "below";

const ROW_LAYOUT: Record<Placement, string> = {
  inline: "flex flex-col gap-2.5 @md:flex-row @md:items-center @md:justify-between @md:gap-5",
  trailing: "flex items-center justify-between gap-4",
  below: "flex flex-col gap-2.5",
};

const CONTROL_LAYOUT: Record<Placement, string> = {
  inline: "flex min-w-0 flex-col items-start gap-2 @md:shrink-0 @md:items-end",
  trailing: "flex shrink-0 items-center gap-2",
  below: "flex min-w-0 flex-col items-stretch gap-2",
};

/** One labelled setting: the label and help, then the control. */
export function Row({ label, help, htmlFor, children, className, placement = "inline" }: {
  label: string;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  placement?: Placement;
}) {
  return (
    <div className={cn("@container py-3", className)}>
      <div className={ROW_LAYOUT[placement]}>
        <div className="min-w-0 flex-1">
          <label htmlFor={htmlFor} className="text-sm text-foreground">
            {label}
          </label>
          {help ? <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{help}</div> : null}
        </div>
        <div className={CONTROL_LAYOUT[placement]}>{children}</div>
      </div>
    </div>
  );
}

/** A quiet segmented control. It fills a narrow row and sizes to its choices in a wide one. */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex w-full min-w-0 rounded-md border border-input p-0.5 @md:w-auto">
      {options.map((option) => (
        <Button
          key={option.value}
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 flex-1 px-2.5 @md:flex-none"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** A closed-by-default block with a chevron button, for detail most people skip. */
export function Disclosure({ label, defaultOpen = false, children }: { label: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="py-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="-mx-1 flex cursor-pointer items-center gap-1 rounded-sm px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon name="ChevronDown" className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden="true" />
        {label}
      </button>
      {open ? (
        <div id={id} className="mt-2 flex flex-col gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Rows with quiet dividers. A title and its note form one header block. */
export function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 divide-y divide-border/60">
      {title ? (
        <div className="pb-2">
          <h4 className="text-sm font-medium text-foreground">{title}</h4>
          {note ? <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{note}</p> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** BB's vendored, portal-scoped select. Every settings picker shares its sizing. */
export function SettingSelect({ id, label, value, options, onValueChange, disabled }: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className="h-8 w-full min-w-0 gap-2 bg-transparent px-2.5 text-xs @md:w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-[min(24rem,var(--radix-select-content-available-height))] max-w-[calc(100vw-2rem)]">
        {options.map((option) => <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function Loading({ error }: { error: string | null }) {
  return <p role={error ? "alert" : "status"} className={cn("py-2 text-sm", error ? "text-destructive" : "text-muted-foreground")}>{error ?? "Loading…"}</p>;
}

export function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" | "ok" }) {
  return (
    <p role={tone === "error" ? "alert" : undefined} className={cn("text-xs leading-relaxed", tone === "error" ? "text-destructive" : tone === "ok" ? "text-foreground" : "text-muted-foreground")}>
      {children}
    </p>
  );
}
