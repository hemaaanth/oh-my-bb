// Data: tables, progress, code, diffs, calendars, diagrams, and other small views of data.
import { defineComponent } from "@openuidev/react-lang";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";
import { useCopy, useHost } from "../host.js";
import { Chevron, focusRing, seriesColor, type Group } from "../kit.js";
import { ChartFailed, useChartClass, useHighchart } from "./charts.js";
import { SourceLine } from "../SourceLine.js";
import { FileExcerpt } from "../FileExcerpt.js";
import { ZoomDiagram } from "../viewer.js";

const Table = defineComponent({
  name: "Table",
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))), source: z.string().optional() }),
  description: "A data table. Each row is a list of cells in column order. Numbers align right. source is an optional caption or HTTPS URL; otherwise loaded files are credited. An empty source hides the caption.",
  component: ({ props }) => <div className="flex min-w-0 flex-col gap-1.5"><div className="min-w-0 overflow-x-auto">
    <table className="w-full border-collapse">
      <thead><tr>{props.columns.map((column, i) => <th key={i} className="border-b border-border px-2 py-1.5 text-left font-medium text-muted-foreground first:pl-0">{column}</th>)}</tr></thead>
      <tbody>{props.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} className={`border-b border-border-hairline px-2 py-1.5 text-foreground first:pl-0 ${typeof cell === "number" ? "text-right tabular-nums" : ""}`}>{cell ?? ""}</td>)}</tr>)}</tbody>
    </table>
  </div><SourceLine props={props} /></div>,
});

