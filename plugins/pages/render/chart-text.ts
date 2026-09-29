// The text layer of a chart: a data table and an alt-text summary, built from
// the Highcharts options without Highcharts. Ported from hem.so
// components/Chart/dataTable.ts. Pure: the server renderers and the browser
// runtime (charts.js) both use it.
import { escapeHtml } from "./html.js";
import { field, firstAxis, isObject, list, text } from "./json.js";

type Cell = string | number;
export type ChartTable = { headers: string[]; rows: Cell[][] };

// Series types that read as "node → node (weight)".
const RELATIONAL: Record<string, true> = { sankey: true, dependencywheel: true, networkgraph: true, arcdiagram: true, organization: true };
// Series types that read as a flat "name → value" list.
const NAME_VALUE: Record<string, true> = { pie: true, funnel: true, pyramid: true, sunburst: true, treemap: true, variwide: true, venn: true };

function chartType(options: unknown): string {
  return text(field(field(options, "chart"), "type")) ?? text(field(list(field(options, "series"))[0], "type")) ?? "line";
}

function categoriesOf(axis: unknown): unknown[] | null {
  const categories = field(axis, "categories");
  return Array.isArray(categories) ? categories : null;
}

function seriesName(series: unknown, index: number): string {
  return text(field(series, "name")) ?? `Series ${index + 1}`;
}

function cell(value: unknown): Cell {
  return typeof value === "number" ? value : value == null ? "" : String(value);
}

function pointName(point: unknown, index: number): string {
  const name = field(point, "name");
  if (name != null) return String(name);
  if (Array.isArray(point) && typeof point[0] === "string") return point[0];
  return String(index + 1);
}

function pointValue(point: unknown): Cell {
  if (typeof point === "number") return point;
  if (Array.isArray(point)) return cell(point[point.length - 1]);
  if (isObject(point)) return cell(point.y ?? point.value ?? point.weight);
  return "";
}

/** [x, y] pairs or {x, y} points, or null when the series is neither. */
function pairsOf(series: unknown): Cell[][] | null {
  const data = list(field(series, "data"));
  const rows: Cell[][] = [];
  for (const point of data) {
    if (Array.isArray(point) && point.length >= 2) rows.push([cell(point[0]), cell(point[1])]);
    else if (isObject(point) && "x" in point && "y" in point) rows.push([cell(point.x), cell(point.y)]);
    else return null;
  }
  return rows;
}

