import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, useRealtime, useRpc, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { catchUpSummary, type CatchUpItem } from "./catch-up-summary";
import { Button } from "@/components/ui/button";
import * as Dialog from "@radix-ui/react-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { usePortalScopeProps } from "./lib/portal-scope";

const OPEN = "journal:open-catch-up";
const headerActionClass = "flex size-8 items-center justify-center rounded-md text-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
type Entry = { threadId: string; summary: string; outcome: string | null; workStatus: string | null; lastActivityAt: number | null;
  lastWorkedAt: number | null; agentMs: number | null; worked: string | null };
type Paragraph = { text: string; links: Array<{ threadId: string; phrase: string }> };
export function openCatchUp() { window.dispatchEvent(new Event(OPEN)); }
export function CatchUpOverlay() {
  const rpc = useRpc<typeof rpcContract>(); const sidebar = useSidebarThreads(); const navigate = useBbNavigate();
  const portalScope = usePortalScopeProps();
  const opener = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false); const [entries, setEntries] = useState<Entry[] | null>(null); const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [narrativeError, setNarrativeError] = useState<string | null>(null);
  const [narrativeNotice, setNarrativeNotice] = useState<string | null>(null);
  const [paragraphs, setParagraphs] = useState<Paragraph[] | null>(null);
  useEffect(() => { const handler = () => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setOpen(true); }; window.addEventListener(OPEN, handler); return () => window.removeEventListener(OPEN, handler); }, []);
  const refresh = useCallback(() => { rpc.call("journal_catch_up", null).then((result) => { setEntries(result.entries); setError(null); }, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, [rpc]);
  useEffect(() => { refresh(); }, [refresh]);
  useRealtime("journal-changed", refresh);
  useEffect(() => { const timer = window.setInterval(refresh, 5 * 60_000); return () => window.clearInterval(timer); }, [refresh]);
  const summary = useMemo(() => {
    const indexed = new Map(entries?.map((entry) => [entry.threadId, entry]) ?? []);
    const names = new Map(sidebar.projects.map((project) => [project.id, project.name]));
    return catchUpSummary(sidebar.threads.filter((thread) => !thread.isArchived && !thread.isHidden && !thread.parentThreadId).map((thread) => ({ thread, entry: indexed.get(thread.id), project: names.get(thread.projectId) ?? "Other work" })), Date.now());
  }, [entries, sidebar.threads, sidebar.projects]);
  const items = useMemo(() => [...summary.attention, ...summary.active.flatMap((group) => group.items), ...summary.archive], [summary]);
  useEffect(() => {
    if (!entries) return;
    let current = true;
    rpc.call("journal_catch_up_narrative", { force: false }).then(
      (result) => { if (current) { setParagraphs(result.paragraphs); setNarrativeNotice(result.notice ?? null); setNarrativeError(null); } },
      (cause: unknown) => { if (current) setNarrativeError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { current = false; };
  }, [entries, rpc]);
  const refreshNarrative = () => {
    setRefreshing(true); setNarrativeError(null);
    rpc.call("journal_catch_up_narrative", { force: true }).then(
      (result) => { setParagraphs(result.paragraphs); setNarrativeNotice(result.notice ?? null); setNarrativeError(null); refresh(); },
      (cause: unknown) => setNarrativeError(cause instanceof Error ? cause.message : String(cause)),
    ).finally(() => setRefreshing(false));
  };
  const loading = entries === null || sidebar.status === "loading";
  const openThread = (id: string) => { setOpen(false); navigate.toThread(id); };
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal>
    <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/70" />
    <Dialog.Content {...portalScope} onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }} className="journal-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[min(85dvh,780px)] w-[calc(100vw-1.5rem)] max-w-xl flex-col overflow-hidden rounded-md border border-border bg-background shadow-2xl">
      <header className="flex shrink-0 items-center justify-between px-5 py-3 sm:px-6">
        <Dialog.Title className="text-base font-semibold">Catch me up</Dialog.Title>
        <Dialog.Description className="sr-only">Summary of your open work across projects</Dialog.Description>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Refresh summary" title="Refresh summary" className={headerActionClass} disabled={refreshing} onClick={refreshNarrative}>{refreshing ? "…" : "↻"}</button>
          <Dialog.Close className={headerActionClass} aria-label="Close" title="Close">×</Dialog.Close>
        </div>
      </header>
      <div className="min-h-0 overflow-y-auto px-5 py-4 sm:px-6">
        {error ? <div data-bb-demo-sensitive className="text-sm text-destructive">{error} <Button size="sm" variant="outline" onClick={refresh}>Retry</Button></div>
          : loading ? <div className="space-y-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
          : !items.length ? <p className="text-sm text-muted-foreground">No open work across your projects.</p>
          : <>
            <section data-bb-demo-sensitive aria-label="Summary" className="space-y-4">
              {narrativeError && <p role="alert" className="text-sm text-destructive">Catch-up failed: {narrativeError}</p>}
              {narrativeNotice && <p role="status" className="text-sm text-muted-foreground">{narrativeNotice}</p>}
              {!paragraphs?.length && !narrativeError && !narrativeNotice && <p className="text-sm text-muted-foreground">Preparing your catch-up in the background…</p>}
              {(paragraphs ?? []).map((paragraph, index) => <p key={index} className="text-sm leading-6">{linkedText(paragraph, openThread)}</p>)}
            </section>
            {(summary.attention.length > 0 || summary.archive.length > 0) && <section className="mt-6 border-t border-border pt-4">
              <button type="button" className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline" onClick={() => setShowDetails(!showDetails)} aria-expanded={showDetails}>{showDetails ? "Hide" : "Show"} details · {summary.attention.length} need attention · {summary.archive.length} review for archive</button>
              {showDetails && <div className="mt-4 space-y-4">
                {summary.attention.length > 0 && <DetailSection title="Needs attention" items={summary.attention} onOpen={openThread} />}
                {summary.archive.length > 0 && <DetailSection title="Review for archive" items={summary.archive} onOpen={openThread} />}
              </div>}
            </section>}
          </>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

function DetailSection({ title, items, onOpen }: { title: string; items: CatchUpItem[]; onOpen: (id: string) => void }) {
  return <div><h4 className="mb-2 text-xs font-semibold text-muted-foreground">{title}</h4><ul className="space-y-2">{items.map(({ work, reason }) => <li data-bb-demo-sensitive key={work.thread.id} className="text-xs"><button type="button" className="text-left text-foreground hover:underline" onClick={() => onOpen(work.thread.id)}>{work.thread.displayTitle || work.entry?.summary || "Untitled thread"}</button><span className="text-muted-foreground"> · {work.project} · {reason}{work.entry?.worked ? ` · ${work.entry.worked}` : ""}</span></li>)}</ul></div>;
}

function linkedText(paragraph: Paragraph, openThread: (id: string) => void): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  const positions = paragraph.links.map((link) => ({ ...link, start: paragraph.text.indexOf(link.phrase) })).sort((a, b) => a.start - b.start);
  for (const link of positions) {
    if (link.start < cursor || link.start < 0) continue;
    parts.push(paragraph.text.slice(cursor, link.start));
    parts.push(<button key={`${link.threadId}-${link.start}`} type="button" onClick={() => openThread(link.threadId)} className="inline rounded-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{paragraph.text.slice(link.start, link.start + link.phrase.length)}</button>);
    cursor = link.start + link.phrase.length;
  }
  parts.push(paragraph.text.slice(cursor));
  return parts;
}
