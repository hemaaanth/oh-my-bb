// Small layout pieces shared by the settings sections.
import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { cn } from "../lib/utils";

/** One labelled setting: label and help on the left, control on the right. */
export function Row({ label, help, htmlFor, children, className, inline = false }: { label: string; help?: ReactNode; htmlFor?: string; children: ReactNode; className?: string; inline?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3", className)}>
      <div className="min-w-0 flex-1 basis-48 self-center">
        <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {help ? <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{help}</div> : null}
      </div>
      <div className={cn("flex min-w-0 flex-col gap-2", inline ? "max-w-[55%] items-end" : "w-full items-stretch sm:w-auto sm:max-w-[55%] sm:items-end")}>{children}</div>
    </div>
  );
}

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 divide-y divide-border/60">
      {title ? <h4 className="pb-2 text-sm font-medium text-foreground">{title}</h4> : null}
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
      <SelectTrigger id={id} aria-label={label} className="h-8 w-full min-w-0 gap-2 bg-transparent px-2.5 text-xs sm:w-56">
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
