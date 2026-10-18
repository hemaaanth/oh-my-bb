// Charts: Highcharts in styled mode, with the theme and options code published pages use
// (render/charts-runtime). Highcharts and the modules a type needs load on first use.
// The other Highcharts components (Gauge, Treemap, Waterfall, …) draw through useHighchart here too.
import { defineComponent } from "@openuidev/react-lang";
import { useEffect, useRef, useState, type RefObject } from "react";
import { z } from "zod";
import highchartsCss from "highcharts/css/highcharts.css" with { type: "text" };
import type { Chart as HighchartsChart, Options } from "highcharts";
import pagesCss from "../../../render/charts-runtime/charts.css" with { type: "text" };
import type { JsonObject } from "../../../render/json.js";
import { normalizeChartOptions } from "../../../render/charts-runtime/normalize.js";
import { baseTheme } from "../../../render/charts-runtime/theme.js";
import { childProps, type Group } from "../kit.js";
import { useHost } from "../host.js";

const Series = defineComponent({
  name: "Series",
  props: z.object({ name: z.string(), values: z.array(z.number().nullable()) }),
  description: "One named series of a Chart: one number per label. null leaves a gap.",
  component: () => null,
});

/** Round a maximum up to 1, 2, 2.5, or 5 times a power of ten, so the grid lines land on round numbers. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 2.5, 5, 10].find((step) => step * power >= max) ?? 10) * power;
}

/** Pie slices in data order. Only positive values count. Past `max` slices the largest `max - 1` stay and the rest fold into "Other". */
export function pieSlices(labels: readonly string[], values: readonly (number | null)[], max = 8): { label: string; value: number }[] {
  const slices = values.flatMap((value, source) => typeof value === "number" && Number.isFinite(value) && value > 0 ? [{ label: labels[source] || `Item ${source + 1}`, value, source }] : []);
  if (slices.length <= max) return slices.map(({ label, value }) => ({ label, value }));
  const kept = new Set([...slices].sort((a, b) => b.value - a.value || a.source - b.source).slice(0, max - 1));
  const other = slices.reduce((sum, slice) => kept.has(slice) ? sum : sum + slice.value, 0);
  return [...slices.filter((slice) => kept.has(slice)).map(({ label, value }) => ({ label, value })), { label: "Other", value: other }];
}

/** A number, or a string that is exactly one (" 2.5 "); else null. Scatter reads its labels as x with this. */
export function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

const kinds = { bar: "Bar", line: "Line", area: "Area", stackedBar: "Stacked bar", horizontalBar: "Horizontal bar", pie: "Pie", donut: "Donut", radar: "Radar", radial: "Radial", scatter: "Scatter", funnel: "Funnel" } as const;
type ChartType = keyof typeof kinds;
type SeriesData = { name: string; values: (number | null)[] };
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const single = (type: ChartType) => type === "pie" || type === "donut" || type === "radial" || type === "funnel";

/** The drawn height in px: round charts are square-ish, horizontal bars grow with their labels. */
export function chartHeight(type: ChartType, labels: number): number {
  if (type === "horizontalBar") return Math.max(160, labels * 32 + 72);
  return type === "pie" || type === "donut" || type === "radial" || type === "radar" ? 260 : 240;
}

