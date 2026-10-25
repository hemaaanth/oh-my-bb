// Time sheet ported from Agent Calendar (app.tsx) by charpeni/bb-plugins agent-calendar.
// https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-calendar
// Copyright (c) charpeni. MIT License.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { buildTimesheet, dayBoundaries, formatDuration, formatHours, startOfDay, type TimesheetRow } from "./calendar";
import { blockCategory, longDayFormat, OTHER_COLOR, RunningDot, Swatch, weekdayFormat, type Activity, type ActivityThread, type ColorMode, type Grouping, type ProjectStyle, type useColors } from "./calendar-view";
import { Icon } from "@/components/ui/icon";

type Group = { project: ProjectStyle | undefined; projectId: string; rows: TimesheetRow[]; dayMs: number[]; totalMs: number };

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function TimesheetView({ activity, rangeStart, dayCount, grouping, colorMode, colors, now, onOpen, onSelectDay }: {
  activity: Activity; rangeStart: number; dayCount: number; grouping: Grouping; colorMode: ColorMode; colors: ReturnType<typeof useColors>; now: number;
  onOpen: (threadId: string) => void; onSelectDay: (dayStart: number) => void;
}) {
  const projects = colors.projects;
  const boundaries = useMemo(() => dayBoundaries(rangeStart, dayCount), [rangeStart, dayCount]);
  const rows = useMemo(() => buildTimesheet(activity.blocks, boundaries), [activity.blocks, boundaries]);
  const threads = useMemo(() => new Map(activity.threads.map((thread) => [thread.id, thread])), [activity.threads]);
  const ongoing = useMemo(() => new Set(activity.blocks.filter((block) => block.ongoing).map((block) => block.threadId)), [activity.blocks]);
  // By work type, each thread row carries the color of its latest block's category.
  const threadColor = useMemo(() => {
    const byThread = new Map<string, string>();
    if (colorMode === "work") for (const block of activity.blocks) byThread.set(block.threadId, colors.categoryColor(blockCategory(block, threads.get(block.threadId))));
    return byThread;
  }, [activity.blocks, colorMode, colors, threads]);
  const dayStarts = boundaries.slice(0, -1);
  const groups = useMemo(() => {
    const byProject = new Map<string, TimesheetRow[]>();
    for (const row of rows) {
      const projectId = threads.get(row.threadId)?.projectId ?? "";
      byProject.set(projectId, [...(byProject.get(projectId) ?? []), row]);
    }
    return [...byProject.entries()].map(([projectId, projectRows]): Group => ({
      project: projects.get(projectId), projectId, rows: projectRows,
      dayMs: boundaries.slice(0, -1).map((_, day) => projectRows.reduce((sum, row) => sum + row.dayMs[day]!, 0)),
      totalMs: projectRows.reduce((sum, row) => sum + row.totalMs, 0),
    })).sort((a, b) => (a.project?.order ?? Infinity) - (b.project?.order ?? Infinity));
  }, [rows, threads, projects, boundaries]);
  const dayTotals = dayStarts.map((_, day) => rows.reduce((sum, row) => sum + row.dayMs[day]!, 0));
  const total = dayTotals.reduce((sum, ms) => sum + ms, 0);
  const today = startOfDay(now);
  const [copied, setCopied] = useState(false);

  const copyCsv = async () => {
    const lines = [["Project", "Thread", "Thread ID", ...dayStarts.map((t) => longDayFormat.format(t)), "Total"]];
    for (const group of groups) {
      for (const row of group.rows) {
        lines.push([group.project?.name ?? group.projectId, threads.get(row.threadId)?.title ?? row.threadId, row.threadId,
          ...row.dayMs.map((ms) => formatHours(ms) || "0"), formatHours(row.totalMs) || "0"]);
      }
    }
    const ok = await experimental_copyToClipboard({ text: lines.map((line) => line.map(csvCell).join(",")).join("\n") }).catch(() => false);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 2_000);
  };

  const dayCell = (ms: number, dayStart: number, className = "") => <td key={dayStart}
    className={`px-3 py-1.5 text-right tabular-nums ${dayStart === today ? "bg-primary/5" : ""} ${className}`}>
    {formatHours(ms) || <span className="text-muted-foreground/50">–</span>}
  </td>;

  if (rows.length === 0) {
    return <div role="status" className="rounded-md border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">No agent activity in this range.</div>;
  }
  return <div className="rounded-md border border-border bg-card">
    <div className="overflow-x-auto"><table className="w-full border-collapse text-sm" style={{ minWidth: 220 + dayCount * 72 }}>
      <thead className="sticky top-0 z-10">
        <tr className="text-[11px] uppercase tracking-wider text-muted-foreground [&>th]:border-b [&>th]:border-border [&>th]:bg-card [&>th:first-child]:rounded-tl-lg [&>th:last-child]:rounded-tr-lg">
          <th className="px-3 py-2 text-left font-medium">{grouping === "project" ? "Project" : "Thread"}</th>
          {dayStarts.map((dayStart) => <th key={dayStart} className={`w-[4.5rem] p-0 text-right font-medium ${dayStart === today ? "text-foreground" : ""}`}>
            <button type="button" title="Show this day in the calendar" onClick={() => onSelectDay(dayStart)}
              className={`w-full px-3 py-2 text-right uppercase transition-colors hover:bg-muted/60 hover:text-foreground ${dayStart === today ? "bg-primary/5" : ""}`}>
              {weekdayFormat.format(dayStart)} {new Date(dayStart).getDate()}
            </button>
          </th>)}
          <th className="w-20 px-3 py-2 text-right font-medium">Total</th>
        </tr>
      </thead>
      <tbody>{groups.map((group) => <GroupRows key={group.projectId} group={group} showThreads={grouping === "thread"} dayStarts={dayStarts} threads={threads} threadColor={threadColor} ongoing={ongoing} dayCell={dayCell} onOpen={onOpen} />)}</tbody>
      <tfoot>
        <tr className="border-t border-border font-semibold">
          <td className="px-3 py-2">Total</td>
          {dayTotals.map((ms, day) => dayCell(ms, dayStarts[day]!, "py-2"))}
          <td className="px-3 py-2 text-right tabular-nums">{formatHours(total) || "0"}</td>
        </tr>
      </tfoot>
    </table></div>
    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
      <p>Decimal hours of calendar time per thread and day.</p>
      <button type="button" onClick={() => void copyCsv()} className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-muted">
        <Icon name={copied ? "Check" : "Copy"} className="size-3.5" />{copied ? "Copied" : "Copy as CSV"}
      </button>
    </div>
  </div>;
}

