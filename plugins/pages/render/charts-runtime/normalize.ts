// Port of hem.so components/Chart/normalize.ts, plus colour and font
// stripping: in styled mode every colour and font comes from CSS, so options
// that try to set them are removed rather than half-applied.
import { isObject, list, text, type JsonObject } from "../json.js";

type Merge = (...objects: JsonObject[]) => JsonObject;

// Keys that carry colours or fonts. Use colorIndex or className instead.
const PRESENTATION_KEYS: Record<string, true> = {
  color: true, colors: true, fillColor: true, lineColor: true, borderColor: true, backgroundColor: true,
  plotBackgroundColor: true, plotBorderColor: true, gridLineColor: true, minorGridLineColor: true,
  tickColor: true, minorTickColor: true, negativeColor: true, negativeFillColor: true, upColor: true,
  edgeColor: true, minColor: true, maxColor: true, stops: true,
  style: true, itemStyle: true, itemHoverStyle: true, itemHiddenStyle: true, labelStyle: true, activeDataLabelStyle: true,
  fontFamily: true, fontSize: true, fontWeight: true, useHTML: true,
};

/** Deep copy without colour, font, and style keys. Point arrays are copied as-is. */
export function stripPresentation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPresentation);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (PRESENTATION_KEYS[key] || key === "__proto__") continue;
    out[key] = stripPresentation(child);
  }
  return out;
}

// 'simple' / illustrative: no numeric labels, ticks, or gridlines; axis titles stay.
const SIMPLE_AXIS = { labels: { enabled: false }, gridLineWidth: 0, minorGridLineWidth: 0, tickWidth: 0, tickLength: 0, lineWidth: 1 };
// Line-family charts on a numeric x-axis hug both edges, like pointPlacement 'on' on categories.
const SIMPLE_XAXIS_HUG = { ...SIMPLE_AXIS, minPadding: 0, maxPadding: 0, startOnTick: false, endOnTick: false };
const LINE_FAMILY: Record<string, true> = { line: true, spline: true, area: true, areaspline: true };

function isLineFamily(options: JsonObject): boolean {
  const chartType = text(isObject(options.chart) ? options.chart.type : undefined) ?? "line";
  const series = list(options.series);
  return (series.length ? series.map((item) => text(isObject(item) ? item.type : undefined) ?? chartType) : [chartType]).every((type) => LINE_FAMILY[type]);
}

function applySimpleMode(options: JsonObject, merge: Merge): JsonObject {
  const chart = isObject(options.chart) ? options.chart : {};
  const lineFamily = isLineFamily(options);
  const apply = (axis: unknown, config: JsonObject) => (Array.isArray(axis) ? axis.map((item) => merge(isObject(item) ? item : {}, config)) : merge(isObject(axis) ? axis : {}, config));
  const className = [text(chart.className), "hc-simple"].filter(Boolean).join(" ");
  return merge(options, {
    xAxis: apply(options.xAxis, lineFamily ? SIMPLE_XAXIS_HUG : SIMPLE_AXIS),
    yAxis: apply(options.yAxis, SIMPLE_AXIS),
    chart: { className },
    // Illustrative charts are static: no tooltips, no hover states.
    tooltip: { enabled: false },
    plotOptions: { series: { enableMouseTracking: false, states: { inactive: { enabled: false } } } },
  });
}

/** Parsed JSON → Highcharts options in styled mode, with the simple variant applied when asked. */
export function normalizeChartOptions(parsed: unknown, variant: "simple" | undefined, merge: Merge): { options: JsonObject; error?: string } {
  if (!isObject(parsed)) return { options: {}, error: "The chart JSON must be an object." };
  let options = merge(stripPresentation(parsed) as JsonObject, { chart: { styledMode: true } });
  // Line-family charts put the last category on the right edge (pointPlacement
  // 'on'). Let its label run into the right spacing instead of being cut to "Sep…".
  if (isLineFamily(options) && !Array.isArray(options.xAxis)) options = merge({ xAxis: { labels: { overflow: "allow" } } }, options);
  if (variant === "simple") options = applySimpleMode(options, merge);
  return { options };
}
