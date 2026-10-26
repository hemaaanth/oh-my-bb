import { useMemo, useState } from "react";
import { useCopy, useHost } from "../host.js";
import { field, focusRing } from "../kit.js";
import { Zoomable } from "../viewer.js";
import { acceptanceVerdict, checkLabel, isGap, needsPlaces, ownerContradiction, readAcceptance, STATUS_LABEL, type Check, type Evidence as AcceptanceEvidence } from "./acceptance.js";
import { chainSummary, readProvenance, RECEIPT_LABEL, STAGE_STATUS_LABEL, type Evidence as ReceiptEvidence, type Fact } from "./provenance.js";
import { ReportDetails, ReportError, ReportFile, ReportTitle } from "./reportUi.js";
import type { Value } from "./types.js";
import { useImageResource } from "../image-resource.js";

const statusTone: Record<string, string> = { passed: "text-success", failed: "text-destructive", blocked: "text-warning", untested: "text-muted-foreground", claimed: "text-primary", skipped: "text-muted-foreground", good: "text-success", bad: "text-destructive", warn: "text-warning", neutral: "text-muted-foreground", info: "text-muted-foreground" };

function EvidenceImage({ src, label }: { src: string; label: string }) {
  const resource = useImageResource(src);
  if (!resource?.image) return resource?.error ? <ReportError message={resource.error} /> : <p role="status" className="m-0 text-muted-foreground">Loading {label}…</p>;
  const url = resource.image.src;
  return <Zoomable src={url} alt={label}><img src={url} alt={label} referrerPolicy="no-referrer" className="max-h-72 max-w-full rounded-md object-contain" /></Zoomable>;
}

export function EvidenceItems({ items }: { items: readonly (AcceptanceEvidence | ReceiptEvidence)[] }) {
  const host = useHost();
  return <>{items.map((item, index) => <div key={index} className="min-w-0">
    {item.kind === "file" ? <ReportFile path={item.path} from={item.line ?? undefined} to={"endLine" in item ? item.endLine ?? undefined : undefined} />
      : item.kind === "url" ? <a href={item.url} onClick={event => { event.preventDefault(); host.openUrl(item.url); }} className={`break-all text-primary underline underline-offset-2 ${focusRing}`}>{item.label ?? item.url}</a>
      : item.kind === "image" ? <EvidenceImage src={item.src} label={item.label ?? "Evidence image"} />
      : <div>{item.label ? <p className="m-0 mb-1 font-medium">{item.label}</p> : null}<pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{item.text}</pre></div>}
  </div>)}</>;
}