/** Highcharts options for a Chart, before the shared normalize step. Plain JSON, so tests can read it. */
export function chartOptions(type: ChartType, labels: string[], series: SeriesData[], xLabel?: string, yLabel?: string): JsonObject {
  const first = series[0]?.values ?? [];
  const base: JsonObject = {
    chart: { height: chartHeight(type, labels.length) },
    // The figure carries the summary as its accessible name, so the accessibility module is not loaded.
    accessibility: { enabled: false },
    legend: { enabled: single(type) ? type === "pie" || type === "donut" : series.length > 1 },
  };
  if (type === "pie" || type === "donut") {
    return { ...base, plotOptions: { pie: { showInLegend: true, dataLabels: { enabled: false }, innerSize: type === "donut" ? "60%" : 0 } },
      series: [{ type: "pie", name: series[0]?.name, data: pieSlices(labels, first).map((slice) => ({ name: slice.label, y: slice.value })) }] };
  }
  if (type === "funnel") {
    return { ...base, plotOptions: { funnel: { width: "55%", neckWidth: "25%", center: ["35%", "50%"], dataLabels: { enabled: true, format: "{point.name}: {point.y}" } } },
      series: [{ type: "funnel", name: series[0]?.name, data: labels.flatMap((label, i) => isNum(first[i]) ? [[label || `Stage ${i + 1}`, first[i]]] : []) }] };
  }
  if (type === "radial") {
    const max = niceMax(Math.max(0, ...first.filter(isNum)));
    return { ...base, chart: { ...(base.chart as JsonObject), polar: true, inverted: true }, pane: { size: "90%", innerSize: "20%", endAngle: 360 },
      xAxis: { categories: labels, tickmarkPlacement: "on", lineWidth: 0, labels: { align: "right", useHTML: false, allowOverlap: true, step: 1, y: 3 } },
      yAxis: { min: 0, max, lineWidth: 0, gridLineWidth: 0, labels: { enabled: false } },
      plotOptions: { column: { colorByPoint: true, pointPadding: 0, groupPadding: 0.08, borderRadius: 0 } },
      series: [{ type: "column", name: series[0]?.name, data: first.map((value) => isNum(value) ? Math.max(0, value) : null) }] };
  }
  if (type === "radar") {
    return { ...base, chart: { ...(base.chart as JsonObject), polar: true, className: "hc-radar" }, pane: { size: "80%" },
      xAxis: { categories: labels, tickmarkPlacement: "on", lineWidth: 0 },
      yAxis: { min: 0, gridLineInterpolation: "polygon", lineWidth: 0, title: { text: undefined } },
      series: series.map((s) => ({ type: "area", name: s.name, data: s.values, pointPlacement: "on" })) };
  }
  const axes = { xAxis: { title: { text: xLabel } }, yAxis: { title: { text: yLabel ?? null } } };
  if (type === "scatter") {
    const xs = labels.map(numericValue);
    return { ...base, xAxis: { ...axes.xAxis, type: "linear" }, yAxis: axes.yAxis,
      series: series.map((s) => ({ type: "scatter", name: s.name, data: xs.flatMap((x, i) => x !== null && isNum(s.values[i]) ? [[x, s.values[i]]] : []) })) };
  }
  const seriesType = type === "horizontalBar" ? "bar" : type === "line" || type === "area" ? type : "column";
  return { ...base, xAxis: { ...axes.xAxis, categories: labels }, yAxis: { ...axes.yAxis, min: 0 },
    plotOptions: type === "stackedBar" ? { series: { stacking: "normal" } } : {},
    series: series.map((s) => ({ type: seriesType, name: s.name, data: s.values })) };
}

export type Highcharts = typeof import("highcharts/esm/highcharts").default;
/** Modules a chart can need beyond core Highcharts. Each loads once, on first use. */
export type ChartModule = "more" | "funnel" | "treemap" | "heatmap" | "solidGauge" | "xrange";
let core: Promise<Highcharts> | undefined;
const loaded: Partial<Record<ChartModule, Promise<unknown>>> = {};
const MODULES: Record<ChartModule, () => Promise<unknown>> = {
  more: () => import("highcharts/esm/highcharts-more"),
  funnel: () => import("highcharts/esm/modules/funnel"),
  treemap: () => import("highcharts/esm/modules/treemap"),
  heatmap: () => import("highcharts/esm/modules/heatmap"),
  // Solid gauges draw on highcharts-more's pane.
  solidGauge: () => loadModule("more").then(() => import("highcharts/esm/modules/solid-gauge")),
  xrange: () => import("highcharts/esm/modules/xrange"),
};

/**
 * BB wraps Node.prototype.insertBefore and reads the reference node's parentNode, so Highcharts'
 * insertBefore(node, undefined) throws there. The DOM reads undefined as null; this puts that back.
 */
function insertBeforeUndefinedAsNull(): void {
  const insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
    return insertBefore.call(this, node, child ?? null) as T;
  };
}

function loadCore(): Promise<Highcharts> {
  return core ??= import("highcharts/esm/highcharts").then(({ default: highcharts }) => {
    insertBeforeUndefinedAsNull();
    highcharts.setOptions(baseTheme);
    return highcharts;
  });
}

