// One-time import of Flint `report/v1` documents (from the retired artifacts
// plugin) into themed HTML pages. The input is untyped JSON from the old
// database, so every field is read through guards.
import { chartFigureHtml } from "./charts.js";
import { escapeHtml } from "./html.js";
import { field, isObject, list, text, type JsonObject } from "./json.js";
import { markdownBlock, markdownInline, pageDocument } from "./markdown.js";

type Row = JsonObject;
type Scalar = string | number | boolean | null;
type Encoding = { field: string; type?: string; aggregate?: string; sortOrder?: string; sortBy?: string };

const TONE: Record<string, { className: string; word: string }> = {
  note: { className: "", word: "Note" },
  success: { className: "success", word: "Good" },
  warning: { className: "warning", word: "Watch" },
  danger: { className: "danger", word: "Risk" },
};
const NUMERIC_CELL = /^[-+−]?[\d,.]+\s*[%kmbKMB]?$/u;

function encoding(value: unknown): Encoding | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string" && first) return { field: first };
  const name = text(field(first, "field"));
  if (!name) return null;
  return {
    field: name,
    type: text(field(first, "type")),
    aggregate: text(field(first, "aggregate")),
    sortOrder: text(field(first, "sortOrder")),
    sortBy: text(field(first, "sortBy")),
  };
}

function aggregate(values: number[], how: string | undefined): number {
  if (how === "count") return values.length;
  const sum = values.reduce((total, value) => total + value, 0);
  return how === "average" || how === "mean" ? sum / values.length : sum;
}

