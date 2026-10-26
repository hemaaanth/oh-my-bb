import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import type { SandboxThreadStatus } from "../shared";

export type MachineKind = "local" | "sandbox";

// One small glyph per thread: a square runs on this machine, a circle runs in
// a remote sandbox. The caller picks the colour (machine state for top-level
// rows, working state for sub-agents).
export function MachineShape({
  machine,
  className,
  style,
}: {
  machine: MachineKind;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      data-machine-marker={machine}
      className={cn(
        "block bg-current",
        machine === "local" ? "rounded-[22%]" : "rounded-full",
        className,
      )}
      style={style}
    />
  );
}

export function MachineMarker({
  machine,
  label,
  className,
  style,
}: {
  machine: MachineKind;
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      <MachineShape machine={machine} className={cn("size-2", className)} style={style} />
    </span>
  );
}

export function machineStateClassName(
  machine: MachineKind,
  status: SandboxThreadStatus["status"] | undefined,
): string {
  if (machine === "local") return "text-success";
  if (status === "live") return "text-success";
  if (status === "idle") return "text-warning-text";
  if (status === "unreachable") return "text-destructive-text";
  if (status === "stopped") return "text-muted-foreground/50";
  if (status === "unrecoverable") return "text-destructive-text";
  return "text-muted-foreground";
}
