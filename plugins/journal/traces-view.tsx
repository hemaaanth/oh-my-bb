import { useMemo, useState } from "react";
import type { FeedEvent } from "./server";
import { traceRows, type TraceRow } from "./traces";
import { blockCategory, longDayFormat, OTHER_COLOR, RunningDot, Swatch, useRevealed, type Activity, type ColorMode, type Grouping, type useColors } from "./calendar-view";
import { Button } from "@/components/ui/button";

// Raw spans, newest first: one row per agent turn, plus failures and input
// requests. No summaries and no rollup; child threads keep their own rows.
// Dispatch calls, when shown, get their own rows outside any project.
const TRACE_PAGE_SIZE = 300;
const CALLS_SECTION = "dispatch-calls";

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function traceDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const timeCell = (at: number, multiDay: boolean) => `${multiDay ? `${longDayFormat.format(at)} ` : ""}${clockFormat.format(at)}`;

/** A Dispatch call: its title and summary when remembered. It opens the first thread it touched, if any. */
function CallRow({ row, color, from, span, now, multiDay, grouping, onOpen }: {
  row: Extract<TraceRow, { kind: "call" }>; color: string; from: number; span: number; now: number; multiDay: boolean; grouping: Grouping;
  onOpen: (threadId: string) => void;
}) {
  const { call } = row; const end = row.end ?? now; const threadId = call.threadIds[0];
  const title = (call.remembered && call.title) || "Dispatch call";
  const left = Math.max(0, (row.at - from) / span) * 100; const width = Math.min(100 - left, ((end - row.at) / span) * 100);
  return <tr onClick={threadId ? () => onOpen(threadId) : undefined} className={`border-b border-border/60 last:border-b-0 ${threadId ? "cursor-pointer hover:bg-muted/30" : ""}`}>
    <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-muted-foreground">{timeCell(row.at, multiDay)}</td>
    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{traceDuration(end - row.at)}</td>
    <td className="truncate px-3 py-1.5" title={call.remembered && call.summary ? call.summary : title}>
      <span className="flex min-w-0 items-center gap-1.5">
        {row.end === null ? <RunningDot /> : null}
        <span className="shrink-0 rounded px-1 font-medium" style={{ color, backgroundColor: `color-mix(in oklab, ${color} 15%, transparent)` }}>call</span>
        <span className="truncate">{title}</span>
        {call.remembered && call.summary ? <span className="truncate text-muted-foreground">{call.summary}</span> : null}
      </span>
    </td>
    {grouping === "thread" ? <td className="truncate px-3 py-1.5 text-muted-foreground">Dispatch · {[call.channel === "phone" ? "Phone" : "App", call.device].filter(Boolean).join(" · ")}</td> : null}
    <td className="px-3 py-1.5"><div className="relative h-2 rounded-sm bg-muted">
      <span className="absolute inset-y-0 min-w-[2px] rounded-sm" style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color }} />
    </div></td>
  </tr>;
}

