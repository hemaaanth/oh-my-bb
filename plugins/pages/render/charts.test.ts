import { describe, expect, it } from "vitest";
import { buildChartText, chartFigureHtml, inspectCharts, wantsAutoTable } from "./index.js";
import { flintChartOptions } from "./legacy.js";

const figure = (json: string, title = "") => `<figure class="chart">${title ? `<div class="chart-title">${title}</div>` : ""}<script type="application/json">${json}</script></figure>`;
const line = JSON.stringify({ xAxis: { categories: ["a", "b"] }, series: [{ type: "line", name: "Rate", data: [1, 2] }] });

describe("inspectCharts", () => {
  it("accepts valid blocks and reports hasCharts", () => {
    expect(inspectCharts(`<p>no charts</p><script type="application/json">{}</script>`)).toEqual({ hasCharts: false, errors: [] });
    expect(inspectCharts(figure(line) + figure(line))).toEqual({ hasCharts: true, errors: [] });
    // A format string that mentions an arrow is text, not code.
    expect(inspectCharts(figure(JSON.stringify({ tooltip: { pointFormat: "{point.from} => {point.to}" }, series: [] }))).errors).toEqual([]);
  });

  it("rejects invalid JSON and non-object JSON, naming the chart", () => {
    const { hasCharts, errors } = inspectCharts(figure("{ nope", "Sales") + figure("[1,2]"));
    expect(hasCharts).toBe(true);
    expect(errors[0]).toMatch(/^Chart 1 \(“Sales”\): invalid JSON/u);
    expect(errors[1]).toMatch(/^Chart 2: the JSON must be an object/u);
  });

  it("rejects function-like strings", () => {
    for (const code of ["function () { return 1 }", "(x) => x * 2", "value => value", "async function f() {}"]) {
      expect(inspectCharts(figure(JSON.stringify({ tooltip: { formatter: code } }))).errors).toHaveLength(1);
    }
  });

  it("rejects remote and script URLs in url, href, and src", () => {
    const errors = (value: unknown) => inspectCharts(figure(JSON.stringify(value))).errors;
    expect(errors({ series: [{ data: [{ y: 1, url: "https://evil.example" }] }] })).toHaveLength(1);
    expect(errors({ credits: { href: "//evil.example" } })).toHaveLength(1);
    expect(errors({ series: [{ marker: { symbol: "url(x)", src: "JavaScript:alert(1)" } }] })).toHaveLength(1);
    expect(errors({ series: [{ data: [{ y: 1, url: "#section" }] }] })).toEqual([]);
  });

  it("caps points per chart and charts per page", () => {
    const points = (count: number) => figure(JSON.stringify({ series: [{ data: Array.from({ length: count }, () => 1) }] }));
    expect(inspectCharts(points(5_000)).errors).toEqual([]);
    expect(inspectCharts(points(5_001)).errors[0]).toMatch(/5001 data points/u);
    expect(inspectCharts(figure(line).repeat(21)).errors).toEqual(["The page has 21 charts; the limit is 20."]);
  });

  it("finds blocks only inside figure.chart, including nested markup, and not in comments", () => {
    expect(inspectCharts(`<figure class="wide chart"><div><script type="application/json; charset=utf-8">{ bad</script></div></figure>`).errors).toHaveLength(1);
    expect(inspectCharts(`<!-- ${figure("{ bad")} -->`).hasCharts).toBe(false);
    expect(inspectCharts(`<figure><script type="application/json">{ bad</script></figure>`).hasCharts).toBe(false);
  });
});

describe("chart text", () => {
  it("builds the site-style data table and alt text", () => {
    const { table, alt } = buildChartText(JSON.parse(line), "Rate fell");
    expect(table).toEqual({ headers: ["", "Rate"], rows: [["a", 1], ["b", 2]] });
    expect(alt).toBe("Line chart titled “Rate fell” of Rate across a–b.");
  });

  it("writes a complete figure that passes inspection and survives </script> in data", () => {
    const html = chartFigureHtml({ title: "T", caption: "c", options: { xAxis: { categories: ["</script><b>"] }, series: [{ type: "column", name: "n", data: [3] }] } });
    expect(html).toContain('<script type="application/json">{"xAxis":{"categories":["\\u003c/script>\\u003cb>"]}');
    expect(html).toContain("<details><summary>Data table</summary>");
    expect(inspectCharts(html)).toEqual({ hasCharts: true, errors: [] });
  });

  it("adds a data table unless the figure has one or opts out with data-table=\"none\"", () => {
    const figure = (attr: string | null, table: boolean) => ({ querySelector: () => (table ? {} : null), getAttribute: () => attr });
    expect(wantsAutoTable(figure(null, false))).toBe(true);
    expect(wantsAutoTable(figure(null, true))).toBe(false);
    expect(wantsAutoTable(figure(" None ", false))).toBe(false);
    expect(wantsAutoTable(figure("auto", false))).toBe(true);
    const optedOut = chartFigureHtml({ title: "T", options: { series: [{ type: "bar", data: [1] }] } }).replace('<figure class="chart"', '<figure class="chart" data-table="none"');
    expect(inspectCharts(optedOut)).toEqual({ hasCharts: true, errors: [] });
  });
});

describe("flintChartOptions", () => {
  it("groups by the color encoding and stacks stacked bars", () => {
    const options = flintChartOptions({
      data: [{ p: "Rill", l: "UI", k: 2 }, { p: "Rill", l: "Engine", k: 1 }, { p: "Evidence", l: "UI", k: 3 }],
      field_display_names: { p: "Product", k: "Lines" },
      chart_spec: { chartType: "Stacked Bar Chart", title: "t", encodings: { x: "p", y: "k", color: "l" } },
    });
    expect(options).toMatchObject({
      chart: { type: "column" },
      xAxis: { categories: ["Rill", "Evidence"], title: { text: "Product" } },
      yAxis: { title: { text: "Lines" } },
      plotOptions: { series: { stacking: "normal" } },
      series: [{ name: "UI", data: [2, 3] }, { name: "Engine", data: [1, null] }],
    });
  });

  it("sorts categories by sortBy and maps percentages", () => {
    const options = flintChartOptions({
      data: [{ a: "x", s: 10 }, { a: "y", s: 50 }],
      semantic_types: { s: "Percentage" },
      chart_spec: { chartType: "bar", title: "t", encodings: { x: { field: "a", sortBy: "s", sortOrder: "descending" }, y: { field: "s" } } },
    });
    expect(options).toMatchObject({ xAxis: { categories: ["y", "x"] }, yAxis: { labels: { format: "{value}%" } }, tooltip: { valueSuffix: "%" }, legend: { enabled: false } });
  });

  it("maps numeric scatter to point pairs and refuses unknown chart types", () => {
    expect(flintChartOptions({ data: [{ a: 2, b: 3 }, { a: 1, b: 5 }], chart_spec: { chartType: "Scatter Plot", title: "t", encodings: { x: "a", y: "b" } } }))
      .toMatchObject({ chart: { type: "scatter" }, series: [{ data: [[1, 5], [2, 3]] }] });
    expect(flintChartOptions({ data: [{ a: 1, b: 2 }], chart_spec: { chartType: "Sankey", title: "t", encodings: { x: "a", y: "b" } } })).toBeNull();
  });
});
