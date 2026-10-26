import { useMemo, useState } from "react";
import { useHost } from "../host.js";
import { focusRing } from "../kit.js";
import { readDependencies, type OutdatedPackage } from "./dependencies.js";
import type { Value } from "./types.js";
import { ReportDetails, ReportError, ReportTitle, reportRow, reportTone } from "./reportUi.js";

const bumpOrder = ["major", "minor", "patch", "prerelease", "other"] as const;
const bumpTone = { major: "text-destructive", minor: "text-primary", patch: "text-success", prerelease: "text-warning", other: "text-muted-foreground" };

export function DependenciesView({ packages, title }: { packages: unknown; title?: string }) {
  const host = useHost();
  const result = useMemo(() => readDependencies(packages as Value), [packages]);
  const [limit, setLimit] = useState(30);
  if (!result.ok) return <ReportError message={result.error} />;
  const report = result.report;
  const groups = bumpOrder.map(bump => ({ bump, rows: report.outdated.filter(row => (row.bump ?? "other") === bump) })).filter(group => group.rows.length);
  const link = (url: string, label: string) => <a href={url} onClick={event => { event.preventDefault(); host.openUrl(url); }} className={`text-primary underline-offset-2 hover:underline ${focusRing}`}>{label}</a>;
  const packageRow = (item: OutdatedPackage) => <div key={`${item.dependent ?? ""}:${item.name}`} className={`${reportRow} flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1`}>
    <span className="min-w-0 flex-1 break-all font-mono text-xs">{item.url ? link(item.url, item.name) : item.name}{item.type ? <span className="ml-2 font-sans text-muted-foreground">{item.type}</span> : null}</span>
    <span className="shrink-0 font-mono text-xs">{item.current ?? "Not installed"} → <span className={bumpTone[item.bump ?? "other"]}>{item.latest ?? "Unknown"}</span></span>
    {item.breaking || item.deprecated || item.ahead ? <span className="text-xs text-warning">{[item.breaking ? "Breaking update" : "", item.deprecated ? "Deprecated" : "", item.ahead ? "Installed version is ahead" : ""].filter(Boolean).join(" · ")}</span> : null}
    {item.note || item.dependent || item.wanted ? <span className="basis-full text-xs text-muted-foreground">{[item.dependent, item.wanted ? `Allowed by manifest: ${item.wanted}` : null, item.note].filter(Boolean).join(" · ")}</span> : null}
  </div>;
  return <div className="flex min-w-0 flex-col gap-3">
    <ReportTitle title={title}><span className="text-xs text-muted-foreground">{[report.outdated.length ? `${report.outdated.length} outdated` : "", report.vulnerable.length ? `${report.vulnerable.length} vulnerable` : "", report.scanned === null ? "" : `${report.scanned} scanned`].filter(Boolean).join(" · ")}</span></ReportTitle>
    {report.vulnerable.length ? <section aria-label="Vulnerabilities" className="min-w-0">
      <h4 className="m-0 mb-1 text-xs font-medium text-muted-foreground">Vulnerabilities</h4>
      {report.vulnerable.slice(0, limit).map(item => <ReportDetails key={item.name} summary={<><span className="min-w-0 flex-1 break-all font-mono text-xs">{item.name}</span><span className={`shrink-0 text-xs ${reportTone[item.severity]}`}>{item.severity}</span></>}>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            {item.range ? <><dt className="text-muted-foreground">Affected versions</dt><dd className="m-0 break-words font-mono">{item.range}</dd></> : null}
            {item.direct !== null ? <><dt className="text-muted-foreground">Dependency</dt><dd className="m-0">{item.direct ? "Direct" : "Transitive"}</dd></> : null}
            <dt className="text-muted-foreground">Fix</dt><dd className="m-0 break-words">{item.fix ? `${item.fix.name ?? item.name}${item.fix.version ? `@${item.fix.version}` : ""}${item.fix.major ? " (major update)" : ""}` : "No fix reported"}</dd>
            {item.through.length ? <><dt className="text-muted-foreground">Through</dt><dd className="m-0 break-words">{item.through.join(", ")}</dd></> : null}
            {item.pulledInBy.length ? <><dt className="text-muted-foreground">Required by</dt><dd className="m-0 break-words">{item.pulledInBy.join(", ")}</dd></> : null}
          </dl>
          {item.advisories.map((advisory, index) => <p key={index} className="m-0">{advisory.url ? link(advisory.url, advisory.title) : advisory.title}{advisory.range ? <span className="ml-2 font-mono text-muted-foreground">{advisory.range}</span> : null}</p>)}
      </ReportDetails>)}
      {report.vulnerable.length > limit ? <button type="button" onClick={() => setLimit(limit + 30)} className={`mt-2 rounded-sm text-xs text-primary ${focusRing}`}>Show more vulnerabilities</button> : null}
    </section> : null}
    {groups.map(({ bump, rows }) => <section key={bump} aria-label={`${bump} updates`} className="min-w-0"><h4 className={`m-0 mb-1 text-xs font-medium ${bumpTone[bump]}`}>{bump[0]!.toUpperCase() + bump.slice(1)} <span className="font-normal text-muted-foreground">{rows.length}</span></h4>{rows.map(packageRow)}</section>)}
    {!report.outdated.length && !report.vulnerable.length ? <p className="m-0 text-xs text-muted-foreground">No dependency issues in this report.</p> : null}
  </div>;
}