const Progress = defineComponent({
  name: "Progress",
  props: z.object({ label: z.string(), value: z.number(), max: z.number().optional() }),
  description: "A labelled progress bar. max defaults to 100.",
  component: ({ props }) => {
    const max = props.max && props.max > 0 ? props.max : 100;
    const percent = Math.max(0, Math.min(100, (props.value / max) * 100));
    return <div className="flex flex-col gap-1">
      <div className="flex justify-between gap-3"><span className="text-foreground">{props.label}</span><span className="tabular-nums text-muted-foreground">{props.value} / {max}</span></div>
      <div role="progressbar" aria-label={props.label} aria-valuenow={props.value} aria-valuemin={0} aria-valuemax={max} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${percent}%` }} /></div>
    </div>;
  },
});

const Code = defineComponent({
  name: "Code",
  props: z.object({ code: z.string(), language: z.string().optional() }),
  description: 'A code block with BB\'s highlighting. language is a file extension like "ts", "py", "sh", "json".',
  component: ({ props }) => {
    const { SourceCode } = useHost();
    return <SourceCode content={props.code} path={`snippet.${props.language ?? "txt"}`} />;
  },
});

const Diff = defineComponent({
  name: "Diff",
  props: z.object({ patch: z.string(), file: z.string() }),
  description: "A unified diff of one file in BB's diff viewer. patch is unified diff text with @@ hunks. file is its path.",
  component: ({ props }) => {
    const host = useHost();
    return <host.Diff patch={props.patch} path={props.file} />;
  },
});

const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);
type Tone = z.infer<typeof tone>;
const toneText: Record<Tone, string> = { neutral: "text-muted-foreground", info: "text-primary", success: "text-success", warning: "text-warning", danger: "text-destructive" };
const toneStroke: Record<Tone, string> = { neutral: "stroke-border", info: "stroke-primary", success: "stroke-success", warning: "stroke-warning", danger: "stroke-destructive" };
const toneOf = (value: unknown, fallback: Tone): Tone => typeof value === "string" && value in toneText ? value as Tone : fallback;
const formatNumber = (value: number) => new Intl.NumberFormat("en-US").format(value);
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const textOf = (value: unknown) => typeof value === "string" ? value : isNum(value) ? String(value) : "";

// Ported from GenUI ui/components/calendarMath.ts (Apache-2.0): parseDay to calendarLayout.
// A day is its number since 1970-01-01 in UTC, so "yyyy-mm-dd" maps to a day and back without a time zone moving it.
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A real calendar date written "yyyy-mm-dd" as its day number; anything else is null. */
export function parseDay(value: unknown): number | null {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 2026-02-30 over to March and maps years below 100 into the 1900s.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() / DAY_MS : null;
}

export const dayString = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** "Wed, Mar 4, 2026". */
export const dayLabel = (day: number) => DAY_FORMAT.format(new Date(day * DAY_MS));
/** 0 for Sunday to 6 for Saturday. Day 0 (1970-01-01) was a Thursday. */
export const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;

/** Week columns, Sunday on top, from `first` to `last`, and the column where each month name goes. */
export function calendarLayout(first: number, last: number): { start: number; weeks: number; months: { week: number; label: string }[] } {
  const start = first - weekday(first);
  const weeks = Math.floor((last - start) / 7) + 1;
  const months: { week: number; label: string }[] = [];
  for (let week = 0; week < weeks; week++) {
    for (let row = 0; row < 7; row++) {
      const day = start + week * 7 + row;
      if (day < first || day > last) continue;
      const date = new Date(day * DAY_MS);
      if (day === first || date.getUTCDate() === 1) { months.push({ week, label: MONTHS[date.getUTCMonth()]! }); break; }
    }
  }
  // A month that starts the range late has no room before the next month's name.
  if (months.length > 1 && months[1]!.week - months[0]!.week < 3) months.shift();
  return { start, weeks, months };
}

// Ported from GenUI ui/components/explain-logic.ts (Apache-2.0): monthWeeks and firstWeekday.
/** A month's weeks as day numbers, starting on `firstDay` (0 Sunday). null pads the first and last week. */
export function monthWeeks(year: number, month: number, firstDay: number): (number | null)[][] {
  const start = Date.UTC(year, month - 1, 1) / DAY_MS;
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array.from({ length: (weekday(start) - firstDay + 7) % 7 }, () => null), ...Array.from({ length: count }, (_, i) => start + i)];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/** CLDR regions whose week starts on Sunday or Saturday; everywhere else it is Monday. */
const SUNDAY_REGIONS = "AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW".split(" ");
const SATURDAY_REGIONS = "AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" ");

/** The first day of the week (0 Sunday to 6 Saturday) for a BCP 47 locale. */
export function firstWeekday(locale: string): number {
  let info: Intl.Locale;
  try { info = new Intl.Locale(locale); } catch { return 1; }
  try {
    // A method in Chromium and newer WebKit, a getter in older WebKit; ISO days, 7 is Sunday. Firefox has neither.
    const week = info as Intl.Locale & { getWeekInfo?: () => { firstDay?: number }; weekInfo?: { firstDay?: number } };
    const firstDay = (week.getWeekInfo?.() ?? week.weekInfo)?.firstDay;
    if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
  } catch { /* Fall back to the region tables. */ }
  const region = info.maximize().region ?? "";
  return SUNDAY_REGIONS.includes(region) ? 0 : SATURDAY_REGIONS.includes(region) ? 6 : 1;
}

const monthOf = (day: number) => { const date = new Date(day * DAY_MS); return date.getUTCFullYear() * 12 + date.getUTCMonth(); };
const localToday = () => { const now = new Date(); return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS; };
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

type CalendarEvent = { day: number; title: string; tone: Tone };

const Calendar = defineComponent({
  name: "Calendar",
  props: z.object({ events: z.array(z.object({ date: z.string(), title: z.string(), tone: tone.optional() })), month: z.string().optional() }),
  description: 'A month calendar with events. date is "yyyy-mm-dd". month "yyyy-mm" picks the month shown first; it defaults to the first event\'s month, then today. People step between months and pick a day to see its events. tone colours an event: "info" (default), "success", "warning", "danger", or "neutral".',
  component: ({ props }) => {
    const events: CalendarEvent[] = props.events.flatMap((event) => { const day = parseDay(event?.date); return day === null || !event?.title ? [] : [{ day, title: event.title, tone: toneOf(event.tone, "info") }]; }).sort((a, b) => a.day - b.day);
    const today = localToday();
    const asked = parseDay(`${props.month ?? ""}-01`);
    const [shown, setShown] = useState<number | null>(null);
    const [picked, setPicked] = useState<number | null>(null);
    const [focus, setFocus] = useState<number | null>(null);
    const moved = useRef(false);
    const grid = useRef<HTMLDivElement>(null);
    const [firstDay] = useState(() => typeof navigator === "undefined" ? 0 : firstWeekday(navigator.language));
    // Until someone steps months, the month follows the props as they stream in.
    const month = shown ?? monthOf(asked ?? events[0]?.day ?? today);
    const weeks = monthWeeks(Math.floor(month / 12), (month % 12) + 1, firstDay);
    const days = weeks.flat().filter(isNum);
    const byDay = new Map<number, CalendarEvent[]>();
    for (const event of events) byDay.set(event.day, [...(byDay.get(event.day) ?? []), event]);
    const current = focus !== null && monthOf(focus) === month ? focus : picked !== null && monthOf(picked) === month ? picked : monthOf(today) === month ? today : days[0]!;
    useEffect(() => { if (moved.current) { moved.current = false; grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus(); } }, [focus]);
    const go = (day: number) => { moved.current = true; setFocus(day); setShown(monthOf(day)); };
    const onKeyDown = (event: KeyboardEvent) => {
      const step = STEP[event.key];
      const next = step !== undefined ? current + step : event.key === "Home" ? current - (weekday(current) - firstDay + 7) % 7 : event.key === "End" ? current + 6 - (weekday(current) - firstDay + 7) % 7 : null;
      if (next === null) return;
      event.preventDefault();
      go(next);
    };
    const listed = picked !== null && monthOf(picked) === month ? byDay.get(picked) ?? [] : events.filter((event) => monthOf(event.day) === month);
    const nav = `inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground ${focusRing}`;
    return <div className="flex min-w-0 max-w-sm flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span aria-live="polite" className="font-medium text-foreground">{MONTH_FORMAT.format(new Date(Date.UTC(Math.floor(month / 12), month % 12, 1)))}</span>
        <span className="flex gap-1">
          <button type="button" aria-label="Previous month" onClick={() => setShown(month - 1)} className={nav}>‹</button>
          <button type="button" aria-label="Next month" onClick={() => setShown(month + 1)} className={nav}>›</button>
        </span>
      </div>
      <div ref={grid} onKeyDown={onKeyDown} className="grid grid-cols-7 gap-0.5 text-center">
        {Array.from({ length: 7 }, (_, i) => <span key={i} aria-hidden="true" className="py-1 text-xs text-muted-foreground">{WEEKDAYS[(firstDay + i) % 7]}</span>)}
        {weeks.flat().map((day, i) => { if (day === null) return <span key={i} />; const dayEvents = byDay.get(day) ?? []; return <button key={i} type="button" data-day={day} tabIndex={day === current ? 0 : -1} aria-pressed={day === picked} aria-current={day === today ? "date" : undefined} aria-label={`${dayLabel(day)}${dayEvents.length ? `, ${dayEvents.length} event${dayEvents.length > 1 ? "s" : ""}` : ""}`} onClick={() => { setPicked(day === picked ? null : day); setFocus(day); }} className={`flex h-9 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md tabular-nums ${focusRing} ${day === picked ? "bg-muted font-medium" : "hover:bg-muted"} ${day === today ? "font-semibold text-primary" : "text-foreground"}`}>
          {new Date(day * DAY_MS).getUTCDate()}
          <span className="flex h-1 gap-0.5">{dayEvents.slice(0, 3).map((event, e) => <span key={e} className={`size-1 rounded-full bg-current ${toneText[event.tone]}`} />)}</span>
        </button>; })}
      </div>
      {listed.length > 0 ? <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{listed.map((event, i) => <li key={i} className="flex gap-2"><span className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-current ${toneText[event.tone]}`} /><span className="min-w-0"><span className="text-muted-foreground tabular-nums">{dayLabel(event.day).replace(/, \d{4}$/, "")}</span> <span className="text-foreground">{event.title}</span></span></li>)}</ul>
        : <p className="m-0 text-muted-foreground">{picked !== null && monthOf(picked) === month ? "No events on this day." : "No events this month."}</p>}
    </div>;
  },
});

/** A count's shade, GitHub style: 0 for nothing, else 1 to `levels` by its share of `max`. Ported from GenUI chartMath.ts (Apache-2.0). */
export function heatLevel(value: number, max: number, levels = 4): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(levels, Math.max(1, Math.ceil((value / max) * levels)));
}

