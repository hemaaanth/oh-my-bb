import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import * as Select from "@radix-ui/react-select";
import { experimental_Icon as Icon, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { FLEET_CHANNEL, type FleetFacet, type FleetHistogramBin, type FleetRow, type FleetSnapshot, type FleetView, type FleetMode, type fleetContract } from "./fleet-contract";
import { metricDrilldownQuery, parseFleetQuery, type FleetMetricPredicate } from "./fleet-query";
import "./fleet.css";

const number = (value: number | null | undefined) => value == null ? "not stored" : value.toLocaleString();
const compact = (value: number | null | undefined) => value == null ? "—" : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
const duration = (ms: number | null) => ms === null ? "not measured" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit" });
const terminal = (status: FleetSnapshot["status"]) => status !== "running" && status !== "cancelling";
const ROW_HEIGHT = 27;
const ROW_WINDOW = 50;
const WINDOWS = [{ value: "1h", label: "1 hour" }, { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }];

function useFleetJob(view: FleetView, initialQuery: string, initialSince: string, initialMode: FleetMode) {
  const rpc = useRpc<typeof fleetContract>();
  const query = initialQuery;
  const [draft, setDraft] = useState(initialQuery);
  const since = initialSince;
  const [mode, setMode] = useState(initialMode);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeJob = useRef<string | null>(null);
  const generation = useRef(0);
  const statusTimer = useRef<number | null>(null);
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const refreshStatus = useCallback(async (id: string) => {
    try {
      const next = await rpc.call("traces_fleet_status", { jobId: id });
      if (activeJob.current !== id) return;
      if (next.limitReasons.some((reason) => reason.code === "live-reservoir")) { setRevision((value) => value + 1); return; }
      setSnapshot((previous) => previous && previous.updatedAt > next.updatedAt ? previous : next);
    } catch {
      // A bounded job can expire or be evicted while its view stays open.
      // Rebuild from source with the same query instead of showing a stale error.
      if (activeJob.current === id) { activeJob.current = null; void rpc.call("traces_fleet_cancel", { jobId: id }).catch(() => {}); setRevision((value) => value + 1); }
    }
  }, [rpc]);
  const launch = useCallback(async () => {
    const current = ++generation.current;
    window.clearTimeout(statusTimer.current ?? undefined); statusTimer.current = null;
    const old = activeJob.current;
    if (old) { try { await rpc.call("traces_fleet_cancel", { jobId: old }); } catch { /* Expired jobs need no cleanup. */ } }
    if (current !== generation.current) return;
    activeJob.current = null; setSnapshot(null); setError(null);
    try {
      const next = await rpc.call("traces_fleet_start", { query, since, view, mode });
      if (current !== generation.current) { void rpc.call("traces_fleet_cancel", { jobId: next.jobId }).catch(() => {}); return; }
      activeJob.current = next.jobId; setSnapshot(next);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : "Could not start a fleet scan.");
    }
  }, [rpc, query, since, view, mode]);
  useEffect(() => { void launch(); return () => { generation.current++; }; }, [launch, revision]);
  useEffect(() => {
    const heartbeat = window.setInterval(() => { if (activeJob.current) void refreshStatus(activeJob.current); }, 60_000);
    return () => {
      window.clearInterval(heartbeat); window.clearTimeout(statusTimer.current ?? undefined);
      const id = activeJob.current; activeJob.current = null;
      if (id) void rpc.call("traces_fleet_cancel", { jobId: id }).catch(() => {});
    };
  }, [rpc, refreshStatus]);
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") setRevision((value) => value + 1);
    previousConnection.current = connection;
  }, [connection]);
  useRealtime(FLEET_CHANNEL, (payload) => {
    const message = payload as { jobId?: unknown; status?: unknown; scannedThreads?: unknown; totalThreads?: unknown;
      scannedEvents?: unknown; matchedEvents?: unknown; updatedAt?: unknown };
    const id = message.jobId;
    if (typeof id !== "string" || id !== activeJob.current) return;
    const { status, scannedThreads, totalThreads, scannedEvents, matchedEvents, updatedAt } = message;
    if ((status === "running" || status === "cancelling") && typeof scannedThreads === "number"
      && typeof totalThreads === "number" && typeof scannedEvents === "number"
      && typeof matchedEvents === "number" && typeof updatedAt === "number") {
      const progress = { status, scannedThreads, totalThreads, scannedEvents, matchedEvents, updatedAt } as const;
      setSnapshot((previous) => previous && previous.jobId === id && updatedAt >= previous.updatedAt
        ? { ...previous, ...progress } : previous);
      return;
    }
    if (statusTimer.current !== null) return;
    statusTimer.current = window.setTimeout(() => { statusTimer.current = null; void refreshStatus(id); }, snapshot?.status === "running" ? 0 : 2_000);
  });
  const cancel = () => { const id = activeJob.current; if (!id) return;
    rpc.call("traces_fleet_cancel", { jobId: id }).then(setSnapshot, () => setError("Could not cancel the scan.")); };
  return { query, draft, setDraft, since, mode, setMode, snapshot, error, cancel,
    refresh: () => setRevision((value) => value + 1), connection };
}

