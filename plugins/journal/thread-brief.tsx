import { useCallback, useEffect, useRef, useState } from "react";
import { useBbContext, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import * as Dialog from "@radix-ui/react-dialog";
import type { rpcContract, ThreadBrief } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { usePortalScopeProps } from "./lib/portal-scope";
import { CHANGE_CHANNEL } from "./calendar";

// Must match BRIEF_CHANGED and JOURNAL_CHANGED in server.ts (the app bundle cannot import server values).
const BRIEF_CHANGED = "journal-brief";
const JOURNAL_CHANGED = "journal-changed";
const OPEN = "journal:open-thread-brief";
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function openThreadBrief(threadId: string) {
  // Let the native menu close before the dialog takes focus.
  setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN, { detail: threadId })), 0);
}

/** Opens the selected thread's saved briefing; never starts a model call. */
export function ThreadBriefOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const portalScope = usePortalScopeProps();
  const context = useBbContext();
  const opener = useRef<HTMLElement | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = (event: Event) => {
      const id: unknown = (event as CustomEvent).detail;
      if (typeof id !== "string" || !id) return;
      const active = document.activeElement;
      // A closing menu can retain focus until its exit animation ends.
      const triggerId = active?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
      opener.current = (triggerId ? document.getElementById(triggerId) : null)
        ?? (active instanceof HTMLElement ? active : null);
      setThreadId(id);
      setOpen(true);
    };
    window.addEventListener(OPEN, handler);
    return () => window.removeEventListener(OPEN, handler);
  }, []);
  useEffect(() => { setOpen(false); }, [context.threadId]);
  const [data, setData] = useState<ThreadBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the newest request may write state: an older thread's late answer or failure is dropped.
  const latest = useRef(0);
  const load = useCallback(() => {
    if (!threadId) return;
    const request = ++latest.current;
    setLoading(true);
    rpc.call("journal_thread_brief", { threadId }).then(
      (result) => { if (request === latest.current) { setData(result); setError(null); } },
      (cause: unknown) => { if (request === latest.current) setError(errorMessage(cause)); },
    ).finally(() => { if (request === latest.current) setLoading(false); });
  }, [rpc, threadId]);
  // Drop the previous selection's late answer, including after unmount.
  useEffect(() => {
    latest.current += 1; setData(null); setError(null); setLoading(false);
    return () => { latest.current += 1; };
  }, [threadId]);
  useEffect(() => { if (open) load(); }, [open, load]);
  const reloadIfOpen = () => { if (open) load(); };
  useRealtime(BRIEF_CHANGED, (payload) => {
    const changed = payload && typeof payload === "object" && "threadId" in payload ? payload.threadId : null;
    if (changed === data?.rootThreadId || changed === threadId) reloadIfOpen();
  });
  // New activity and turn starts/ends change freshness and the live status; these reads are stored rows only.
  useRealtime(JOURNAL_CHANGED, reloadIfOpen);
  useRealtime(CHANGE_CHANNEL, reloadIfOpen);
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Portal>
      <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content {...portalScope} onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }} className="journal-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[min(85dvh,760px)] w-[calc(100vw-1.5rem)] max-w-lg flex-col overflow-hidden rounded-md border border-border bg-background shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <Dialog.Title className="text-base font-semibold">Catch up on this thread</Dialog.Title>
            <Dialog.Description className="truncate text-xs text-muted-foreground">{data?.title ?? "Saved briefing"}</Dialog.Description>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Reload saved briefing" disabled={loading} onClick={load}>
              <Icon name="ArrowReloadHorizontal" aria-hidden />
            </Button>
            <Dialog.Close asChild><Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Close">×</Button></Dialog.Close>
          </div>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-4" aria-busy={loading}>
          <BriefBody data={data} error={error} loading={loading} onRetry={load} />
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function BriefBody({ data, error, loading, onRetry }: { data: ThreadBrief | null; error: string | null; loading: boolean; onRetry: () => void }) {
  if (error && !data) return <div role="alert" className="space-y-2 text-sm text-destructive"><p>Could not read the briefing: {error}</p><Button size="sm" variant="outline" onClick={onRetry}>Retry</Button></div>;
  if (!data) return loading ? <div className="space-y-3" data-testid="brief-loading"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div> : null;
  if (!data.visible) return <p className="text-sm text-muted-foreground">Journal does not track this thread.</p>;
  const now = Date.now();
  const status = !data.brief
    ? data.automatic ? data.pending ? "A briefing will be written after this thread has been idle for a few minutes." : "No briefing yet. One is written after the thread's next idle turn."
      : "No briefing yet. Automatic briefings run only with the subscription AI backend (Journal settings). `bb journal brief <id> --refresh` writes one on request."
    : null;
  return <div className="space-y-4">
    {data.rootThreadId !== data.threadId && <p className="text-xs text-muted-foreground">This thread's work rolls into its parent thread; the briefing covers the parent and its visible child threads.</p>}
    <p role="status" className="text-sm" data-testid="brief-live">{data.running ? "Right now: an agent is working on this thread." : "Right now: no agent is running (idle is not the same as done)."}</p>
    {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
    {data.error && <p role="status" className="text-xs text-muted-foreground">Last refresh failed: {data.error}{data.retryAt ? ` Retrying after ${new Date(data.retryAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.` : ""}</p>}
    {data.brief && <>
      <p className="text-xs text-muted-foreground" role="status">
        Updated {ago(data.generatedAt!, now)}
        {data.stale ? ` · New activity${data.lastActivityAt ? ` ${ago(data.lastActivityAt, now)}` : ""} is not covered yet${data.automatic ? "; it refreshes after the thread idles" : ""}.` : " · Covers the latest activity."}
      </p>
      <Section title="Original goal" text={data.brief.goal} />
      <Section title="Done so far" items={data.brief.done} empty="Nothing confirmed done yet." />
      <Section title="Remaining work" items={data.brief.remaining} empty="Nothing listed." />
      <Section title="Where it stopped" text={data.brief.current} />
      <Section title="Decisions made" items={data.brief.decisions} empty="No accepted decisions recorded." />
      <Section title="Open decisions" items={data.brief.openDecisions} empty="None open." />
      {data.coverage && (data.coverage.historyClipped || data.coverage.excerptClipped || !data.coverage.startRead || data.coverage.workDays < data.coverage.workDaysTotal || data.coverage.children < data.coverage.childrenTotal) &&
        <p className="border-t border-border pt-3 text-xs text-muted-foreground" data-testid="brief-coverage">
          Coverage: {[
            !data.coverage.startRead && "the start of the thread was not read, so the goal comes from saved summaries",
            data.coverage.historyClipped && data.coverage.startRead && "older messages come from earlier briefings",
            data.coverage.excerptClipped && "some long or middle messages were shortened",
            data.coverage.workDays < data.coverage.workDaysTotal && `${data.coverage.workDays} of ${data.coverage.workDaysTotal} work days read`,
            data.coverage.children < data.coverage.childrenTotal && `${data.coverage.children} of ${data.coverage.childrenTotal} child threads read`,
          ].filter(Boolean).join("; ")}.
        </p>}
    </>}
  </div>;
}

function Section({ title, text, items, empty }: { title: string; text?: string; items?: string[]; empty?: string }) {
  return <section aria-label={title}>
    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
    {text !== undefined ? <p className="text-sm leading-6">{text}</p>
      : items!.length ? <ul className="list-disc space-y-1 pl-5 text-sm leading-6">{items!.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
      : <p className="text-sm text-muted-foreground">{empty}</p>}
  </section>;
}
