import { useState, type ReactNode } from "react";
import { useHost } from "../host.js";
import { FileExcerpt } from "../FileExcerpt.js";
import { focusRing } from "../kit.js";

export const reportRow = "border-b border-border-hairline py-2 last:border-b-0";
export const reportButton = `w-fit cursor-pointer rounded-sm text-xs text-primary hover:underline ${focusRing}`;
export const reportTone: Record<string, string> = { critical: "text-destructive", high: "text-destructive", medium: "text-warning", moderate: "text-warning", low: "text-primary", info: "text-muted-foreground", passed: "text-success", failed: "text-destructive", skipped: "text-muted-foreground" };

export function ReportError({ message }: { message: string }) {
  return <p role="alert" className="m-0 text-xs text-destructive">{message}</p>;
}

export function ReportTitle({ title, children }: { title?: string; children?: ReactNode }) {
  if (!title && !children) return null;
  return <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">{title ? <h3 className="m-0 text-sm font-medium">{title}</h3> : null}{children}</div>;
}

export function ReportDetails({ summary, children, initiallyOpen = false }: { summary: ReactNode; children?: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const heading = <><svg aria-hidden viewBox="0 0 16 16" fill="none" className="mt-0.5 size-3 shrink-0 [[open]>summary>&]:rotate-90"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" /></svg>{summary}</>;
  return children ? <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className={reportRow}>
    <summary className={`flex cursor-pointer list-none items-start gap-2 rounded-sm ${focusRing}`}>{heading}</summary>
    {open ? <div className="mt-3 flex min-w-0 flex-col gap-3 pl-5 text-xs">{children}</div> : null}
  </details> : <div className={`${reportRow} flex min-w-0 items-start gap-2`}><span className="size-3 shrink-0" />{summary}</div>;
}

/** Source is read only after an explicit click; public pages do not fetch private files. */
export function ReportFile({ path, from, to }: { path: string; from?: number; to?: number }) {
  const host = useHost();
  const [peek, setPeek] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setError(null);
    try { if (!await host.openFile?.(path, from, to)) setError("Could not open this file in BB."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this file in BB."); }
  };
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex min-w-0 flex-wrap items-baseline gap-3">
      <code className="min-w-0 break-all text-xs text-muted-foreground">{path}{from ? `:${from}${to && to !== from ? `-${to}` : ""}` : ""}</code>
      {host.openFile ? <button type="button" onClick={() => void open()} className={reportButton}>Open file</button> : null}
      {host.kind !== "page" ? <button type="button" aria-expanded={peek} onClick={() => setPeek(!peek)} className={reportButton}>{peek ? "Hide excerpt" : "Show excerpt"}</button> : null}
    </div>
    {error ? <ReportError message={error} /> : null}
    {peek ? <FileExcerpt file={path} from={from} to={to} /> : null}
  </div>;
}