function ScanProgress({ snapshot, error, onCancel, onRefresh, connection, quiet = false }: { snapshot: FleetSnapshot | null; error: string | null;
  onCancel: () => void; onRefresh: () => void; connection: string; quiet?: boolean }) {
  const progress = snapshot ? Math.min(100, snapshot.totalThreads ? Math.round(snapshot.scannedThreads / snapshot.totalThreads * 100) : 100) : 0;
  const state = snapshot?.status ?? "loading";
  const freshness = snapshot?.freshness === "live-since-completion" ? `Live since ${clock(snapshot.liveSince ?? snapshot.startedAt)}; last update ${clock(snapshot.lastLiveEventAt ?? snapshot.updatedAt)}`
    : snapshot?.freshness === "snapshot" ? `Snapshot at ${clock(snapshot.completedAt ?? snapshot.updatedAt)}; ${snapshot.liveEnabled ? "live tail listens while connected" : "live tail stopped"}`
      : snapshot?.freshness === "cancelled" ? "Cancelled; results are partial" : snapshot?.freshness === "unavailable" ? "Fleet unavailable; per-thread views still work"
        : "Scanning existing BB storage…";
  const sourceReasons = snapshot?.limitReasons.filter((reason) => reason.code !== "rows" && reason.code !== "samples" && reason.code !== "live-reservoir") ?? [];
  const sampled = snapshot?.limitReasons.find((reason) => reason.code === "samples");
  const staleRows = snapshot?.limitReasons.find((reason) => reason.code === "live-reservoir");
  return <div className="traces-fleet-progress">
    <div className="traces-fleet-progress-line"><span className={`traces-fleet-state traces-fleet-state-${state}`} role="status" aria-live="polite">{state}</span>
      <strong>{snapshot ? `${snapshot.scannedThreads.toLocaleString()} / ${snapshot.totalThreads.toLocaleString()} threads` : "Starting scan"}</strong>
      <span>{snapshot ? `${snapshot.scannedEvents.toLocaleString()} events scanned · ${snapshot.matchedEvents.toLocaleString()} matches` : ""}</span>
      {quiet && connection !== "connected" && <span className="traces-fleet-partial">Live offline</span>}
      <span className="traces-fleet-progress-actions">{snapshot && (state === "running" || state === "cancelling") && <button type="button" onClick={onCancel} disabled={state === "cancelling"}>Cancel scan</button>}
        <button type="button" onClick={onRefresh}>Rescan</button></span></div>
    <div className="traces-fleet-progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Thread scan progress"><span style={{ width: `${progress}%` }} /></div>
    <div className="traces-fleet-coverage-line">
      {snapshot?.view === "explorer" && snapshot.matchedEvents > snapshot.rows.length && <span>Showing newest {snapshot.rows.length.toLocaleString()} of {snapshot.matchedEvents.toLocaleString()} scanned matches. Narrow the filter to inspect older events.</span>}
      {sampled && <span className="traces-fleet-sampled">Latency sampled: {sampled.count.toLocaleString()} measured durations omitted from p50/p95.</span>}
      {staleRows && <span className="traces-fleet-source-limit">Live rows need a source rescan ({staleRows.count.toLocaleString()} entries missing from the display).</span>}
      {snapshot?.status === "cancelled" && <span className="traces-fleet-source-limit">Scan cancelled: counts cover scanned threads only.</span>}
      {snapshot?.limited && !sourceReasons.length && !sampled && !staleRows && snapshot.status !== "cancelled" && <span className="traces-fleet-source-limit">Scan coverage limited; check the job status for details.</span>}
    </div>
    {sourceReasons.length > 0 && <ul className="traces-fleet-source-limits" aria-label="Source scan limits">{sourceReasons.map((reason) =>
      <li key={reason.code}><strong>Source limited:</strong> {reason.count.toLocaleString()} {reason.detail}</li>)}</ul>}
    {!quiet && <div className="traces-fleet-freshness">{freshness}{snapshot?.retries ? ` · ${snapshot.retries} SQLite busy retries` : ""}{connection !== "connected" ? " · Live connection unavailable; reconnect triggers a new scan" : ""}</div>}
    {(snapshot?.error || error) && <p className="traces-fleet-error" role="alert">{snapshot?.error ?? error}</p>}
  </div>;
}

