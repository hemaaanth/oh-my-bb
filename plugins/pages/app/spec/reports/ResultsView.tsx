import { useContext, useMemo, useState } from "react";
import { useFormName } from "@openuidev/react-lang";
import { useHost } from "../host.js";
import { field, focusRing, SentContext } from "../kit.js";
import { fixAllMessage, fixThisMessage, needsFix, readFindings, severityLabel, verdictHeadline } from "./findings.js";
import { groupTests, readTestRun } from "./test-results.js";
import type { Value } from "./types.js";
import { ReportDetails, ReportError, ReportFile, ReportTitle, reportTone } from "./reportUi.js";
import { FollowUpMenu } from "./FollowUpMenu.js";
import { EvidenceItems } from "./EvidenceView.js";
import { readEvidence } from "./acceptance.js";

const statuses: Record<string, string> = { open: "Open", fixed: "Fixed, not confirmed", confirmed: "Confirmed", rejected: "Disputed", deferred: "Deferred", wontfix: "Won't fix" };

export function FindingsView({ findings, title }: { findings: unknown; title?: string }) {
  const host = useHost();
  const read = useMemo(() => readFindings(findings as Value), [findings]);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  const { sent, unlock } = useContext(SentContext);
  const form = useFormName() ?? "";
  if (!read.ok) return <ReportError message={read.error} />;
  const report = read.report;
  const needle = query.trim().toLowerCase();
  const shown = report.findings.filter(item => `${item.title} ${item.file ?? ""} ${item.rule ?? ""} ${item.status ?? ""}`.toLowerCase().includes(needle));
  const fixable = report.findings.filter(needsFix);
  const verdict = verdictHeadline(report);
  return <div className="flex min-w-0 flex-col gap-3">
    <ReportTitle title={title ?? report.review?.subject ?? undefined}><span className="flex items-center gap-2 text-xs text-muted-foreground">{report.findings.length} {report.findings.length === 1 ? "finding" : "findings"}{report.tool ? ` · ${report.tool}` : ""}{fixable.length ? <FollowUpMenu label={fixable.length === 1 ? "Ask agent to fix this" : `Ask agent to fix all ${fixable.length}`} message={() => fixable.length === 1 ? fixThisMessage(fixable[0]!) : fixAllMessage(fixable, report.scale, undefined, report.review?.subject ?? null)} /> : null}</span></ReportTitle>
    {verdict ? <p className={`m-0 text-sm ${verdict.tone === "bad" ? "text-destructive" : verdict.tone === "warn" ? "text-warning" : verdict.tone === "good" ? "text-success" : "text-muted-foreground"}`}>{verdict.text}</p> : null}
    {sent[form] !== undefined && host.replies ? <div role="status" className="text-xs text-muted-foreground">{host.kind === "gallery" ? <ReportDetails summary={<span>Preview request</span>}><p className="m-0 whitespace-pre-wrap">{sent[form]}</p></ReportDetails> : "Sent to the thread."} <button type="button" onClick={() => unlock(form)} className={`rounded-sm text-foreground underline underline-offset-2 ${focusRing}`}>Change</button></div> : null}
    {report.review && (report.review.evidence.length || report.review.artifacts.length) ? <ReportDetails summary={<span className="text-xs">Review evidence</span>}><EvidenceItems items={readEvidence([...report.review.evidence, ...report.review.artifacts])} /></ReportDetails> : null}
    {report.findings.length > 5 ? <input type="search" aria-label="Filter findings" value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} placeholder="Filter findings" className={`${field} h-7 py-1 text-xs`} /> : null}
    <div className="min-w-0">{shown.slice(0, limit).map((item, index) => <ReportDetails key={item.id ?? `${item.file}:${item.line}:${item.title}:${index}`} summary={<>
      <span className={`w-14 shrink-0 text-xs ${reportTone[item.severity]}`}>{severityLabel(item.severity, report.scale)}</span>
      <span className="min-w-0 flex-1 break-words text-sm">{item.title}<span className="mt-0.5 block text-xs text-muted-foreground">{[item.file ? `${item.file}${item.line ? `:${item.line}` : ""}` : null, item.rule, item.status ? statuses[item.status] : null].filter(Boolean).join(" · ")}</span></span>
    </>}>
      {item.detail || item.evidence || item.file || item.url || item.fix || item.snippet || item.fixNote || item.owner || item.by || item.revision || item.note || host.replies && needsFix(item) ? <>
        {item.detail ? <p className="m-0 whitespace-pre-wrap break-words">{item.detail}</p> : null}
        {item.evidence ? <blockquote className="m-0 border-l border-border pl-3 whitespace-pre-wrap">{item.evidence}</blockquote> : null}
        {item.file ? <ReportFile path={item.file} from={item.line ?? undefined} to={item.endLine ?? undefined} /> : null}
        {item.url ? <a href={item.url} onClick={event => { event.preventDefault(); host.openUrl(item.url!); }} className={`w-fit text-primary underline-offset-2 hover:underline ${focusRing}`}>Rule documentation</a> : null}
        {item.fix?.kind === "patch" ? <host.Diff patch={item.fix.patch} path={item.file ?? "suggested.patch"} /> : item.fix?.kind === "code" ? <host.SourceCode content={item.fix.code} path={item.file ?? "suggested.txt"} /> : item.fix?.kind === "proposal" ? <p className="m-0 whitespace-pre-wrap">{item.fix.text}</p> : item.fix?.kind === "edits" ? <host.SourceCode content={JSON.stringify(item.fix.edits, null, 2)} path="suggested-edits.json" /> : item.snippet ? <host.SourceCode content={item.snippet} path={item.file ?? "excerpt.txt"} /> : null}
        {item.fixNote ? <p className="m-0 text-muted-foreground">{item.fixNote}</p> : null}
        {item.owner || item.by || item.revision || item.note ? <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">{[["Owner", item.owner], ["Checked by", item.by], ["Revision", item.revision], ["Note", item.note]].map(([key, value]) => value ? <div key={key} className="contents"><dt className="text-muted-foreground">{key}</dt><dd className="m-0 break-words">{value}</dd></div> : null)}</dl> : null}
        {needsFix(item) ? <div className="flex justify-end"><FollowUpMenu label="Ask agent to fix this" message={() => fixThisMessage(item)} /></div> : null}
      </> : null}
    </ReportDetails>)}</div>
    {shown.length > limit ? <button type="button" onClick={() => setLimit(limit + 30)} className={`w-fit text-xs text-primary ${focusRing}`}>Show more findings</button> : null}
    {!shown.length ? <p className="m-0 text-xs text-muted-foreground">{needle ? "No findings match." : "No findings in this report."}</p> : null}
    {report.ignored ? <p className="m-0 text-xs text-muted-foreground">{report.ignored} entries had no usable finding.</p> : null}
  </div>;
}