/** Unique values in first-seen order. */
function distinct(rows: Row[], key: string): Scalar[] {
  const seen = new Map<string, Scalar>();
  for (const row of rows) {
    const value = (row[key] ?? null) as Scalar;
    if (!seen.has(String(value))) seen.set(String(value), value);
  }
  return [...seen.values()];
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Flint chart component → Highcharts options, or null when the chart cannot
 * be mapped. Supports line, area, bar/column (vertical or horizontal),
 * scatter, and their stacked forms. The color encoding groups rows into series.
 */
export function flintChartOptions(component: JsonObject): Record<string, unknown> | null {
  const rows = list(component.data).filter(isObject);
  const spec = field(component, "chart_spec");
  const encodings = field(spec, "encodings");
  const names = field(component, "field_display_names");
  const semantic = field(component, "semantic_types");
  const display = (key: string) => text(field(names, key)) ?? key;
  const kind = (text(field(spec, "chartType")) ?? "").toLowerCase();
  const stacking = /stack/u.test(kind) ? (/percent|normali[sz]ed|100/u.test(kind) ? "percent" : "normal") : undefined;
  const base = /scatter|point|bubble/u.test(kind) ? "scatter" : /area/u.test(kind) ? "area" : /line/u.test(kind) ? "line" : /bar|column|histogram/u.test(kind) ? "bar" : null;
  let x = encoding(field(encodings, "x"));
  let y = encoding(field(encodings, "y"));
  const color = encoding(field(encodings, "color"));
  if (!base || !x || !y || !rows.length) return null;
  if (![x, y, color].every((item) => !item || rows.some((row) => Object.hasOwn(row, item.field)))) return null;

  // Bars: the numeric field is the value. A numeric x with a categorical y is a horizontal bar.
  let type: string = base;
  if (base === "bar") {
    const xNumeric = rows.every((row) => isNumber(row[x!.field]));
    const yNumeric = rows.every((row) => isNumber(row[y!.field]));
    if (xNumeric && !yNumeric) [x, y] = [y, x];
    else if (!yNumeric) return null;
    type = xNumeric && !yNumeric ? "bar" : "column";
  }
  if (!rows.every((row) => isNumber(row[y!.field]) || row[y!.field] === null)) return null;

  const groups = color ? distinct(rows, color.field) : [null];
  const seriesName = (group: Scalar) => (group === null ? display(y!.field) : String(group));
  const numericX = rows.every((row) => isNumber(row[x!.field])) && x.type !== "nominal" && x.type !== "ordinal";
  const series: JsonObject[] = [];
  let categories: Scalar[] | undefined;

  if (numericX && type !== "column" && type !== "bar") {
    for (const group of groups) {
      const data = rows
        .filter((row) => !color || String(row[color.field] ?? null) === String(group))
        .map((row) => [row[x!.field] as number, row[y!.field] as number | null])
        .sort((a, b) => a[0]! - b[0]!);
      series.push({ type, name: seriesName(group), data });
    }
  } else {
    categories = distinct(rows, x.field);
    const sortBy = x.sortBy ?? (x.sortOrder ? x.field : undefined);
    if (sortBy) {
      const key = (category: Scalar) => {
        const matching = rows.filter((row) => String(row[x!.field] ?? null) === String(category)).map((row) => row[sortBy]);
        return matching.every(isNumber) ? aggregate(matching, "sum") : String(matching[0] ?? "");
      };
      const keyed = categories.map((category) => ({ category, key: key(category) }));
      keyed.sort((a, b) => (typeof a.key === "number" && typeof b.key === "number" ? a.key - b.key : String(a.key).localeCompare(String(b.key))));
      if (x.sortOrder === "descending") keyed.reverse();
      categories = keyed.map((item) => item.category);
    }
    for (const group of groups) {
      const data = categories!.map((category) => {
        const values = rows
          .filter((row) => String(row[x!.field] ?? null) === String(category) && (!color || String(row[color.field] ?? null) === String(group)))
          .map((row) => row[y!.field])
          .filter(isNumber);
        return values.length ? aggregate(values, y!.aggregate) : null;
      });
      series.push({ type, name: seriesName(group), data });
    }
  }

  const percent = text(field(semantic, y.field))?.toLowerCase() === "percentage" && rows.some((row) => Math.abs(Number(row[y!.field])) > 1);
  const options: JsonObject = {
    chart: { type },
    xAxis: { ...(categories ? { categories: categories.map((value) => (value === null ? "" : String(value))) } : {}), title: { text: display(x.field) } },
    yAxis: { title: { text: display(y.field) }, ...(percent ? { labels: { format: "{value}%" } } : {}) },
    legend: { enabled: series.length > 1 },
    series,
  };
  if (percent) options.tooltip = { valueSuffix: "%" };
  if (stacking) options.plotOptions = { series: { stacking } };
  return options;
}

function staticTable(columns: string[], rows: string[][], caption?: string): string {
  const numeric = columns.map((_, column) => column > 0 && rows.length > 0 && rows.every((row) => !row[column] || NUMERIC_CELL.test(row[column]!.trim())));
  const cls = (column: number) => (numeric[column] ? ' class="num"' : "");
  const head = columns.map((column, index) => `<th${cls(index)}>${escapeHtml(column)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((value, index) => `<td${cls(index)}>${markdownInline(value)}</td>`).join("")}</tr>`).join("\n");
  const table = `<table>${caption ? `<caption>${escapeHtml(caption)}</caption>` : ""}<thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
  // Wide tables scroll inside their own box so the page never scrolls sideways.
  return columns.length > 4 ? `<div style="overflow-x:auto">${table}</div>` : table;
}

function chartHtml(component: JsonObject, showTitle: boolean): string {
  const spec = field(component, "chart_spec");
  const title = showTitle ? text(field(spec, "title")) : undefined;
  const subtitle = text(field(spec, "subtitle"));
  const provenance = field(component, "provenance");
  const caption = [text(field(provenance, "summary")), text(field(provenance, "source")) && `Source: ${text(field(provenance, "source"))}`, text(field(provenance, "snapshot")) && `Snapshot: ${text(field(provenance, "snapshot"))}`]
    .filter(Boolean).join(" · ") || undefined;
  const query = text(field(provenance, "query"));
  const queryHtml = query ? `\n<details><summary>Query</summary><pre><code>${escapeHtml(query)}</code></pre></details>` : "";
  const options = flintChartOptions(component);
  if (options) {
    return chartFigureHtml({ options, title, subtitle, caption, alt: text(component.alt_text) }) + queryHtml;
  }
  // Cannot map: keep the data as a static table under the same title.
  const rows = list(component.data).filter(isObject);
  const names = field(component, "field_display_names");
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    `<figure class="chart" aria-label="${escapeHtml(text(component.alt_text) ?? title ?? "Chart")}">`,
    title ? `<div class="chart-title">${escapeHtml(title)}</div>` : "",
    subtitle ? `<div class="chart-subtitle">${escapeHtml(subtitle)}</div>` : "",
    staticTable(columns.map((key) => text(field(names, key)) ?? key), rows.map((row) => columns.map((key) => (row[key] == null ? "" : String(row[key]))))),
    caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "",
    "</figure>",
  ].filter(Boolean).join("\n") + queryHtml;
}

function svgFigure(svg: string, alt: string, title: string): string {
  return `<figure><img alt="${escapeHtml(alt)}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"><figcaption>${escapeHtml(title)}</figcaption></figure>`;
}

function componentHtml(component: JsonObject, context: { reportTitle: string; chartCount: number }): string {
  switch (component.type) {
    case "heading": {
      const level = [2, 3, 4].includes(component.level as number) ? component.level : 2;
      return `<h${level}>${escapeHtml(String(component.text ?? ""))}</h${level}>`;
    }
    case "text":
      return markdownBlock(String(component.text ?? ""));
    case "callout": {
      const tone = TONE[String(component.tone)] ?? TONE.note!;
      const body = String(component.text ?? "");
      const title = text(component.title);
      const content = title && !/\n\s*\n/u.test(body)
        ? `<p><strong>${escapeHtml(title)}</strong> ${markdownInline(body)}</p>`
        : `${title ? `<p><strong>${escapeHtml(title)}</strong></p>` : ""}${markdownBlock(body)}`;
      return `<div class="${["note", tone.className].filter(Boolean).join(" ")}"><span class="tone">${tone.word}</span>${content}</div>`;
    }
    case "code": {
      const language = text(component.language);
      const pre = `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(String(component.code ?? ""))}</code></pre>`;
      const caption = text(component.caption);
      return caption ? `<figure>${pre}<figcaption>${escapeHtml(caption)}</figcaption></figure>` : pre;
    }
    case "table": {
      const columns = list(component.columns).map(String);
      const rows = list(component.rows).map((row) => list(row).map((value) => (value == null ? "" : String(value))));
      return staticTable(columns, rows, text(component.caption));
    }
    case "metadata": {
      const items = list(component.items).map((item) => `<dt>${escapeHtml(String(field(item, "label") ?? ""))}</dt><dd>${markdownInline(String(field(item, "value") ?? ""))}</dd>`);
      return `<dl class="list">\n${items.join("\n")}\n</dl>`;
    }
    case "diagram": {
      const svg = text(component.svg);
      return svg ? svgFigure(svg, text(component.alt) ?? "", text(component.title) ?? "") : "";
    }
    case "chart": {
      const chartTitle = (text(field(component.chart_spec, "title")) ?? "").trim().toLowerCase();
      const repeatsReport = context.chartCount === 1 && chartTitle === context.reportTitle.trim().toLowerCase();
      return chartHtml(component, !repeatsReport);
    }
    default:
      return "";
  }
}

/** One-time import: a Flint `report/v1` document → a full HTML page using the theme classes and figure.chart blocks. */
export function convertLegacyReport(document: unknown): string {
  const title = text(field(document, "title")) ?? "Imported report";
  const description = text(field(document, "description"));
  const components = list(field(document, "components")).filter(isObject);
  const context = { reportTitle: title, chartCount: components.filter((component) => component.type === "chart").length };
  const body = [
    `<h1>${escapeHtml(title)}</h1>`,
    description ? `<p class="lede">${markdownInline(description)}</p>` : "",
    ...components.map((component) => componentHtml(component, context)),
  ].filter(Boolean);
  return pageDocument(title, `${body.join("\n")}\n`);
}
