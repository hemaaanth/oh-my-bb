// Small layout pieces shared by the settings sections.
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** One labelled setting: label and help on the left, control on the right. */
export function Row({ label, help, htmlFor, children, className }: { label: string; help?: ReactNode; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0 sm:max-w-[55%]">
        <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {help ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{help}</p> : null}
      </div>
      <div className="flex min-w-0 flex-col items-stretch gap-2 sm:items-end">{children}</div>
    </div>
  );
}

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      {title ? <h4 className="pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-subtle-foreground">{title}</h4> : null}
      {children}
    </div>
  );
}

export function Loading({ error }: { error: string | null }) {
  return <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>{error ?? "Loading…"}</p>;
}

export function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" | "ok" }) {
  return (
    <p role={tone === "error" ? "alert" : undefined} className={cn("text-xs leading-5", tone === "error" ? "text-destructive" : tone === "ok" ? "text-foreground" : "text-muted-foreground")}>
      {children}
    </p>
  );
}

export const selectClass =
  "h-9 w-full min-w-40 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 sm:w-auto";