type HeatCell = { x: number; y: number; value: number; className: string };

/** The heatmap itself: one cell per day, a column per week, Sunday on top. */
function HeatmapCells({ cells, months, weeks, start, tone, name, summary }: { cells: HeatCell[]; months: { week: number; label: string }[]; weeks: number; start: number; tone: Tone; name: string; summary: string }) {
    const monthAt = new Map(months.map((month) => [month.week, month.label]));
    const step = 13, left = 28, top = 16;
    const width = left + weeks * step, height = top + 7 * step;
    const chartClass = useChartClass();
    // y axes snap to their first and last tick by default, which would hide the Sun and Sat rows.
    const { canvas, failed } = useHighchart(JSON.stringify({ cells, months, tone, width, name }), () => ({
      chart: { type: "heatmap", className: `bb-tone-${tone} hc-simple bb-calendar`, width, height, margin: [top, 0, 0, left], spacing: [0, 0, 0, 0], animation: false },
      legend: { enabled: false },
      xAxis: { min: -0.5, max: weeks - 0.5, opposite: true, lineWidth: 0, tickLength: 0, tickPositions: months.map((month) => month.week), labels: { align: "left", x: -5, y: 11, overflow: "allow", formatter() { return monthAt.get(this.pos) ?? ""; } } },
      yAxis: { min: -0.5, max: 6.5, startOnTick: false, endOnTick: false, reversed: true, title: { enabled: false }, lineWidth: 0, tickPositions: [1, 3, 5], labels: { align: "left", x: -left, formatter() { return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][this.pos] ?? ""; } } },
      tooltip: { shared: false, formatter() { const cell = cells[this.index]; return cell ? `${dayLabel(start + cell.x * 7 + cell.y)}: <b>${formatNumber(cell.value)}</b>` : false; } },
      plotOptions: { series: { animation: false, states: { inactive: { enabled: false } } } },
      series: [{ type: "heatmap", name, data: cells, colsize: 1, rowsize: 1 }],
    }), ["heatmap"]);
  return <>
    <div className="overflow-x-auto"><div role="img" aria-label={summary} className={`${chartClass} relative`} style={{ width, height }}><div ref={canvas} aria-hidden="true" className="absolute inset-0" /></div></div>
    <ChartFailed failed={failed} />
  </>;
}

const CalendarHeatmap = defineComponent({
  name: "CalendarHeatmap",
  props: z.object({ days: z.array(z.object({ date: z.string(), value: z.number() })), label: z.string().optional(), tone: tone.optional() }),
  description: 'Daily counts as a GitHub-style grid of weeks, from the first date to the last. date is "yyyy-mm-dd"; missing days count as 0 and repeated dates add up. label names what is counted, like "Commits". tone colours the cells: "success" (default), "info", "warning", "danger", or "neutral".',
  component: ({ props }) => {
    const values = new Map<number, number>();
    for (const entry of props.days) { const day = parseDay(entry?.date); if (day !== null && isNum(entry?.value)) values.set(day, (values.get(day) ?? 0) + entry.value); }
    if (values.size === 0) return null;
    const keys = [...values.keys()];
    const first = Math.min(...keys), last = Math.max(...keys);
    const { start, weeks, months } = calendarLayout(first, last);
    const max = Math.max(0, ...values.values());
    // Float noise from adding 0.1s must not show as 0.30000000000000004.
    const total = Number([...values.values()].reduce((sum, value) => sum + value, 0).toPrecision(12));
    const label = props.label ?? "Activity";
    const tone = toneOf(props.tone, "success");
    const cells: HeatCell[] = [];
    for (let i = 0; i < weeks * 7; i++) { const day = start + i; if (day < first || day > last) continue; const value = values.get(day) ?? 0; cells.push({ x: Math.floor(i / 7), y: i % 7, value, className: `bb-heat-${heatLevel(value, max)}` }); }
    const opacity = [1, 0.3, 0.55, 0.8, 1];
    const color = toneText[tone];
    return <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <HeatmapCells cells={cells} months={months} weeks={weeks} start={start} tone={tone} name={label} summary={`${label}: ${formatNumber(total)} from ${dayLabel(first)} to ${dayLabel(last)}, at most ${formatNumber(max)} a day`} />
      <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-muted-foreground">
        <span><span className="text-foreground tabular-nums">{formatNumber(total)}</span> {label.toLowerCase()}</span>
        <span aria-hidden="true" className="inline-flex items-center gap-1 text-xs">Less{[0, 1, 2, 3, 4].map((level) => <span key={level} className={`size-2.5 rounded-sm ${level === 0 ? "bg-muted" : `bg-current ${color}`}`} style={{ opacity: opacity[level] }} />)}More</span>
      </figcaption>
    </figure>;
  },
});

/**
 * Layers for a diagram: each node sits one layer below its deepest parent. Edges that close a cycle are
 * ignored for layering. Each layer is then ordered by where its parents sit, so fewer edges cross.
 */
export function layoutDiagram(ids: readonly string[], edges: readonly { from: string; to: string }[]): string[][] {
  const known = new Set(ids);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) if (known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to) out.get(edge.from)!.push(edge.to);
  // Depth-first: an edge back to a node still on the path closes a cycle.
  const state = new Map<string, 1 | 2>(), forward: [string, string][] = [];
  const visit = (id: string) => { state.set(id, 1); for (const to of out.get(id)!) { if (state.get(to) === 1) continue; forward.push([id, to]); if (!state.has(to)) visit(to); } state.set(id, 2); };
  for (const id of ids) if (!state.has(id)) visit(id);
  const layer = new Map(ids.map((id) => [id, 0]));
  // Longest path: relax until stable; a DAG needs at most one pass per node.
  for (let pass = 0, changed = true; changed && pass < ids.length; pass++) {
    changed = false;
    for (const [from, to] of forward) if (layer.get(to)! < layer.get(from)! + 1) { layer.set(to, layer.get(from)! + 1); changed = true; }
  }
  const layers: string[][] = [];
  for (const id of known) (layers[layer.get(id)!] ??= []).push(id);
  for (let l = 1; l < layers.length; l++) {
    const above = new Map(layers[l - 1]!.map((id, i) => [id, i]));
    const rank = new Map(layers[l]!.map((id, i) => { const parents = forward.filter(([from, to]) => to === id && above.has(from)).map(([from]) => above.get(from)!); return [id, parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : i]; }));
    layers[l]!.sort((a, b) => rank.get(a)! - rank.get(b)!);
  }
  return layers.filter(Boolean);
}