function tableFrom(options: unknown): ChartTable | null {
  const series = list(field(options, "series"));
  if (!series.length) return null;
  const type = chartType(options);
  const dataOf = (item: unknown) => list(field(item, "data"));
  const xAxis = firstAxis(options, "xAxis");
  const yAxis = firstAxis(options, "yAxis");
  const axisTitle = (axis: unknown) => text(field(field(axis, "title"), "text"));

  if (RELATIONAL[type]) {
    const rows = series.flatMap((item) => dataOf(item).flatMap((point): Cell[][] => {
      if (Array.isArray(point)) return [[cell(point[0]), cell(point[1]), cell(point[2])]];
      if (isObject(point)) return [[cell(point.from), cell(point.to), cell(point.weight ?? point.value)]];
      return [];
    }));
    return rows.length ? { headers: ["From", "To", "Weight"], rows } : null;
  }

  if (NAME_VALUE[type]) {
    const rows = series.flatMap((item) => dataOf(item).map((point, index) => [pointName(point, index), pointValue(point)]));
    return rows.length ? { headers: ["Name", "Value"], rows } : null;
  }

  // Heatmap: [x, y, value], labelled through both category axes.
  if (type === "heatmap") {
    const label = (categories: unknown[] | null, value: unknown) => cell(categories && typeof value === "number" && categories[value] != null ? categories[value] : value);
    const [xCats, yCats] = [categoriesOf(xAxis), categoriesOf(yAxis)];
    const rows = series.flatMap((item) => dataOf(item).flatMap((point): Cell[][] => {
      if (Array.isArray(point)) return [[label(xCats, point[0]), label(yCats, point[1]), cell(point[2])]];
      if (isObject(point)) return [[label(xCats, point.x), label(yCats, point.y), cell(point.value)]];
      return [];
    }));
    return rows.length ? { headers: [axisTitle(xAxis) ?? "X", axisTitle(yAxis) ?? "Y", "Value"], rows } : null;
  }

  // Cartesian with categories: category × each series' value.
  const categories = categoriesOf(xAxis);
  if (categories?.length) {
    return {
      headers: [axisTitle(xAxis) ?? "", ...series.map(seriesName)],
      rows: categories.map((category, index) => [typeof category === "number" ? category : String(category), ...series.map((item) => pointValue(dataOf(item)[index]))]),
    };
  }

  // Plain numeric series: index × each series' value.
  if (series.every((item) => Array.isArray(field(item, "data")) && dataOf(item).every((point) => typeof point === "number"))) {
    const length = Math.max(...series.map((item) => dataOf(item).length));
    const rows: Cell[][] = [];
    for (let index = 0; index < length; index += 1) rows.push([index + 1, ...series.map((item) => cell(dataOf(item)[index]))]);
    return { headers: ["#", ...series.map(seriesName)], rows };
  }

  // Scatter-like points. Several series get a Series column.
  const all = series.map(pairsOf);
  if (all.every((rows) => rows !== null) && all.some((rows) => rows.length)) {
    const [x, y] = [axisTitle(xAxis) ?? "X", axisTitle(yAxis) ?? "Y"];
    if (all.length === 1) return { headers: [x, y], rows: all[0]! };
    return { headers: ["Series", x, y], rows: all.flatMap((rows, index) => rows.map((row) => [seriesName(series[index], index), ...row])) };
  }
  return null;
}

function altFrom(options: unknown, title?: string): string {
  const type = chartType(options);
  const names = list(field(options, "series")).map(seriesName);
  const categories = categoriesOf(firstAxis(options, "xAxis"));
  const parts = [`${type.charAt(0).toUpperCase()}${type.slice(1)} chart`];
  if (title) parts.push(`titled “${title}”`);
  if (names.length === 1) parts.push(`of ${names[0]}`);
  else if (names.length > 1) parts.push(`with ${names.length} series: ${names.join(", ")}`);
  if (categories?.length) parts.push(`across ${String(categories[0])}–${String(categories[categories.length - 1])}`);
  return `${parts.join(" ")}.`;
}

/** Highcharts options → a data table (or null) and an alt-text summary. */
export function buildChartText(options: unknown, title?: string): { table: ChartTable | null; alt: string } {
  if (!isObject(options)) return { table: null, alt: title || "Chart" };
  return { table: tableFrom(options), alt: altFrom(options, title) };
}

/** The site-style `<details>` data table for a chart figure. Numeric columns are right-aligned. */
export function chartTableHtml(table: ChartTable): string {
  const numeric = table.headers.map((_, column) => column > 0 && table.rows.every((row) => typeof row[column] === "number" || row[column] === ""));
  const cls = (column: number) => (numeric[column] ? ' class="num"' : "");
  const show = (value: Cell) => escapeHtml(typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : value);
  const head = table.headers.map((header, column) => `<th scope="col"${cls(column)}>${escapeHtml(header)}</th>`).join("");
  const body = table.rows.map((row) => `<tr>${row.map((value, column) => `<td${cls(column)}>${show(value)}</td>`).join("")}</tr>`).join("\n");
  return `<details><summary>Data table</summary><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></details>`;
}

/**
 * The chart runtime adds a data table to a figure unless the figure already has a `<table>`
 * or opts out with `data-table="none"` (the page shows the same data in a table next to it).
 */
export function wantsAutoTable(figure: { querySelector(selector: string): unknown; getAttribute(name: string): string | null }): boolean {
  return !figure.querySelector("table") && figure.getAttribute("data-table")?.trim().toLowerCase() !== "none";
}
