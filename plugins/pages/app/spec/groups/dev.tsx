// Dev: test, build, and runtime results: logs, pipelines, coverage, traces.
import { useMemo, useState, type ReactNode } from "react";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { useHost } from "../host.js";
import { Chevron, Reveal, focusRing, type Group } from "../kit.js";
import {
  byStage, findLinks, formatAmount, formatElapsed, frameRows, niceTicks, overallStatus, readLogs, readPipeline,
  readTiles, readTrace, readWaterfall, treemapPoints, type Job, type LogLevel, type PipelineStatus,
} from "./dev-logic.js";
import { ChartFailed, useChartClass, useHighchart } from "./charts.js";
import { BenchmarkView } from "../reports/BenchmarkView.js";
import { CoverageView } from "../reports/CoverageView.js";
import { DependenciesView } from "../reports/DependenciesView.js";
import { FindingsView } from "../reports/ResultsView.js";

const toggle = `flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-sm text-left ${focusRing}`;
const link = `cursor-pointer rounded-sm text-primary hover:underline ${focusRing}`;
const row = "border-b border-border-hairline py-1.5 last:border-b-0";
const list = "m-0 flex list-none flex-col p-0";
const data = z.union([z.array(z.any()), z.record(z.string(), z.any())]);

function Title({ text, children }: { text?: string; children?: ReactNode }) {
  return text || children ? <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">{text ? <h3 className="m-0 font-semibold text-foreground">{text}</h3> : null}{children}</div> : null;
}

function Empty({ text }: { text: string }) {
  return <p className="m-0 text-muted-foreground">{text}</p>;
}