const Diagram = defineComponent({
  name: "Diagram",
  props: z.object({ nodes: z.array(z.object({ id: z.string(), label: z.string().optional(), tone: tone.optional() })), edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })), direction: z.enum(["down", "right"]).optional() }),
  description: 'A flow diagram of boxes and arrows, laid out in layers. Each node has an id and an optional label (defaults to the id). Each edge goes from one node id to another, with an optional short label. direction "down" (default) or "right". tone outlines a node: "info", "success", "warning", "danger", or "neutral" (default). Keep it under about 15 nodes.',
  component: ({ props }) => {
    const marker = `arrow${useId().replace(/[^\w-]/g, "")}`;
    const nodes = new Map<string, { label: string; tone: Tone }>();
    for (const node of props.nodes) if (node?.id && !nodes.has(node.id)) nodes.set(node.id, { label: node.label || node.id, tone: toneOf(node.tone, "neutral") });
    const edges = props.edges.filter((edge) => nodes.has(edge?.from) && nodes.has(edge?.to));
    if (nodes.size === 0) return null;
    const layers = layoutDiagram([...nodes.keys()], edges);
    const right = props.direction === "right";
    const short = (label: string) => label.length > 26 ? `${label.slice(0, 25)}…` : label;
    const w = Math.min(180, Math.max(72, Math.max(...[...nodes.values()].map((node) => short(node.label).length)) * 7 + 24)), h = 34, pad = 4;
    // Lay out along (down the layers) and across (within a layer), then turn the points for "right".
    const H = right ? w : h, C = right ? h : w, along = H + (right ? 56 : 44), across = C + (right ? 16 : 20);
    const xy = (a: number, c: number) => right ? [a, c] as const : [c, a] as const, pt = (a: number, c: number) => xy(a, c).join(",");
    const widest = Math.max(...layers.map((layer) => layer.length));
    const at = new Map<string, { a: number; c: number; layer: number }>();
    layers.forEach((layer, l) => layer.forEach((id, i) => at.set(id, { a: pad + l * along, c: pad + (i + (widest - layer.length) / 2) * across, layer: l })));
    // Edges to the next layer go straight across the gap. Longer and backward edges each take a lane past the far side, so they never cross a box.
    const outer = pad + (widest - 1) * across + C;
    let lanes = 0, room = 0;
    const routes = edges.map((edge) => {
      const s = at.get(edge.from)!, t = at.get(edge.to)!;
      if (t.layer === s.layer + 1) {
        const [sa, sc, ta, tc] = [s.a + H, s.c + C / 2, t.a, t.c + C / 2], mid = (sa + ta) / 2;
        return { d: `M${pt(sa, sc)} C${pt(mid, sc)} ${pt(mid, tc)} ${pt(ta, tc)}`, label: [mid, (sc + tc) / 2] as const };
      }
      const lane = outer + 14 * ++lanes, r = 6, sa = s.a + H / 2, ta = t.a + H / 2, dir = ta > sa ? 1 : -1;
      if (edge.label) room = Math.max(room, right ? 8 : edge.label.length * 3.3);
      return { d: `M${pt(sa, s.c + C)} L${pt(sa, lane - r)} Q${pt(sa, lane)} ${pt(sa + dir * r, lane)} L${pt(ta - dir * r, lane)} Q${pt(ta, lane)} ${pt(ta, lane - r)} L${pt(ta, t.c + C)}`, label: [(sa + ta) / 2, lane] as const };
    });
    const alongSize = 2 * pad + (layers.length - 1) * along + H, acrossSize = outer + 14 * lanes + room + pad;
    const [width, height] = right ? [alongSize, acrossSize] : [acrossSize, alongSize];
    const name = (id: string) => nodes.get(id)!.label;
    return <ZoomDiagram width={width} height={height} label="Diagram"><svg role="img" aria-label={`Diagram: ${edges.length ? edges.map((edge) => `${name(edge.from)} to ${name(edge.to)}`).join(", ") : [...nodes.values()].map((node) => node.label).join(", ")}`} width={width} viewBox={`0 0 ${width} ${height}`} className="h-auto max-w-full" style={{ fontSize: 12 }}>
      <defs><marker id={marker} viewBox="0 0 8 8" refX={8} refY={4} markerWidth={8} markerHeight={8} orient="auto-start-reverse" className="text-muted-foreground"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
      {routes.map((route, i) => { const [x, y] = xy(...route.label); return <g key={i}>
        <path d={route.d} fill="none" className="stroke-muted-foreground" strokeWidth={1.25} markerEnd={`url(#${marker})`} />
        {edges[i]!.label ? <text x={x} y={y} dy="0.32em" textAnchor="middle" className="fill-muted-foreground stroke-background" strokeWidth={4} paintOrder="stroke" style={{ fontSize: 11 }}>{edges[i]!.label}</text> : null}
      </g>; })}
      {[...at].map(([id, { a, c }]) => { const node = nodes.get(id)!, [x, y] = xy(a, c); return <g key={id}>
        <rect x={x} y={y} width={w} height={h} rx={4} className={`fill-background ${toneStroke[node.tone]}`} strokeWidth={node.tone === "neutral" ? 1 : 1.5} />
        <text x={x + w / 2} y={y + h / 2} dy="0.32em" textAnchor="middle" className="fill-foreground">{short(node.label)}{node.label.length > 26 ? <title>{node.label}</title> : null}</text>
      </g>; })}
    </svg></ZoomDiagram>;
  },
});

