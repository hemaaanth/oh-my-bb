import { useMemo, useState } from "react";
import { readCoverageInput, type CoverageMetric } from "../coverage-input.js";
import { field, focusRing } from "../kit.js";
import { coverageTone, coverageTree, formatPercent, percent, rangeLabel, type CoverageNode, type FileCoverage, type Ratio } from "./coverage.js";
import { ReportDetails, ReportError, ReportFile, ReportTitle } from "./reportUi.js";

const tones = { good: "text-success", warn: "text-warning", bad: "text-destructive" };
const fills = { good: "bg-success", warn: "bg-warning", bad: "bg-destructive" };
function CoverageRatio({ ratio }: { ratio: Ratio | null }) {
  const value = percent(ratio);
  return <span className="flex min-w-0 items-center gap-3">
    <span aria-hidden className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"><span className={`block h-full ${value === null ? "" : fills[coverageTone(value)]}`} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} /></span>
    <span className={`w-14 text-right tabular-nums ${value === null ? "text-muted-foreground" : tones[coverageTone(value)]}`}>{value === null ? "No data" : formatPercent(value)}</span>
  </span>;
}

function FileRow({ file, metric }: { file: FileCoverage; metric: CoverageMetric }) {
  const [range, setRange] = useState<number | null>(null);
  const [rangeLimit, setRangeLimit] = useState(24);
  const ranges = file.uncovered ?? [];
  const picked = range === null ? null : ranges.find(item => item.start === range);
  return <ReportDetails summary={<><span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>{file.path}</span><CoverageRatio ratio={file[metric]} /></>}>
      {file[metric] ? <p className="m-0 text-xs text-muted-foreground">{file[metric]!.covered.toLocaleString()} of {file[metric]!.total.toLocaleString()} {metric} covered</p> : null}
      {ranges.length ? <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">Uncovered lines</span>{ranges.slice(0, rangeLimit).map(item => <button key={item.start} type="button" aria-pressed={range === item.start} onClick={() => setRange(range === item.start ? null : item.start)} className={`rounded-sm border px-1.5 py-0.5 font-mono ${range === item.start ? "border-foreground" : "border-border"} ${focusRing}`}>{rangeLabel(item)}</button>)}{ranges.length > rangeLimit ? <button type="button" onClick={() => setRangeLimit(rangeLimit + 24)} className={`rounded-sm text-primary ${focusRing}`}>Show more ranges</button> : null}</div> : null}
      <ReportFile key={picked?.start ?? "file"} path={file.path} from={picked?.start} to={picked?.end} />
  </ReportDetails>;
}

function TreeRows({ nodes, metric }: { nodes: readonly CoverageNode[]; metric: CoverageMetric }) {
  return <div className="min-w-0">{nodes.map(node => node.kind === "file" ? <FileRow key={node.path} file={node.file} metric={metric} /> : <ReportDetails key={node.path} summary={<><span className="min-w-0 flex-1 truncate font-mono text-xs">{node.name}/ <span className="font-sans text-muted-foreground">{node.fileCount} {node.fileCount === 1 ? "file" : "files"}</span></span><CoverageRatio ratio={node.metrics[metric]} /></>}>
    <div className="border-l border-border-hairline pl-3"><TreeRows nodes={node.children} metric={metric} /></div>
  </ReportDetails>)}</div>;
}

export function CoverageView({ report: input, title, metric: requested = "lines" }: { report: unknown; title?: string; metric?: CoverageMetric }) {
  const read = useMemo(() => readCoverageInput(input, requested), [input, requested]);
  const [metric, setMetric] = useState<CoverageMetric>(requested);
  const [tree, setTree] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  if (!read.ok) return <ReportError message={read.error} />;
  const report = read.report;
  const selected = report.total[metric] ? metric : report.unit;
  const total = report.total[selected];
  const available = (Object.keys(report.total) as CoverageMetric[]).filter(key => report.total[key] !== null);
  const needle = query.trim().toLowerCase();
  const filtered = report.files.filter(file => file.path.toLowerCase().includes(needle));
  const files = [...filtered].sort((a, b) => (percent(a[selected]) ?? 100) - (percent(b[selected]) ?? 100) || a.path.localeCompare(b.path));
  return <div className="flex min-w-0 flex-col gap-3">
    <ReportTitle title={title}><span className="text-xs text-muted-foreground">{report.files.length} {report.files.length === 1 ? "file" : "files"} · {report.format === "list" ? "Manual data" : report.format}</span></ReportTitle>
    {total ? <div className="flex flex-wrap items-baseline gap-3"><strong className={`text-2xl font-medium tabular-nums ${tones[coverageTone(percent(total) ?? 0)]}`}>{percent(total) === null ? "No executable lines" : formatPercent(percent(total)!)}</strong><span className="text-xs text-muted-foreground">{total.covered.toLocaleString()} of {total.total.toLocaleString()} {selected}</span></div> : <p className="m-0 text-muted-foreground">No coverage data.</p>}
    {available.length > 1 ? <div role="group" aria-label="Coverage metric" className="flex flex-wrap gap-2">{available.map(key => <button key={key} type="button" aria-pressed={selected === key} onClick={() => setMetric(key)} className={`rounded-sm border px-2 py-1 text-xs ${selected === key ? "border-foreground" : "border-border text-muted-foreground"} ${focusRing}`}>{key}</button>)}</div> : null}
    {report.files.length ? <div className="flex min-w-0 flex-wrap items-center gap-3"><input type="search" aria-label="Filter coverage files" value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} className={`${field} h-7 min-w-0 flex-1 py-1 text-xs`} placeholder="Filter files" /><button type="button" aria-pressed={tree} onClick={() => setTree(!tree)} className={`shrink-0 rounded-sm text-xs ${focusRing}`}>{tree ? "Lowest coverage" : "Directory tree"}</button></div> : null}
    {tree ? <TreeRows nodes={coverageTree(filtered, file => file.path)} metric={selected} /> : <div className="min-w-0">{files.slice(0, limit).map(file => <FileRow key={file.path} file={file} metric={selected} />)}</div>}
    {!tree && files.length > limit ? <button type="button" onClick={() => setLimit(limit + 30)} className={`w-fit rounded-sm text-xs text-primary ${focusRing}`}>Show {Math.min(30, files.length - limit)} more files</button> : null}
    {needle && !files.length ? <p className="m-0 text-xs text-muted-foreground">No files match.</p> : null}
  </div>;
}