function FleetControls({ view, draft, setDraft, onSubmit, since, setSince, mode, setMode }: { view: FleetView; draft: string; setDraft: (value: string) => void;
  onSubmit: () => void; since: string; setSince: (value: string) => void; mode: FleetMode; setMode: (value: FleetMode) => void }) {
  const windows = WINDOWS.some((option) => option.value === since) ? WINDOWS : [...WINDOWS, { value: since, label: since }];
  return <div className="traces-fleet-controls">
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <label htmlFor={`traces-fleet-query-${view}`}>Filter</label>
      <input id={`traces-fleet-query-${view}`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="provider:codex kind:toolCall status:failed" maxLength={512} />
      <button type="submit">Run scan</button>
    </form>
    {view === "explorer" && <div className="traces-fleet-switch" aria-label="Result mode"><button type="button" aria-pressed={mode === "events"} onClick={() => setMode("events")}>Events</button><button type="button" aria-pressed={mode === "spans"} onClick={() => setMode("spans")}>Spans</button></div>}
    <div className="traces-fleet-window"><span>Window</span><Select.Root value={since} onValueChange={setSince}>
      <Select.Trigger aria-label="Window" className="traces-turn-trigger traces-fleet-window-trigger"><Select.Value /><Select.Icon><Icon name="ChevronDown" aria-hidden="true" /></Select.Icon></Select.Trigger>
      <Select.Portal><Select.Content className="traces-turn-content" position="popper" sideOffset={6}><Select.Viewport>
        {windows.map((option) => <Select.Item key={option.value} className="traces-turn-item" value={option.value}><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator><Icon name="Check" aria-hidden="true" /></Select.ItemIndicator></Select.Item>)}
      </Select.Viewport></Select.Content></Select.Portal>
    </Select.Root></div>
    {view === "explorer" ? <details className="traces-fleet-query-help"><summary aria-label="Query syntax help" title="Query syntax help"><Icon name="Info" aria-hidden="true" /></summary>
      <div className="traces-fleet-query-help-popover"><strong>Filter syntax</strong><p>AND-only <code>field:value</code> terms. Fields: project, thread, provider, model, environment, worktree, child, kind, type, status, tool, category, duration, metric.</p>
        <p>Quote spaces: <code>project:"My Project"</code>. Examples: <code>kind:toolCall status:failed</code>, <code>duration:&gt;5s</code>. No free text or OR. Maximum 7 days.</p></div></details>
      : <details className="traces-fleet-syntax"><summary>Syntax</summary><p>AND-only <code>field:value</code> terms. Fields: project, thread, provider, model, environment, worktree, child, kind, type, status, tool, category, duration. Quote spaces: <code>project:"My Project"</code>. Examples: <code>kind:toolCall status:failed</code>, <code>duration:&gt;5s</code>. No free text or OR. Maximum 7 days.</p></details>}
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
  </figure>;
}

function Facets({ snapshot, onFacet }: { snapshot: FleetSnapshot; onFacet: (field: string, value: string) => void }) {
  const fields = ["provider", "kind", "status", "tool", "project", "model", "environment", "worktree", "child", "category"] as const;
  const active = parseFleetQuery(snapshot.query).terms;
  return <aside className="traces-fleet-facets" aria-label="Filter facets">{fields.map((field) => {
    const values = snapshot.facets[field] ?? [];
    if (!values.length) return null;
    return <section key={field}><h3>{field}</h3>{values.slice(0, 8).map(({ value, count }: FleetFacet) => value === "other"
      ? <div className="traces-fleet-facet-other" key={value} title="Aggregated values beyond the facet cap; this bucket cannot be filtered"><span>Other values (grouped)</span><span>{compact(count)}</span></div>
      : <button type="button" key={value} aria-pressed={active[field] === value} aria-label={`Filter ${field} to ${value} (${count} matches)`} onClick={() => onFacet(field, value)} title={`Filter ${field} to ${value}`}><span>{value}</span><span>{compact(count)}</span></button>)}</section>;
  })}</aside>;
}

function RowDetail({ row, onClose, onWaterfall, onContext, onOpenThread, keyboardSelection }: { row: FleetRow; onClose: () => void; onWaterfall: (id: string) => void; onContext: (id: string) => void; onOpenThread: (id: string) => void; keyboardSelection: boolean }) {
  const rpc = useRpc<typeof fleetContract>();
  const [reveal, setReveal] = useState(true);
  const [detail, setDetail] = useState<{ input: string | null; output: string | null; inputSize: number | null; outputSize: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const pane = useRef<HTMLElement>(null);
  useEffect(() => { if (!keyboardSelection) pane.current?.scrollIntoView?.({ block: "nearest" }); }, [row.id, keyboardSelection]);
  useEffect(() => {
    if (row.seq <= 0) return;
    const generation = ++request.current;
    const fetch = () => { rpc.call("traces_fleet_detail", { threadId: row.threadId, seq: row.seq, reveal }).then((value) => {
      if (generation === request.current) { setDetail(value); setError(null); }
    }, () => { if (generation === request.current) setError("Event detail is no longer available."); }); };
    const timer = keyboardSelection ? window.setTimeout(fetch, 180) : null;
    if (timer === null) fetch();
    return () => { request.current++; if (timer !== null) window.clearTimeout(timer); };
  }, [rpc, row.id, row.seq, row.threadId, reveal, keyboardSelection]);
  return <aside ref={pane} className="traces-fleet-detail" aria-label="Selected event detail">
    <div className="traces-fleet-detail-heading"><h3>{row.name}</h3><button type="button" onClick={onClose} aria-label="Close event detail">×</button></div>
    <p className={row.status === "failed" ? "traces-fleet-error" : ""}>{row.status} · {row.type}</p>
    <dl>{[["Thread", row.threadId], ["Turn", row.turnId ?? "—"], ["Item", row.itemId ?? "—"], ["Provider", row.provider], ["Model", row.model ?? "not stored"],
        ["Project", row.projectId], ["Environment", row.environmentId ?? "none"], ["Worktree", String(row.worktree)], ["At", new Date(row.at).toLocaleString()],
        ["Duration", duration(row.durationMs)], ["Category", row.category ?? "—"]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    <div className="traces-fleet-detail-links"><button type="button" onClick={() => onOpenThread(row.threadId)}>Open BB thread</button><button type="button" onClick={() => onWaterfall(row.threadId)}>Waterfall</button><button type="button" onClick={() => onContext(row.threadId)}>Context Inspector</button></div>
      {row.seq > 0 ? <>
        <label className="traces-fleet-reveal"><input type="checkbox" checked={reveal} onChange={(event) => { if (!event.target.checked) { request.current++; setDetail(null); } setReveal(event.target.checked); }} /> Reveal sensitive data</label>
        {error && <p className="traces-fleet-error">{error}</p>}
        {detail?.input && <section><h4>Input · {number(detail.inputSize)} bytes</h4><pre>{detail.input}</pre></section>}
        {detail?.output && <section><h4>Output · {number(detail.outputSize)} bytes</h4><pre>{detail.output}</pre></section>}
      </> : <p className="traces-fleet-muted">Derived span. Open Waterfall for its nested detail.</p>}
  </aside>;
}

function ExplorerRows({ snapshot, selectedId, selectedRef, onSelect, onWaterfall }: { snapshot: FleetSnapshot; selectedId: string | null;
  selectedRef: RefObject<HTMLButtonElement | null>; onSelect: (row: FleetRow, keyboard?: boolean) => void; onWaterfall: (id: string) => void }) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const focusIndex = useRef<number | null>(null);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  const visible = snapshot.rows.slice(first, first + ROW_WINDOW);
  useLayoutEffect(() => {
    if (focusIndex.current === null) return;
    rowsRef.current?.querySelector<HTMLTableRowElement>(`tr[data-row-index="${focusIndex.current}"]`)?.focus({ preventScroll: true });
    focusIndex.current = null;
  }, [selectedId, scrollTop]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["j", "k", "ArrowDown", "ArrowUp"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !snapshot.rows.length) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable=true], [role=combobox]"))) return;
    event.preventDefault();
    const direction = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
    const index = selectedId === null ? (direction > 0 ? 0 : snapshot.rows.length - 1)
      : Math.max(0, Math.min(snapshot.rows.length - 1, snapshot.rows.findIndex((row) => row.id === selectedId) + direction));
    const viewport = rowsRef.current;
    if (viewport) {
      const top = 30 + index * ROW_HEIGHT;
      const nextTop = top < viewport.scrollTop + 30 ? index * ROW_HEIGHT
        : top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight ? top + ROW_HEIGHT - viewport.clientHeight : viewport.scrollTop;
      if (nextTop !== viewport.scrollTop) { viewport.scrollTop = nextTop; setScrollTop(nextTop); }
    }
    focusIndex.current = index;
    onSelect(snapshot.rows[index]!, true);
  };
  return <div ref={rowsRef} className="traces-fleet-rows" role="region" aria-label="Explorer results" tabIndex={0}
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onKeyDown={onKeyDown}><table><thead><tr><th>Time</th><th>Thread</th><th>Turn</th><th>Kind</th><th>Tool</th><th>Duration</th><th>Status</th></tr></thead><tbody>
    {first > 0 && <tr className="traces-fleet-row-spacer" aria-hidden="true"><td colSpan={7} style={{ height: first * ROW_HEIGHT }} /></tr>}
    {visible.map((row, offset) => <tr key={row.id} data-row-index={first + offset} className={row.id === selectedId ? "selected" : ""} aria-selected={row.id === selectedId} tabIndex={row.id === selectedId ? 0 : -1} onClick={(event) => { event.currentTarget.focus(); onSelect(row); }}>
      <td><button type="button" ref={row.id === selectedId ? selectedRef : undefined} aria-current={row.id === selectedId ? "true" : undefined} aria-label={`Inspect ${row.kind} in ${row.threadId} at ${clock(row.at)}`}>{new Date(row.at).toLocaleTimeString()}</button></td>
      <td><button type="button" onClick={(event) => { event.stopPropagation(); onWaterfall(row.threadId); }} aria-label={`Open Waterfall for ${row.threadId}`}>{row.threadId}</button></td><td>{row.turnId?.split("-t").at(-1) ?? "—"}</td><td>{row.kind}</td><td>{row.tool ?? "—"}</td><td>{duration(row.durationMs)}</td><td className={row.status === "failed" ? "failed" : ""}>{row.status}</td>
    </tr>)}
    {first + visible.length < snapshot.rows.length && <tr className="traces-fleet-row-spacer" aria-hidden="true"><td colSpan={7} style={{ height: (snapshot.rows.length - first - visible.length) * ROW_HEIGHT }} /></tr>}</tbody></table>
    {!snapshot.rows.length && <p className="traces-fleet-muted">{snapshot.status === "running" ? "Rows will appear as threads are scanned." : "No matching events in this window."}</p>}
  </div>;
}

export function ExplorerView({ initialQuery = "", initialSince = "24h", onDrilldown, onFilter }: { initialQuery?: string; initialSince?: string;
  onDrilldown: (view: "waterfall" | "context", id: string) => void; onFilter: (query: string, since: string) => void }) {
  const job = useFleetJob("explorer", initialQuery, initialSince, "events");
  const navigate = useBbNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyboardSelection, setKeyboardSelection] = useState(false);
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setSelectedId(null); }, [job.snapshot?.jobId]);
  const selected = job.snapshot?.rows.find((row) => row.id === selectedId) ?? null;
  const applyFacet = (field: string, value: string) => {
    const without = job.query.replace(new RegExp(`(?:^|\\s)${field}:(?:"[^"]*"|\\S+)`, "g"), " ").trim();
    const next = [without, `${field}:${value}`].filter(Boolean).join(" ").replace(/\s+/g, " ");
    if (next === job.query) job.refresh(); else onFilter(next, job.since);
    setSelectedId(null);
  };
  return <div className="traces-fleet traces-fleet-explorer">
    <FleetControls view="explorer" draft={job.draft} setDraft={job.setDraft} onSubmit={() => { setSelectedId(null); if (job.draft === job.query) job.refresh(); else onFilter(job.draft, job.since); }} since={job.since}
      setSince={(value) => { setSelectedId(null); onFilter(job.query, value); }} mode={job.mode} setMode={(value) => { setSelectedId(null); job.setMode(value); }} />
    <ScanProgress snapshot={job.snapshot} error={job.error} onCancel={job.cancel} onRefresh={() => { setSelectedId(null); job.refresh(); }} connection={job.connection} quiet />
    {job.snapshot && <>
      <Histogram bins={job.snapshot.histogram} since={job.since} />
      <div className={`traces-fleet-explorer-grid${selected ? " has-detail" : ""}`}><Facets snapshot={job.snapshot} onFacet={applyFacet} />
        <ExplorerRows snapshot={job.snapshot} selectedId={selectedId} selectedRef={selectedRef} onSelect={(row, keyboard) => { setKeyboardSelection(Boolean(keyboard)); setSelectedId(row.id); }} onWaterfall={(id) => onDrilldown("waterfall", id)} />
        {selected && <RowDetail key={selected.id} row={selected} keyboardSelection={keyboardSelection} onClose={() => { selectedRef.current?.focus(); setSelectedId(null); }}
          onWaterfall={(id) => onDrilldown("waterfall", id)} onContext={(id) => onDrilldown("context", id)} onOpenThread={(id) => navigate.toThread(id)} />}
      </div>
    </>}
  </div>;
}