const esc = (value: string) => value.replace(/[&<>"]/gu, (char) => `&#${char.charCodeAt(0)};`);


const Benchmark = defineComponent({
  name: "Benchmark",
  props: z.object({ results: data, title: z.string().optional(), unit: z.string().optional() }),
  description: 'Benchmark results from manual before/after rows, hyperfine JSON, vitest bench JSON, or runs with metrics and conditions. unit accepts time, bytes, rates, percentages, or a label. Changes smaller than noise stay unchanged. Different recorded conditions are not presented as a like-for-like improvement. Expand a result for samples and conditions.',
  component: ({ props }) => <BenchmarkView results={props.results} title={props.title} unit={props.unit} />,
});


const Coverage = defineComponent({
  name: "Coverage",
  props: z.object({ report: z.union([data, z.string()]), title: z.string().optional(), metric: z.enum(["lines", "statements", "functions", "branches"]).optional() }),
  description: 'Coverage from Istanbul coverage-summary.json, lcov.info text, coverage.py JSON, Go coverage.out text, or existing manual rows [{path, covered, total} | {path, pct}]. Files can be filtered, read as a directory tree, and expanded to inspect uncovered ranges. Query("file") returns .data for JSON and .text for lcov/Go. metric selects lines, statements, functions, or branches.',
  component: ({ props }) => <CoverageView report={props.report} title={props.title} metric={props.metric} />,
});


const Dependencies = defineComponent({
  name: "Dependencies",
  props: z.object({ packages: data, title: z.string().optional() }),
  description: 'Outdated and vulnerable dependencies. packages accepts existing manual rows, npm/pnpm outdated JSON, pip outdated JSON, npm audit v2, pnpm advisories, or {outdated, audit}. Expand a vulnerability for affected versions, direct/transitive relationships, advisory links, and the reported fix. This component never installs or updates a package.',
  component: ({ props }) => <DependenciesView packages={props.packages} title={props.title} />,
});


const Findings = defineComponent({
  name: "Findings",
  props: z.object({ findings: z.union([data, z.string()]), title: z.string().optional() }),
  description: 'Review, lint, or security findings from manual rows, ESLint/Ruff/oxlint/Biome JSON, SARIF, tsc text, or a structured review. Search by message, path, rule, or status. Expand a finding for evidence, source files, suggested patches, and ownership or verification details. Fixed by an owner is distinct from confirmed by a reviewer.',
  component: ({ props }) => <FindingsView findings={props.findings} title={props.title} />,
});

const LEVEL_TONE: Record<string, string> = { fatal: "text-destructive", error: "text-destructive", warn: "text-warning", debug: "text-muted-foreground", trace: "text-muted-foreground" };
const FILTERS: { id: string; label: string; levels: (LogLevel | null)[] | null }[] = [{ id: "all", label: "All", levels: null }, { id: "errors", label: "Errors", levels: ["fatal", "error"] }, { id: "warnings", label: "Warnings", levels: ["warn"] }];
const LOG_LIMIT = 500;

const Logs = defineComponent({
  name: "Logs",
  props: z.object({ log: z.union([z.string(), z.array(z.any())]), title: z.string().optional(), wrap: z.boolean().optional() }),
  description: 'A log viewer: levels toned, repeated lines folded with a count, links clickable, and filters for errors and warnings. log is the text (ANSI colours are removed) or a list of lines or {level, msg, time} entries (pino and bunyan JSON lines work). Levels are read from words like ERROR, [warn], level=info. wrap true wraps long lines. Load a file with Query("file") and pass its text.',
  component: ({ props }) => {
    const host = useHost();
    const [filter, setFilter] = useState("all");
    const [all, setAll] = useState(false);
    const lines = useMemo(() => readLogs(props.log), [props.log]);
    const counts = Object.fromEntries(FILTERS.map((item) => [item.id, item.levels ? lines.filter((line) => item.levels!.includes(line.level)).length : lines.length]));
    const levels = FILTERS.find((item) => item.id === filter)?.levels ?? null;
    const shown = levels ? lines.filter((line) => levels.includes(line.level)) : lines;
    const visible = all ? shown : shown.slice(-LOG_LIMIT);
    return <div className="flex min-w-0 flex-col gap-2">
      <Title text={props.title} />
      {counts.errors || counts.warnings ? <div role="group" aria-label="Show lines" className="flex gap-4 border-b border-border-hairline">{FILTERS.filter((item) => counts[item.id] || item.id === "all").map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} className={`-mb-px cursor-pointer border-b-2 pb-1 ${focusRing} ${filter === item.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{item.label} <span className="tabular-nums text-muted-foreground">{counts[item.id]}</span></button>)}</div> : null}
      {shown.length > visible.length ? <button type="button" onClick={() => setAll(true)} className={`self-start ${link}`}>Show {shown.length - visible.length} earlier lines</button> : null}
      {visible.length ? <ol className={`${list} max-h-96 overflow-auto font-mono text-[0.85em] leading-relaxed`}>{visible.map((line) => <li key={line.number} className={`flex min-w-0 gap-3 ${LEVEL_TONE[line.level ?? ""] ?? "text-foreground"}`}>
        <span aria-hidden className="w-10 shrink-0 select-none text-right tabular-nums text-muted-foreground">{line.number}</span>
        <span className={`min-w-0 flex-1 ${props.wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
          {line.time ? <span className="text-muted-foreground">{line.time} </span> : null}
          {findLinks(line.text).map((part, i) => part.url ? <button key={i} type="button" onClick={() => host.openUrl(part.url!)} className={`${link} underline`}>{part.text}</button> : <span key={i}>{part.text}</span>)}
          {line.count > 1 ? <span className="ml-2 text-muted-foreground">×{line.count}</span> : null}
        </span>
      </li>)}</ol> : <Empty text={lines.length ? "No lines match." : "No log lines."} />}
    </div>;
  },
});

const STATUS: Record<PipelineStatus, [string, string, string]> = {
  success: ["✓", "text-success", "passed"], failure: ["✕", "text-destructive", "failed"], in_progress: ["●", "text-primary", "running"], queued: ["○", "text-warning", "queued"],
  cancelled: ["⊘", "text-muted-foreground", "cancelled"], skipped: ["–", "text-muted-foreground", "skipped"], neutral: ["○", "text-muted-foreground", "neutral"],
};

function Mark({ status }: { status: PipelineStatus }) {
  return <span role="img" aria-label={STATUS[status][2]} title={STATUS[status][2]} className={`w-3 shrink-0 text-center ${STATUS[status][1]}`}>{STATUS[status][0]}</span>;
}

function JobRow({ job }: { job: Job }) {
  const host = useHost();
  const [open, setOpen] = useState(job.status === "failure" && job.steps.length > 0);
  const head = <><Mark status={job.status} /><span className="min-w-0 flex-1 truncate text-foreground" title={job.name}>{job.name}</span>{job.ms !== undefined ? <span className="shrink-0 tabular-nums text-muted-foreground">{formatElapsed(job.ms)}</span> : null}</>;
  return <li className={row}>
    <div className="flex min-w-0 items-baseline gap-2">
      {job.steps.length ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={toggle}><Chevron open={open} />{head}</button> : <div className="flex min-w-0 flex-1 items-baseline gap-2"><span className="w-[1em] shrink-0" />{head}</div>}
      {job.url && /^https?:\/\//iu.test(job.url) ? <button type="button" onClick={() => host.openUrl(job.url!)} className={`shrink-0 ${link}`}>Open</button> : null}
    </div>
    {job.steps.length ? <Reveal open={open}><ul className={`${list} mt-1 pl-5`}>{job.steps.map((step, i) => <li key={i} className="flex min-w-0 items-baseline gap-2 py-0.5">
      <Mark status={step.status} /><span className={`min-w-0 flex-1 truncate ${step.status === "skipped" ? "text-muted-foreground" : "text-foreground"}`}>{step.name}</span>{step.ms !== undefined ? <span className="shrink-0 tabular-nums text-muted-foreground">{formatElapsed(step.ms)}</span> : null}
    </li>)}</ul></Reveal> : null}
  </li>;
}

const Pipeline = defineComponent({
  name: "Pipeline",
  props: z.object({ jobs: data, title: z.string().optional() }),
  description: 'A CI run: its overall status, then jobs by stage, failures first; a job with steps opens to show them (failed jobs start open). jobs is [{name, status, ms?, stage?, url?, steps?}] or `gh run view --json jobs` output (status and conclusion, startedAt and completedAt). status is success, failure, in_progress, queued, cancelled, or skipped; words like passed, running, pending, error also work.',
  component: ({ props }) => {
    const jobs = readPipeline(props.jobs);
    const stages = byStage(jobs);
    const overall = overallStatus(jobs.map((job) => job.status));
    const total = jobs.reduce((sum, job) => sum + (job.ms ?? 0), 0);
    return <div className="flex min-w-0 flex-col gap-2">
      <Title text={props.title}>{jobs.length ? <span role="status" className={`flex items-baseline gap-1.5 ${STATUS[overall][1]}`}><span aria-hidden>{STATUS[overall][0]}</span>{STATUS[overall][2].replace(/^./u, (c) => c.toUpperCase())}{total ? <span className="text-muted-foreground"> · {formatElapsed(total)} of job time</span> : null}</span> : null}</Title>
      {jobs.length ? stages.map((stage) => <section key={stage.stage} className="flex min-w-0 flex-col">
        {stage.stage ? <h4 className="m-0 flex items-baseline gap-2 text-[0.85em] font-semibold uppercase tracking-wide text-muted-foreground"><Mark status={stage.status} />{stage.stage}</h4> : null}
        <ul className={list}>{stage.jobs.map((job, i) => <JobRow key={`${job.name}:${i}`} job={job} />)}</ul>
      </section>) : <Empty text="No jobs." />}
    </div>;
  },
});

function FrameList({ frames }: { frames: ReturnType<typeof readTrace>[number]["frames"] }) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  return <ol className={`${list} font-mono text-[0.85em] leading-relaxed`}>{frameRows(frames, unfolded).map((item) => "folded" in item
    ? <li key={`f${item.at}`} className="pl-4"><button type="button" onClick={() => setUnfolded(new Set([...unfolded, ...Array.from({ length: item.folded }, (_, i) => item.at + i)]))} className={`${link} font-sans`}>{item.folded} library frames</button></li>
    : <li key={item.index} className="flex min-w-0 flex-col pl-4">
      <span className="min-w-0 break-all"><span className={item.frame.app ? "text-foreground" : "text-muted-foreground"}>{item.frame.fn ?? "<anonymous>"}</span>{item.frame.file ? <span className="text-muted-foreground"> {item.frame.file}{item.frame.line ? `:${item.frame.line}` : ""}{item.frame.column ? `:${item.frame.column}` : ""}</span> : null}</span>
      {item.frame.code ? <span className="pl-4 text-muted-foreground">{item.frame.code}</span> : null}
    </li>)}</ol>;
}

const StackTrace = defineComponent({
  name: "StackTrace",
  props: z.object({ trace: z.union([z.string(), z.record(z.string(), z.any())]), title: z.string().optional() }),
  description: 'An error and its stack, your code first: runs of library frames (node_modules, node:, site-packages, java.*) fold into one row; causes follow. trace is the text of a JavaScript, Python, or Java/Kotlin trace, or {name, message, stack}. Python traces show the innermost frame first like the others.',
  component: ({ props }) => {
    const sections = readTrace(props.trace);
    return <div className="flex min-w-0 flex-col gap-3">
      <Title text={props.title} />
      {sections.length ? sections.map((section, i) => <section key={i} className="flex min-w-0 flex-col gap-1">
        <p className="m-0 min-w-0 whitespace-pre-wrap break-words">{section.cause ? <span className="text-muted-foreground">Caused by </span> : null}{section.type ? <span className="font-semibold text-destructive">{section.type}{section.message ? ": " : ""}</span> : null}<span className="text-foreground">{section.message}</span></p>
        {section.frames.length ? <FrameList frames={section.frames} /> : null}
      </section>) : <Empty text="No stack trace." />}
    </div>;
  },
});

const Treemap = defineComponent({
  name: "Treemap",
  props: z.object({ items: data, title: z.string().optional(), unit: z.string().optional() }),
  description: 'Sizes as nested tiles, area by value: bundle or folder sizes, time by area, cost by service. items is [{name, value, group?}] (path and size also work) or {name: size}. Items that share a group sit together under its name. The largest 24 show; the rest fold into one "N more" tile. unit (B, KB, ms, $, …) formats values.',
  component: ({ props }) => {
    const tiles = readTiles(props.items);
    const points = treemapPoints(tiles);
    const total = tiles.reduce((sum, tile) => sum + tile.value, 0);
    const unit = props.unit;
    const share = (value: number) => `${formatAmount(value, unit)} (${total ? ((value / total) * 100).toFixed(1) : 0}%)`;
    const chartClass = useChartClass();
    const nested = points.some((point) => point.parent);
    const { canvas, failed } = useHighchart(points.length ? JSON.stringify({ points, unit }) : "", () => ({
      chart: { className: "bb-treemap", spacing: [0, 0, 0, 0], margin: [0, 0, 0, 0] },
      legend: { enabled: false },
      tooltip: { shared: false, formatter() { return `${esc(this.name ?? "")}: <b>${share(Number((this as unknown as { value?: number }).value ?? 0))}</b>`; } },
      series: [{
        type: "treemap", name: "Items", layoutAlgorithm: "squarified", colorByPoint: false, data: points, animation: false,
        dataLabels: { enabled: true, align: "left", verticalAlign: "top", padding: 4, formatter() { return `${esc(this.name ?? "")}<br/><span class="bb-faint">${formatAmount(Number((this as unknown as { value?: number }).value ?? 0), unit)}</span>`; } },
        levels: nested ? [
          { level: 1, groupPadding: 0, dataLabels: { enabled: true, headers: true, align: "left", verticalAlign: "top", padding: 3, formatter() { return `<b>${esc(this.name ?? "")}</b> <span class="bb-faint">${formatAmount(Number((this as unknown as { value?: number }).value ?? 0), unit)}</span>`; } } },
          { level: 2 },
        ] : undefined,
      }],
    }), ["treemap"]);
    return <div className="flex min-w-0 flex-col gap-2">
      <Title text={props.title}>{tiles.length ? <span className="text-muted-foreground">{formatAmount(total, unit)} total</span> : null}</Title>
      {points.length ? <div className={chartClass}>
        <div role="img" aria-label={`${props.title || "Treemap"}: ${points.filter((point) => point.value !== undefined).map((point) => `${point.name} ${share(point.value!)}`).join(", ")}`} className="relative aspect-[16/9] w-full min-w-0"><div ref={canvas} aria-hidden="true" className="absolute inset-0" /></div>
        <ChartFailed failed={failed} />
      </div> : <Empty text="Nothing to show." />}
    </div>;
  },
});

const Waterfall = defineComponent({
  name: "Waterfall",
  props: z.object({ spans: data, title: z.string().optional(), unit: z.string().optional() }),
  description: 'Spans on one time axis: trace spans, build steps, page requests. spans is [{name, start, duration, depth?, failed?, detail?}] (end works for duration; status failure marks it failed), a HAR file (browser devtools export), or Chrome trace events. unit is the unit of start and duration: ms (default), s, or us. depth indents a child span.',
  component: ({ props }) => {
    const spans = readWaterfall(props.spans, props.unit ?? "ms");
    const end = Math.max(0, ...spans.map((span) => span.start + span.duration));
    const ticks = niceTicks(0, end || 1);
    const time = (ms: number) => formatAmount(ms, "ms");
    const said = (span: (typeof spans)[number]) => `${span.name}: starts at ${time(span.start)}, takes ${time(span.duration)}${span.failed ? ", failed" : ""}${span.detail ? `, ${span.detail}` : ""}`;
    const chartClass = useChartClass();
    const { canvas, failed } = useHighchart(spans.length ? JSON.stringify({ spans, ticks }) : "", () => ({
      chart: { type: "xrange", className: "bb-waterfall", spacing: [0, 0, 0, 0] },
      legend: { enabled: false },
      xAxis: { type: "linear", min: 0, max: ticks[ticks.length - 1], tickPositions: ticks, opposite: true, labels: { formatter() { return time(Number(this.value)); } } },
      // Indented names, with the detail on hover, like a trace viewer.
      // Durations sit in a column on the right.
      yAxis: [{ categories: spans.map((span) => span.name), reversed: true, title: { enabled: false }, labels: { useHTML: true, align: "left", reserveSpace: true, formatter() { const span = spans[this.pos]; return span ? `<span title="${esc(span.detail ? `${span.name} · ${span.detail}` : span.name)}" style="display:inline-block;max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:${span.depth * 0.75}rem">${esc(span.name)}</span>` : ""; } } }, { linkedTo: 0, opposite: true, reversed: true, categories: spans.map((span) => time(span.duration)), title: { enabled: false }, gridLineWidth: 0 }],
      tooltip: { shared: false, formatter() { const span = spans[this.index]; return span ? esc(said(span)) : false; } },
      plotOptions: { xrange: { pointWidth: 8, borderRadius: 2, groupPadding: 0, pointPadding: 0, states: { inactive: { enabled: false } } } },
      series: [{ type: "xrange", name: props.title ?? "Spans", data: spans.map((span, i) => ({ x: span.start, x2: span.start + span.duration, y: i, colorIndex: 0, className: span.failed ? "bb-failed" : undefined })) }],
    }), ["xrange"]);
    return <div className="flex min-w-0 flex-col gap-2">
      <Title text={props.title}>{spans.length ? <span className="text-muted-foreground">{spans.length} {spans.length === 1 ? "span" : "spans"} · {time(end)}</span> : null}</Title>
      {spans.length ? <div className={chartClass}>
        <div role="img" aria-label={spans.map(said).join("; ")} className="relative min-w-0" style={{ height: 28 + spans.length * 24 }}><div ref={canvas} aria-hidden="true" className="absolute inset-0" /></div>
        <ChartFailed failed={failed} />
      </div> : <Empty text="No spans." />}
    </div>;
  },
});

const coverageFile = {
  total: { lines: { total: 1240, covered: 1017, pct: 82.02 }, statements: { total: 1302, covered: 1046, pct: 80.34 }, functions: { total: 210, covered: 151, pct: 71.9 }, branches: { total: 388, covered: 251, pct: 64.69 } },
  "/w/shop/src/cart/total.ts": { lines: { total: 48, covered: 48, pct: 100 } },
  "/w/shop/src/cart/coupons.ts": { lines: { total: 120, covered: 70, pct: 58.33 } },
  "/w/shop/src/checkout/pay.ts": { lines: { total: 310, covered: 229, pct: 73.87 } },
  "/w/shop/src/checkout/address.ts": { lines: { total: 95, covered: 94, pct: 98.94 } },
};
const npmOutdated = { react: { current: "19.0.2", wanted: "19.0.2", latest: "20.1.0", type: "dependencies" }, zod: { current: "4.0.5", wanted: "4.1.3", latest: "4.1.3", type: "dependencies" }, vitest: { current: "3.2.1", wanted: "3.2.4", latest: "3.2.4", type: "devDependencies" }, typescript: { current: "5.9.2", wanted: "5.9.3", latest: "6.0.1", type: "devDependencies" } };
const serverLog = [
  "2026-06-15T09:00:01Z INFO  server listening on http://localhost:3000",
  "2026-06-15T09:00:04Z DEBUG cache warm: 312 keys",
  "2026-06-15T09:01:10Z WARN  slow query (812 ms): SELECT * FROM orders",
  "2026-06-15T09:01:12Z INFO  GET /api/cart 200 14ms",
  "2026-06-15T09:01:12Z INFO  GET /api/cart 200 14ms",
  "2026-06-15T09:01:12Z INFO  GET /api/cart 200 14ms",
  "2026-06-15T09:01:15Z ERROR payment failed: card_declined",
  "    at charge (src/checkout/pay.ts:42:11)",
  "2026-06-15T09:01:15Z INFO  see https://docs.example.com/errors/card_declined",
].join("\n");
const har = { log: { entries: [
  { startedDateTime: "2026-06-15T09:00:00.000Z", time: 180, request: { method: "GET", url: "https://shop.example.com/" }, response: { status: 200 } },
  { startedDateTime: "2026-06-15T09:00:00.190Z", time: 95, request: { method: "GET", url: "https://shop.example.com/assets/app.js" }, response: { status: 200 } },
  { startedDateTime: "2026-06-15T09:00:00.195Z", time: 40, request: { method: "GET", url: "https://shop.example.com/assets/app.css" }, response: { status: 200 } },
  { startedDateTime: "2026-06-15T09:00:00.300Z", time: 220, request: { method: "GET", url: "https://shop.example.com/api/cart?id=42" }, response: { status: 200 } },
  { startedDateTime: "2026-06-15T09:00:00.310Z", time: 60, request: { method: "GET", url: "https://shop.example.com/api/promo" }, response: { status: 500 } },
] } };
const jsTrace = "TypeError: Cannot read properties of undefined (reading 'price')\n    at lineTotal (/w/shop/src/cart/total.ts:12:24)\n    at Array.map (<anonymous>)\n    at total (/w/shop/src/cart/total.ts:5:22)\n    at renderWithHooks (/w/shop/node_modules/react-dom/cjs/react-dom.development.js:15486:18)\n    at mountIndeterminateComponent (/w/shop/node_modules/react-dom/cjs/react-dom.development.js:20103:13)\n    at beginWork (/w/shop/node_modules/react-dom/cjs/react-dom.development.js:21626:16)\n    at Cart (/w/shop/src/cart/Cart.tsx:31:9)\n  [cause]: Error: item 3 has no product\n    at loadItems (/w/shop/src/cart/load.ts:20:11)";
const pyTrace = 'Traceback (most recent call last):\n  File "/app/main.py", line 14, in <module>\n    main()\n  File "/app/main.py", line 10, in main\n    total = order_total(items)\n  File "/app/orders.py", line 7, in order_total\n    return sum(item["price"] for item in items)\nKeyError: \'price\'';
const lit = (value: unknown) => JSON.stringify(value);
const fileOf = (path: string, value: { data?: unknown; text?: string }) => ({ file: { path, kind: value.text !== undefined ? "text" : "json", rows: [], data: value.data ?? null, text: value.text ?? "" } });

export const group: Group = {
  id: "dev",
  name: "Dev",
  notes: ['Most Dev components read the report a tool writes. Load it with Query("file", {path: "coverage/coverage-summary.json"}, {data: null}) and pass data.data (JSON) or data.text (logs, traces, XML).'],
  entries: [
    { component: Benchmark, summary: "benchmark comparison", examples: [
      { name: "Before and after", code: 'root = Benchmark([{name: "parse 1 MB", before: 18.4, after: 11.2, unit: "ms"}, {name: "render cart", before: 3.1, after: 3.12, unit: "ms"}, {name: "checkout", before: 42, after: 51, unit: "ms", noise: 2}, {name: "bundle", before: 349438, after: 331200, unit: "B"}], "This branch vs main")' },
      { name: "hyperfine", code: `root = Benchmark(${lit({ results: [{ command: "esbuild", mean: 0.312, stddev: 0.01 }, { command: "rollup", mean: 4.84, stddev: 0.2 }, { command: "webpack", mean: 9.71, stddev: 0.35 }] })}, "Bundlers")` },
      { name: "Measurement conditions", code: 'root = Benchmark([{name:"Build",before:{value:120,context:{device:"Laptop",thermal:"Nominal"}},after:{value:80,context:{device:"Desktop",thermal:"Nominal"}},unit:"ms"},{name:"Parse",before:[18.2,18.5,18.3],after:[11.1,11.3,11.2],unit:"ms"}], "Comparable results")' },
      { name: "All experiment runs", code: 'root = Benchmark({runs:[{name:"Laptop, cold",status:"ok",metrics:{latency:120,memory:24000},context:{device:"Laptop",cache:"Cold"}},{name:"Laptop, warm",status:"ok",metrics:{latency:80,memory:26000},context:{device:"Laptop",cache:"Warm"}},{name:"Desktop",status:"failed",context:{device:"Desktop"},note:"Process crashed before measuring"}],metrics:{latency:{unit:"ms",better:"lower"},memory:{unit:"B",better:"lower"}}}, "Experiment notebook")' },
    ] },
    { component: Coverage, summary: "test coverage", examples: [
      { name: "From a file", code: 'data = Query("file", {path: "coverage/coverage-summary.json"}, {data: null})\nroot = Coverage(data.data, "Coverage")', tools: fileOf("coverage/coverage-summary.json", { data: coverageFile }) },
      { name: "Inline, branches", code: `root = Coverage(${lit(coverageFile)}, null, "branches")` },
      { name: "LCOV uncovered lines", code: `root = Coverage(${lit("SF:src/cart.ts\nDA:10,4\nDA:11,0\nDA:12,0\nDA:13,2\nLF:4\nLH:2\nend_of_record\n")}, "Cart coverage")` },
      { name: "Python coverage", code: 'root = Coverage({meta:{version:"7.6"},files:{"worker.py":{executed_lines:[1,2,5],missing_lines:[3,4],summary:{covered_lines:3,num_statements:5,percent_covered:60}}},totals:{covered_lines:3,num_statements:5,percent_covered:60}}, "Worker coverage")' },
      { name: "Go coverage", code: `root = Coverage(${lit("mode: set\nexample.com/shop/cart.go:10.1,12.2 2 1\nexample.com/shop/cart.go:14.1,18.2 3 0\n")}, "Go statements")` },
    ] },
    { component: Dependencies, summary: "outdated packages and security audits", examples: [
      { name: "npm outdated", code: `root = Dependencies(${lit(npmOutdated)}, "Outdated")` },
      { name: "From a file", code: 'data = Query("file", {path: "outdated.json"}, {data: null})\nroot = Dependencies(data.data)', tools: fileOf("outdated.json", { data: npmOutdated }) },
      { name: "npm audit", code: 'root = Dependencies({auditReportVersion:2,vulnerabilities:{axios:{name:"axios",severity:"high",isDirect:true,via:[{name:"axios",title:"Untrusted redirect",url:"https://github.com/axios/axios/security/advisories",severity:"high",range:"<1.8.2"}],effects:[],range:"<1.8.2",nodes:["node_modules/axios"],fixAvailable:{name:"axios",version:"1.8.2",isSemVerMajor:false}}},metadata:{dependencies:{total:311}}}, "Security audit")' },
    ] },
    { component: Findings, summary: "review and lint findings", examples: [
      { name: "Review", code: 'root = Findings([{severity: "high", title: "SQL built from user input", file: "src/orders/query.ts", line: 31, rule: "sql-injection", detail: "Pass the id as a parameter.", code: "db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`)"}, {severity: "medium", title: "Promise is not awaited", file: "src/checkout/pay.ts", line: 58}, {severity: "low", title: "Unused import", file: "src/checkout/pay.ts", line: 2, rule: "no-unused-vars"}], "Review")' },
      { name: "SARIF", code: `root = Findings(${lit({ runs: [{ results: [{ ruleId: "js/xss", level: "error", message: { text: "Unescaped HTML from a query string." }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/search.tsx" }, region: { startLine: 22 } } }] }, { ruleId: "js/unused-local", level: "note", message: { text: "Unused variable 'tmp'." }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/util.ts" }, region: { startLine: 4 } } }] }] }] })})` },
      { name: "Compiler output", code: `root = Findings(${lit("src/cart.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.")}, "Type check")` },
      { name: "Review lifecycle", code: 'root = Findings([{id:"auth",severity:"high",title:"Check the session before changing roles",area:"auth",file:"src/roles.ts",line:18,status:"open",fix:"Verify the session and required role before updating."},{id:"cache",severity:"medium",title:"Cache eviction",status:"fixed",fixNote:"Patch is applied; load check is still missing."},{id:"import",severity:"low",title:"Unused import",status:"confirmed",by:"Reviewer",revision:"abc123"}], "Follow-up review")' },
    ] },
    { component: Logs, summary: "log viewer", examples: [
      { name: "Server log", code: `root = Logs(${lit(serverLog)}, "server.log")` },
      { name: "From a file", code: 'data = Query("file", {path: "/tmp/build.log"}, {text: ""})\nroot = Logs(data.text, data.path, true)', tools: fileOf("/tmp/build.log", { text: "> shop@2.4.0 build\n> tsc && vite build\n\nsrc/cart/total.ts(12,24): error TS2532: Object is possibly 'undefined'.\nwarning: 1 chunk is larger than 500 kB\nFound 1 error." }) },
      { name: "JSON lines", code: 'root = Logs([{level: 30, time: "09:00:01", msg: "worker started"}, {level: 40, time: "09:00:05", msg: "queue is 80% full"}, {level: 50, time: "09:00:07", msg: "job 812 failed"}])' },
    ] },
    { component: Pipeline, summary: "CI run", examples: [
      { name: "Stages", code: 'root = Pipeline([{name: "lint", stage: "check", status: "success", ms: 21000}, {name: "typecheck", stage: "check", status: "success", ms: 48000}, {name: "unit (node 22)", stage: "test", status: "failure", ms: 95000, steps: [{name: "install", status: "success", ms: 30000}, {name: "vitest", status: "failure", ms: 64000}, {name: "upload", status: "skipped"}]}, {name: "unit (node 24)", stage: "test", status: "success", ms: 91000}, {name: "deploy", stage: "release", status: "skipped"}], "CI #812")' },
      { name: "gh run view", code: `root = Pipeline(${lit({ jobs: [{ name: "build", status: "completed", conclusion: "success", startedAt: "2026-06-15T09:00:00Z", completedAt: "2026-06-15T09:02:14Z", steps: [{ name: "Checkout", status: "completed", conclusion: "success" }, { name: "Build", status: "completed", conclusion: "success" }] }, { name: "e2e", status: "in_progress", startedAt: "2026-06-15T09:02:20Z" }] })})` },
    ] },
    { component: StackTrace, summary: "stack trace", examples: [
      { name: "JavaScript", code: `root = StackTrace(${lit(jsTrace)})` },
      { name: "Python", code: `root = StackTrace(${lit(pyTrace)}, "Worker crash")` },
    ] },
    { component: Treemap, summary: "sizes as tiles", examples: [
      { name: "Bundle", code: 'root = Treemap([{name: "react-dom", value: 131000, group: "vendor"}, {name: "zod", value: 58000, group: "vendor"}, {name: "date-fns", value: 31000, group: "vendor"}, {name: "checkout", value: 72000, group: "app"}, {name: "cart", value: 41000, group: "app"}, {name: "search", value: 26000, group: "app"}, {name: "app.css", value: 18000, group: "styles"}], "dist/ by chunk", "B")' },
      { name: "Flat", code: 'root = Treemap({compute: 4210, storage: 1380, network: 920, logs: 410, backups: 160}, "Cloud cost", "$")' },
    ] },
    { component: Waterfall, summary: "spans on a timeline", examples: [
      { name: "Trace", code: 'root = Waterfall([{name: "POST /checkout", start: 0, duration: 412}, {name: "auth", start: 4, duration: 22, depth: 1}, {name: "load cart", start: 28, duration: 96, depth: 1}, {name: "SELECT items", start: 31, duration: 80, depth: 2}, {name: "charge card", start: 130, duration: 270, depth: 1, failed: true, detail: "card_declined"}], "Request trace")' },
      { name: "From a HAR file", code: 'data = Query("file", {path: "/tmp/shop.har"}, {data: null})\nroot = Waterfall(data.data, "Page load")', tools: fileOf("/tmp/shop.har", { data: har }) },
    ] },
  ],
};
