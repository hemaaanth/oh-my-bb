// Calendar grid ported from Agent Calendar (app.tsx) by charpeni/bb-plugins agent-calendar.
// https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-calendar
// Copyright (c) charpeni. MIT License.
//
// Journal adds the work day to each block: summary, outcome, category, child
// threads, and a work-type color mode.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import type { CalendarActivity } from "./server";
import { CATEGORIES, categoryLabels, type JournalCategory } from "./shared";
import {
  dayBoundaries, filterCalls, formatDuration, groupBlocks, layoutDayWithCalls, MINUTE_MS, startOfDay, wallMinutes,
  type ActivityBlock, type CallSegment, type DaySegment, type GroupBlock, type MergeGapMinutes,
} from "./calendar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type Activity = CalendarActivity;
export type ActivityThread = Activity["threads"][number];
export type CalendarBlock = Activity["blocks"][number];
export type Grouping = "thread" | "project";
export type ColorMode = "project" | "work";
export type ProjectStyle = { id: string; name: string; color: string; order: number };
export type CalendarFilters = { query: string; category: JournalCategory | "all"; projectId: string };
export type CalendarCall = NonNullable<Activity["calls"]>[number];

// Week stays compact; Day and 3 days give a quarter hour room for one line.
const WEEK_HOUR_PX = 48;
const FOCUS_HOUR_PX = 64;
// The grid always shows working hours; earlier or later work widens it.
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 18;
const POPOVER_WIDTH = 300;
const POPOVER_MAX_HEIGHT = 380;
// Grace period for the pointer to cross from a block to its card.
const POPOVER_CLOSE_DELAY_MS = 150;
// The Dispatch call rail: a thin pill on each day's left edge.
const CALL_RAIL_WIDTH_PX = 6;
const CALL_RAIL_MIN_PX = 8;
const CALL_ICON_MIN_PX = 18;

// Fixed-order categorical palette, validated for CVD separation in both modes.
// Projects outside the eight busiest, and blocks with no category, share a neutral color.
const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
} as const;
export const OTHER_COLOR = "#898781";
/** Dispatch calls: one violet outside both palettes, in the widest hue gap between indigo and pink. */
const CALL_COLOR = { light: "#a335c0", dark: "#c46ae0" } as const;
const COLOR_SLOT_COUNT = 8;

/** The eight work-type color slots. Related categories share a slot. */
export const WORK_TYPES: ReadonlyArray<{ id: string; label: string; categories: readonly JournalCategory[] }> = [
  { id: "feature", label: "Feature", categories: ["feature"] },
  { id: "improvement", label: "Improvement", categories: ["improvement"] },
  { id: "bug-fix", label: "Bug fix", categories: ["bug-fix"] },
  { id: "research", label: "Research & analysis", categories: ["research", "analysis"] },
  { id: "operations", label: "Operations", categories: ["operations"] },
  { id: "content", label: "Content", categories: ["content"] },
  { id: "planning", label: "Planning & project", categories: ["planning", "project"] },
  { id: "review", label: "Review & test", categories: ["review", "test"] },
];
const workTypeSlot = new Map(WORK_TYPES.flatMap((type, slot) => type.categories.map((category) => [category, slot] as const)));

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
export const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
export const longDayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const formatSpan = (start: number, end: number) => `${timeFormat.format(start)} – ${timeFormat.format(end)}`;

/** A block's category: the root thread-day's, falling back to the thread's. */
export function blockCategory(block: CalendarBlock, thread: ActivityThread | undefined): JournalCategory | null {
  return block.work?.category ?? thread?.category ?? null;
}

/**
 * Colors. By project, the server hands the palette to the busiest projects of
 * the last 30 days, so a project keeps its color in every view. By work type,
 * each of the eight slots has a fixed color.
 */