function loadModule(name: ChartModule): Promise<unknown> {
  return loaded[name] ??= loadCore().then(MODULES[name]);
}

/** Highcharts with the shared theme, plus only the modules a chart needs. Every Highcharts use goes through here. */
export function loadHighcharts(modules: readonly ChartModule[] = []): Promise<Highcharts> {
  return Promise.all(modules.map(loadModule)).then(loadCore);
}

const typeModules = (type: ChartType): ChartModule[] => type === "radar" || type === "radial" ? ["more"] : type === "funnel" ? ["funnel"] : [];

// The chart CSS is scoped to .bb-spec-chart, so it never styles BB or a page outside a chart.
// In chat and the gallery, .bb-spec-chart-bb maps the --bb-* tokens charts.css reads to BB's own,
// the way theme.css does for a page that follows the app. On a page the site's tokens apply.
const scoped = (css: string) => css.replace(/:root\b/gu, ".bb-spec-chart");
const bbTokens = `.bb-spec-chart-bb {
  --bb-bg: var(--background); --bb-surface: var(--muted); --bb-text: var(--foreground); --bb-strong: var(--foreground);
  --bb-muted: var(--muted-foreground); --bb-rule: var(--border); --bb-link-line: var(--border); --bb-accent: var(--primary);
  --bb-positive: var(--success); --bb-negative: var(--destructive); --bb-warning: var(--warning); --bb-font-sans: var(--font-sans);
  --bb-chart-1: var(--primary); --bb-chart-2: var(--muted-foreground); --bb-chart-3: var(--success); --bb-chart-4: var(--warning);
  --bb-chart-5: var(--destructive); --bb-chart-6: color-mix(in oklch, var(--primary) 50%, var(--background));
  --bb-chart-grid: var(--border); --bb-chart-axis: var(--muted-foreground);
}`;
// Classes the components set in styled mode. A tone on the chart recolours its first series colour.
// bb-heat-N shades heatmap cells, bb-failed marks a failed span, bb-track is a gauge's empty arc.
const componentCss = `.bb-tone-neutral { --highcharts-color-0: var(--bb-muted); }
.bb-tone-info { --highcharts-color-0: var(--bb-accent); }
.bb-tone-success { --highcharts-color-0: var(--bb-positive); }
.bb-tone-warning { --highcharts-color-0: var(--bb-warning); }
.bb-tone-danger { --highcharts-color-0: var(--bb-negative); }
.bb-spec-chart .highcharts-point.bb-heat-0 { fill: var(--bb-surface); }
.bb-spec-chart .highcharts-point.bb-heat-1 { fill: var(--highcharts-color-0); fill-opacity: 0.3; }
.bb-spec-chart .highcharts-point.bb-heat-2 { fill: var(--highcharts-color-0); fill-opacity: 0.55; }
.bb-spec-chart .highcharts-point.bb-heat-3 { fill: var(--highcharts-color-0); fill-opacity: 0.8; }
.bb-spec-chart .highcharts-point.bb-heat-4 { fill: var(--highcharts-color-0); fill-opacity: 1; }
.bb-spec-chart .highcharts-heatmap-series .highcharts-point { stroke: var(--bb-bg); stroke-width: 2px; }
.bb-spec-chart .bb-calendar .highcharts-axis-line { display: none; }
.bb-spec-chart .highcharts-point.bb-failed { fill: var(--bb-negative); }
.bb-spec-chart .highcharts-pane.bb-track { fill: var(--bb-surface); }
.bb-spec-chart .bb-treemap .highcharts-point { fill-opacity: 0.3; stroke: var(--bb-bg); stroke-width: 1px; }
.bb-spec-chart .bb-treemap .highcharts-internal-node { fill: none; stroke: var(--bb-bg); stroke-width: 3px; }
.bb-spec-chart .bb-treemap .highcharts-data-label text { fill: var(--bb-text); font-weight: 400; }
.bb-spec-chart .highcharts-data-label text tspan.bb-faint, .bb-spec-chart .highcharts-axis-labels .bb-faint { fill: var(--bb-muted); }
.bb-spec-chart .highcharts-axis-labels span { color: var(--bb-text); }
.bb-spec-chart .bb-sparkline .highcharts-graph { stroke-width: 1.5px; }
.bb-spec-chart .bb-benchmark .highcharts-point { fill: var(--bb-muted); fill-opacity: 0.45; }
.bb-spec-chart .bb-benchmark .highcharts-point.bb-best { fill: var(--bb-positive); fill-opacity: 0.8; }
.bb-spec-chart .bb-benchmark .highcharts-xaxis-labels text { font-family: var(--bb-font-mono); fill: var(--bb-text); }
.bb-spec-chart .highcharts-data-label text tspan.bb-good { fill: var(--bb-positive); }
.bb-spec-chart .bb-waterfall .highcharts-point { fill: var(--bb-accent); }
.bb-spec-chart .bb-waterfall .highcharts-point.bb-failed { fill: var(--bb-negative); }`;
const styled = new WeakSet<Node>();

