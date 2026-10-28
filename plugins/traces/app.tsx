import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as Select from "@radix-ui/react-select";
import { experimental_Icon as Icon, definePluginApp, experimental_THREAD_ACTION_GROUPS, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { TraceResult, TraceSpan } from "./spans";
import { clampWindow, fitWindow, panWindow, projectSpan, zoomWindow, type TimeWindow } from "./investigate";
import { CallGroups, TurnComparison } from "./turn-analysis";
import { ContextInspector } from "./context-view";
import { ExplorerView, MetricsView } from "./fleet-view";
import { TracesSidebar } from "./sidebar";
import "./app.css";

function duration(ms: number | null) {
  if (ms === null) return "open";
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
}
function clock(ms: number) { return new Date(ms).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function flatten(span: TraceSpan, depth = 0, collapsed?: ReadonlySet<string>): Array<{ span: TraceSpan; depth: number }> {
  return [{ span, depth }, ...(collapsed?.has(span.id) ? [] : span.children.flatMap((child) => flatten(child, depth + 1, collapsed)))];
}
const WAIT = "wait";
const TOOL_SPANS: Record<string, true> = { commandExecution: true, toolCall: true, fileRead: true, fileChange: true,
  search: true, webSearch: true, webFetch: true, delegation: true, backgroundTask: true };
const palette: Record<string, string> = {
  thread: "var(--muted-foreground)", turn: "var(--primary)", reasoning: "#9b82d2", agentMessage: "#8b97cb",
  commandExecution: "#e5ad6f", toolCall: "#72afc6", fileRead: "#78bcb0", fileChange: "#d494ae",
  delegation: "#a7c47c", backgroundTask: "#a7c47c", search: "#78bcb0", contextCompaction: "#bc8bd2",
};

function SpanRow({ span, depth, selected, collapsed, turnNumber, onSelect, onToggle, origin, window, observedEnd }: {
  span: TraceSpan; depth: number; selected: boolean; collapsed: boolean; turnNumber: number | undefined; onSelect: (span: TraceSpan) => void;
  onToggle: (span: TraceSpan) => void; origin: number; window: TimeWindow; observedEnd: number;
}) {
  const effectiveEnd = span.end ?? Math.max(span.start, observedEnd);
  const bar = projectSpan(span.start - origin, effectiveEnd - origin, window);
  const barClass = span.kind === WAIT ? "traces-bar traces-bar-wait" : span.status === "failed" ? "traces-bar traces-bar-failed" : "traces-bar";
  const elapsed = span.end === null ? `${duration(effectiveEnd - span.start)} open` : duration(span.durationMs);
  return <div className="traces-row-wrap">
    {span.children.length > 0 && <button type="button" className="traces-fold" style={{ left: `${Math.min(depth, 6) * 16 + 2}px` }}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${span.kind} ${span.name}`} aria-expanded={!collapsed} onClick={() => onToggle(span)}>{collapsed ? "▸" : "▾"}</button>}
    <button type="button" className={`traces-row ${selected ? "traces-row-selected" : ""}`} data-span-id={span.id}
      aria-current={selected ? "true" : undefined} onClick={() => onSelect(span)} title={`${span.kind} · ${span.name} · ${elapsed}`}>
      <span className="traces-row-label" style={{ paddingLeft: `${Math.min(depth, 6) * 16 + (span.children.length ? 28 : 12)}px` }}>
        <span className="traces-kind" aria-hidden="true" style={{ color: palette[span.kind] ?? "var(--muted-foreground)" }}>●</span>
        <span className="traces-row-text">{span.kind === "turn" ? `Turn ${turnNumber ?? span.name}` : span.name}</span>
        {span.status === "failed" && <span className="traces-failed">failed</span>}
      </span>
      <span className="traces-track">{bar && <span className={barClass} style={{ left: `${bar.left}%`, width: `${bar.width}%`, background: span.kind === WAIT || span.status === "failed" ? undefined : palette[span.kind] ?? "var(--muted-foreground)" }} />}</span>
      <span className="traces-row-time">{elapsed}</span>
    </button>
  </div>;
}

function Detail({ span, revealed }: { span: TraceSpan; revealed: boolean }) {
  const fields = [
    ["Kind", span.kind], ["Status", span.status], ["Started", `${new Date(span.start).toLocaleString()} · ${span.start}`],
    ["Duration", duration(span.durationMs)], ["Provider", span.metadata.provider], ["Model", span.metadata.model ?? "not stored"],
    ["Reasoning", span.metadata.reasoningLevel ?? "not stored"], ["Permission", span.metadata.permissionMode ?? "not stored"],
    ["Environment", span.metadata.environment ?? "none"], ["Initiator", span.metadata.initiator ?? "not stored"],
    ["Turn", span.turnId ?? "—"], ["Item", span.itemId ?? "—"],
  ];
  return <aside className="traces-detail" aria-label="Span detail">
    <h3>{span.name}</h3>
    <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {span.error && <p className="traces-error">Error: {span.error}</p>}
    {span.kind === "turn" && <p>Token usage: {span.usage ? "latest stored snapshot" : "not stored"}. Context usage: {span.contextUsage ? "latest stored snapshot" : "not stored"}.</p>}
    {span.usage != null && <pre>Usage: {JSON.stringify(span.usage, null, 2)}</pre>}
    {span.contextUsage != null && <pre>Context: {JSON.stringify(span.contextUsage, null, 2)}</pre>}
    {span.input && <section><h4>Input · {span.inputSize?.toLocaleString()} bytes</h4><pre>{span.input}</pre></section>}
    {span.output && <section><h4>Output · {span.outputSize?.toLocaleString()} bytes</h4><pre>{span.output}</pre></section>}
    {!revealed && <p className="traces-hint">Inputs and outputs are hidden. Turn on Reveal sensitive data to inspect them.</p>}
  </aside>;
}

function Waterfall({ threadId, compact = false, initialTurnId = null, onTurnChange }: { threadId: string; compact?: boolean;
  initialTurnId?: string | null; onTurnChange?: (turnId: string | null) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [reveal, setReveal] = useState(true);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [turn, setTurn] = useState("last");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [analysis, setAnalysis] = useState<"none" | "calls" | "compare">("none");
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const focusSpan = useRef<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const [scrollTop, setScrollTop] = useState(0);
  const load = useCallback(() => {
    const generation = ++request.current;
    rpc.call("traces_thread", { threadId, includeChildren: false, reveal }).then((trace) => {
      if (generation !== request.current) return;
      setResult(trace); setError(null);
    }, (cause: unknown) => {
      if (generation !== request.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, threadId, reveal]);
  useEffect(() => { setResult(null); setSelectedId(null); setCollapsed(new Set()); setTurn("last"); }, [threadId]);
  useEffect(() => { load(); return () => { request.current++; window.clearTimeout(refreshTimer.current ?? undefined); refreshTimer.current = null; }; }, [load]);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; load(); }, 450);
  }, [load]);
  useRealtime("traces-changed", (payload) => {
    const changed = payload as { threadId?: string };
    if (changed.threadId === threadId) scheduleRefresh();
  });
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") scheduleRefresh();
    previousConnection.current = connection;
  }, [connection, scheduleRefresh]);
  const trace = result?.tree.threadId === threadId ? result : null;
  const root = trace?.tree;
  const all = useMemo(() => root ? flatten(root) : [], [root]);
  const byId = useMemo(() => new Map(all.map(({ span }) => [span.id, span])), [all]);
  const turns = useMemo(() => all.filter(({ span }) => span.kind === "turn" && span.threadId === threadId).map(({ span }) => span)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)), [all, threadId]);
  const turnNumbers = useMemo(() => new Map(turns.map((span, index) => [span.id, index + 1])), [turns]);
  useEffect(() => {
    if (!onTurnChange) return;
    const next = initialTurnId === "all" ? "all" : initialTurnId ? turns.find((span) => span.turnId === initialTurnId)?.id ?? "last" : "last";
    if (turn !== next) { setTurn(next); setSelectedId(null); }
  }, [initialTurnId, onTurnChange, turns]);
  const selectTurn = (value: string) => {
    setTurn(value); setSelectedId(null); setZoom(null);
    if (onTurnChange) onTurnChange(value === "last" ? null : value === "all" ? "all" : turns.find((span) => span.id === value)?.turnId ?? null);
  };
  const turnIndex = turn === "last" ? turns.length - 1 : turns.findIndex((span) => span.id === turn);
  const display = turn === "all" ? root : turn === "last" ? turns.at(-1) ?? root : turns[turnIndex] ?? root;
  const summaryRows = useMemo(() => display ? flatten(display) : [], [display]);
  const rows = useMemo(() => display ? flatten(display, 0, collapsed) : [], [display, collapsed]);
  const selected = selectedId && byId.get(selectedId) || display || null;
  const counts = useMemo(() => {
    const value = { tools: 0, waits: 0, errors: 0 };
    for (const { span } of summaryRows) {
      if (Object.hasOwn(TOOL_SPANS, span.kind)) value.tools++;
      if (span.kind === "wait" || span.kind === "idle") value.waits++;
      if (span.kind === "error" || span.status === "failed") value.errors++;
    }
    return value;
  }, [summaryRows]);
  const toggleSpan = (span: TraceSpan) => {
    setCollapsed((previous) => { const next = new Set(previous); if (!next.delete(span.id)) next.add(span.id); return next; });
    setSelectedId(span.id);
  };
  const firstRow = Math.max(0, Math.floor(scrollTop / 27) - 5);
  const visibleRows = rows.slice(firstRow, firstRow + 55);
  useLayoutEffect(() => {
    if (focusSpan.current === null) return;
    const target = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".traces-row") ?? []).find((element) => element.dataset.spanId === focusSpan.current);
    target?.focus({ preventScroll: true }); focusSpan.current = null;
  }, [selectedId, scrollTop, rows]);
  const onTimelineKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !rows.length) return;
    const active = rows.findIndex(({ span }) => span.id === selected?.id);
    if (event.key === "ArrowDown" || event.key === "j" || event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, active + (event.key === "ArrowDown" || event.key === "j" ? 1 : -1)));
      const viewport = listRef.current;
      if (viewport) {
        const top = next * 27;
        const scroll = top < viewport.scrollTop ? top : top + 27 > viewport.scrollTop + viewport.clientHeight ? top + 27 - viewport.clientHeight : viewport.scrollTop;
        if (scroll !== viewport.scrollTop) { viewport.scrollTop = scroll; setScrollTop(scroll); }
      }
      focusSpan.current = rows[next]!.span.id; setSelectedId(rows[next]!.span.id);
    } else if (event.key === "ArrowRight" && selected?.children.length && collapsed.has(selected.id)) {
      event.preventDefault(); toggleSpan(selected);
    } else if (event.key === "ArrowLeft") {
      if (selected?.children.length && !collapsed.has(selected.id)) { event.preventDefault(); toggleSpan(selected); }
      else if (active > 0) {
        const parent = rows.slice(0, active).reverse().find(({ depth }) => depth < rows[active]!.depth);
        if (parent) { event.preventDefault(); focusSpan.current = parent.span.id; setSelectedId(parent.span.id); }
      }
    } else if (event.key === "Enter" && event.target === event.currentTarget && selected?.children.length) {
      event.preventDefault(); toggleSpan(selected);
    } else if (event.key === "Escape" && selectedId) { event.preventDefault(); setSelectedId(null); }
  };
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; setScrollTop(0); setZoom(null); }, [display?.id]);
  const origin = display?.start ?? 0;
  const running = display?.end === null && display?.kind === "turn";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const observedEnd = Math.max(origin, root?.end ?? origin, running ? now : 0);
  const fullDuration = Math.max(20, (display?.end ?? observedEnd) - origin);
  const view = clampWindow(zoom ?? { from: 0, to: fullDuration }, fullDuration);
  const zoomed = view.from > 0 || view.to < fullDuration;
  const time = trace?.summary.timeMs ?? {};
  const total = Object.values(time).reduce((sum, ms) => sum + ms, 0);
  const entries = Object.entries(time).sort((a, b) => b[1] - a[1]);
  const slowest = useMemo(() => summaryRows.reduce<TraceSpan | null>((best, { span }) =>
    Object.hasOwn(TOOL_SPANS, span.kind) && span.durationMs !== null && (!best || span.durationMs > best.durationMs!) ? span : best, null), [summaryRows]);
  const markers = useMemo(() => summaryRows.filter(({ span }) => Object.hasOwn(TOOL_SPANS, span.kind) && span.durationMs !== null && span.durationMs > 0)
    .sort((a, b) => b.span.durationMs! - a.span.durationMs!).slice(0, 16).map(({ span }) => span), [summaryRows]);
  const openRun = (span: TraceSpan) => {
    setAnalysis("none"); setCollapsed(new Set()); setSelectedId(span.id);
    const index = summaryRows.findIndex(({ span: row }) => row.id === span.id);
    if (index >= 0 && listRef.current) {
      const top = Math.max(0, index * 27 - listRef.current.clientHeight / 2);
      listRef.current.scrollTop = top; setScrollTop(top); focusSpan.current = span.id;
    }
    setZoom(fitWindow(span.start - origin, (span.end ?? observedEnd) - origin, fullDuration));
  };
  return <div className={`traces-panel ${compact ? "traces-panel-compact" : ""}`}>
    <div className="traces-toolbar">
      <div className="traces-heading"><h2>Thread Waterfall</h2><span>{threadId}</span></div>
      <div className="traces-controls">
        <div className="traces-turn-control"><span>Turn</span><Select.Root value={turn} onValueChange={selectTurn}>
          <Select.Trigger className="traces-turn-trigger" aria-label="Turn"><Select.Value /><Select.Icon><Icon name="ChevronDown" aria-hidden="true" /></Select.Icon></Select.Trigger>
          <Select.Portal><Select.Content className="traces-turn-content" position="popper" sideOffset={6}><Select.Viewport>
            <Select.Item className="traces-turn-item" value="last"><Select.ItemText>Latest turn</Select.ItemText><Select.ItemIndicator><Icon name="Check" aria-hidden="true" /></Select.ItemIndicator></Select.Item>
            <Select.Item className="traces-turn-item" value="all"><Select.ItemText>All turns</Select.ItemText><Select.ItemIndicator><Icon name="Check" aria-hidden="true" /></Select.ItemIndicator></Select.Item>
            {turns.map((span, index) => <Select.Item key={span.id} className="traces-turn-item" value={span.id}><Select.ItemText>Turn {index + 1}</Select.ItemText><Select.ItemIndicator><Icon name="Check" aria-hidden="true" /></Select.ItemIndicator></Select.Item>)}
          </Select.Viewport></Select.Content></Select.Portal>
        </Select.Root></div>
        <button type="button" aria-label="Previous turn" disabled={turnIndex <= 0} onClick={() => selectTurn(turns[turnIndex - 1]!.id)}>←</button>
        <button type="button" aria-label="Next turn" disabled={turnIndex < 0 || turnIndex >= turns.length - 1} onClick={() => selectTurn(turns[turnIndex + 1]!.id)}>→</button>
        <label className={reveal ? "traces-reveal-on" : ""}><input type="checkbox" checked={reveal} onChange={(event) => { if (!event.target.checked) { setResult(null); setSelectedId(null); } setReveal(event.target.checked); }} /> Reveal sensitive data</label>
        <button type="button" onClick={load}>Refresh</button>
      </div>
    </div>
    {error && <p role="alert" className="traces-error">{error}</p>}
    {!trace && !error && <p className="traces-empty">Loading thread events…</p>}
    {root && <>
      <section className="traces-turn-summary" aria-label="Turn summary">
        <strong>{turns.length === 0 ? "No turns yet" : turn === "all" ? `All ${turns.length} turns` : `Turn ${turnIndex + 1} of ${turns.length}`}</strong>
        <span>{display?.status ?? "not started"} · {running ? duration(Math.max(0, now - (display?.start ?? now))) : duration(display?.durationMs ?? null)} · {display?.metadata.model ?? "model not stored"}</span>
        <span>{counts.tools} tools · {counts.waits} waits · {counts.errors} errors</span>
      </section>
      <div className="traces-investigate-actions">
        <button type="button" disabled={display?.kind !== "turn"} aria-pressed={analysis === "calls"}
          onClick={() => setAnalysis(analysis === "calls" ? "none" : "calls")}>Calls by command/tool</button>
        <button type="button" disabled={turnIndex <= 0 || display?.kind !== "turn"} aria-pressed={analysis === "compare"}
          onClick={() => setAnalysis(analysis === "compare" ? "none" : "compare")}>Compare with previous turn</button>
      </div>
      {analysis === "calls" && display?.kind === "turn" && <CallGroups key={display.id} turn={display} onOpen={openRun} />}
      {analysis === "compare" && display?.kind === "turn" && turnIndex > 0 &&
        <TurnComparison previous={turns[turnIndex - 1]!} current={display} previousNumber={turnIndex} currentNumber={turnIndex + 1} />}
      {fullDuration >= 1_000 && summaryRows.length > 4 && <div className="traces-zoom-controls" aria-label="Timeline zoom controls">
        <button type="button" onClick={() => setZoom(zoomWindow(view, fullDuration, 0.5))}>Zoom in</button>
        <button type="button" disabled={!zoomed} onClick={() => setZoom(zoomWindow(view, fullDuration, 2))}>Zoom out</button>
        <button type="button" disabled={!zoomed} onClick={() => setZoom(panWindow(view, fullDuration, -(view.to - view.from) / 3))}>Pan left</button>
        <button type="button" disabled={!zoomed} onClick={() => setZoom(panWindow(view, fullDuration, (view.to - view.from) / 3))}>Pan right</button>
        <button type="button" disabled={!zoomed} onClick={() => setZoom(null)}>Reset zoom</button>
        <button type="button" disabled={!selectedId || !selected} onClick={() => selected && setZoom(fitWindow(selected.start - origin, (selected.end ?? observedEnd) - origin, fullDuration))}>Focus selected</button>
        <button type="button" disabled={!slowest} onClick={() => slowest && openRun(slowest)}>Focus slowest call</button>
        <span>{zoomed ? `${duration(view.from)}–${duration(view.to)} of ${duration(fullDuration)}` : `Full ${duration(fullDuration)}`}</span>
      </div>}
      <div className="traces-axis"><span>Span · {trace!.eventCount.toLocaleString()} events</span><span className="traces-ticks"><span>{clock(origin + view.from)}</span><span>+{duration(view.from + (view.to - view.from) / 2)}</span><span>+{duration(view.to)}</span></span><span>Dur.</span></div>
      {fullDuration >= 5_000 && summaryRows.length > 8 && <div className="traces-minimap" aria-label="Timeline overview">
        {markers.map((span) => <span key={span.id} aria-hidden="true" style={{ left: `${100 * (span.start - origin) / fullDuration}%`, width: `${Math.max(0.3, 100 * span.durationMs! / fullDuration)}%` }} />)}
        {zoomed && <span className="traces-minimap-window" aria-hidden="true" style={{ left: `${100 * view.from / fullDuration}%`, width: `${100 * (view.to - view.from) / fullDuration}%` }} />}
        <input type="range" aria-label="Pan zoomed timeline" aria-valuetext={`${duration(view.from)} to ${duration(view.to)} of ${duration(fullDuration)}`}
          min={0} max={Math.max(0, Math.ceil(fullDuration - (view.to - view.from)))} value={Math.round(view.from)} disabled={!zoomed}
          onChange={(event) => setZoom(panWindow(view, fullDuration, Number(event.target.value) - view.from))} />
      </div>}
      <div className="traces-body">
        <div className="traces-list" ref={listRef} role="region" aria-label="Waterfall spans" tabIndex={0}
          onKeyDown={onTimelineKey} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          <div style={{ height: firstRow * 27 }} />
          {visibleRows.map(({ span, depth }) => <SpanRow key={span.id} span={span} depth={depth} selected={span.id === selected?.id}
            collapsed={collapsed.has(span.id)} turnNumber={turnNumbers.get(span.id)} onToggle={toggleSpan} onSelect={(value) => setSelectedId(value.id)} origin={origin} window={view} observedEnd={observedEnd} />)}
          <div style={{ height: Math.max(0, rows.length - firstRow - visibleRows.length) * 27 }} />
        </div>
        {selected && <Detail span={selected} revealed={reveal} />}
      </div>
      <div className="traces-breakdown"><strong>Where thread time went · {duration(trace!.summary.elapsedMs)}</strong>
        <div className="traces-stack" aria-hidden="true">{entries.map(([kind, ms]) => <span key={kind} style={{ width: `${total ? ms / total * 100 : 0}%`, background: kind === WAIT ? "var(--muted-foreground)" : palette[kind] ?? "#9b82d2" }} />)}</div>
        <div>{entries.map(([kind, ms]) => <span key={kind}>{kind} {duration(ms)} ({total ? Math.round(ms / total * 100) : 0}%) · </span>)}</div>
      </div>
    </>}
  </div>;
}

function encodeFleetFilter(query: string): string {
  if (!query) return "_";
  let binary = "";
  for (const byte of new TextEncoder().encode(query)) binary += String.fromCharCode(byte);
  return `q${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
function decodeFleetFilter(segment: string | undefined): string {
  if (!segment || segment === "_" || !/^q[A-Za-z0-9_-]{1,3000}$/.test(segment)) return "";
  try {
    const base = segment.slice(1).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base.padEnd(Math.ceil(base.length / 4) * 4, "="));
    const text = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return text.length <= 512 ? text : "";
  } catch { return ""; }
}

function NavPanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const parts = subPath.split("/");
  const view = parts[0] === "context" || parts[0] === "explorer" || parts[0] === "metrics" ? parts[0]
    : parts[0] === "waterfall" || /^thr_[a-z0-9]+$/.test(parts[0] ?? "") ? "waterfall" : "explorer";
  const rawId = view === "context" ? parts[1] : view === "waterfall" ? parts[0] : null;
  const threadId = rawId && /^thr_[a-z0-9]+$/.test(rawId) ? rawId : "";
  let focusedTurn: string | null = parts[1] === "all" ? "all" : null;
  if (view === "waterfall" && parts[1] === "turn" && parts[2] && parts[2].length <= 300) {
    try { const decoded = decodeURIComponent(parts[2]); if (decoded.length <= 100) focusedTurn = decoded; } catch { /* Invalid turn segment falls back to latest. */ }
  }
  const fleetQuery = view === "explorer" || view === "metrics" ? decodeFleetFilter(parts[1]) : "";
  const fleetSince = /^(?:[1-9]\d?h|[1-7]d)$/.test(parts[2] ?? "") ? parts[2]! : "24h";
  const open = (path: string) => navigate.toPluginPanel("waterfall", { subPath: path });
  const openThreadView = (target: "waterfall" | "context", id: string) => open(target === "context" ? id ? `context/${id}` : "context" : id || "waterfall");
  const openFleetView = (target: "explorer" | "metrics", query = "", since = "24h") => open(`${target}/${encodeFleetFilter(query)}/${since}`);
  return <div className="traces-page"><div className="traces-container">
    <nav className="traces-view-tabs" aria-label="Trace views">
      <button type="button" aria-current={view === "explorer" ? "page" : undefined} onClick={() => openFleetView("explorer", view === "metrics" ? fleetQuery : "", view === "metrics" ? fleetSince : "24h")}>Log Explorer</button>
      <button type="button" aria-current={view === "waterfall" ? "page" : undefined} onClick={() => openThreadView("waterfall", threadId)}>Waterfall</button>
      <button type="button" aria-current={view === "context" ? "page" : undefined} onClick={() => openThreadView("context", threadId)}>Context Inspector</button>
      <button type="button" aria-current={view === "metrics" ? "page" : undefined} onClick={() => openFleetView("metrics", view === "explorer" ? fleetQuery : "", view === "explorer" ? fleetSince : "24h")}>Fleet Metrics</button>
    </nav>
    {view === "explorer" ? <ExplorerView key={subPath} initialQuery={fleetQuery} initialSince={fleetSince} onDrilldown={openThreadView} />
      : view === "metrics" ? <MetricsView key={subPath} initialQuery={fleetQuery} initialSince={fleetSince} onExplorer={(query, since) => openFleetView("explorer", query, since)} onWaterfall={(id) => openThreadView("waterfall", id)} />
      : threadId ? view === "context" ? <ContextInspector key={threadId} threadId={threadId} />
        : <Waterfall key={threadId} threadId={threadId} initialTurnId={focusedTurn}
          onTurnChange={(id) => open(id === "all" ? `${threadId}/all` : id ? `${threadId}/turn/${encodeURIComponent(id)}` : threadId)} />
        : <div className="traces-thread-empty"><p>Select a thread in Log Explorer, or choose “Trace this thread” in a thread menu.</p><button type="button" onClick={() => openFleetView("explorer")}>Open Log Explorer</button></div>}
  </div></div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "waterfall", title: "Traces", icon: "traces/traces", path: "waterfall", component: NavPanel, experimental_sidebar: TracesSidebar });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "trace", title: "Trace this thread",
    icon: "traces/traces", layout: "flush", component: ({ threadId }) => <Waterfall threadId={threadId} compact /> });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "context", title: "Context Inspector",
    icon: "traces/traces", layout: "flush", component: ({ threadId }) => <ContextInspector key={threadId} threadId={threadId} compact /> });
  app.slots.experimental_threadAction({ id: "trace-thread", title: "Trace this thread", icon: "traces/traces", group: experimental_THREAD_ACTION_GROUPS.open,
    item: ({ thread, navigate }) => ({ label: "Trace this thread", icon: "traces/traces",
      run: () => navigate.toPluginPanel("waterfall", { subPath: encodeURIComponent(thread.id) }) }) });
});