export function useColors(activity: Activity | null) {
  const { mode } = experimental_useCodeTheme();
  const projects = useMemo(() => {
    const styles = new Map<string, ProjectStyle>();
    if (!activity) return styles;
    const slots = new Map(activity.colorOrder.map((id, slot) => [id, slot]));
    const names = new Map(activity.projects.map((project) => [project.id, project.name]));
    const order = new Map(activity.projects.map((project, index) => [project.id, index]));
    // Every known project, so views outside this range (all-time activity) color the same way.
    for (const id of new Set([...activity.projects.map((project) => project.id), ...activity.threads.map((thread) => thread.projectId)])) {
      const slot = slots.get(id);
      styles.set(id, {
        id, name: names.get(id) ?? "Unknown project", color: slot === undefined ? OTHER_COLOR : PALETTE[mode][slot]!,
        // Colored projects first, in slot order; the rest in bb's order.
        order: slot ?? COLOR_SLOT_COUNT + (order.get(id) ?? activity.projects.length),
      });
    }
    return styles;
  }, [activity, mode]);
  const categoryColor = (category: JournalCategory | null) => {
    const slot = category ? workTypeSlot.get(category) : undefined;
    return slot === undefined ? OTHER_COLOR : PALETTE[mode][slot]!;
  };
  return { projects, categoryColor, call: CALL_COLOR[mode] };
}

