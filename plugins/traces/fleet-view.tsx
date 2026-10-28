import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { FLEET_CHANNEL, type FleetFacet, type FleetHistogramBin, type FleetRow, type FleetSnapshot, type FleetView, type FleetMode, type fleetContract } from "./fleet-contract";
import "./fleet.css";

const number = (value: number | null | undefined) => value == null ? "not stored" : value.toLocaleString();
const compact = (value: number | null | undefined) => value == null ? "—" : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
const duration = (ms: number | null) => ms === null ? "not measured" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit" });
const terminal = (status: FleetSnapshot["status"]) => status !== "running" && status !== "cancelling";

function useFleetJob(view: FleetView, initialQuery: string, initialSince: string, initialMode: FleetMode) {
  const rpc = useRpc<typeof fleetContract>();
  const [query, setQuery] = useState(initialQuery);
  const [draft, setDraft] = useState(initialQuery);
  const [since, setSince] = useState(initialSince);
  const [mode, setMode] = useState(initialMode);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeJob = useRef<string | null>(null);
  const generation = useRef(0);
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const launch = useCallback(async () => {
    const current = ++generation.current;
    const old = activeJob.current;
    if (old) { try { await rpc.call("traces_fleet_cancel", { jobId: old }); } catch { /* A completed or expired job needs no cleanup. */ } }
    if (current !== generation.current) return;
    activeJob.current = null; setSnapshot(null); setError(null);
    try {
      const next = await rpc.call("traces_fleet_start", { query, since, view, mode });
      if (current !== generation.current) { if (!terminal(next.status)) void rpc.call("traces_fleet_cancel", { jobId: next.jobId }); return; }
      activeJob.current = next.jobId; setSnapshot(next);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : "Could not start a fleet scan.");
    }
  }, [rpc, query, since, view, mode]);
  useEffect(() => { void launch(); return () => { generation.current++; }; }, [launch, revision]);
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") setRevision((value) => value + 1);
    previousConnection.current = connection;
  }, [connection]);
  useRealtime(FLEET_CHANNEL, (payload) => {
    const message = payload as { jobId?: string };
    if (!message.jobId || message.jobId !== activeJob.current) return;
    rpc.call("traces_fleet_status", { jobId: message.jobId }).then((next) => {
      if (activeJob.current === next.jobId) setSnapshot((previous) => previous && previous.updatedAt > next.updatedAt ? previous : next);
    }, () => setError("Scan status expired. Start a new scan."));
  });
  const cancel = () => { const id = activeJob.current; if (!id) return;
    rpc.call("traces_fleet_cancel", { jobId: id }).then(setSnapshot, () => setError("Could not cancel the scan.")); };
  const apply = (next: string) => { setDraft(next); setQuery(next); if (next === query) setRevision((value) => value + 1); };
  return { query, draft, setDraft, apply, since, setSince, mode, setMode, snapshot, error, cancel,
    refresh: () => setRevision((value) => value + 1), connection };
}

function ScanProgress({ snapshot, error, onCancel, onRefresh, connection }: { snapshot: FleetSnapshot | null; error: string | null;
  onCancel: () => void; onRefresh: () => void; connection: string }) {
  const progress = snapshot ? Math.min(100, snapshot.totalThreads ? Math.round(snapshot.scannedThreads / snapshot.totalThreads * 100) : 100) : 0;
  const state = snapshot?.status ?? "loading";
  const freshness = snapshot?.freshness === "live-since-completion" ? `Live since ${clock(snapshot.liveSince ?? snapshot.startedAt)}; last update ${clock(snapshot.lastLiveEventAt ?? snapshot.updatedAt)}`
    : snapshot?.freshness === "snapshot" ? `Snapshot at ${clock(snapshot.completedAt ?? snapshot.updatedAt)}; live tail listens while connected`
      : snapshot?.freshness === "cancelled" ? "Cancelled; results are partial" : snapshot?.freshness === "unavailable" ? "Fleet unavailable; per-thread views still work"
        : "Scanning existing BB storage…";
  return <div className="traces-fleet-progress" role="status" aria-live="polite">
    <div className="traces-fleet-progress-line"><span className={`traces-fleet-state traces-fleet-state-${state}`}>{state}</span>
      <strong>{snapshot ? `${snapshot.scannedThreads.toLocaleString()} / ${snapshot.totalThreads.toLocaleString()} threads` : "Starting scan"}</strong>
      <span>{snapshot ? `${snapshot.scannedEvents.toLocaleString()} events scanned · ${snapshot.matchedEvents.toLocaleString()} matches` : ""}</span>
      <span className="traces-fleet-progress-actions">{snapshot && (state === "running" || state === "cancelling") && <button type="button" onClick={onCancel} disabled={state === "cancelling"}>Cancel scan</button>}
        <button type="button" onClick={onRefresh}>Rescan</button></span></div>
    <div className="traces-fleet-progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Thread scan progress"><span style={{ width: `${progress}%` }} /></div>
    <div className="traces-fleet-freshness">{freshness}{snapshot?.limited ? " · Bounded result; see scan limits" : ""}{snapshot?.retries ? ` · ${snapshot.retries} SQLite busy retries` : ""}{connection !== "connected" ? " · Live connection unavailable; reconnect triggers a new scan" : ""}</div>
    {(snapshot?.error || error) && <p className="traces-fleet-error" role="alert">{snapshot?.error ?? error}</p>}
  </div>;
}

