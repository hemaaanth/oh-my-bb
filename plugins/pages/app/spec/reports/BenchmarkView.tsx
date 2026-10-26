import { useMemo, useState } from "react";
import { formatAmount, verdictOf, verdictWords } from "../groups/dev-logic.js";
import { manualBenchmarks, type ManualBenchmarkRow } from "../benchmark-input.js";
import { focusRing } from "../kit.js";
import { formatRatio, groupRuns, readBenchmark, runStatusWord, type AllRunsReport, type Context } from "./benchmark.js";
import type { Value } from "./types.js";
import { ReportDetails, ReportError, ReportTitle, reportRow } from "./reportUi.js";

const tone = { better: "text-success", worse: "text-destructive", same: "text-muted-foreground" };
function Conditions({ context }: { context: Context | null }) {
  return context && Object.keys(context).length ? <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">{Object.entries(context).map(([key, value]) => <div key={key} className="contents"><dt className="text-muted-foreground">{key}</dt><dd className="m-0 break-words">{value}</dd></div>)}</dl> : null;
}

function AllRuns({ report }: { report: AllRunsReport }) {
  const [by, setBy] = useState(report.groupBy ?? "__all__");
  const selected = by === "__all__" || report.varying.includes(by) ? by : "__all__";
  const groups = groupRuns(report, selected === "__all__" ? null : selected);
  return <div className="flex min-w-0 flex-col gap-3">
    <p className="m-0 text-xs text-muted-foreground">{report.counts.ok} measured{report.runs.length > report.counts.ok ? ` · ${report.runs.length - report.counts.ok} did not measure` : ""}</p>
    <Conditions context={report.shared} />
    {report.varying.length ? <label className="flex items-center gap-2 text-xs text-muted-foreground">Group by<select aria-label="Group benchmark runs" value={selected} onChange={event => { if (event.target.value === "__all__" || report.varying.includes(event.target.value)) setBy(event.target.value); }} className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-foreground"><option value="__all__">All runs</option>{report.varying.map(key => <option key={key} value={key}>{key}</option>)}</select></label> : null}
    {groups.map((group, index) => <section key={`${group.key}:${group.value}:${index}`} className="min-w-0">
      {group.key ? <h4 className="m-0 mb-2 text-xs font-medium">{group.key}: {group.value ?? "Not recorded"}</h4> : null}
      {group.varying.length ? <p className="m-0 mb-2 text-xs text-warning">Conditions differ: {group.varying.join(", ")}. Values are not a like-for-like comparison.</p> : null}
      <div className="min-w-0 overflow-x-auto"><table className="w-full border-collapse text-xs"><thead><tr><th className="border-b border-border py-2 text-left font-medium">Run</th>{report.metrics.map(metric => <th key={metric.key} className="border-b border-border px-2 py-2 text-right font-medium">{metric.label}{metric.unit ? ` (${metric.unit})` : ""}</th>)}<th className="border-b border-border py-2 text-right font-medium">Status</th></tr></thead>
        <tbody>{group.runs.map((run, runIndex) => <tr key={`${run.name}:${runIndex}`}><th className="border-b border-border-hairline py-2 text-left font-normal">{run.name}</th>{report.metrics.map(metric => <td key={metric.key} className="border-b border-border-hairline px-2 py-2 text-right tabular-nums">{run.status === "ok" && run.values[metric.key] !== undefined ? formatAmount(run.values[metric.key]!, metric.unit) : "Not measured"}</td>)}<td className={`border-b border-border-hairline py-2 text-right ${run.status === "ok" ? "text-success" : "text-warning"}`}>{runStatusWord(run)}</td></tr>)}</tbody>
      </table></div>
      {group.runs.map((run, runIndex) => Object.keys(run.context).length || run.note ? <details key={`${run.name}:${runIndex}:context`} className={reportRow}><summary className={`cursor-pointer rounded-sm text-xs ${focusRing}`}>{run.name}: conditions</summary><div className="mt-2 pl-3"><Conditions context={run.context} />{run.note ? <p className="m-0 mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{run.note}</p> : null}</div></details> : null)}
    </section>)}
  </div>;
}

function ManualResults({ rows, title }: { rows: ManualBenchmarkRow[]; title?: string }) {
  const words = verdictWords(rows);
  const ranked = rows.length > 1 && rows.every(row => row.before === null && row.unit === rows[0]!.unit && row.better === rows[0]!.better);
  const maximum = Math.max(0, ...rows.map(row => row.after));
  const best = rows[0]?.better === "higher" ? maximum : Math.min(...rows.map(row => row.after));
  return <div className="flex min-w-0 flex-col gap-3"><ReportTitle title={title} />{rows.map((row, index) => {
    const verdict = row.before !== null && row.comparable ? verdictOf(row.before, row.after, row.better, row.noise) : null;
    const ratio = ranked && best > 0 && row.after > 0 ? row.better === "lower" ? row.after / best : best / row.after : null;
    const summary = <><span className="min-w-0 flex-1 break-words text-xs">{row.name}</span><span className="text-right text-xs tabular-nums">{row.before !== null ? `${formatAmount(row.before, row.unit)} → ` : ""}{formatAmount(row.after, row.unit)}{row.noise !== null ? ` ± ${formatAmount(row.noise, row.unit)}` : ""}{ratio !== null ? ` · ${ratio === 1 ? "best" : `${ratio.toFixed(2)}×`}` : ""}</span>{!row.comparable ? <span className="text-xs text-warning">Different conditions</span> : verdict ? <span className={`text-xs ${tone[verdict]}`}>{verdict === "same" ? "Unchanged" : words[verdict]}</span> : null}</>;
    const details = row.before !== null || row.contextBefore || row.contextAfter || row.note || row.min !== null || row.max !== null || row.median !== null || row.samples.length || row.beforeSamples.length;
    return <div key={`${row.name}:${index}`} className="min-w-0">{details ? <ReportDetails summary={summary}>
      {row.before !== null && row.before !== 0 ? <p className="m-0 tabular-nums">Change: {((row.after - row.before) / row.before * 100).toFixed(2)}%</p> : null}
      {row.contextBefore || row.contextAfter ? <div className="grid min-w-0 gap-3 @min-[28rem]:grid-cols-2"><section><h4 className="m-0 mb-1 font-medium">Before</h4><Conditions context={row.contextBefore} /></section><section><h4 className="m-0 mb-1 font-medium">After</h4><Conditions context={row.contextAfter} /></section></div> : null}
      {!row.comparable ? <p className="m-0 text-warning">These measurements are not a like-for-like performance result.</p> : null}
      {row.partial.length ? <p className="m-0 text-warning">Conditions recorded on one side only: {row.partial.join(", ")}.</p> : null}
      {row.min !== null || row.max !== null || row.median !== null ? <p className="m-0 tabular-nums">{[row.min !== null ? `Min ${formatAmount(row.min, row.unit)}` : null, row.max !== null ? `Max ${formatAmount(row.max, row.unit)}` : null, row.median !== null ? `Median ${formatAmount(row.median, row.unit)}` : null].filter(Boolean).join(" · ")}</p> : null}
      {row.beforeSamples.length || row.samples.length ? <p className="m-0 text-muted-foreground">{row.beforeSamples.length ? `${row.beforeSamples.length} before samples · ` : ""}{row.samples.length} after samples</p> : null}
      {row.note ? <p className="m-0 whitespace-pre-wrap text-muted-foreground">{row.note}</p> : null}
    </ReportDetails> : <div className={`${reportRow} flex min-w-0 flex-wrap items-baseline gap-3`}>{summary}</div>}
      {ranked && maximum > 0 ? <div aria-hidden className="h-2 bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.max(0, row.after / maximum) * 100}%` }} /></div> : null}
    </div>;
  })}{!rows.length ? <p className="m-0 text-xs text-muted-foreground">No benchmark results.</p> : null}</div>;
}

export function BenchmarkView({ results, title, unit }: { results: unknown; title?: string; unit?: string }) {
  const parsed = useMemo(() => readBenchmark(results as Value, unit ?? null), [results, unit]);
  const manual = useMemo(() => manualBenchmarks(results, unit, parsed), [results, unit, parsed]);
  if (manual !== null) return <ManualResults rows={manual} title={title} />;
  if (!parsed.ok) return <ReportError message={parsed.error} />;
  const report = parsed.report;
  if (report.kind === "all-runs") return <div className="flex min-w-0 flex-col gap-3"><ReportTitle title={title} /><AllRuns report={report} /></div>;
  if (report.kind === "compare") return <div className="flex min-w-0 flex-col gap-3">
    <ReportTitle title={title}><span className="text-xs text-muted-foreground">{report.counts.better} {report.words.better} · {report.counts.worse} {report.words.worse} · {report.counts.same} unchanged</span></ReportTitle>
    <Conditions context={report.shared} />
    {report.rows.map((row, index) => <ReportDetails key={`${row.name}:${index}`} summary={<><span className="min-w-0 flex-1 break-words text-xs">{row.name}</span><span className="text-xs tabular-nums">{formatAmount(row.before, row.unit)} → {formatAmount(row.after, row.unit)}</span><span className={`text-xs ${row.comparable ? tone[row.verdict] : "text-warning"}`}>{row.comparable ? row.verdict === "same" ? "Unchanged" : report.words[row.verdict] : "Different conditions"}</span></>}>
        {row.percent !== null ? <p className="m-0 tabular-nums">Change: {row.percent > 0 ? "+" : ""}{row.percent.toFixed(2)}%{row.noise !== null ? ` · spread ${formatAmount(row.noise, row.unit)}` : ""}</p> : null}
        {row.contextBefore || row.contextAfter ? <div className="grid min-w-0 gap-3 @min-[28rem]:grid-cols-2"><section><h4 className="m-0 mb-1 font-medium">Before</h4><Conditions context={row.contextBefore} /></section><section><h4 className="m-0 mb-1 font-medium">After</h4><Conditions context={row.contextAfter} /></section></div> : null}
        {!row.comparable ? <p className="m-0 text-warning">These measurements are not a like-for-like performance result.</p> : null}
        {row.comparability?.state === "partial" ? <p className="m-0 text-warning">Some conditions were recorded on one side only: {row.comparability.oneSided.map(condition => condition.key).join(", ")}.</p> : null}
        {row.note ? <p className="m-0 whitespace-pre-wrap text-muted-foreground">{row.note}</p> : null}
        {row.beforeSamples.length || row.afterSamples.length ? <p className="m-0 text-muted-foreground">{row.beforeSamples.length} before samples · {row.afterSamples.length} after samples</p> : null}
    </ReportDetails>)}
    {report.ignored ? <p className="m-0 text-xs text-muted-foreground">{report.ignored} entries could not be compared.</p> : null}
  </div>;
  return <div className="flex min-w-0 flex-col gap-3"><ReportTitle title={title} />{report.groups.map((group, groupIndex) => {
    const maximum = Math.max(0, ...group.runs.map(run => run.mean));
    return <section key={`${group.name}:${groupIndex}`} className="min-w-0">{group.name ? <h4 className="m-0 mb-2 text-xs font-medium">{group.name}</h4> : null}{group.source ? <p className="m-0 mb-2 break-all font-mono text-xs text-muted-foreground">{group.source}</p> : null}
      {group.runs.map((run, index) => <div key={`${run.name}:${index}`} className="min-w-0"><ReportDetails summary={<><span className="min-w-0 flex-1 break-words text-xs">{run.name}</span><span className="text-right text-xs tabular-nums">{formatAmount(run.mean, report.unit)}{run.stddev !== null ? ` ± ${formatAmount(run.stddev, report.unit)}` : ""}{run.failed ? " (failed run)" : ` · ${formatRatio(run.ratio, run.ratioStddev)}× fastest`}</span></>}>
        {run.min !== null || run.max !== null || run.median !== null || run.times.length || run.facts.length ? <>
          {run.min !== null || run.max !== null || run.median !== null ? <p className="m-0 tabular-nums">{[run.min !== null ? `Min ${formatAmount(run.min, report.unit)}` : null, run.max !== null ? `Max ${formatAmount(run.max, report.unit)}` : null, run.median !== null ? `Median ${formatAmount(run.median, report.unit)}` : null].filter(Boolean).join(" · ")}</p> : null}
          {run.times.length ? <p className="m-0 text-muted-foreground">{run.times.length} samples</p> : null}
          {run.facts.length ? <p className="m-0 text-muted-foreground">{run.facts.map(fact => `${fact.label}: ${formatAmount(fact.value, fact.unit)}`).join(" · ")}</p> : null}
        </> : null}
      </ReportDetails><div aria-hidden className="h-2 bg-muted"><div className={`h-full ${run.failed ? "bg-destructive" : "bg-primary"}`} style={{ width: `${maximum ? Math.max(0, run.mean / maximum) * 100 : 0}%` }} /></div></div>)}
    </section>;
  })}{report.ignored ? <p className="m-0 text-xs text-muted-foreground">{report.ignored} entries had no usable measurement.</p> : null}</div>;
}