/** Puts the chart CSS once into the document, or the shadow root a page block renders in. */
function installStyles(node: HTMLElement): void {
  const root = node.getRootNode();
  if (styled.has(root)) return;
  styled.add(root);
  const style = document.createElement("style");
  style.setAttribute("data-bb-spec-charts", "");
  style.textContent = `${scoped(highchartsCss ?? "")}\n${scoped(pagesCss ?? "")}\n${bbTokens}\n${componentCss}`;
  (root instanceof ShadowRoot ? root : document.head).append(style);
}

/** The classes a chart's box needs for the chart CSS: BB's tokens in chat, the site's on a page. */
export function useChartClass(): string {
  return useHost().kind === "page" ? "bb-spec-chart" : "bb-spec-chart bb-spec-chart-bb";
}

/**
 * Draws a Highcharts chart in the shared look into the returned node. `key` holds every input, so the chart
 * redraws only when the data changes; `build` turns it into options. Styled mode is always on.
 */
export function useHighchart<T extends HTMLElement = HTMLDivElement>(key: string, build: (highcharts: Highcharts) => Options, modules: readonly ChartModule[] = []): { canvas: RefObject<T | null>; failed: string | null } {
  const canvas = useRef<T>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef(build);
  latest.current = build;
  const needs = modules.join(" ");
  useEffect(() => {
    const node = canvas.current;
    if (!node || !key) return;
    let chart: HighchartsChart | undefined, observer: ResizeObserver | undefined, live = true;
    installStyles(node);
    loadHighcharts(needs ? needs.split(" ") as ChartModule[] : []).then((highcharts) => {
      if (!live) return;
      chart = highcharts.chart(node, highcharts.merge(latest.current(highcharts), { chart: { styledMode: true } }));
      observer = new ResizeObserver(() => chart?.reflow());
      observer.observe(node);
      setFailed(null);
    }).catch((caught: unknown) => { if (live) setFailed(caught instanceof Error ? caught.message : String(caught)); });
    return () => { live = false; observer?.disconnect(); chart?.destroy(); };
  }, [key, needs]);
  return { canvas, failed };
}

/** The line a chart shows in place of itself when Highcharts fails. */
export function ChartFailed({ failed, inline }: { failed: string | null; inline?: boolean }) {
  if (!failed) return null;
  const text = `This chart could not be drawn: ${failed}`;
  return inline ? <span className="text-xs text-muted-foreground">{text}</span> : <p className="m-0 text-xs text-muted-foreground">{text}</p>;
}

