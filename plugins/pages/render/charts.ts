import { buildChartText, chartTableHtml } from "./chart-text.js";
import { attr, escapeHtml, hasClass, jsonForScript, scanHtml } from "./html.js";
import { isObject } from "./json.js";

export const MAX_CHARTS_PER_PAGE = 20;
export const MAX_POINTS_PER_CHART = 5_000;

export type ChartBlock = { json: string; title?: string };

/** Every `<script type="application/json">` inside a `figure.chart`, in document order. */
export function findChartBlocks(html: string): ChartBlock[] {
  const blocks: ChartBlock[] = [];
  // One entry per open <figure>: is it a chart, and its .chart-title text so far.
  const figures: Array<{ chart: boolean; title?: string }> = [];
  const { tags } = scanHtml(html);
  for (const [index, tag] of tags.entries()) {
    if (tag.name === "figure") {
      if (tag.kind === "start") figures.push({ chart: hasClass(tag, "chart") });
      else figures.pop();
      continue;
    }
    const figure = [...figures].reverse().find((item) => item.chart);
    if (!figure || tag.kind !== "start") continue;
    if (hasClass(tag, "chart-title")) {
      const next = tags[index + 1];
      figure.title = html.slice(tag.end, next ? next.start : tag.end).trim() || undefined;
    }
    const type = (attr(tag, "type") ?? "").trim().toLowerCase();
    if (tag.name === "script" && (type === "application/json" || type.startsWith("application/json;"))) {
      blocks.push({ json: tag.text ?? "", title: figure.title });
    }
  }
  return blocks;
}

const FUNCTION_TEXT = /^\s*(?:async\s+)?(?:function\b|(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>)/u;
const REMOTE_URL = /^\s*(?:https?:|\/\/|javascript:)/iu;
const URL_KEYS: Record<string, true> = { url: true, href: true, src: true };

function problemsIn(options: unknown): string[] {
  const problems: string[] = [];
  let points = 0;
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (typeof child === "string") {
        if (FUNCTION_TEXT.test(child)) problems.push(`${at} looks like a function. Use a format string, not code`);
        if (URL_KEYS[key.toLowerCase()] && REMOTE_URL.test(child)) problems.push(`${at} points to a remote or script URL`);
      }
      if (key === "data" && Array.isArray(child)) points += child.length;
      walk(child, at);
    }
  };
  walk(options, "");
  if (points > MAX_POINTS_PER_CHART) problems.push(`${points} data points; the limit is ${MAX_POINTS_PER_CHART}. Aggregate first`);
  return problems;
}

/**
 * Find figure.chart JSON blocks and validate them: the JSON parses to an
 * object, no function-like strings, no remote or javascript: URLs, at most
 * 5,000 points per chart and 20 charts per page.
 */
export function inspectCharts(html: string): { hasCharts: boolean; errors: string[] } {
  const blocks = findChartBlocks(html);
  const errors: string[] = [];
  if (blocks.length > MAX_CHARTS_PER_PAGE) errors.push(`The page has ${blocks.length} charts; the limit is ${MAX_CHARTS_PER_PAGE}.`);
  blocks.forEach((block, index) => {
    const name = `Chart ${index + 1}${block.title ? ` (“${block.title.slice(0, 60)}”)` : ""}`;
    let options: unknown;
    try {
      options = JSON.parse(block.json);
    } catch (error) {
      errors.push(`${name}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!isObject(options)) {
      errors.push(`${name}: the JSON must be an object of Highcharts options.`);
      return;
    }
    for (const problem of problemsIn(options)) errors.push(`${name}: ${problem}.`);
  });
  return { hasCharts: blocks.length > 0, errors };
}

export type ChartFigure = {
  options: Record<string, unknown>;
  title?: string;
  subtitle?: string;
  /** Plain text. */
  caption?: string;
  /** Alt text; generated from the options when missing. */
  alt?: string;
  variant?: "simple";
  aspect?: string;
};

/** A complete `figure.chart` block: title, subtitle, JSON options, data table, caption. */
export function chartFigureHtml(figure: ChartFigure): string {
  const { table, alt } = buildChartText(figure.options, figure.title);
  const attrs = [
    'class="chart"',
    `aria-label="${escapeHtml(figure.alt ?? alt)}"`,
    figure.variant ? `data-variant="${figure.variant}"` : "",
    figure.aspect ? `data-aspect="${escapeHtml(figure.aspect)}"` : "",
  ].filter(Boolean).join(" ");
  return [
    `<figure ${attrs}>`,
    figure.title ? `<div class="chart-title">${escapeHtml(figure.title)}</div>` : "",
    figure.subtitle ? `<div class="chart-subtitle">${escapeHtml(figure.subtitle)}</div>` : "",
    `<script type="application/json">${jsonForScript(figure.options)}</script>`,
    figure.caption ? `<figcaption>${escapeHtml(figure.caption)}</figcaption>` : "",
    table ? chartTableHtml(table) : "",
    "</figure>",
  ].filter(Boolean).join("\n");
}
