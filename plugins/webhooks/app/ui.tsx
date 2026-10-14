// Small helpers over BB's shared UI. Colors come from host theme tokens only.
import { useId, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { DeliveryView } from "../contract.js";

/** The glyph from `bb.branding.experimental_icons`, also used by the nav entry. */
export const WEBHOOK_ICON = "webhooks/webhook";

export function messageOf(error: unknown, fallback = "Something went wrong."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000;
  if (!Number.isFinite(seconds)) return "";
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return "just now";
}

type ControlProps = { id: string; "aria-describedby"?: string };

/** A labelled form row. The control gets the id; `hint` is one short line under it. */
export function Field({ label, hint, className, children }: { label: string; hint?: ReactNode; className?: string; children: (props: ControlProps) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children(hint ? { id, "aria-describedby": hintId } : { id })}
      {hint ? (
        <p id={hintId} className="text-xs leading-snug text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type ChoiceOption = { value: string; label: string; disabled?: boolean };

/** BB's select. Radix refuses an empty item value, so "nothing chosen" shows the placeholder. */
export function Choice({
  value,
  options,
  placeholder,
  onChange,
  className,
  ...control
}: { value: string; options: readonly ChoiceOption[]; placeholder?: string; onChange: (value: string) => void; className?: string } & Partial<ControlProps> & { "aria-label"?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger {...control} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One line of muted text with a leading glyph. Used for warnings and errors instead of a box. */
export function Notice({ tone, children, className }: { tone: "warning" | "error"; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "error" ? "alert" : "note"} className={cn("flex min-w-0 items-start gap-2 text-xs leading-5", tone === "error" ? "text-destructive" : "text-muted-foreground", className)}>
      <Icon name={tone === "error" ? "CircleX" : "AlertTriangle"} aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", tone === "warning" && "text-warning")} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export const deliveryStatusVisuals: Record<DeliveryView["status"], { label: string; icon: string; className: string }> = {
  processing: { label: "Processing", icon: "Loading", className: "animate-spin text-muted-foreground" },
  succeeded: { label: "Succeeded", icon: "CircleCheck", className: "text-success" },
  failed: { label: "Failed", icon: "CircleX", className: "text-destructive" },
  rejected: { label: "Rejected", icon: "CircleX", className: "text-destructive" },
};

export function DeliveryStatusIcon({ status, className }: { status: string; className?: string }) {
  const visual = deliveryStatusVisuals[status as DeliveryView["status"]];
  if (!visual) return <Icon name={WEBHOOK_ICON} aria-hidden className={cn("size-3.5 text-muted-foreground", className)} />;
  return (
    <span role="img" aria-label={visual.label} title={visual.label} className="inline-flex shrink-0">
      <Icon name={visual.icon} aria-hidden className={cn("size-3.5", visual.className, className)} />
    </span>
  );
}