const Chart = defineComponent({
  name: "Chart",
  props: z.object({
    type: z.enum(["bar", "line", "area", "stackedBar", "horizontalBar", "pie", "donut", "radar", "radial", "scatter", "funnel"]),
    labels: z.array(z.union([z.string(), z.number()])),
    series: z.array(Series.ref),
    title: z.string().optional(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
  }),
  description: 'A small chart. labels name the x axis points; each Series gives one value per label. bar, line, area, stackedBar, horizontalBar, and radar (labels are the spokes, 3 or more) take several series. pie, donut, radial, and funnel draw the first series only. scatter reads labels as numeric x values and each series as the y for each x. Values are 0 or more, except in scatter. xLabel and yLabel title the bottom and left axes. For anything bigger, publish a page.',
  component: ({ props }) => {
    const series = props.series.map((node) => childProps<SeriesData>(node)).filter((s): s is SeriesData => typeof s?.name === "string" && Array.isArray(s.values));
    const labels = props.labels.map((label) => String(label ?? ""));
    const type = props.type;
    const shown = single(type) ? series.slice(0, 1) : series;
    const empty = labels.length === 0 || series.length === 0;
    const options = empty ? "" : JSON.stringify(chartOptions(type, labels, shown, props.xLabel, props.yLabel));
    const chartClass = useChartClass();
    const { canvas, failed } = useHighchart(options, (highcharts) => {
      const merge = (...objects: JsonObject[]) => highcharts.merge<JsonObject>({}, ...objects);
      const { options: normalized, error } = normalizeChartOptions(JSON.parse(options), undefined, merge);
      if (error) throw new Error(error);
      return normalized as Options;
    }, typeModules(type));
    if (empty) return null;
    const summary = `${kinds[type] ?? "Bar"} chart of ${shown.map((s) => s.name).join(", ")} over ${labels.join(", ")}`;
    return <figure className={`${chartClass} m-0 flex min-w-0 flex-col gap-1.5`}>
      {props.title ? <div className="font-medium text-foreground">{props.title}</div> : null}
      <div role="img" aria-label={props.title ? `${props.title}: ${summary}` : summary} className="relative min-w-0" style={{ height: chartHeight(type, labels.length) }}>
        <div ref={canvas} aria-hidden="true" className="absolute inset-0" />
      </div>
      <ChartFailed failed={failed} />
    </figure>;
  },
});

export const group: Group = {
  id: "charts",
  name: "Charts",
  entries: [
    { component: Chart, summary: "bar, line, area, pie, radar, scatter, funnel, and more", examples: [
      { name: "Bar", code: `root = Chart("bar", ["Mon", "Tue", "Wed"], [Series("Signups", [4, 9, 6]), Series("Churn", [1, 2, 1])])` },
      { name: "Line", code: `root = Chart("line", ["Jan", "Feb", "Mar", "Apr"], [Series("Revenue", [12, 18, 15, 24])])` },
      { name: "Area with axis titles", code: `root = Chart("area", ["W1", "W2", "W3", "W4", "W5"], [Series("Active users", [120, 180, 160, 240, 310]), Series("New", [40, 60, null, 80, 95])], "Weekly users", "Week", "Users")` },
      { name: "Stacked bar", code: `root = Chart("stackedBar", ["Q1", "Q2", "Q3", "Q4"], [Series("Web", [30, 42, 51, 60]), Series("iOS", [12, 18, 22, 30]), Series("Android", [8, 11, 15, 21])], "Revenue by platform")` },
      { name: "Horizontal bar", code: `root = Chart("horizontalBar", ["Search", "Referral", "Social", "Email"], [Series("Visits", [4200, 1800, 950, 600])], "Traffic sources")` },
      { name: "Pie", code: `root = Chart("pie", ["Chrome", "Safari", "Firefox", "Edge"], [Series("Share", [64, 19, 4, 5])], "Browsers")` },
      { name: "Donut", code: `root = Chart("donut", ["Passed", "Failed", "Skipped"], [Series("Tests", [412, 6, 18])], "Test run")` },
      { name: "Radar", code: `root = Chart("radar", ["Speed", "Cost", "Quality", "Support", "Docs"], [Series("Us", [8, 6, 9, 7, 5]), Series("Rival", [6, 8, 6, 5, 7])])` },
      { name: "Radial", code: `root = Chart("radial", ["Move", "Exercise", "Stand"], [Series("Goal %", [82, 60, 95])])` },
      { name: "Scatter", code: `root = Chart("scatter", [1, 2, 3, 5, 8, 13], [Series("Build time", [12, 15, 14, 22, 30, 41]), Series("Test time", [5, 6, null, 9, 14, 18])], "Time by package count", "Packages", "Seconds")` },
      { name: "Funnel", code: `root = Chart("funnel", ["Visited", "Signed up", "Activated", "Paid"], [Series("Users", [5000, 1200, 640, 180])], "Signup funnel")` },
    ] },
    { component: Series, summary: "one series of a Chart", part: true, examples: [] },
  ],
};
