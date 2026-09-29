// charts.js: renders every figure.chart on the page with Highcharts 13 in
// styled mode. Built into assets/charts.js by build.mjs (one IIFE).
import Highcharts from "highcharts/esm/highcharts";
// The hem.so module list (components/Chart/highcharts.ts) without the three
// exporting modules: exporting is off and the sandbox blocks downloads.
import "highcharts/esm/highcharts-more";
import "highcharts/esm/highcharts-3d";
import "highcharts/esm/modules/heatmap";
import "highcharts/esm/modules/tilemap";
import "highcharts/esm/modules/treemap";
import "highcharts/esm/modules/treegraph";
import "highcharts/esm/modules/sunburst";
import "highcharts/esm/modules/sankey";
import "highcharts/esm/modules/dependency-wheel";
import "highcharts/esm/modules/organization";
import "highcharts/esm/modules/arc-diagram";
import "highcharts/esm/modules/networkgraph";
import "highcharts/esm/modules/funnel";
import "highcharts/esm/modules/item-series";
import "highcharts/esm/modules/wordcloud";
import "highcharts/esm/modules/vector";
import "highcharts/esm/modules/xrange";
import "highcharts/esm/modules/bullet";
import "highcharts/esm/modules/variwide";
import "highcharts/esm/modules/streamgraph";
import "highcharts/esm/modules/timeline";
import "highcharts/esm/modules/venn";
import "highcharts/esm/modules/solid-gauge";
import "highcharts/esm/modules/dumbbell";
import "highcharts/esm/modules/lollipop";
import "highcharts/esm/modules/histogram-bellcurve";
import "highcharts/esm/modules/pareto";
import "highcharts/esm/modules/pattern-fill";
import "highcharts/esm/modules/annotations";
import "highcharts/esm/modules/accessibility"; // must load last
import highchartsCss from "highcharts/css/highcharts.css";
import pagesCss from "./charts.css";
import { buildChartText, chartTableHtml, wantsAutoTable } from "../chart-text.js";
import { isObject, type JsonObject } from "../json.js";
import { normalizeChartOptions } from "./normalize.js";
import { baseTheme } from "./theme.js";

type ChartWithAxis = { chart: Highcharts.Chart; colorAxis: boolean };

const ASPECT = /^\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*$/u;
const merge = (...objects: JsonObject[]) => Highcharts.merge<JsonObject>({}, ...objects);

function installStyles(): void {
  const style = document.createElement("style");
  style.setAttribute("data-bb-charts", "");
  style.textContent = `${highchartsCss}\n${pagesCss}`;
  // Right after the theme, before author styles, so a page can override chart CSS.
  const theme = document.querySelector('link[rel="stylesheet"][href*="_page/theme.css"]');
  if (theme) theme.after(style);
  else document.head.prepend(style);
}

/** Colour-axis charts (heatmaps) get real colours: Highcharts interpolates them, so CSS variables cannot. */
function colorAxisTheme(): JsonObject {
  const root = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  return { minColor: read("--bb-surface", "#f0f1f3"), maxColor: read("--bb-chart-1", "#7c84e0") };
}

function renderFigure(figure: HTMLElement, charts: ChartWithAxis[]): void {
  const script = Array.from(figure.children).find((child) => child.tagName === "SCRIPT" && /^application\/json\b/iu.test(child.getAttribute("type") ?? ""));
  if (!script || figure.hasAttribute("data-bb-chart")) return;
  figure.setAttribute("data-bb-chart", "");
  const fail = (message: string) => {
    const error = document.createElement("p");
    error.className = "chart-error";
    error.textContent = `This chart could not be drawn: ${message}`;
    script.after(error);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(script.textContent ?? "");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const { options, error } = normalizeChartOptions(parsed, figure.dataset.variant === "simple" ? "simple" : undefined, merge);
  if (error) {
    fail(error);
    return;
  }

  const canvas = document.createElement("div");
  canvas.className = "chart-canvas";
  if (figure.dataset.aspect && ASPECT.test(figure.dataset.aspect)) canvas.style.aspectRatio = figure.dataset.aspect;
  const inner = document.createElement("div");
  inner.className = "chart-canvas-inner";
  canvas.append(inner);
  script.after(canvas);

  // The text layer: add the data table when the author did not (and did not opt out with
  // data-table="none"), and alt text when missing.
  const title = figure.querySelector(".chart-title")?.textContent?.trim() || undefined;
  const text = buildChartText(parsed, title);
  let hasTable = Boolean(figure.querySelector("table"));
  if (wantsAutoTable(figure) && text.table) {
    figure.insertAdjacentHTML("beforeend", chartTableHtml(text.table));
    hasTable = true;
  }
  if (hasTable) canvas.setAttribute("aria-hidden", "true");
  if (!figure.hasAttribute("aria-label")) figure.setAttribute("aria-label", text.alt);
  if (!figure.hasAttribute("role")) figure.setAttribute("role", "group");

  const colorAxis = "colorAxis" in options || (Array.isArray(options.series) && options.series.some((series) => isObject(series) && series.type === "heatmap"));
  const chartOptions = colorAxis ? merge(options, { colorAxis: colorAxisTheme() }) : options;
  try {
    const chart = Highcharts.chart(inner, chartOptions as Highcharts.Options);
    charts.push({ chart, colorAxis });
    new ResizeObserver(() => chart.reflow()).observe(canvas);
  } catch (caught) {
    canvas.remove();
    fail(caught instanceof Error ? caught.message : String(caught));
  }
}

function start(): void {
  Highcharts.setOptions(baseTheme);
  installStyles();
  const charts: ChartWithAxis[] = [];
  for (const figure of Array.from(document.querySelectorAll<HTMLElement>("figure.chart"))) renderFigure(figure, charts);
  if (!charts.some((item) => item.colorAxis)) return;
  // Everything else follows the theme through CSS variables. Colour axes are
  // numbers inside Highcharts, so repaint them when the theme changes.
  const repaint = () => {
    const theme = colorAxisTheme();
    for (const item of charts) if (item.colorAxis) item.chart.update({ colorAxis: theme } as Highcharts.Options);
  };
  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-bb-theme", "class"] });
  if (document.body) new MutationObserver(repaint).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", repaint);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