export function TestsView({ results, title }: { results: unknown; title?: string }) {
  const host = useHost();
  const read = useMemo(() => readTestRun(results as Value), [results]);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  if (!read.ok) return <ReportError message={read.error} />;
  const run = read.run;
  const needle = query.trim().toLowerCase();
  const order: Record<string, number> = { failed: 0, skipped: 1, passed: 2 };
  const tests = run.tests.filter(test => `${test.name} ${test.suite ?? ""} ${test.file ?? ""}`.toLowerCase().includes(needle)).sort((a, b) => order[a.status]! - order[b.status]!);
  return <div className="flex min-w-0 flex-col gap-3">
    <ReportTitle title={title}><span className="flex flex-wrap gap-3 text-xs">{(["failed", "passed", "skipped"] as const).map(status => run.counts[status] ? <span key={status} className={reportTone[status]}>{run.counts[status]} {status}</span> : null)}{run.ms !== null ? <span className="text-muted-foreground">{Math.round(run.ms).toLocaleString()} ms</span> : null}</span></ReportTitle>
    {run.tests.length > 5 ? <input type="search" aria-label="Filter test results" value={query} onChange={event => { setQuery(event.target.value); setLimit(50); }} placeholder="Filter tests" className={`${field} h-7 py-1 text-xs`} /> : null}
    <div className="min-w-0">{groupTests(tests.slice(0, limit)).map(group => <ReportDetails key={`${group.file}:${group.label}`} initiallyOpen={group.tests.some(test => test.status === "failed")} summary={<><span className="min-w-0 flex-1 break-words text-sm">{group.label}</span><span className="shrink-0 text-xs text-muted-foreground">{group.tests.length} {group.tests.length === 1 ? "test" : "tests"}</span></>}>
      {group.tests.map((test, index) => <ReportDetails key={`${test.file}:${test.name}:${index}`} summary={<>
        <span className={`w-14 shrink-0 text-xs ${reportTone[test.status]}`}>{test.detail ?? test.status}</span>
        <span className="min-w-0 flex-1 break-words text-sm">{test.name}</span>
        {test.ms !== null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{test.ms.toLocaleString()} ms</span> : null}
      </>}>
        {test.message || test.output || test.file ? <>
          {test.message ? <host.SourceCode content={test.message} path="failure.txt" /> : null}
          {test.output ? <host.SourceCode content={test.output} path="captured-output.txt" /> : null}
          {test.file ? <ReportFile path={test.file} from={test.line ?? undefined} /> : null}
        </> : null}
      </ReportDetails>)}
    </ReportDetails>)}</div>
    {tests.length > limit ? <button type="button" onClick={() => setLimit(limit + 50)} className={`w-fit text-xs text-primary ${focusRing}`}>Show more tests</button> : null}
    {!tests.length ? <p className="m-0 text-xs text-muted-foreground">{needle ? "No tests match." : "No test results."}</p> : null}
    {run.ignored ? <p className="m-0 text-xs text-muted-foreground">{run.ignored} entries were not test results.</p> : null}
  </div>;
}
