import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Select from "@radix-ui/react-select";
import { experimental_Icon as Icon, definePluginApp, experimental_THREAD_ACTION_GROUPS, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { TraceResult, TraceSpan } from "./spans";
import { ContextInspector } from "./context-view";
import { ExplorerView, MetricsView } from "./fleet-view";
import "./app.css";

function duration(ms: number | null) {
  if (ms === null) return "open";
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
}
function clock(ms: number) { return new Date(ms).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function flatten(span: TraceSpan, depth = 0): Array<{ span: TraceSpan; depth: number }> {
  return [{ span, depth }, ...span.children.flatMap((child) => flatten(child, depth + 1))];
}
const WAIT = "wait";
const palette: Record<string, string> = {
  thread: "var(--muted-foreground)", turn: "var(--primary)", reasoning: "#9b82d2", agentMessage: "#8b97cb",
  commandExecution: "#e5ad6f", toolCall: "#72afc6", fileRead: "#78bcb0", fileChange: "#d494ae",
  delegation: "#a7c47c", backgroundTask: "#a7c47c", search: "#78bcb0", contextCompaction: "#bc8bd2",
};

function SpanRow({ span, depth, selected, onSelect, origin, width, observedEnd }: {
  span: TraceSpan; depth: number; selected: boolean; onSelect: (span: TraceSpan) => void; origin: number; width: number; observedEnd: number;
}) {
  const left = Math.max(0, Math.min(100, (span.start - origin) / width * 100));
  const effectiveEnd = span.end ?? Math.max(span.start, observedEnd);
  const length = Math.max(0.4, Math.min(100 - left, (effectiveEnd - span.start) / width * 100));
  const barClass = span.kind === WAIT ? "traces-bar traces-bar-wait" : span.status === "failed" ? "traces-bar traces-bar-failed" : "traces-bar";
  const elapsed = span.end === null ? `${duration(effectiveEnd - span.start)} open` : duration(span.durationMs);
  return <button type="button" className={`traces-row ${selected ? "traces-row-selected" : ""}`} onClick={() => onSelect(span)} title={`${span.kind} · ${span.name} · ${elapsed}`}>
    <span className="traces-row-label" style={{ paddingLeft: `${Math.min(depth, 6) * 16 + 12}px` }}>
      <span className="traces-kind" aria-hidden="true" style={{ color: palette[span.kind] ?? "var(--muted-foreground)" }}>●</span>
      <span className="traces-row-text">{span.kind === "turn" ? `Turn ${span.name.split("-t").at(-1)}` : span.name}</span>
      {span.status === "failed" && <span className="traces-failed">failed</span>}
    </span>
    <span className="traces-track"><span className={barClass} style={{ left: `${left}%`, width: `${length}%`, background: span.kind === WAIT || span.status === "failed" ? undefined : palette[span.kind] ?? "var(--muted-foreground)" }} /></span>
    <span className="traces-row-time">{elapsed}</span>
  </button>;
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

function Waterfall({ threadId, compact = false }: { threadId: string; compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [reveal, setReveal] = useState(true);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [turn, setTurn] = useState("last");
  const request = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => { setResult(null); setSelectedId(null); setTurn("last"); }, [threadId]);
  useEffect(() => { load(); return () => { request.current++; }; }, [load]);
  useRealtime("traces-changed", (payload) => {
    const changed = payload as { threadId?: string };
    if (changed.threadId === threadId) load();
  });
  const trace = result?.tree.threadId === threadId ? result : null;
  const root = trace?.tree;
  const all = useMemo(() => root ? flatten(root) : [], [root]);
  const byId = useMemo(() => new Map(all.map(({ span }) => [span.id, span])), [all]);
  const turns = all.filter(({ span }) => span.kind === "turn" && span.threadId === threadId).map(({ span }) => span);
  const display = turn === "all" ? root : turn === "last" ? turns.at(-1) ?? root : turns.find((candidate) => candidate.id === turn) ?? root;
  const rows = useMemo(() => display ? flatten(display) : [], [display]);
  const selected = selectedId && byId.get(selectedId) || display || null;
  const firstRow = Math.max(0, Math.floor(scrollTop / 27) - 5);
  const visibleRows = rows.slice(firstRow, firstRow + 55);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; setScrollTop(0); }, [display?.id]);
  const origin = display?.start ?? 0;
  const observedEnd = Math.max(origin, root?.end ?? origin);
  const width = Math.max(1, (display?.end ?? observedEnd) - origin);
  const time = trace?.summary.timeMs ?? {};
  const total = Object.values(time).reduce((sum, ms) => sum + ms, 0);
  const entries = Object.entries(time).sort((a, b) => b[1] - a[1]);
  return <div className={`traces-panel ${compact ? "traces-panel-compact" : ""}`}>
    <div className="traces-toolbar">
      <div className="traces-heading"><h2>Thread Waterfall</h2><span>{threadId}</span></div>
      <div className="traces-controls">
        <div className="traces-turn-control"><span>Turn</span><Select.Root value={turn} onValueChange={(value) => { setTurn(value); setSelectedId(null); }}>
          <Select.Trigger className="traces-turn-trigger" aria-label="Turn"><Select.Value /><Select.Icon><Icon name="ChevronDown" aria-hidden="true" /></Select.Icon></Select.Trigger>
          <Select.Portal><Select.Content className="traces-turn-content" position="popper" sideOffset={6}><Select.Viewport>
            <Select.Item className="traces-turn-item" value="last"><Select.ItemText>Latest turn</Select.ItemText><Select.ItemIndicator><Icon name="Check" aria-hidden="true" /></Select.ItemIndicator></Select.Item>
            <Select.Item className="traces-turn-item" value="all"><Select.ItemText>All turns</Select.ItemText><Select.ItemIndicator><Icon name="Check" aria-hidden="true" /></Select.ItemIndicator></Select.Item>
            {turns.map((span, index) => <Select.Item key={span.id} className="traces-turn-item" value={span.id}><Select.ItemText>Turn {index + 1}</Select.ItemText><Select.ItemIndicator><Icon name="Check" aria-hidden="true" /></Select.ItemIndicator></Select.Item>)}
          </Select.Viewport></Select.Content></Select.Portal>
        </Select.Root></div>
        <label className={reveal ? "traces-reveal-on" : ""}><input type="checkbox" checked={reveal} onChange={(event) => { if (!event.target.checked) { setResult(null); setSelectedId(null); } setReveal(event.target.checked); }} /> Reveal sensitive data</label>
        <button type="button" onClick={load}>Refresh</button>
      </div>
    </div>
    {error && <p role="alert" className="traces-error">{error}</p>}
    {!trace && !error && <p className="traces-empty">Loading thread events…</p>}
    {root && <>
      <div className="traces-axis"><span>Span · {trace!.eventCount.toLocaleString()} events</span><span className="traces-ticks"><span>{clock(origin)}</span><span>+{duration(width / 2)}</span><span>+{duration(width)}</span></span><span>Dur.</span></div>
      <div className="traces-body">
        <div className="traces-list" ref={listRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          <div style={{ height: firstRow * 27 }} />
          {visibleRows.map(({ span, depth }) => <SpanRow key={span.id} span={span} depth={depth} selected={span.id === selected?.id} onSelect={(value) => setSelectedId(value.id)} origin={origin} width={width} observedEnd={observedEnd} />)}
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
      : threadId ? view === "context" ? <ContextInspector key={threadId} threadId={threadId} /> : <Waterfall key={threadId} threadId={threadId} />
        : <div className="traces-thread-empty"><p>Select a thread in Log Explorer, or choose “Trace this thread” in a thread menu.</p><button type="button" onClick={() => openFleetView("explorer")}>Open Log Explorer</button></div>}
  </div></div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "waterfall", title: "Traces", icon: "traces/traces", path: "waterfall", component: NavPanel });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "trace", title: "Trace this thread",
    icon: "traces/traces", layout: "flush", component: ({ threadId }) => <Waterfall threadId={threadId} compact /> });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "context", title: "Context Inspector",
    icon: "traces/traces", layout: "flush", component: ({ threadId }) => <ContextInspector key={threadId} threadId={threadId} compact /> });
  app.slots.experimental_threadAction({ id: "trace-thread", title: "Trace this thread", icon: "traces/traces", group: experimental_THREAD_ACTION_GROUPS.open,
    item: ({ thread, navigate }) => ({ label: "Trace this thread", icon: "traces/traces",
      run: () => navigate.toPluginPanel("waterfall", { subPath: encodeURIComponent(thread.id) }) }) });
});