const Gauge = defineComponent({
  name: "Gauge",
  props: z.object({ label: z.string(), value: z.number(), max: z.number().optional(), tone: tone.optional() }),
  description: 'One value on a half-circle dial from 0 to max (default 100), like a score or a utilisation. tone colours the dial: "info" (default), "success", "warning", "danger", or "neutral".',
  component: ({ props }) => {
    const max = props.max && props.max > 0 ? props.max : 100;
    const value = Math.max(0, Math.min(max, props.value));
    const tone = toneOf(props.tone, "info");
    const chartClass = useChartClass();
    // A 144 by 77 box: the arc's centre sits near the bottom, with room for the value inside it.
    const { canvas, failed } = useHighchart(JSON.stringify({ max, value, tone }), () => ({
      chart: { type: "solidgauge", className: `bb-tone-${tone}`, margin: [0, 0, 0, 0], spacing: [0, 0, 0, 0] },
      legend: { enabled: false },
      tooltip: { enabled: false },
      pane: { center: ["50%", 67], size: 122, startAngle: -90, endAngle: 90, background: [{ shape: "arc", innerRadius: "80%", outerRadius: "100%", className: "bb-track", borderWidth: 0 }] },
      yAxis: { min: 0, max, lineWidth: 0, tickWidth: 0, minorTickInterval: undefined, tickPositions: [], labels: { enabled: false } },
      plotOptions: { solidgauge: { innerRadius: "80%", radius: "100%", rounded: false, dataLabels: { enabled: false }, enableMouseTracking: false, states: { inactive: { enabled: false } } } },
      series: [{ type: "solidgauge", name: props.label, data: [{ y: value, colorIndex: 0 }] }],
    }), ["solidGauge"]);
    return <div role="meter" aria-label={props.label} aria-valuenow={props.value} aria-valuemin={0} aria-valuemax={max} className="flex w-36 flex-col items-center">
      <div className={`${chartClass} relative h-[77px] w-full`}>
        <div ref={canvas} aria-hidden="true" className="absolute inset-0" />
        <span aria-hidden="true" className="absolute inset-x-0 bottom-2 text-center text-lg font-semibold leading-none tabular-nums text-foreground">{formatNumber(props.value)}</span>
      </div>
      <ChartFailed failed={failed} />
      <span className="text-center text-muted-foreground">{props.label}{props.max ? <span className="tabular-nums"> of {formatNumber(max)}</span> : null}</span>
    </div>;
  },
});

/**
 * Whole percentages that always add up to 100 (largest remainder): the shares that lost the most to rounding get the spare points.
 * Ported from GenUI chartMath.ts (Apache-2.0).
 */
export function percentages(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || !Number.isFinite(total)) return values.map(() => 0);
  const exact = values.map((value) => (value / total) * 100);
  const whole = exact.map(Math.floor);
  const order = exact.map((share, index) => ({ index, remainder: share - whole[index]! })).sort((a, b) => b.remainder - a.remainder || values[b.index]! - values[a.index]! || a.index - b.index);
  for (let k = 0, spare = 100 - whole.reduce((sum, value) => sum + value, 0); k < spare; k++) whole[order[k % order.length]!.index]! += 1;
  return whole;
}

const SegmentedBar = defineComponent({
  name: "SegmentedBar",
  props: z.object({ parts: z.array(z.object({ label: z.string(), value: z.number(), tone: tone.optional() })), label: z.string().optional() }),
  description: "One bar split into parts by value, with a legend of each part's value and share, like a budget or a disk. Parts without a tone take the chart colours in order.",
  component: ({ props }) => {
    const parts = props.parts.filter((part) => typeof part?.label === "string" && isNum(part?.value) && part.value > 0);
    const total = parts.reduce((sum, part) => sum + part.value, 0);
    if (parts.length === 0) return null;
    const shares = percentages(parts.map((part) => part.value));
    const color = (i: number) => parts[i]!.tone ? toneText[toneOf(parts[i]!.tone, "neutral")] : seriesColor[i % seriesColor.length];
    return <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      {props.label ? <div className="flex justify-between gap-3"><span className="text-foreground">{props.label}</span><span className="tabular-nums text-muted-foreground">{formatNumber(total)}</span></div> : null}
      <div role="img" aria-label={`${props.label ? `${props.label}: ` : ""}${parts.map((part, i) => `${part.label} ${shares[i]}%`).join(", ")}`} className="flex h-2 gap-0.5 overflow-hidden rounded-sm">{parts.map((part, i) => <span key={i} className={`h-full bg-current ${color(i)}`} style={{ width: `${(part.value / total) * 100}%` }} />)}</div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">{parts.map((part, i) => <span key={i} className="inline-flex items-center gap-1.5"><span className={`size-2 shrink-0 rounded-full bg-current ${color(i)}`} /><span className="text-foreground">{part.label}</span><span className="tabular-nums">{formatNumber(part.value)} · {shares[i]}%</span></span>)}</figcaption>
    </figure>;
  },
});

const Snippet = defineComponent({
  name: "Snippet",
  props: z.object({ text: z.string(), label: z.string().optional() }),
  description: "A short line of code or text with a Copy button, like a command to run, an ID, or a URL. For longer code with highlighting use Code.",
  component: ({ props }) => {
    const [copied, copy] = useCopy(props.text);
    return <div className="flex min-w-0 flex-col gap-1">
      {props.label ? <span className="text-muted-foreground">{props.label}</span> : null}
      <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-2.5 py-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-foreground">{props.text}</code>
        <button type="button" onClick={copy} aria-label={props.label ? `Copy ${props.label}` : "Copy"} className={`shrink-0 cursor-pointer rounded-sm text-xs text-muted-foreground hover:text-foreground ${focusRing}`}><span aria-live="polite">{copied ?? "Copy"}</span></button>
      </div>
    </div>;
  },
});

const FileCode = defineComponent({
  name: "FileCode",
  props: z.object({ file: z.string().min(1), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }),
  description: "Read source lines from a real file in the thread workspace, thread storage, or /tmp. from and to are one-based inclusive lines; default is the file, at most 400 lines. Shows original line numbers and offers Copy and Open file. Published pages use the source captured at publish time. Unlike Snippet, this reads a file rather than copying supplied text.",
  component: ({ props }) => <FileExcerpt {...props} />,
});

/** "Trend from 12 to 18, up 50%": what a sparkline shows, for screen readers. Ported from GenUI chartMath.ts (Apache-2.0). */
export function trendLabel(values: readonly number[]): string {
  if (values.length < 2) return "No trend";
  const first = values[0]!, last = values[values.length - 1]!;
  const base = `Trend from ${formatNumber(first)} to ${formatNumber(last)}`;
  if (first === last) return `${base}, flat`;
  const direction = last > first ? "up" : "down";
  return first === 0 ? `${base}, ${direction}` : `${base}, ${direction} ${formatNumber(Math.round(Math.abs((last - first) / first) * 100))}%`;
}

