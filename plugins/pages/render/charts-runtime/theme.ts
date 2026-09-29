// Port of hem.so components/Chart/theme.ts: structure and behaviour that CSS
// cannot own. All presentation (colours, fonts, strokes) lives in charts.css.
import type { Options } from "highcharts";

// A small swatch that matches the legend symbol, before each tooltip row.
const SWATCH = '<span class="highcharts-color-{point.colorIndex} hc-sw">▪</span> ';

type LegendClickEvent = { legendItem?: { series?: unknown; visible?: boolean; chart?: { series: Array<{ visible: boolean }> } }; preventDefault?: () => void };

export const baseTheme: Options = {
  chart: {
    styledMode: true,
    // No card around the chart: the y-axis labels line up with the text column.
    spacing: [12, 24, 6, 0],
    animation: { duration: 350 },
  },
  // Title, subtitle, and caption are HTML in the figure, never drawn by Highcharts.
  title: { text: undefined },
  subtitle: { text: undefined },
  credits: { enabled: false },
  exporting: { enabled: false },
  legend: {
    align: "left",
    verticalAlign: "bottom",
    squareSymbol: true,
    symbolRadius: 6,
    margin: 12,
    padding: 0,
    itemDistance: 16,
    events: {
      // Never hide the last visible series.
      itemClick(event) {
        const item = (event as unknown as LegendClickEvent).legendItem;
        if (!item || item.series || !item.chart) return;
        const visible = item.chart.series.filter((series) => series.visible).length;
        if (item.visible && visible <= 1) {
          event.preventDefault?.();
          return false;
        }
      },
    },
  },
  tooltip: {
    shared: true,
    outside: false,
    shape: "rect",
    borderRadius: 8,
    padding: 10,
    headerFormat: "",
    pointFormat: `${SWATCH}{series.name}: <b>{point.y}</b><br/>`,
  },
  responsive: {
    rules: [{ condition: { maxWidth: 520 }, chartOptions: { chart: { spacing: [10, 24, 4, 0] }, legend: { symbolRadius: 5, itemDistance: 12 } } }],
  },
  plotOptions: {
    series: {
      events: {
        // If anything hides the last visible series, show it again.
        hide() {
          const chart = this.chart;
          if (chart.series.every((series) => !series.visible)) this.setVisible(true);
        },
      },
    },
    // Clean lines: markers only on hover. pointPlacement 'on' spans the full plot width on category axes.
    line: { marker: { enabled: false }, pointPlacement: "on" },
    spline: { marker: { enabled: false }, pointPlacement: "on" },
    area: { marker: { enabled: false }, pointPlacement: "on" },
    areaspline: { marker: { enabled: false }, pointPlacement: "on" },
    treemap: { colorByPoint: true, tooltip: { headerFormat: "", pointFormat: `${SWATCH}{point.name}: <b>{point.value}</b>` } },
    sunburst: { colorByPoint: true, tooltip: { headerFormat: "", pointFormat: `${SWATCH}{point.name}: <b>{point.value}</b>` } },
    pie: { tooltip: { headerFormat: "", pointFormat: `${SWATCH}{point.name}: <b>{point.y}</b>` } },
    funnel: { tooltip: { headerFormat: "", pointFormat: `${SWATCH}{point.name}: <b>{point.y}</b>` } },
    pyramid: { tooltip: { headerFormat: "", pointFormat: `${SWATCH}{point.name}: <b>{point.y}</b>` } },
    heatmap: { tooltip: { headerFormat: "", pointFormat: "<b>{point.value}</b>" } },
    scatter: { tooltip: { headerFormat: "", pointFormat: `${SWATCH}{series.name}: <b>{point.x}, {point.y}</b>` } },
    sankey: { tooltip: { headerFormat: "", nodeFormat: "{point.name}: <b>{point.sum}</b>", pointFormat: "{point.from} → {point.to}: <b>{point.weight}</b>" } },
    dependencywheel: { tooltip: { headerFormat: "", nodeFormat: "{point.name}: <b>{point.sum}</b>", pointFormat: "{point.from} → {point.to}: <b>{point.weight}</b>" } },
  },
  lang: { thousandsSep: "," },
  accessibility: { enabled: true },
};