function CheckDetails({ check }: { check: Check }) {
  return <>
    <p className={`m-0 ${statusTone[check.status]}`}>{checkLabel(check)}</p>
    {check.note ? <p className="m-0 whitespace-pre-wrap break-words">{check.note}</p> : null}
    {check.needs ? <p className="m-0 text-warning">Needs you: {check.needs}</p> : null}
    {check.method || check.run || check.at ? <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">{[["Method", check.method], ["Run", check.run], ["When", check.at]].map(([key, value]) => value ? <div key={key} className="contents"><dt className="text-muted-foreground">{key}</dt><dd className="m-0 break-words">{value}</dd></div> : null)}</dl> : null}
    <EvidenceItems items={check.evidence} />
  </>;
}

export function AcceptanceView({ criteria, title, columns }: { criteria: unknown; title?: string; columns?: string[] }) {
  const parsed = useMemo(() => readAcceptance(criteria as Value, columns), [criteria, columns]);
  const [gaps, setGaps] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(30);
  const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
  if (!parsed.ok) return <ReportError message={parsed.error} />;
  const report = parsed.report, verdict = acceptanceVerdict(report);
  const contradiction = ownerContradiction(report, verdict);
  const needle = query.trim().toLowerCase();
  const filtered = report.criteria.filter(item => (!gaps || isGap(item)) && `${item.name} ${item.detail ?? ""}`.toLowerCase().includes(needle));
  const picked = selected ? report.criteria.find(item => item.index === selected.row) : undefined;
  const check = picked && selected ? picked.cells?.[selected.column] : undefined;
  return <div className="@container flex min-w-0 flex-col gap-3">
    <ReportTitle title={title ?? report.title ?? undefined} />
    <div role="status" className="flex min-w-0 flex-col gap-1"><p className="m-0 text-sm"><strong className={statusTone[verdict.tone]}>{verdict.headline}</strong><span className="text-muted-foreground"> · {verdict.proven}{verdict.parts.length ? ` · ${verdict.parts.join(" · ")}` : ""}</span></p>
      {contradiction ? <p className="m-0 text-xs text-warning">{contradiction}</p> : null}
      {verdict.optional.total ? <p className="m-0 text-xs text-muted-foreground">Optional: {verdict.optional.proven} of {verdict.optional.total} proven</p> : null}
      {report.limitations.map((limitation, index) => <p key={index} className="m-0 text-xs text-muted-foreground">{limitation}</p>)}
    </div>
    {verdict.needsYou.length ? <section className="rounded-md border border-border p-3"><h4 className="m-0 text-xs font-medium">Needs you</h4><ul className="m-0 mt-2 list-disc space-y-1 pl-4 text-xs">{verdict.needsYou.map((need, index) => <li key={index}>{need.what || "A user action is required"}<span className="block text-muted-foreground">{needsPlaces(need)}</span></li>)}</ul></section> : null}
    <div className="flex min-w-0 flex-wrap items-center gap-3"><button type="button" aria-pressed={gaps} onClick={() => { setGaps(!gaps); setLimit(30); }} className={`rounded-sm text-xs ${gaps ? "text-primary" : "text-muted-foreground"} ${focusRing}`}>{gaps ? "Showing gaps" : "Show gaps only"}</button>{report.criteria.length > 5 ? <input type="search" aria-label="Filter acceptance criteria" value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} placeholder="Filter criteria" className={`${field} h-7 min-w-0 flex-1 py-1 text-xs`} /> : null}</div>
    {report.columns.length ? <div className="min-w-0 overflow-x-auto"><table className="w-full border-collapse text-xs"><thead><tr><th className="border-b border-border p-2 text-left font-medium">Criterion</th>{report.columns.map(column => <th key={column} scope="col" className="border-b border-border p-2 text-center font-medium">{column}</th>)}</tr></thead><tbody>{filtered.slice(0, limit).map(item => <tr key={item.index}><th scope="row" className="min-w-40 border-b border-border-hairline p-2 text-left font-normal">{item.name}{!item.required ? <span className="block text-muted-foreground">Optional</span> : null}{item.stated ? <span className="block text-warning">Row claims {STATUS_LABEL[item.stated]}; cells disagree</span> : null}</th>{item.cells?.map((cell, column) => <td key={column} className="border-b border-border-hairline p-1 text-center"><button type="button" aria-label={`${item.name}, ${report.columns[column]}: ${checkLabel(cell)}`} aria-pressed={selected?.row === item.index && selected.column === column} onClick={() => setSelected({ row: item.index, column })} className={`min-h-8 w-full whitespace-nowrap rounded-md border px-2 py-1 ${cell.status === "claimed" ? "border-dashed border-primary" : "border-transparent hover:border-border"} ${statusTone[cell.status]} ${focusRing}`}>{cell.notApplicable ? "N/A" : STATUS_LABEL[cell.status]}</button></td>)}</tr>)}</tbody></table></div> : <div>{filtered.slice(0, limit).map(item => <ReportDetails key={item.index} summary={<><span className="min-w-0 flex-1 break-words text-sm">{item.name}{!item.required ? <span className="ml-2 text-xs text-muted-foreground">Optional</span> : null}</span><span className={`shrink-0 text-xs ${statusTone[item.own.status]}`}>{item.own.notApplicable ? "N/A" : STATUS_LABEL[item.own.status]}</span></>}>
      {item.detail || item.own.note || item.own.evidence.length || item.own.by || item.own.method || item.own.run || item.own.at || item.own.needs || !item.own.known ? <>{item.detail ? <p className="m-0 whitespace-pre-wrap">{item.detail}</p> : null}<CheckDetails check={item.own} /></> : null}
    </ReportDetails>)}</div>}
    {picked && check && selected ? <ReportDetails key={`${selected.row}:${selected.column}`} initiallyOpen summary={<span className="min-w-0 break-words text-xs font-medium">{picked.name} · {report.columns[selected.column]}</span>}><CheckDetails check={check} /></ReportDetails> : null}
    {!filtered.length ? <p className="m-0 text-xs text-muted-foreground">{gaps || needle ? "No matching criteria." : "No acceptance criteria."}</p> : null}
    {filtered.length > limit ? <button type="button" onClick={() => setLimit(limit + 30)} className={`w-fit text-xs text-primary ${focusRing}`}>Show more criteria</button> : null}
    {report.hiddenColumns ? <p className="m-0 text-xs text-muted-foreground">{report.hiddenColumns} conditions omitted by the supplied columns.</p> : null}
  </div>;
}