const Sparkline = defineComponent({
  name: "Sparkline",
  props: z.object({ values: z.array(z.number()), tone: tone.optional() }),
  description: 'A tiny line of recent values with no axes, to show a trend at a glance next to text or in a Table cell\'s place. tone "info" (default), "success", "warning", "danger", or "neutral".',
  component: ({ props }) => {
    const values = props.values.filter(isNum);
    const tone = toneOf(props.tone, "info");
    const chartClass = useChartClass();
    const { canvas, failed } = useHighchart<HTMLSpanElement>(values.length ? JSON.stringify({ values, tone }) : "", () => ({
      chart: { type: "line", className: `bb-tone-${tone} bb-sparkline`, width: 80, height: 20, margin: [3, 3, 3, 3], spacing: [0, 0, 0, 0], animation: false },
      legend: { enabled: false },
      tooltip: { enabled: false },
      xAxis: { visible: false, minPadding: 0, maxPadding: 0 },
      yAxis: { visible: false, startOnTick: false, endOnTick: false, minPadding: 0, maxPadding: 0 },
      plotOptions: { series: { animation: false, enableMouseTracking: false, pointPlacement: undefined, states: { hover: { enabled: false }, inactive: { enabled: false } } } },
      // A dot on the last value, like the end of a stock ticker.
      series: [{ type: "line", data: values.map((y, i) => i === values.length - 1 ? { y, marker: { enabled: true, radius: 2 } } : y) }],
    }));
    if (values.length === 0) return null;
    return <>
      <span role="img" aria-label={trendLabel(values)} className={`${chartClass} relative inline-block h-5 w-20 shrink-0 align-middle`}><span ref={canvas} aria-hidden="true" className="absolute inset-0" /></span>
      <ChartFailed failed={failed} inline />
    </>;
  },
});

const status = z.enum(["done", "current", "todo", "blocked"]);
const stepMarker: Record<z.infer<typeof status>, string> = { done: "bg-primary text-primary-foreground border-primary", current: "border-primary text-primary", todo: "border-border text-muted-foreground", blocked: "border-destructive text-destructive" };

const Steps = defineComponent({
  name: "Steps",
  props: z.object({ items: z.array(z.object({ title: z.string(), detail: z.string().optional(), status: status.optional() })) }),
  description: 'Numbered steps in order, joined by a line, like a setup guide or a plan. status "done", "current", "todo" (default), or "blocked".',
  component: ({ props }) => {
    const items = props.items.filter((item) => typeof item?.title === "string");
    return <ol className="m-0 flex list-none flex-col p-0">{items.map((item, i) => { const state = item.status && item.status in stepMarker ? item.status : "todo"; return <li key={i} aria-current={state === "current" ? "step" : undefined} className="flex gap-3">
      <span className="flex flex-col items-center">
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums ${stepMarker[state]}`}>{state === "done" ? "✓" : state === "blocked" ? "!" : i + 1}</span>
        {i < items.length - 1 ? <span className={`w-px flex-1 ${state === "done" ? "bg-primary" : "bg-border"}`} /> : null}
      </span>
      <span className={`flex min-w-0 flex-col pt-0.5 ${i < items.length - 1 ? "pb-4" : ""}`}>
        <span className={state === "todo" ? "text-muted-foreground" : "font-medium text-foreground"}>{item.title}<span className="sr-only">{`, ${state === "todo" ? "to do" : state}`}</span></span>
        {item.detail ? <span className="text-muted-foreground">{item.detail}</span> : null}
      </span>
    </li>; })}</ol>;
  },
});

const Timeline = defineComponent({
  name: "Timeline",
  props: z.object({ items: z.array(z.object({ time: z.string().optional(), title: z.string(), detail: z.string().optional(), tone: tone.optional() })) }),
  description: 'Events in order along a line, like a changelog, an incident, or a history. time is free text such as "09:42" or "May 2026". tone colours the dot: "neutral" (default), "info", "success", "warning", or "danger".',
  component: ({ props }) => {
    const items = props.items.filter((item) => typeof item?.title === "string");
    return <ol className="m-0 flex list-none flex-col p-0">{items.map((item, i) => <li key={i} className="flex gap-3">
      <span className="flex w-2 flex-col items-center">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full bg-current ${toneText[toneOf(item.tone, "neutral")]}`} />
        {i < items.length - 1 ? <span className="mt-1 w-px flex-1 bg-border" /> : null}
      </span>
      <span className={`flex min-w-0 flex-col ${i < items.length - 1 ? "pb-3" : ""}`}>
        {item.time ? <span className="text-xs text-muted-foreground tabular-nums">{item.time}</span> : null}
        <span className="font-medium text-foreground">{item.title}</span>
        {item.detail ? <span className="text-muted-foreground">{item.detail}</span> : null}
      </span>
    </li>)}</ol>;
  },
});

// Ported from GenUI ui/components/content-model.ts (Apache-2.0): buildTree, defaultExpanded, and visibleRows, cut to labels and notes.
export type TreeItem = { id: string; label: string; note: string | null; folder: boolean; children: TreeItem[] };
type Draft = TreeItem & { fromPath: boolean; children: Draft[]; byName: Map<string, Draft> };

/**
 * A tree from path strings ("src/core/a.ts") and {label, note?, children?} items (children of the same shape).
 * Paths sharing folders merge, path-built folders come before files, and unreadable entries are dropped.
 */