function FleetControls({ view, draft, setDraft, onSubmit, since, setSince, mode, setMode }: { view: FleetView; draft: string; setDraft: (value: string) => void;
  onSubmit: () => void; since: string; setSince: (value: string) => void; mode: FleetMode; setMode: (value: FleetMode) => void }) {
  return <div className="traces-fleet-controls">
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <label htmlFor={`traces-fleet-query-${view}`}>Filter</label>
      <input id={`traces-fleet-query-${view}`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="provider:codex kind:toolCall status:failed" maxLength={512} />
      <button type="submit">Run scan</button>
    </form>
    {view === "explorer" && <div className="traces-fleet-switch" aria-label="Result mode"><button type="button" aria-pressed={mode === "events"} onClick={() => setMode("events")}>Events</button><button type="button" aria-pressed={mode === "spans"} onClick={() => setMode("spans")}>Spans</button></div>}
    <label className="traces-fleet-window">Window <select value={since} onChange={(event) => setSince(event.target.value)}><option value="1h">1 hour</option><option value="6h">6 hours</option><option value="24h">24 hours</option><option value="7d">7 days</option></select></label>
    <details className="traces-fleet-syntax"><summary>Syntax</summary><p>AND-only <code>field:value</code> terms. Fields: project, thread, provider, model, environment, worktree, child, kind, type, status, tool, category, duration. Quote spaces: <code>project:"My Project"</code>. Examples: <code>kind:toolCall status:failed</code>, <code>duration:&gt;5s</code>. No free text or OR. Maximum 7 days.</p></details>
  </div>;
}

function Histogram({ bins, since }: { bins: FleetHistogramBin[]; since: string }) {
  const peak = Math.max(1, ...bins.map((bin) => bin.count));
  const maxBin = bins.reduce((best, bin) => bin.count > best.count ? bin : best, bins[0]!);
  return <figure className="traces-fleet-histogram">
    <figcaption><strong>{maxBin.count ? `Peak activity near ${clock(maxBin.from)}` : "No events in this window"}</strong><span>Matching events per interval · {since} window · errors in red</span></figcaption>
    <div className="traces-fleet-histogram-bars" role="img" aria-label="Matching event count by time interval">
      {bins.map((bin, index) => <div key={index} className="traces-fleet-histogram-column" title={`${index === 24 ? "Live" : `${clock(bin.from)}–${clock(bin.to)}`}: ${bin.count} events, ${bin.errors} errors`}>
        <span style={{ height: `${Math.max(bin.count ? 2 : 0, bin.count / peak * 100)}%` }}><i style={{ height: `${bin.count ? bin.errors / bin.count * 100 : 0}%` }} /></span>
      </div>)}
    </div>
    <div className="traces-fleet-histogram-axis"><span>{bins[0] ? clock(bins[0].from) : "—"}</span><span>{bins.length > 24 ? "Live" : bins.at(-1) ? clock(bins.at(-1)!.to) : "—"}</span></div>
    <details><summary>Time-bin data table</summary><table><thead><tr><th>Interval</th><th>Events</th><th>Errors</th></tr></thead><tbody>{bins.map((bin, index) => <tr key={index}><td>{index === 24 ? "Live" : `${clock(bin.from)}–${clock(bin.to)}`}</td><td>{bin.count}</td><td>{bin.errors}</td></tr>)}</tbody></table></details>
  </figure>;
}

function Facets({ snapshot, onFacet }: { snapshot: FleetSnapshot; onFacet: (field: string, value: string) => void }) {
  const fields = ["provider", "kind", "status", "tool", "project", "model", "environment", "worktree", "child", "category"];
  return <aside className="traces-fleet-facets" aria-label="Filter facets">{fields.map((field) => {
    const values = snapshot.facets[field] ?? [];
    if (!values.length) return null;
    return <section key={field}><h3>{field}</h3>{values.slice(0, 8).map(({ value, count }: FleetFacet) => <button type="button" key={value} onClick={() => onFacet(field, value)} title={`Filter ${field} to ${value}`}><span>{value}</span><span>{compact(count)}</span></button>)}</section>;
  })}</aside>;
}

function RowDetail({ row, onWaterfall, onContext, onOpenThread }: { row: FleetRow | null; onWaterfall: (id: string) => void; onContext: (id: string) => void; onOpenThread: (id: string) => void }) {
  const rpc = useRpc<typeof fleetContract>();
  const [reveal, setReveal] = useState(false);
  const [detail, setDetail] = useState<{ input: string | null; output: string | null; inputSize: number | null; outputSize: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => { setReveal(false); setDetail(null); setError(null); }, [row?.id]);
  useEffect(() => {
    if (!row || row.seq <= 0) return;
    const generation = ++request.current;
    rpc.call("traces_fleet_detail", { threadId: row.threadId, seq: row.seq, reveal }).then((value) => {
      if (generation === request.current) { setDetail(value); setError(null); }
    }, () => { if (generation === request.current) setError("Event detail is no longer available."); });
    return () => { request.current++; };
  }, [rpc, row?.id, row?.seq, row?.threadId, reveal]);
  return <aside className="traces-fleet-detail" aria-label="Selected event detail">
    {!row ? <div className="traces-fleet-detail-empty"><h3>Select a row</h3><p>Inspect timing and metadata. Event payloads stay hidden until revealed.</p></div> : <>
      <h3>{row.name}</h3><p className={row.status === "failed" ? "traces-fleet-error" : ""}>{row.status} · {row.type}</p>
      <dl>{[["Thread", row.threadId], ["Turn", row.turnId ?? "—"], ["Item", row.itemId ?? "—"], ["Provider", row.provider], ["Model", row.model ?? "not stored"],
        ["Project", row.projectId], ["Environment", row.environmentId ?? "none"], ["Worktree", String(row.worktree)], ["At", new Date(row.at).toLocaleString()],
        ["Duration", duration(row.durationMs)], ["Category", row.category ?? "—"]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      <div className="traces-fleet-detail-links"><button type="button" onClick={() => onOpenThread(row.threadId)}>Open thread</button><button type="button" onClick={() => onWaterfall(row.threadId)}>Waterfall</button><button type="button" onClick={() => onContext(row.threadId)}>Context</button></div>
      {row.seq > 0 ? <>
        <label className="traces-fleet-reveal"><input type="checkbox" checked={reveal} onChange={(event) => { if (!event.target.checked) { request.current++; setDetail(null); } setReveal(event.target.checked); }} /> Reveal sensitive data</label>
        {error && <p className="traces-fleet-error">{error}</p>}
        {detail?.input && <section><h4>Input · {number(detail.inputSize)} bytes</h4><pre>{detail.input}</pre></section>}
        {detail?.output && <section><h4>Output · {number(detail.outputSize)} bytes</h4><pre>{detail.output}</pre></section>}
      </> : <p className="traces-fleet-muted">Derived span. Open Waterfall for its nested detail.</p>}
    </>}
  </aside>;
}

function ExplorerRows({ snapshot, selectedId, onSelect }: { snapshot: FleetSnapshot; selectedId: string | null; onSelect: (row: FleetRow) => void }) {
  return <div className="traces-fleet-rows"><table><thead><tr><th>Time</th><th>Thread</th><th>Turn</th><th>Kind</th><th>Tool</th><th>Duration</th><th>Status</th></tr></thead><tbody>
    {snapshot.rows.map((row) => <tr key={row.id} className={row.id === selectedId ? "selected" : ""}>
      <td><button type="button" onClick={() => onSelect(row)} aria-label={`Inspect ${row.kind} in ${row.threadId} at ${clock(row.at)}`}>{new Date(row.at).toLocaleTimeString()}</button></td>
      <td>{row.threadId}</td><td>{row.turnId?.split("-t").at(-1) ?? "—"}</td><td>{row.kind}</td><td>{row.tool ?? "—"}</td><td>{duration(row.durationMs)}</td><td className={row.status === "failed" ? "failed" : ""}>{row.status}</td>
    </tr>)}</tbody></table>
    {!snapshot.rows.length && <p className="traces-fleet-muted">{snapshot.status === "running" ? "Rows will appear as threads are scanned." : "No matching events in this window."}</p>}
    <p className="traces-fleet-rows-footer">Showing {snapshot.rows.length} newest rows · {snapshot.rowsTruncated.toLocaleString()} omitted by row limits · {snapshot.matchedEvents.toLocaleString()} matches from {snapshot.scannedThreads}/{snapshot.totalThreads} threads.</p>
  </div>;
}

export function ExplorerView({ initialQuery = "", initialSince = "24h", onDrilldown }: { initialQuery?: string; initialSince?: string; onDrilldown: (view: "waterfall" | "context", id: string) => void }) {
  const job = useFleetJob("explorer", initialQuery, initialSince, "events");
  const navigate = useBbNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = job.snapshot?.rows.find((row) => row.id === selectedId) ?? null;
  const applyFacet = (field: string, value: string) => {
    const without = job.query.replace(new RegExp(`(?:^|\\s)${field}:(?:"[^"]*"|\\S+)`, "g"), " ").trim();
    job.apply([without, `${field}:${value}`].filter(Boolean).join(" ").replace(/\s+/g, " "));
    setSelectedId(null);
  };
  return <div className="traces-fleet traces-fleet-explorer">
    <div className="traces-fleet-header"><div><h2>Log Explorer</h2><p>Event metadata and derived spans from BB's existing storage. Payloads are never indexed.</p></div><span className="traces-fleet-range">{job.snapshot ? `${new Date(job.snapshot.from).toLocaleString()} → ${new Date(job.snapshot.to).toLocaleString()}` : "Bounded window"}</span></div>
    <FleetControls view="explorer" draft={job.draft} setDraft={job.setDraft} onSubmit={() => job.apply(job.draft)} since={job.since} setSince={job.setSince} mode={job.mode} setMode={job.setMode} />
    <ScanProgress snapshot={job.snapshot} error={job.error} onCancel={job.cancel} onRefresh={job.refresh} connection={job.connection} />
    {job.snapshot && <>
      <Histogram bins={job.snapshot.histogram} since={job.since} />
      <div className="traces-fleet-explorer-grid"><Facets snapshot={job.snapshot} onFacet={applyFacet} />
        <ExplorerRows snapshot={job.snapshot} selectedId={selectedId} onSelect={(row) => setSelectedId(row.id)} />
        <RowDetail row={selected} onWaterfall={(id) => onDrilldown("waterfall", id)} onContext={(id) => onDrilldown("context", id)} onOpenThread={(id) => navigate.toThread(id)} />
      </div>
    </>}
  </div>;
}

function MetricTile({ label, value, note, onClick }: { label: string; value: string; note: string; onClick?: () => void }) {
  const content = <><span>{label}</span><strong>{value}</strong><small>{note}</small></>;
  return onClick ? <button type="button" className="traces-fleet-tile" onClick={onClick}>{content}</button> : <div className="traces-fleet-tile">{content}</div>;
}
function MetricBars({ title, subtitle, items, max, onClick }: { title: string; subtitle: string;
  items: Array<{ name: string; value: number | null; detail: string }>; max: number; onClick?: (name: string) => void }) {
  return <section className="traces-fleet-card"><div className="traces-fleet-card-heading"><h3>{title}</h3><p>{subtitle}</p></div>
    <div className="traces-fleet-bar-list">{items.length ? items.map((item) => <div key={item.name} className="traces-fleet-bar-row">
      {onClick ? <button type="button" onClick={() => onClick(item.name)}>{item.name}</button> : <span>{item.name}</span>}
      <div className="traces-fleet-bar-track"><span style={{ width: `${item.value === null ? 0 : Math.max(2, item.value / Math.max(1, max) * 100)}%` }} /></div>
      <span className="traces-fleet-bar-value" title={item.detail}>{item.value === null ? "—" : item.detail}</span>
    </div>) : <p className="traces-fleet-muted">No measured samples in this window.</p>}</div>
    <details><summary>Data table</summary><table><thead><tr><th>Group</th><th>Value</th><th>Detail</th></tr></thead><tbody>{items.map((item) => <tr key={item.name}><td>{item.name}</td><td>{item.value === null ? "not measured" : item.value}</td><td>{item.detail}</td></tr>)}</tbody></table></details>
  </section>;
}
function TtftHeatmap({ snapshot }: { snapshot: FleetSnapshot }) {
  const rows = snapshot.metrics.ttft;
  const providers = [...new Set(rows.map((row) => row.provider))];
  const byKey = new Map(rows.map((row) => [`${row.provider}:${row.hour}`, row]));
  const max = Math.max(1, ...rows.map((row) => row.p50Ms ?? 0));
  return <section className="traces-fleet-card"><div className="traces-fleet-card-heading"><h3>First recorded output by provider and UTC hour</h3><p>Median turn start → first reasoning or message delta · milliseconds · measured samples only; not network TTFT</p></div>
    <div className="traces-fleet-heat-wrap"><table className="traces-fleet-heat"><thead><tr><th>Provider</th>{Array.from({ length: 24 }, (_, hour) => <th key={hour}>{hour}</th>)}</tr></thead><tbody>
      {providers.map((provider) => <tr key={provider}><th>{provider}</th>{Array.from({ length: 24 }, (_, hour) => {
        const cell = byKey.get(`${provider}:${hour}`);
        const opacity = cell?.p50Ms === null || cell?.p50Ms === undefined ? 0 : Math.max(.14, (cell.p50Ms / max) * .8);
        return <td key={hour} title={cell ? `${provider} ${hour}:00 UTC · ${duration(cell.p50Ms)} median · ${cell.count} turns${cell.partial ? " · partial" : ""}` : "Not measured"} style={{ background: opacity ? `color-mix(in srgb, var(--primary) ${Math.round(opacity * 100)}%, transparent)` : undefined }}>{cell?.p50Ms === null || cell?.p50Ms === undefined ? "—" : compact(Math.round(cell.p50Ms))}</td>;
      })}</tr>)}
    </tbody></table></div>
    {!rows.length && <p className="traces-fleet-muted">No provider reported a first output delta in the scanned threads.</p>}
  </section>;
}
function SpawnTree({ snapshot, onOpen }: { snapshot: FleetSnapshot; onOpen: (threadId: string) => void }) {
  const nodes = snapshot.metrics.spawnTree;
  const byId = new Map(nodes.map((node) => [node.threadId, node]));
  const depthOf = (id: string) => { let depth = 0, node = byId.get(id);
    while (node?.parentThreadId && byId.has(node.parentThreadId) && depth < 8) { depth++; node = byId.get(node.parentThreadId); }
    return depth; };
  return <section className="traces-fleet-card"><div className="traces-fleet-card-heading"><h3>Largest visible spawn trees</h3><p>BB parent_thread_id among scanned threads · identifiers only; titles may contain secrets</p></div>
    <div className="traces-fleet-spawn">{nodes.length ? nodes.map((node) => <button key={node.threadId} type="button" onClick={() => onOpen(node.threadId)} style={{ paddingLeft: `${10 + depthOf(node.threadId) * 16}px` }}>
      <span>{depthOf(node.threadId) ? "↳" : "●"} {node.threadId}</span><small>{node.provider} · {node.children} children</small>
    </button>) : <p className="traces-fleet-muted">No parent/child relations were found in the scanned threads.</p>}</div>
  </section>;
}

export function MetricsView({ initialQuery = "", initialSince = "24h", onExplorer, onWaterfall }: { initialQuery?: string; initialSince?: string;
  onExplorer: (query: string, since: string) => void; onWaterfall: (id: string) => void }) {
  const job = useFleetJob("metrics", initialQuery, initialSince, "events");
  const snapshot = job.snapshot;
  const metrics = snapshot?.metrics;
  const slow = metrics?.slowTools ?? [];
  const errors = metrics?.errors ?? [];
  const maxSlow = Math.max(1, ...slow.map((tool) => tool.p95Ms ?? 0));
  const maxErrors = Math.max(1, ...errors.map((entry) => entry.count));
  return <div className="traces-fleet traces-fleet-metrics">
    <div className="traces-fleet-header"><div><h2>Fleet Metrics</h2><p>Measured latency, failures and spawn structure from a bounded read-only scan.</p></div><span className="traces-fleet-range">{job.snapshot ? `${new Date(job.snapshot.from).toLocaleString()} → ${new Date(job.snapshot.to).toLocaleString()}` : "Bounded window"}</span></div>
    <FleetControls view="metrics" draft={job.draft} setDraft={job.setDraft} onSubmit={() => job.apply(job.draft)} since={job.since} setSince={job.setSince} mode={job.mode} setMode={job.setMode} />
    <ScanProgress snapshot={snapshot} error={job.error} onCancel={job.cancel} onRefresh={job.refresh} connection={job.connection} />
    {snapshot && <>
      <div className="traces-fleet-tiles">
        <MetricTile label="Turns" value={number(metrics?.turns)} note={`${metrics?.activeThreads ?? 0} active threads scanned`} onClick={() => onExplorer("type:turn/started", job.since)} />
        <MetricTile label="Tool p95" value={duration(metrics?.toolP95Ms ?? null)} note={`${metrics?.toolCalls ?? 0} completed tools${metrics?.toolLatencyPartial ? " · sampled" : ""}`} onClick={() => onExplorer("type:item/completed", job.since)} />
        <MetricTile label="Tool failure rate" value={metrics?.errorRate === null || metrics?.errorRate === undefined ? "not measured" : `${(metrics.errorRate * 100).toFixed(1)}%`} note={`${metrics?.failedTools ?? 0} failed of ${metrics?.toolCalls ?? 0}`} onClick={() => onExplorer("status:failed", job.since)} />
        <MetricTile label="Cache read share" value="unknown" note={`${metrics?.tokenCoverage.threadsWithSnapshot ?? 0} latest thread snapshots · not window totals`} />
        <MetricTile label="Provider retries" value={number(metrics?.providerRetries)} note={`${metrics?.modelFallbacks ?? 0} model fallbacks`} onClick={() => onExplorer("type:provider/error", job.since)} />
        <MetricTile label="Matched events" value={number(snapshot.matchedEvents)} note={`${snapshot.scannedThreads}/${snapshot.totalThreads} threads · ${job.since}`} onClick={() => onExplorer(job.query, job.since)} />
      </div>
      <p className="traces-fleet-missing">Token/cache fleet-window totals: <strong>unknown</strong>. {metrics?.tokenCoverage.reason}</p>
      <div className="traces-fleet-metric-grid">
        <MetricBars title="Slowest tools by p95" subtitle={`Completed tool spans · ${job.since} · milliseconds; partial samples marked`} max={maxSlow}
          items={slow.slice(0, 8).map((tool) => ({ name: tool.name, value: tool.p95Ms, detail: `${duration(tool.p50Ms)} p50 / ${duration(tool.p95Ms)} p95 · ${tool.measured}/${tool.count}${tool.partial ? " partial" : ""}` }))}
          onClick={(name) => onExplorer(name === "other tools" ? "type:item/completed" : `tool:${name}`, job.since)} />
        <MetricBars title="Recorded failures by category" subtitle={`Provider and item failures · ${job.since} · counts`} max={maxErrors}
          items={errors.slice(0, 8).map((entry) => ({ name: entry.category, value: entry.count, detail: `${entry.count.toLocaleString()} failures` }))}
          onClick={(category) => onExplorer(category === "other" ? "status:failed" : `category:${category}`, job.since)} />
        <TtftHeatmap snapshot={snapshot} />
        <SpawnTree snapshot={snapshot} onOpen={onWaterfall} />
      </div>
    </>}
  </div>;
}