function FactValue({ fact }: { fact: Fact }) {
  const [copied, copy] = useCopy(fact.value);
  return <div className="contents"><dt className="text-muted-foreground">{fact.label}</dt><dd className="m-0 min-w-0"><button type="button" onClick={copy} title={fact.value} className={`max-w-full break-all rounded-sm text-left font-mono ${fact.check ? "text-destructive" : fact.confirmed ? "text-success" : "text-foreground"} ${focusRing}`}>{copied ?? fact.value}</button>{fact.check ? <span className="mt-1 block text-destructive">{fact.check.kind === "expected" ? `Expected: ${fact.check.expected}` : `Previously: ${fact.check.previous}`}</span> : null}</dd></div>;
}

export function ProvenanceView({ stages, expected, title }: { stages: unknown; expected?: unknown; title?: string }) {
  const parsed = useMemo(() => readProvenance(stages as Value, expected as Value), [stages, expected]);
  if (!parsed.ok) return <ReportError message={parsed.error} />;
  const chain = parsed.provenance;
  return <div className="flex min-w-0 flex-col gap-3"><ReportTitle title={title}><span className="text-xs text-muted-foreground">{chainSummary(chain)}</span></ReportTitle>
    <div role="status"><p className={`m-0 text-sm font-medium ${statusTone[chain.verdict.tone]}`}>{chain.verdict.title}</p>{chain.verdict.lines.map((line, index) => <p key={index} className={`m-0 mt-1 break-words text-xs ${statusTone[line.tone]}`}>{line.text}</p>)}</div>
    {chain.expected.length ? <ReportDetails summary={<span className="text-xs">Requested identity</span>}><dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">{chain.expected.map(fact => <FactValue key={fact.key} fact={fact} />)}</dl></ReportDetails> : null}
    <ol className="m-0 ml-1.5 flex min-w-0 list-none flex-col border-l border-border-hairline p-0 pl-4">{chain.stages.map((stage, index) => <li key={`${stage.name}:${index}`} className="relative min-w-0">
      <span aria-hidden className={`absolute -left-[calc(1rem+0.5px)] top-2.5 size-2.5 -translate-x-1/2 rounded-full border ${stage.status === "failed" || stage.facts.some(fact => fact.check) ? "border-destructive bg-destructive" : stage.receipt !== "receipt" ? "border-muted-foreground bg-background" : stage.status === "done" ? "border-success bg-success" : "border-warning bg-warning"}`} />
      <ReportDetails summary={<><span className="min-w-0 flex-1 break-words text-sm">{stage.name}{stage.last ? <span className="mt-0.5 block text-xs text-muted-foreground">Last receipt</span> : null}</span><span className={`shrink-0 text-xs ${stage.status === "failed" ? "text-destructive" : stage.receipt !== "receipt" ? "text-muted-foreground" : stage.status === "done" ? "text-success" : "text-warning"}`}>{stage.receipt === "receipt" ? STAGE_STATUS_LABEL[stage.status] : RECEIPT_LABEL[stage.receipt]}</span></>}>
        {stage.facts.length || stage.evidence.length || stage.detail || stage.note || stage.at !== null || stage.timeText || stage.ms !== null ? <>
          {stage.note ? <p className="m-0 text-muted-foreground">{stage.note}</p> : null}
          {stage.detail ? <p className="m-0 whitespace-pre-wrap break-words">{stage.detail}</p> : null}
          {stage.at !== null || stage.timeText || stage.ms !== null ? <p className="m-0 text-muted-foreground">{[stage.at !== null ? new Date(stage.at).toLocaleString() : stage.timeText, stage.ms !== null ? `${stage.ms.toLocaleString()} ms` : null].filter(Boolean).join(" · ")}</p> : null}
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">{stage.facts.map(fact => <FactValue key={fact.key} fact={fact} />)}</dl>
          <EvidenceItems items={stage.evidence} />
        </> : null}
      </ReportDetails>
    </li>)}</ol>
  </div>;
}