export function buildTree(items: readonly unknown[]): TreeItem[] {
  const draft = (id: string, label: string, fromPath: boolean): Draft => ({ id, label, note: null, folder: false, children: [], fromPath, byName: new Map() });
  const add = (parent: Draft, list: readonly unknown[]) => {
    const seen = new Map<string, number>();
    for (const item of list) {
      if (typeof item === "string") {
        const segments = item.trim().split("/").filter((segment) => segment !== "" && segment !== ".");
        let node = parent;
        segments.forEach((segment, i) => {
          let child = node.byName.get(segment);
          if (!child) { child = draft(`${node.id}\u001fp${segment}`, segment, true); node.byName.set(segment, child); node.children.push(child); }
          // A segment with something below it is a folder, whatever came first.
          if (i < segments.length - 1 || item.trim().endsWith("/")) child.folder = true;
          node = child;
        });
        continue;
      }
      const object = item && typeof item === "object" && !Array.isArray(item) ? item as { label?: unknown; note?: unknown; children?: unknown } : null;
      const label = typeof object?.label === "string" ? object.label.trim() : "";
      if (label === "") continue;
      const count = seen.get(label) ?? 0;
      seen.set(label, count + 1);
      const child = draft(`${parent.id}\u001fo${label}${count ? `#${count}` : ""}`, label, false);
      child.note = typeof object!.note === "string" ? object!.note : null;
      if (Array.isArray(object!.children)) { child.folder = true; add(child, object!.children); }
      parent.children.push(child);
    }
  };
  // Path-built siblings go folders first, each keeping first-seen order; {label} items keep their place.
  const finish = (children: readonly Draft[]): TreeItem[] => {
    const paths = children.filter((child) => child.fromPath);
    const ordered = [...paths.filter((child) => child.folder), ...paths.filter((child) => !child.folder)];
    let next = 0;
    return children.map((child) => { const item = child.fromPath ? ordered[next++]! : child; return { id: item.id, label: item.label, note: item.note, folder: item.folder, children: finish(item.children) }; });
  };
  const root = draft("", "", false);
  add(root, items);
  return finish(root.children);
}

/** Folders open by default, breadth first: each level opens while the visible rows stay within `maxRows`, down to `maxDepth` levels. */
export function defaultExpanded(roots: readonly TreeItem[], maxDepth = 3, maxRows = 50): Set<string> {
  const open = new Set<string>();
  let rows = roots.length, level = roots;
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: TreeItem[] = [];
    for (const item of level) {
      if (!item.folder || item.children.length === 0 || rows + item.children.length > maxRows) continue;
      open.add(item.id);
      rows += item.children.length;
      next.push(...item.children);
    }
    level = next;
  }
  return open;
}

export type TreeRow = { item: TreeItem; depth: number; position: number; siblings: number; parent: string | null };

/** The rows on screen, in order, given which folders are open. */
export function visibleRows(roots: readonly TreeItem[], isOpen: (id: string) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (items: readonly TreeItem[], depth: number, parent: string | null) => items.forEach((item, i) => {
    rows.push({ item, depth, position: i + 1, siblings: items.length, parent });
    if (item.folder && isOpen(item.id)) walk(item.children, depth + 1, item.id);
  });
  walk(roots, 0, null);
  return rows;
}

const Tree = defineComponent({
  name: "Tree",
  props: z.object({ items: z.array(z.union([z.string(), z.object({ label: z.string(), note: z.string().optional(), children: z.array(z.any()).optional() })])) }),
  description: 'A collapsible tree. Each item is a path string ("src/app/main.ts"; paths that share folders merge) or {label, note?, children?}, where children is a list of the same kind of items. note is short muted text after the label. Folders start open while the tree stays short.',
  component: ({ props }) => {
    const roots = buildTree(props.items);
    const [open, setOpen] = useState<Set<string> | null>(null);
    const [focus, setFocus] = useState<string | null>(null);
    const moved = useRef(false);
    const list = useRef<HTMLDivElement>(null);
    // Until someone toggles a folder, the defaults follow the items as they stream in.
    const expanded = open ?? defaultExpanded(roots);
    const rows = visibleRows(roots, (id) => expanded.has(id));
    const index = Math.max(0, rows.findIndex((row) => row.item.id === focus));
    useEffect(() => { if (moved.current) { moved.current = false; list.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[index]?.focus(); } }, [focus, index]);
    if (rows.length === 0) return null;
    const toggle = (id: string, to?: boolean) => { const next = new Set(expanded); if (to ?? !next.has(id)) next.add(id); else next.delete(id); setOpen(next); };
    const go = (i: number) => { moved.current = true; setFocus(rows[Math.max(0, Math.min(rows.length - 1, i))]!.item.id); };
    const onKeyDown = (event: KeyboardEvent, row: TreeRow, i: number) => {
      const { item } = row, isOpen = item.folder && expanded.has(item.id);
      const keys: Record<string, () => void> = {
        ArrowDown: () => go(i + 1), ArrowUp: () => go(i - 1), Home: () => go(0), End: () => go(rows.length - 1),
        ArrowRight: () => item.folder && (isOpen ? go(i + 1) : toggle(item.id, true)),
        ArrowLeft: () => isOpen ? toggle(item.id, false) : row.parent !== null && go(rows.findIndex((other) => other.item.id === row.parent)),
        Enter: () => item.folder && toggle(item.id), " ": () => item.folder && toggle(item.id),
      };
      if (!keys[event.key]) return;
      event.preventDefault();
      keys[event.key]!();
    };
    return <div ref={list} role="tree" aria-label="Tree" className="flex min-w-0 flex-col">
      {rows.map((row, i) => { const { item } = row, isOpen = expanded.has(item.id); return <div key={item.id} role="treeitem" aria-level={row.depth + 1} aria-setsize={row.siblings} aria-posinset={row.position} aria-expanded={item.folder ? isOpen : undefined} tabIndex={i === index ? 0 : -1} onFocus={() => setFocus(item.id)} onClick={() => { setFocus(item.id); if (item.folder) toggle(item.id); }} onKeyDown={(event) => onKeyDown(event, row, i)} style={{ paddingLeft: row.depth * 16 }} className={`flex min-w-0 items-center gap-1.5 rounded-sm py-0.5 pr-2 hover:bg-muted ${item.folder ? "cursor-pointer" : ""} ${focusRing}`}>
        {item.folder ? <Chevron open={isOpen} /> : <span className="w-[1em] shrink-0" />}
        <span className={`min-w-0 truncate ${item.folder ? "font-medium text-foreground" : "text-foreground"}`}>{item.label}</span>
        {item.note ? <span className="ml-auto shrink-0 pl-3 text-muted-foreground">{item.note}</span> : null}
      </div>; })}
    </div>;
  },
});