export function TracesView({ activity, events, grouping, colorMode, colors, multiDay, now, onOpen }: {
  activity: Activity; events: FeedEvent[]; grouping: Grouping; colorMode: ColorMode; colors: ReturnType<typeof useColors>;
  multiDay: boolean; now: number; onOpen: (threadId: string) => void;
}) {
  const [limit, setLimit] = useState(TRACE_PAGE_SIZE);
  const threads = useMemo(() => new Map(activity.threads.map((thread) => [thread.id, thread])), [activity.threads]);
  const rows = useMemo(() => traceRows(activity.turns, events, activity.calls), [activity.turns, events, activity.calls]);
  // A thread's category: its own, else its root block's.
  const rootCategory = useMemo(() => new Map(activity.blocks.map((block) => [block.threadId, blockCategory(block, threads.get(block.threadId))])), [activity.blocks, threads]);
  const colorOf = (threadId: string) => {
    const thread = threads.get(threadId);
    if (colorMode === "project") return colors.projects.get(thread?.projectId ?? "")?.color ?? OTHER_COLOR;
    return colors.categoryColor(thread?.category ?? rootCategory.get(thread?.rootThreadId ?? threadId) ?? null);
  };

  const revealed = useRevealed(Math.min(limit, rows.length));
  if (rows.length === 0) {
    return <div role="status" className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">No agent turns in this range.</div>;
  }
  const shown = rows.slice(0, revealed);
  const byProject = new Map<string, TraceRow[]>();
  if (grouping === "project") for (const row of shown) {
    const projectId = row.kind === "call" ? CALLS_SECTION : threads.get(row.threadId)?.projectId ?? "";
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), row]);
  }
  const sectionColor = (key: string) => key === CALLS_SECTION ? colors.call : colors.projects.get(key)?.color ?? OTHER_COLOR;
  const sections = grouping === "project"
    ? [...byProject].map(([projectId, items]) => ({ key: projectId, label: projectId === CALLS_SECTION ? "Dispatch calls" : colors.projects.get(projectId)?.name ?? "Unknown project", items }))
      .sort((a, b) => (colors.projects.get(a.key)?.order ?? Infinity) - (colors.projects.get(b.key)?.order ?? Infinity))
    : [{ key: "all", label: "", items: shown }];
  // The timeline spans the page of rows, so short turns stay visible across a week.
  const page = rows.slice(0, limit);
  const from = Math.min(...page.map((row) => row.at));
  const span = Math.max(60_000, Math.max(...page.map((row) => row.kind === "turn" || row.kind === "call" ? row.end ?? now : row.at)) - from);

  return <div className="rounded-md border border-border bg-card">
    <div className="overflow-x-auto"><table className="w-full min-w-[680px] table-fixed border-collapse text-xs">
      <thead className="sticky top-0 z-10">
        <tr className="text-[11px] uppercase tracking-wider text-muted-foreground [&>th]:border-b [&>th]:border-border [&>th]:bg-card [&>th:first-child]:rounded-tl-lg [&>th:last-child]:rounded-tr-lg">
          <th className={`${multiDay ? "w-44" : "w-24"} px-3 py-2 text-left font-medium`}>Time</th>
          <th className="w-20 px-3 py-2 text-right font-medium">Duration</th>
          <th className="px-3 py-2 text-left font-medium">Span</th>
          {grouping === "thread" ? <th className="w-40 px-3 py-2 text-left font-medium">Project</th> : null}
          <th className="w-[28%] px-3 py-2 text-left font-medium">Timeline</th>
        </tr>
      </thead>
      {sections.map((section) => <tbody key={section.key}>
        {section.label ? <tr className="border-b border-border bg-muted/40"><td colSpan={4} className="px-3 py-1.5 text-xs font-medium">
          <span className="flex items-center gap-2"><Swatch color={sectionColor(section.key)} />{section.label} · {section.items.length}</span></td></tr> : null}
        {section.items.map((row) => {
          if (row.kind === "call") return <CallRow key={row.key} row={row} color={colors.call} from={from} span={span} now={now} multiDay={multiDay} grouping={grouping} onOpen={onOpen} />;
          const thread = threads.get(row.threadId); const color = colorOf(row.threadId);
          const end = row.kind === "turn" ? row.end ?? now : row.at;
          const child = thread !== undefined && thread.rootThreadId !== thread.id;
          const left = Math.max(0, (row.at - from) / span) * 100; const width = Math.min(100 - left, ((end - row.at) / span) * 100);
          return <tr key={row.key} onClick={() => onOpen(row.threadId)} className="cursor-pointer border-b border-border/60 last:border-b-0 hover:bg-muted/30">
            <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-muted-foreground">{timeCell(row.at, multiDay)}</td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums">{row.kind === "turn" ? traceDuration(end - row.at) : "—"}</td>
            <td className="truncate px-3 py-1.5" title={thread?.title ?? row.threadId}>
              <span className="flex min-w-0 items-center gap-1.5">
                {row.kind === "turn" && row.end === null ? <RunningDot /> : null}
                {row.kind === "failed" ? <span className="shrink-0 rounded bg-red-500/15 px-1 font-medium text-red-600 dark:text-red-400">failed</span> : null}
                {row.kind === "input" ? <span className="shrink-0 rounded bg-amber-500/15 px-1 font-medium text-amber-700 dark:text-amber-400">needs input</span> : null}
                <span className="truncate">{child ? "↳ " : ""}{thread?.title ?? row.threadId}</span>
                {row.kind !== "turn" && row.detail ? <span className="truncate text-muted-foreground">{row.detail}</span> : null}
              </span>
            </td>
            {grouping === "thread" ? <td className="truncate px-3 py-1.5 text-muted-foreground">{colors.projects.get(thread?.projectId ?? "")?.name ?? "Unknown project"}</td> : null}
            <td className="px-3 py-1.5"><div className="relative h-2 rounded-sm bg-muted">
              {row.kind === "turn" ? <span className="absolute inset-y-0 min-w-[2px] rounded-sm" style={{ left: `${left}%`, width: `${width}%`, backgroundColor: color }} />
                : <span className={`absolute -inset-y-0.5 w-0.5 ${row.kind === "failed" ? "bg-red-500" : "bg-amber-500"}`} style={{ left: `${left}%` }} />}
            </div></td>
          </tr>;
        })}
      </tbody>)}
    </table></div>
    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
      <p>{rows.length > page.length ? `Showing ${page.length} of ${rows.length} spans.` : `${rows.length} spans.`} Times are local; failures and input requests are kept for 62 days.</p>
      {rows.length > page.length ? <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setLimit(limit + TRACE_PAGE_SIZE)}>Show more</Button> : null}
    </div>
  </div>;
}