function GroupRows({ group, showThreads, dayStarts, threads, threadColor, ongoing, dayCell, onOpen }: {
  group: Group; showThreads: boolean; dayStarts: number[]; threads: Map<string, ActivityThread>; threadColor: Map<string, string>; ongoing: Set<string>;
  dayCell: (ms: number, dayStart: number, className?: string) => ReactNode; onOpen: (threadId: string) => void;
}) {
  return <>
    <tr className="border-b border-border bg-muted/40 font-medium">
      <td className="px-3 py-1.5"><span className="flex items-center gap-2"><Swatch color={group.project?.color ?? OTHER_COLOR} />{group.project?.name ?? "Unknown project"}</span></td>
      {group.dayMs.map((ms, day) => dayCell(ms, dayStarts[day]!))}
      <td className="px-3 py-1.5 text-right tabular-nums">{formatHours(group.totalMs)}</td>
    </tr>
    {showThreads ? group.rows.map((row) => {
      const thread = threads.get(row.threadId); const color = threadColor.get(row.threadId);
      return <tr key={row.threadId} className="border-b border-border/60 hover:bg-muted/30">
        <td className="max-w-0 py-1.5 pl-7 pr-3">
          <button type="button" onClick={() => onOpen(row.threadId)} title={`${thread?.title ?? row.threadId} · ${formatDuration(row.activeMs) || "<1m"} of agent turns`}
            className="flex w-full min-w-0 items-center gap-1.5 text-left hover:underline">
            {color ? <Swatch color={color} /> : null}{ongoing.has(row.threadId) ? <RunningDot /> : null}
            <span className="truncate">{thread?.title ?? row.threadId}</span>
            {thread?.archived ? <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">archived</span> : null}
          </button>
        </td>
        {row.dayMs.map((ms, day) => dayCell(ms, dayStarts[day]!))}
        <td className="px-3 py-1.5 text-right font-medium tabular-nums">{formatHours(row.totalMs)}</td>
      </tr>;
    }) : null}
  </>;
}