export const group: Group = {
  id: "data",
  name: "Data",
  entries: [
    { component: Table, summary: "rows and columns", examples: [
      { name: "Mixed cells", code: `root = Table(["Task", "Owner", "Days"], [["Copy", "Ana", 2], ["QA", "Raj", 5], ["Launch", "Ana", null]])` },
    ] },
    { component: Progress, summary: "labelled bar", examples: [
      { name: "Two bars", code: `root = Stack([Progress("Done", 3, 5), Progress("Budget used", 72)])` },
    ] },
    { component: Code, summary: "highlighted code", examples: [
      { name: "TypeScript", code: `root = Code("export function add(a: number, b: number) {\\n  return a + b;\\n}", "ts")` },
    ] },
    { component: Diff, summary: "one file's diff", examples: [
      { name: "One hunk", code: `root = Diff("@@ -1,3 +1,3 @@\\n export function add(a, b) {\\n-  return a - b;\\n+  return a + b;\\n }", "src/math.ts")` },
    ] },
    { component: Snippet, summary: "short text to copy", examples: [
      { name: "Command", code: `root = Snippet("npm install @openuidev/react-lang", "Install")` },
      { name: "ID", code: `root = Snippet("thr_8f2a91c4")` },
    ] },
    { component: FileCode, summary: "source lines read from a file", examples: [
      { name: "Real line numbers", code: 'root = FileCode("src/math.ts", 2, 4)', tools: { file: { path: "src/math.ts", text: `export function add(a: number, b: number) {
  const total = a + b;
  return total;
}
` } } },
    ] },
    { component: Gauge, summary: "one value on a dial", examples: [
      { name: "Score", code: `root = Gauge("Lighthouse score", 92, 100, "success")` },
      { name: "Two dials", code: `root = Stack([Gauge("CPU", 71, 100, "warning"), Gauge("Disk GB", 120, 512)], "row")` },
    ] },
    { component: SegmentedBar, summary: "one bar split into parts", examples: [
      { name: "Budget", code: `root = SegmentedBar([{label: "Design", value: 12000}, {label: "Build", value: 30000}, {label: "Launch", value: 8000}], "Budget")` },
      { name: "Disk with tones", code: `root = SegmentedBar([{label: "Used", value: 380, tone: "warning"}, {label: "Free", value: 132, tone: "neutral"}])` },
    ] },
    { component: Sparkline, summary: "tiny trend line", examples: [
      { name: "Up", code: `root = Sparkline([12, 14, 13, 17, 16, 21, 24], "success")` },
      { name: "Down", code: `root = Sparkline([9, 7, 8, 4, 5, 2], "danger")` },
    ] },
    { component: Steps, summary: "numbered steps with status", examples: [
      { name: "Setup", code: `root = Steps([{title: "Create the project", status: "done"}, {title: "Connect GitHub", detail: "Pick the repositories BB may read.", status: "current"}, {title: "Invite the team"}])` },
      { name: "Blocked", code: `root = Steps([{title: "Build", status: "done"}, {title: "Deploy", detail: "Waiting on a production approval.", status: "blocked"}, {title: "Announce"}])` },
    ] },
    { component: Timeline, summary: "events along a line", examples: [
      { name: "Incident", code: `root = Timeline([{time: "09:42", title: "Alert fired", detail: "p95 latency over 2 s.", tone: "danger"}, {time: "09:50", title: "Rolled back v2.14", tone: "warning"}, {time: "10:05", title: "Resolved", tone: "success"}])` },
      { name: "History", code: `root = Timeline([{time: "Jan 2026", title: "Beta"}, {time: "May 2026", title: "1.0"}, {time: "Oct 2026", title: "Teams", detail: "Shared projects and roles."}])` },
    ] },
    { component: Tree, summary: "collapsible tree", examples: [
      { name: "File paths", code: `root = Tree(["src/app/main.ts", "src/app/routes.ts", "src/lib/db.ts", "package.json", "README.md"])` },
      { name: "Labels and notes", code: `root = Tree([{label: "Company", children: [{label: "Engineering", note: "24", children: [{label: "Platform", note: "9"}, {label: "Product", note: "15"}]}, {label: "Design", note: "6"}]}])` },
    ] },
    { component: Calendar, summary: "month grid with events", examples: [
      { name: "Launch month", code: `root = Calendar([{date: "2026-11-03", title: "Design review"}, {date: "2026-11-12", title: "Code freeze", tone: "warning"}, {date: "2026-11-12", title: "QA starts"}, {date: "2026-11-19", title: "Launch", tone: "success"}], "2026-11")` },
    ] },
    { component: CalendarHeatmap, summary: "daily counts as a grid", examples: [
      { name: "Commits", code: `root = CalendarHeatmap([{date: "2026-09-01", value: 3}, {date: "2026-09-02", value: 5}, {date: "2026-09-04", value: 1}, {date: "2026-09-08", value: 8}, {date: "2026-09-09", value: 2}, {date: "2026-09-10", value: 6}, {date: "2026-09-15", value: 4}, {date: "2026-09-17", value: 9}, {date: "2026-09-18", value: 3}, {date: "2026-09-22", value: 2}, {date: "2026-09-24", value: 7}, {date: "2026-09-29", value: 5}, {date: "2026-10-01", value: 1}, {date: "2026-10-06", value: 6}, {date: "2026-10-08", value: 4}, {date: "2026-10-13", value: 10}], "Commits")` },
    ] },
    { component: Diagram, summary: "boxes and arrows", examples: [
      { name: "Flow", code: `root = Diagram([{id: "req", label: "Request"}, {id: "auth", label: "Auth"}, {id: "cache", label: "Cache"}, {id: "db", label: "Database"}, {id: "res", label: "Response", tone: "success"}], [{from: "req", to: "auth"}, {from: "auth", to: "cache"}, {from: "cache", to: "res", label: "hit"}, {from: "cache", to: "db", label: "miss"}, {from: "db", to: "res"}])` },
      { name: "Left to right with a loop", code: `root = Diagram([{id: "draft", label: "Draft"}, {id: "review", label: "Review", tone: "info"}, {id: "ship", label: "Ship", tone: "success"}], [{from: "draft", to: "review"}, {from: "review", to: "draft", label: "changes"}, {from: "review", to: "ship"}], "right")` },
    ] },
  ],
};