function MetricTile({ label, value, note, onClick }: { label: string; value: string; note: string; onClick?: () => void }) {
  const content = <><span>{label}</span><strong>{value}</strong><small>{note}</small></>;
  return onClick ? <button type="button" className="traces-fleet-tile" onClick={onClick}>{content}</button> : <div className="traces-fleet-tile">{content}</div>;
}
function MetricBars({ title, subtitle, items, max, onClick, canClick }: { title: string; subtitle: string;
  items: Array<{ name: string; value: number | null; detail: string }>; max: number; onClick?: (name: string) => void; canClick?: (name: string) => boolean }) {
  return <section className="traces-fleet-card"><div className="traces-fleet-card-heading"><h3>{title}</h3><p>{subtitle}</p></div>
    <div className="traces-fleet-bar-list">{items.length ? items.map((item) => <div key={item.name} className="traces-fleet-bar-row">
      {onClick && (!canClick || canClick(item.name)) ? <button type="button" onClick={() => onClick(item.name)}>{item.name}</button> : <span title="Grouped values cannot be filtered exactly">{item.name}</span>}
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

export function MetricsView({ initialQuery = "", initialSince = "24h", onExplorer, onWaterfall, onFilter }: { initialQuery?: string; initialSince?: string;
  onExplorer: (query: string, since: string) => void; onWaterfall: (id: string) => void; onFilter: (query: string, since: string) => void }) {
  const job = useFleetJob("metrics", initialQuery, initialSince, "events");
  const snapshot = job.snapshot;
  const metrics = snapshot?.metrics;
  const slow = metrics?.slowTools ?? [];
  const errors = metrics?.errors ?? [];
  const maxSlow = Math.max(1, ...slow.map((tool) => tool.p95Ms ?? 0));
  const maxErrors = Math.max(1, ...errors.map((entry) => entry.count));
  const drilldown = (predicate: FleetMetricPredicate, group?: { field: "tool" | "category"; value: string }) =>
    metricDrilldownQuery(job.query, predicate, group);
  const openMetric = (predicate: FleetMetricPredicate, group?: { field: "tool" | "category"; value: string }) => {
    const query = drilldown(predicate, group);
    if (query !== null) onExplorer(query, job.since);
  };
  return <div className="traces-fleet traces-fleet-metrics">
    <div className="traces-fleet-header"><div><h2>Fleet Metrics</h2><p>Measured latency, failures and spawn structure from a bounded read-only scan.</p></div><span className="traces-fleet-range">{job.snapshot ? `${new Date(job.snapshot.from).toLocaleString()} → ${new Date(job.snapshot.to).toLocaleString()}` : "Bounded window"}</span></div>
    <FleetControls view="metrics" draft={job.draft} setDraft={job.setDraft} onSubmit={() => job.draft === job.query ? job.refresh() : onFilter(job.draft, job.since)}
      since={job.since} setSince={(value) => onFilter(job.query, value)} mode={job.mode} setMode={job.setMode} />
    <ScanProgress snapshot={snapshot} error={job.error} onCancel={job.cancel} onRefresh={job.refresh} connection={job.connection} />
    {snapshot && <>
      <div className="traces-fleet-tiles">
        <MetricTile label="Turns" value={number(metrics?.turns)} note={`${metrics?.activeThreads ?? 0} active threads scanned`}
          onClick={metrics?.turns && drilldown("turn-start") ? () => openMetric("turn-start") : undefined} />
        <MetricTile label="Tool p95" value={duration(metrics?.toolP95Ms ?? null)} note={`${metrics?.toolCalls ?? 0} completed tools${metrics?.toolLatencyPartial ? " · sampled" : ""}`}
          onClick={metrics?.toolP95Ms != null && drilldown("tool-measured") ? () => openMetric("tool-measured") : undefined} />
        <MetricTile label="Tool failure rate" value={metrics?.errorRate === null || metrics?.errorRate === undefined ? "not measured" : `${(metrics.errorRate * 100).toFixed(1)}%`} note={`${metrics?.failedTools ?? 0} failed of ${metrics?.toolCalls ?? 0}`}
          onClick={metrics?.failedTools && drilldown("tool-failed") ? () => openMetric("tool-failed") : undefined} />
        <MetricTile label="Cache read share" value="unknown" note={`${metrics?.tokenCoverage.threadsWithSnapshot ?? 0} latest thread snapshots · not window totals`} />
        <MetricTile label="Provider retries" value={number(metrics?.providerRetries)} note={`${metrics?.modelFallbacks ?? 0} model fallbacks`}
          onClick={metrics?.providerRetries && drilldown("provider-retry") ? () => openMetric("provider-retry") : undefined} />
        <MetricTile label="Matched events" value={number(snapshot.matchedEvents)} note={`${snapshot.scannedThreads}/${snapshot.totalThreads} threads · ${job.since}`} onClick={() => onExplorer(job.query, job.since)} />
      </div>
      <p className="traces-fleet-missing">Token/cache fleet-window totals: <strong>unknown</strong>. {metrics?.tokenCoverage.reason}</p>
      <div className="traces-fleet-metric-grid">
        <MetricBars title="Slowest tools by p95" subtitle={`Completed tool spans · ${job.since} · milliseconds; partial samples marked`} max={maxSlow}
          items={slow.slice(0, 8).map((tool) => ({ name: tool.name, value: tool.p95Ms, detail: `${duration(tool.p50Ms)} p50 / ${duration(tool.p95Ms)} p95 · ${tool.measured}/${tool.count}${tool.partial ? " partial" : ""}` }))}
          canClick={(name) => drilldown("tool-measured", { field: "tool", value: name }) !== null}
          onClick={(name) => openMetric("tool-measured", { field: "tool", value: name })} />
        <MetricBars title="Recorded failures by category" subtitle={`Provider and item failures · ${job.since} · counts`} max={maxErrors}
          items={errors.slice(0, 8).map((entry) => ({ name: entry.category, value: entry.count, detail: `${entry.count.toLocaleString()} failures` }))}
          canClick={(category) => drilldown("recorded-failure", { field: "category", value: category }) !== null}
          onClick={(category) => openMetric("recorded-failure", { field: "category", value: category })} />
        <TtftHeatmap snapshot={snapshot} />
        <SpawnTree snapshot={snapshot} onOpen={onWaterfall} />
      </div>
    </>}
  </div>;
}