export function Segmented<T extends string | number>({ label, value, options, onChange, onHover, title }: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (next: T) => void; title?: string;
  /** Runs when the pointer reaches another option, so its data can load before the click. */
  onHover?: (next: T) => void;
}) {
  // As tall as the h-8 buttons beside it. No shadow: the theme's shadow-sm drops 2px and makes the pill look low.
  return <div role="group" aria-label={label} title={title} className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
    {options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}
      onPointerEnter={onHover && option.value !== value ? () => onHover(option.value) : undefined}
      className={`flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors ${option.value === value ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{option.label}</button>)}
  </div>;
}

export function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />;
}

/**
 * How many rows of a long list to render: the first screenful at once, the rest
 * after that first paint, so a view switch shows content without waiting for all of it.
 */
export function useRevealed(total: number, first = 40): number {
  const [all, setAll] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const frame = window.requestAnimationFrame(() => { timer = window.setTimeout(() => setAll(true)); });
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, []);
  return all ? total : Math.min(total, first);
}

export function RunningDot() {
  return <span className="relative inline-flex size-2 shrink-0" aria-label="Running now">
    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
  </span>;
}

function peakParallel(blocks: readonly ActivityBlock[]): number {
  const edges = blocks.flatMap((block) => [{ t: block.start, delta: 1 }, { t: block.end, delta: -1 }]);
  edges.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let current = 0; let peak = 0;
  for (const edge of edges) { current += edge.delta; peak = Math.max(peak, current); }
  return peak;
}

export function CalendarStats({ activity }: { activity: Activity }) {
  const calendarMs = activity.blocks.reduce((sum, block) => sum + block.end - block.start, 0);
  const activeMs = activity.blocks.reduce((sum, block) => sum + block.activeMs, 0);
  const stats = [
    { label: "Threads", value: String(new Set(activity.blocks.map((block) => block.threadId)).size) },
    { label: "On the calendar", value: formatDuration(calendarMs) || "0m" },
    { label: "Agent turns", value: formatDuration(activeMs) || "0m" },
    { label: "Peak in parallel", value: String(peakParallel(activity.blocks)) },
  ];
  return <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">{stats.map((stat) => <div key={stat.label} className="rounded-lg border border-border bg-card px-3 py-2">
    <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{stat.label}</dt>
    <dd className="mt-0.5 text-lg font-semibold tabular-nums">{stat.value}</dd>
  </div>)}</dl>;
}

/** The color key: projects or work types on the calendar, following the color mode. Hours live in the time sheet. */
export function CalendarLegend({ activity, colorMode, colors }: { activity: Activity; colorMode: ColorMode; colors: ReturnType<typeof useColors> }) {
  const threads = new Map(activity.threads.map((thread) => [thread.id, thread]));
  const present = new Set(activity.blocks.map((block) => {
    const thread = threads.get(block.threadId);
    return colorMode === "project" ? (thread?.projectId ?? "") : String(workTypeSlot.get(blockCategory(block, thread)!) ?? "other");
  }));
  const items = colorMode === "project"
    ? [...colors.projects.values()].sort((a, b) => a.order - b.order).map((project) => ({ key: project.id, label: project.name, color: project.color }))
    : [...WORK_TYPES.map((type, slot) => ({ key: String(slot), label: type.label, color: colors.categoryColor(type.categories[0]!) })),
      { key: "other", label: "Uncategorized", color: OTHER_COLOR }];
  // Child threads can sit in other projects, but their time counts toward the root.
  const shown = items.filter((item) => present.has(item.key));
  if (activity.calls?.length) shown.push({ key: "dispatch-calls", label: "Dispatch calls", color: colors.call });
  return <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label={colorMode === "project" ? "Projects" : "Work types"}>{shown.map((item) => <li key={item.key} className="flex items-center gap-1.5">
    <Swatch color={item.color} /><span data-bb-demo-sensitive={colorMode === "project" && item.key !== "dispatch-calls" ? "" : undefined}>{item.label}</span>
  </li>)}</ul>;
}

/** One calendar entry: a project's or a thread's merged blocks, ready to draw. */
type Entry = GroupBlock & {
  projectId: string; title: string; detail: string; blocks: CalendarBlock[]; category: JournalCategory | null;
};
type Segment = DaySegment<Entry>;

function blockMatches(block: CalendarBlock, thread: ActivityThread | undefined, filters: CalendarFilters): boolean {
  if (filters.projectId !== "all" && thread?.projectId !== filters.projectId) return false;
  if (filters.category !== "all" && blockCategory(block, thread) !== filters.category) return false;
  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  return [thread?.title, block.work?.summary, block.work?.outcome].some((text) => text?.toLowerCase().includes(query));
}

/**
 * The panel filters, applied once: every view reads only matching blocks, and the turns of their root threads.
 * Search also reaches call titles and summaries; project and work-type filters leave calls alone.
 */
export function filterActivity(activity: Activity, filters: CalendarFilters): Activity {
  if (filters.projectId === "all" && filters.category === "all" && !filters.query.trim()) return activity;
  const threads = new Map(activity.threads.map((thread) => [thread.id, thread]));
  const blocks = activity.blocks.filter((block) => blockMatches(block, threads.get(block.threadId), filters));
  const roots = new Set(blocks.map((block) => block.threadId));
  return {
    ...activity, blocks, turns: activity.turns.filter((turn) => roots.has(threads.get(turn.threadId)?.rootThreadId ?? turn.threadId)),
    ...(activity.calls ? { calls: filterCalls(activity.calls, filters.query) } : {}),
  };
}

function buildEntries(activity: Activity, grouping: Grouping, gap: MergeGapMinutes, projects: Map<string, ProjectStyle>): Entry[] {
  const threads = new Map(activity.threads.map((thread) => [thread.id, thread]));
  const projectOf = (threadId: string) => threads.get(threadId)?.projectId ?? "";
  if (grouping === "thread") {
    return activity.blocks.map((block) => {
      const thread = threads.get(block.threadId); const projectId = projectOf(block.threadId);
      return {
        key: block.threadId, start: block.start, end: block.end, activeMs: block.activeMs, ongoing: block.ongoing,
        threads: [{ threadId: block.threadId, ms: block.end - block.start }], projectId, title: thread?.title ?? block.threadId,
        detail: projects.get(projectId)?.name ?? "Unknown project", blocks: [block], category: blockCategory(block, thread),
      };
    });
  }
  return groupBlocks(activity.blocks, projectOf, gap * MINUTE_MS).map((group) => {
    const members = activity.blocks.filter((block) => projectOf(block.threadId) === group.key && block.start >= group.start && block.end <= group.end);
    // A project entry takes the category with the most calendar time.
    const byCategory = new Map<JournalCategory | null, number>();
    for (const block of members) {
      const category = blockCategory(block, threads.get(block.threadId));
      byCategory.set(category, (byCategory.get(category) ?? 0) + block.end - block.start);
    }
    return {
      ...group, projectId: group.key, title: projects.get(group.key)?.name ?? "Unknown project",
      detail: group.threads.length === 1 ? "1 thread" : `${group.threads.length} threads`, blocks: members,
      category: [...byCategory].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    };
  });
}

/** The one open card: a block's, or a call's. A clicked call stays pinned until a click outside or Escape. */
type Popover = { left: number; top: number } & ({ entry: Entry; call?: undefined } | { call: CalendarCall; pinned: boolean; entry?: undefined });

function PopoverCard({ popover, label, onHold, onRelease, children }: {
  popover: Popover; label: string; onHold: () => void; onRelease: () => void; children: ReactNode;
}) {
  return <div data-bb-demo-sensitive role="dialog" aria-label={label} data-journal-calendar-popover=""
    onMouseEnter={onHold} onMouseLeave={onRelease} onFocus={onHold}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onRelease(); }}
    className="absolute z-30 overflow-y-auto rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
    style={{ left: popover.left, top: popover.top, width: POPOVER_WIDTH, maxWidth: "100%", maxHeight: POPOVER_MAX_HEIGHT }}>{children}</div>;
}

function EntryPopover({ popover, entry, grouping, color, threads, onOpen, onSetCategory, onHold, onRelease }: {
  popover: Popover; entry: Entry; grouping: Grouping; color: string; threads: Map<string, ActivityThread>;
  onOpen: (threadId: string) => void; onSetCategory: (threadId: string, category: JournalCategory) => void;
  onHold: () => void; onRelease: () => void;
}) {
  const block = grouping === "thread" ? entry.blocks[0] : undefined;
  const thread = block ? threads.get(block.threadId) : undefined;
  const work = block?.work ?? null;
  const showSummary = work?.summary && work.summary.trim().toLowerCase() !== entry.title.trim().toLowerCase();
  const childOutcome = new Map(work?.children.map((child) => [child.threadId, child]) ?? []);
  const childIds = block ? [...new Set([...block.childThreadIds, ...childOutcome.keys()])] : [];
  const status = [thread?.archived ? "archived" : thread?.status, work?.workStatus && work.workStatus !== "unknown" ? work.workStatus : null].filter(Boolean).join(" · ");
  return <PopoverCard popover={popover} label={entry.title} onHold={onHold} onRelease={onRelease}>
    <p className="text-sm font-medium leading-snug">{entry.title}</p>
    <p className="mt-1 flex items-center gap-1.5 text-muted-foreground"><Swatch color={color} /><span className="truncate">{entry.detail}</span>
      {status ? <span className="shrink-0">· {status}</span> : null}{work?.provisional ? <span className="shrink-0 italic">· provisional</span> : null}</p>
    {showSummary ? <p className="mt-2 leading-5">{work.summary}</p> : null}
    {work?.outcome && work.outcome !== work.summary ? <p className="mt-1 leading-5 text-muted-foreground">{work.outcome}</p> : null}
    <p className="mt-2 tabular-nums">{longDayFormat.format(entry.start)} · {formatSpan(entry.start, entry.end)}</p>
    <p className="mt-0.5 tabular-nums text-muted-foreground">{formatDuration(entry.end - entry.start)} on the calendar · {formatDuration(entry.activeMs) || "<1m"} of agent turns</p>
    {entry.ongoing ? <p className="mt-2 flex items-center gap-1.5 font-medium"><RunningDot /> Running now</p> : null}
    {block ? <div className="mt-2 flex items-center gap-2 text-muted-foreground">Work type
      <Select value={blockCategory(block, thread) ?? ""} onValueChange={(value) => { if (CATEGORIES.includes(value as JournalCategory)) onSetCategory(block.threadId, value as JournalCategory); }}>
        <SelectTrigger aria-label="Work type" className="h-7 flex-1 text-xs"><SelectValue placeholder="Not categorized" /></SelectTrigger>
        {/* The menu renders outside the card; the marker keeps clicks and focus in it counted as inside. */}
        <SelectContent data-journal-calendar-popover="">{CATEGORIES.map((value) => <SelectItem key={value} value={value} className="text-xs">{categoryLabels[value]}</SelectItem>)}</SelectContent>
      </Select></div> : null}
    {childIds.length > 0 ? <ul className="mt-2 space-y-px border-t border-border pt-2">{childIds.map((id) => {
      const child = childOutcome.get(id); const text = `↳ ${threads.get(id)?.title ?? child?.title ?? id}${child?.outcome ? ` · ${child.outcome}` : ""}`;
      return <li key={id}><button type="button" onClick={() => onOpen(id)} className="block w-full truncate rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground">{text}</button></li>;
    })}</ul> : null}
    {grouping === "project" ? <ul className="mt-2 max-h-64 space-y-px overflow-y-auto border-t border-border pt-2">{entry.threads.map((item) => {
      const content = <><span className="min-w-0 flex-1 truncate">{threads.get(item.threadId)?.title ?? item.threadId}</span><span className="shrink-0 tabular-nums text-muted-foreground">{formatDuration(item.ms)}</span></>;
      return <li key={item.threadId}><button type="button" onClick={() => onOpen(item.threadId)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted">{content}</button></li>;
    })}</ul> : null}
    {block ? <Button size="sm" variant="outline" className="mt-3 h-7 w-full text-xs" onClick={() => onOpen(block.threadId)}>Open thread<Icon name="ArrowRight" className="size-3.5" /></Button> : null}
  </PopoverCard>;
}

const callSpan = (call: CalendarCall) => call.end === null ? `${timeFormat.format(call.start)} – now` : formatSpan(call.start, call.end);
const callDevice = (call: CalendarCall) => [call.channel === "phone" ? "Phone" : "App", call.device].filter(Boolean).join(" · ");

/** A Dispatch call. Without call memory it shows only the time, duration, and device. */
function CallPopover({ popover, call, color, threads, now, onOpen, onHold, onRelease }: {
  popover: Popover; call: CalendarCall; color: string; threads: Map<string, ActivityThread>; now: number;
  onOpen: (threadId: string) => void; onHold: () => void; onRelease: () => void;
}) {
  const title = (call.remembered && call.title) || "Dispatch call";
  return <PopoverCard popover={popover} label={title} onHold={onHold} onRelease={onRelease}>
    <p className="text-sm font-medium leading-snug">{title}</p>
    <p className="mt-1 flex items-center gap-1.5 text-muted-foreground"><Swatch color={color} /><span className="truncate">Dispatch · {callDevice(call)}</span></p>
    {call.remembered && call.summary ? <p className="mt-2 leading-5">{call.summary}</p> : null}
    <p className="mt-2 tabular-nums">{longDayFormat.format(call.start)} · {callSpan(call)}</p>
    <p className="mt-0.5 tabular-nums text-muted-foreground">{formatDuration((call.end ?? now) - call.start) || "<1m"} on the call</p>
    {call.end === null ? <p className="mt-2 flex items-center gap-1.5 font-medium"><RunningDot /> On the call now</p> : null}
    {call.threadIds.length > 0 ? <ul className="mt-2 space-y-px border-t border-border pt-2">{call.threadIds.map((id) => <li key={id}>
      <button type="button" onClick={() => onOpen(id)} className="block w-full truncate rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground">↳ {threads.get(id)?.title ?? id}</button>
    </li>)}</ul> : null}
  </PopoverCard>;
}

export function CalendarView({ activity, grouping, gap, colorMode, colors, rangeStart, dayCount, now, onOpen, onSelectDay, onSetCategory }: {
  activity: Activity; grouping: Grouping; gap: MergeGapMinutes; colorMode: ColorMode; colors: ReturnType<typeof useColors>;
  rangeStart: number; dayCount: number; now: number;
  onOpen: (threadId: string) => void; onSelectDay: (dayStart: number) => void; onSetCategory: (threadId: string, category: JournalCategory) => void;
}) {
  const boundaries = useMemo(() => dayBoundaries(rangeStart, dayCount), [rangeStart, dayCount]);
  const rangeKey = `${rangeStart}:${dayCount}`;
  const hourPx = dayCount >= 7 ? WEEK_HOUR_PX : FOCUS_HOUR_PX;
  const threads = useMemo(() => new Map(activity.threads.map((thread) => [thread.id, thread])), [activity.threads]);
  const entries = useMemo(() => buildEntries(activity, grouping, gap, colors.projects), [activity, grouping, gap, colors.projects]);
  const calls = useMemo(() => activity.calls ?? [], [activity.calls]);
  const days = useMemo(() => boundaries.slice(0, -1).map((dayStart, index) => {
    const dayEnd = boundaries[index + 1]!;
    return { dayStart, dayEnd, ...layoutDayWithCalls(entries, calls, dayStart, dayEnd, now) };
  }), [entries, calls, boundaries, now]);
  const today = startOfDay(now);
  const colorOf = (entry: Entry) => colorMode === "work" ? colors.categoryColor(entry.category) : (colors.projects.get(entry.projectId)?.color ?? OTHER_COLOR);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<Popover | null>(null);

  // No inner scroller: the grid trims the empty night hours instead, and widens for any work in them.
  const nowShown = now >= boundaries[0]! && now < boundaries[boundaries.length - 1]!;
  // Calls only widen the grid enough to stay visible.
  const segments: Array<{ top: number; bottom: number }> = days.flatMap((day): Array<{ top: number; bottom: number }> => [...day.segments, ...day.calls]);
  const firstHour = Math.min(DEFAULT_FIRST_HOUR, ...segments.map((segment) => Math.floor(segment.top / 60)), ...(nowShown ? [new Date(now).getHours()] : []));
  const lastHour = Math.max(DEFAULT_LAST_HOUR, ...segments.map((segment) => Math.ceil(segment.bottom / 60)), ...(nowShown ? [new Date(now).getHours() + 1] : []));
  const offset = firstHour * hourPx;

  useEffect(() => setPopover(null), [rangeKey, grouping]);
  // A refetch replaces the entries and calls; keep an open card on the same block or call.
  useEffect(() => setPopover((current) => {
    if (!current) return current;
    if (current.call) { const call = calls.find((next) => next.id === current.call.id); return call ? { ...current, call } : null; }
    const entry = entries.find((next) => next.key === current.entry.key && next.start === current.entry.start);
    return entry ? { ...current, entry } : null;
  }), [entries, calls]);

  // One card: hovering or focusing a block opens it, and it stays open while
  // the pointer or focus is on the block or the card. Leaving both closes it
  // after a short grace period, unless focus is inside the card or its open select.
  const closeTimer = useRef<number | undefined>(undefined);
  const hold = () => window.clearTimeout(closeTimer.current);
  const release = () => {
    hold();
    closeTimer.current = window.setTimeout(() => {
      if (!document.activeElement?.closest("[data-journal-calendar-popover]")) setPopover((current) => current?.call && current.pinned ? current : null);
    }, POPOVER_CLOSE_DELAY_MS);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const open = popover !== null;
  useEffect(() => {
    if (!open) return;
    // Escape in the open work-type menu closes only the menu.
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !(event.target as Element | null)?.closest("[role=listbox]")) setPopover(null); };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest("[data-journal-calendar-popover], [data-journal-calendar-block]")) setPopover(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => { document.removeEventListener("keydown", onKeyDown); document.removeEventListener("pointerdown", onPointerDown, true); };
  }, [open]);

  const place = (target: HTMLElement) => {
    const wrapper = wrapperRef.current; if (!wrapper) return null;
    const area = wrapper.getBoundingClientRect(); const rect = target.getBoundingClientRect();
    const left = rect.right + 8 + POPOVER_WIDTH <= area.right ? rect.right - area.left + 8 : Math.max(0, rect.left - area.left - 8 - POPOVER_WIDTH);
    const top = Math.min(Math.max(0, rect.top - area.top), Math.max(0, area.height - POPOVER_MAX_HEIGHT));
    return { left, top };
  };
  const show = (entry: Entry, target: HTMLElement) => { hold(); const at = place(target); setPopover(at && { ...at, entry }); };
  // Hovering a call opens its card; clicking pins it. A pinned card stays until another card replaces it.
  const showCall = (call: CalendarCall, target: HTMLElement, pin: boolean) => {
    hold();
    const at = place(target);
    setPopover((current) => at && { ...at, call, pinned: pin || (current?.call ? current.call.id === call.id && current.pinned : false) });
  };
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, index) => firstHour + index);
  const gridTemplate = { gridTemplateColumns: `3.25rem repeat(${dayCount}, minmax(0, 1fr))` };

  return <div ref={wrapperRef} className="relative">
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <div style={{ minWidth: 52 + dayCount * 112 }}>
        <div className="sticky top-0 z-20 grid rounded-t-md border-b border-border bg-card" style={gridTemplate}>
          <div />
          {days.map((day) => {
            const label = <>
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{weekdayFormat.format(day.dayStart)}</span>
              <span className={`flex size-6 items-center justify-center rounded-full text-sm font-semibold tabular-nums ${day.dayStart === today ? "bg-primary text-primary-foreground" : ""}`}>{new Date(day.dayStart).getDate()}</span>
            </>;
            const cell = "flex items-center justify-center gap-1.5 border-l border-border px-2 py-1.5";
            // A single day is already in focus; otherwise the header zooms in.
            return dayCount === 1 ? <div key={day.dayStart} className={cell}>{label}</div>
              : <button key={day.dayStart} type="button" title="Show this day" onClick={() => onSelectDay(day.dayStart)} className={`${cell} transition-colors hover:bg-muted/60`}>{label}</button>;
          })}
        </div>
        <div className="relative grid" style={{ ...gridTemplate, height: (lastHour - firstHour) * hourPx }}>
          <div className="relative">{hours.slice(1, -1).map((hour) => <span key={hour} className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground" style={{ top: hour * hourPx - offset }}>{hourFormat.format(new Date(2000, 0, 1, hour))}</span>)}</div>
          {days.map((day) => {
            const weekday = new Date(day.dayStart).getDay();
            return <div key={day.dayStart} className={`relative border-l border-border ${weekday === 0 || weekday === 6 ? "bg-muted/30" : ""}`}>
              {hours.slice(1, -1).map((hour) => <div key={hour} aria-hidden className="absolute inset-x-0 border-t border-border/60" style={{ top: hour * hourPx - offset }} />)}
              {day.calls.map((segment) => <CallPill key={`call:${segment.call.id}`} segment={segment} color={colors.call} hourPx={hourPx} offset={offset}
                active={popover?.call?.id === segment.call.id}
                onShow={(target, pin) => showCall(segment.call, target, pin)} onRelease={release} />)}
              {/* On a day with calls, blocks move right to clear the rail. */}
              <div className="absolute inset-y-0 right-0" style={{ left: day.inset }}>
              {day.segments.map((segment) => {
                const { entry } = segment; const color = colorOf(entry);
                const height = ((segment.bottom - segment.top) / 60) * hourPx - 2; const lane = 100 / segment.lanes;
                const isActive = popover?.entry?.key === entry.key && popover.entry.start === entry.start;
                const style: CSSProperties = {
                  borderLeftColor: color,
                  // Mixed into the card color, not transparency, so grid lines stay hidden.
                  backgroundColor: `color-mix(in oklab, ${color} ${isActive ? 30 : 18}%, var(--card))`,
                  top: (segment.top / 60) * hourPx - offset + 1, height,
                  left: `calc(${segment.lane * lane}% + 2px)`, width: `calc(${segment.span * lane}% - 4px)`,
                };
                // A thread block opens its thread; a project block has no single thread, so it keeps the card.
                return <button key={`${entry.key}:${entry.start}`} type="button" style={style} data-bb-demo-sensitive data-journal-calendar-block=""
                  onClick={(event) => { const threadId = grouping === "thread" ? entry.blocks[0]?.threadId : undefined; if (threadId) onOpen(threadId); else show(entry, event.currentTarget); }}
                  onMouseEnter={(event) => show(entry, event.currentTarget)} onMouseLeave={release}
                  onFocus={(event) => show(entry, event.currentTarget)} onBlur={release}
                  aria-label={`${entry.title}, ${entry.detail}, ${longDayFormat.format(entry.start)} ${formatSpan(entry.start, entry.end)}`}
                  className={`absolute z-10 flex flex-col justify-start overflow-hidden rounded-[4px] border-l-[3px] px-1.5 text-left text-[11px] leading-[14px] text-foreground transition-[background-color] focus-visible:outline-2 focus-visible:outline-ring ${height < 20 ? "py-0" : "py-0.5"}`}>
                  <span className="flex items-center gap-1">{entry.ongoing ? <RunningDot /> : null}<span className="truncate font-medium">{entry.title}</span></span>
                  {height >= 30 ? <span className="block truncate tabular-nums text-muted-foreground">{formatSpan(entry.start, entry.end)}</span> : null}
                  {height >= 44 ? <span className="block truncate text-muted-foreground">{entry.detail}</span> : null}
                </button>;
              })}
              </div>
              {now >= day.dayStart && now < day.dayEnd ? <div aria-hidden className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-primary" style={{ top: (wallMinutes(now, day.dayStart) / 60) * hourPx - offset }}>
                <span className="absolute -left-1 -top-1 size-2.5 rounded-full bg-primary" />
              </div> : null}
            </div>;
          })}
        </div>
      </div>
    </div>
    {popover?.entry ? <EntryPopover popover={popover} entry={popover.entry} grouping={grouping} color={colorOf(popover.entry)} threads={threads} onOpen={onOpen}
      onSetCategory={onSetCategory} onHold={hold} onRelease={release} /> : null}
    {popover?.call ? <CallPopover popover={popover} call={popover.call} color={colors.call} threads={threads} now={now} onOpen={onOpen}
      onHold={hold} onRelease={release} /> : null}
  </div>;
}

/** One call on the rail: a thin pill at the day's left edge, with a phone icon when it has room. */
function CallPill({ segment, color, hourPx, offset, active, onShow, onRelease }: {
  segment: CallSegment<CalendarCall>; color: string; hourPx: number; offset: number; active: boolean;
  onShow: (target: HTMLElement, pin: boolean) => void; onRelease: () => void;
}) {
  const { call } = segment;
  const height = Math.max(CALL_RAIL_MIN_PX, ((segment.bottom - segment.top) / 60) * hourPx - 2);
  const label = `Dispatch call${call.remembered && call.title ? `, ${call.title}` : ""}, ${longDayFormat.format(call.start)} ${callSpan(call)}`;
  return <button type="button" data-bb-demo-sensitive data-journal-calendar-block="" aria-label={label} aria-pressed={active}
    onClick={(event) => onShow(event.currentTarget, true)}
    onMouseEnter={(event) => onShow(event.currentTarget, false)} onMouseLeave={onRelease}
    onFocus={(event) => onShow(event.currentTarget, false)} onBlur={onRelease}
    className="absolute z-10 flex justify-center rounded-full border-0 p-0 pt-px text-white transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring"
    style={{ left: 2, width: CALL_RAIL_WIDTH_PX, top: (segment.top / 60) * hourPx - offset + 1, height, backgroundColor: color, filter: active ? "brightness(1.15)" : undefined }}>
    {height >= CALL_ICON_MIN_PX ? <Icon name="Call" className="size-[6px] shrink-0" /> : null}
    {segment.live ? <span className="absolute -bottom-1 left-1/2 -translate-x-1/2"><RunningDot /></span> : null}
  </button>;
}

export function CalendarEmpty({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}
