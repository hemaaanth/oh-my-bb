import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_InfoSection as InfoSection, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";

import type { rpcContract, ThreadBrief } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";

import { CHANGE_CHANNEL } from "./calendar";

// Must match BRIEF_CHANGED and JOURNAL_CHANGED in server.ts (the app bundle cannot import server values).
const BRIEF_CHANGED = "journal-brief";
const JOURNAL_CHANGED = "journal-changed";
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The SDK accessory sits outside the native toggle; mount age inside it instead. */
export function SummaryFrame({ age, title, children }: { age: string | null; title?: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [heading, setHeading] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const header = root.current?.querySelector<HTMLElement>("h3");
    setHeading(header?.querySelector<HTMLElement>("button[aria-expanded]") ?? header ?? null);
  }, []);
  return <div ref={root} className="min-w-0">
    {children}
    {age && heading ? createPortal(<span title={title} className="pointer-events-none ml-1.5 whitespace-nowrap rounded-full bg-surface-recessed px-1.5 text-2xs leading-4 font-normal text-muted-foreground tabular-nums">{age}</span>, heading) : null}
  </div>;
}

/** Reads the visible thread's saved briefing; never starts a model call. */
export function ThreadBriefSection({ threadId }: { threadId: string }) {
  // Remount on selection so an old briefing cannot flash under a new thread.
  return <SavedBrief key={threadId} threadId={threadId} />;
}

function SavedBrief({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ThreadBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const generation = useRef(false);
  const mounted = useRef(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);
  const generate = useCallback(async () => {
    if (generation.current) return;
    generation.current = true; setGenerating(true); setGenerationError(null);
    try {
      const result = await rpc.call("journal_refresh_thread_brief", { threadId });
      if (mounted.current) { latest.current += 1; setLoading(false); setData(result); setError(null); setNow(Date.now()); }
    } catch (cause) {
      if (mounted.current) setGenerationError(errorMessage(cause));
    } finally {
      generation.current = false;
      if (mounted.current) setGenerating(false);
    }
  }, [rpc, threadId]);
  // Only the newest request may write state: an older thread's late answer or failure is dropped.
  const latest = useRef(0);
  const load = useCallback(() => {
    if (!threadId) return;
    const request = ++latest.current;
    setLoading(true);
    rpc.call("journal_thread_brief", { threadId }).then(
      (result) => { if (request === latest.current) { setData(result); setError(null); setNow(Date.now()); } },
      (cause: unknown) => { if (request === latest.current) setError(errorMessage(cause)); },
    ).finally(() => { if (request === latest.current) setLoading(false); });
  }, [rpc, threadId]);
  // Drop the previous selection's late answer, including after unmount.
  useEffect(() => {
    latest.current += 1; setData(null); setError(null); setLoading(false);
    return () => { latest.current += 1; };
  }, [threadId]);
  useEffect(() => { load(); }, [load]);
  const connection = useRealtimeConnectionState();
  const connectedBefore = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) load();
    connectedBefore.current = true;
  }, [connection, load]);
  useRealtime(BRIEF_CHANGED, (payload) => {
    const changed = payload && typeof payload === "object" && "threadId" in payload ? payload.threadId : null;
    if (changed === data?.rootThreadId || changed === threadId) load();
  });
  // New activity and turn starts/ends change freshness and the live status; these reads are stored rows only.
  useRealtime(JOURNAL_CHANGED, load);
  useRealtime(CHANGE_CHANNEL, load);
  const age = data?.generatedAt ? ago(data.generatedAt, now) : null;
  return <SummaryFrame age={data?.brief ? age : null} title={data?.generatedAt ? `Generated ${new Date(data.generatedAt).toLocaleString()}${data.stale ? "; newer activity is not covered" : ""}` : undefined}><InfoSection label="Summary" trailing={
    <button className="inline-flex size-5 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground transition-colors hover:bg-state-hover/50 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" type="button" aria-label={data?.brief ? "Update summary" : "Generate summary"} disabled={generating || loading} onClick={generate}>
      <span data-bb-demo-sensitive title={[data?.brief ? "Update summary" : "Generate summary", age ? `Updated ${age}${data?.stale ? "; newer activity is not covered" : ""}` : null, data?.automaticNotice].filter(Boolean).join(". ")}><Icon name="RotateCcw" className={generating ? "size-3 animate-spin" : "size-3"} aria-hidden /></span>
    </button>
  }>
    <div className="min-w-0 break-words text-sm leading-6 text-foreground" aria-busy={loading || generating}>
      {generationError && <p role="alert" className="mb-2 text-sm text-destructive">Could not update summary: <span data-bb-demo-sensitive>{generationError}</span></p>}
      <BriefBody data={data} error={error} loading={loading} onRetry={load} />
    </div>
  </InfoSection></SummaryFrame>;
}

function BriefBody({ data, error, loading, onRetry }: { data: ThreadBrief | null; error: string | null; loading: boolean; onRetry: () => void }) {
  if (error && !data) return <div role="alert" className="space-y-2 text-sm text-destructive"><p>Could not read the briefing: <span data-bb-demo-sensitive>{error}</span></p><Button size="sm" variant="outline" onClick={onRetry}>Retry</Button></div>;
  if (!data) return loading ? <div className="space-y-2 py-1" data-testid="brief-loading"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div> : null;
  if (!data.visible) return <p className="text-sm text-foreground">Journal does not track this thread.</p>;
  const status = !data.brief ? "Generate a summary to catch up on this thread." : null;
  return <div>
    {data.rootThreadId !== data.threadId && <p className="text-xs text-muted-foreground">This thread's work rolls into its parent thread; the briefing covers the parent and its visible child threads.</p>}
    {status && <p role="status" className="text-sm leading-6 text-foreground">{status}</p>}
    {error && <p role="alert" className="text-sm text-destructive">Could not reload the briefing: <span data-bb-demo-sensitive>{error}</span></p>}
    {data.error && <p role="status" className="text-sm text-destructive">Last refresh failed: <span data-bb-demo-sensitive>{data.error}</span>{data.retryAt ? ` Retrying after ${new Date(data.retryAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.` : ""}</p>}
    {data.brief && <>
      <Section title="Original goal" text={data.brief.goal} />
      <Section title="Done so far" items={data.brief.done} />
      <Section title="Remaining work" items={data.brief.remaining} />
      <Section title="Where it stopped" text={data.brief.current} />
      <Section title="Decisions made" items={data.brief.decisions} />
      <Section title="Open decisions" items={data.brief.openDecisions} />
      <Section title="Older history" items={data.brief.olderHistory ?? []} collapsed />
    </>}
  </div>;
}

function Section({ title, text, items, collapsed = false }: { title: string; text?: string; items?: string[]; collapsed?: boolean }) {
  const entries = text ? [text] : items ?? [];
  if (!entries.length) return null;
  return <details open={!collapsed} className="journal-brief-section group/brief-section min-w-0 text-sm" aria-label={title}>
    <summary className="-mx-1 flex h-6 min-w-0 cursor-pointer list-none items-center gap-1.5 rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <Icon name="ChevronRight" className="size-3 shrink-0 transition-transform group-open/brief-section:rotate-90" aria-hidden />
      <span className="truncate">{title}</span>
    </summary>
    <ul className="ml-5 min-w-0 space-y-1 pl-1">{entries.map((entry, index) => <li data-bb-demo-sensitive key={index} title={entry} className="truncate text-sm leading-6">• {entry}</li>)}</ul>
  </details>;
}
