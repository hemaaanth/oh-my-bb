import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, experimental_THREAD_ACTION_GROUPS, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { TraceResult, TraceSpan } from "./spans";
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
    {!revealed && <p className="traces-hint">Inputs and outputs are hidden by default. Reveal is explicit and stays in this view only.</p>}
  </aside>;
}

function Waterfall({ threadId, compact = false }: { threadId: string; compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [children, setChildren] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [turn, setTurn] = useState("last");
  const request = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const load = useCallback(() => {
    const generation = ++request.current;
    rpc.call("traces_thread", { threadId, includeChildren: children, reveal }).then((trace) => {
      if (generation !== request.current) return;
      setResult(trace); setError(null);
    }, (cause: unknown) => {
      if (generation !== request.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, threadId, children, reveal]);
  useEffect(() => { setResult(null); setSelectedId(null); setTurn("last"); }, [threadId]);
  useEffect(() => { load(); return () => { request.current++; }; }, [load]);
  useRealtime("traces-changed", (payload) => {
    const changed = payload as { threadId?: string; parentThreadId?: string };
    if (changed.threadId === threadId || changed.parentThreadId === threadId || children) load();
  });
  const root = result?.tree;
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
  const time = result?.summary.timeMs ?? {};
  const total = Object.values(time).reduce((sum, ms) => sum + ms, 0);
  const entries = Object.entries(time).sort((a, b) => b[1] - a[1]);
  return <div className={`traces-panel ${compact ? "traces-panel-compact" : ""}`}>
    <div className="traces-toolbar">
      <div className="traces-heading"><h2>Thread Waterfall</h2><span>{threadId}</span></div>
      <div className="traces-controls">
        <label>Turn <select value={turn} onChange={(event) => { setTurn(event.target.value); setSelectedId(null); }}><option value="last">Latest turn</option><option value="all">All turns</option>{turns.map((s, index) => <option key={s.id} value={s.id}>Turn {index + 1}</option>)}</select></label>
        <label><input type="checkbox" checked={children} onChange={(event) => { setChildren(event.target.checked); if (event.target.checked) setTurn("all"); }} /> Children</label>
        <label className={reveal ? "traces-reveal-on" : ""}><input type="checkbox" checked={reveal} onChange={(event) => { if (!event.target.checked) { setResult(null); setSelectedId(null); } setReveal(event.target.checked); }} /> Reveal sensitive data</label>
        <button type="button" onClick={load}>Refresh</button>
      </div>
    </div>
    {error && <p role="alert" className="traces-error">{error}</p>}
    {!result && !error && <p className="traces-empty">Loading thread events…</p>}
    {root && <>
      <div className="traces-axis"><span>Span · {result.eventCount.toLocaleString()} events</span><span className="traces-ticks"><span>{clock(origin)}</span><span>+{duration(width / 2)}</span><span>+{duration(width)}</span></span><span>Dur.</span></div>
      <div className="traces-body">
        <div className="traces-list" ref={listRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          <div style={{ height: firstRow * 27 }} />
          {visibleRows.map(({ span, depth }) => <SpanRow key={span.id} span={span} depth={depth} selected={span.id === selected?.id} onSelect={(value) => setSelectedId(value.id)} origin={origin} width={width} observedEnd={observedEnd} />)}
          <div style={{ height: Math.max(0, rows.length - firstRow - visibleRows.length) * 27 }} />
        </div>
        {selected && <Detail span={selected} revealed={reveal} />}
      </div>
      <div className="traces-breakdown"><strong>Where thread time went · {duration(result.summary.elapsedMs)}</strong>
        <div className="traces-stack" aria-hidden="true">{entries.map(([kind, ms]) => <span key={kind} style={{ width: `${total ? ms / total * 100 : 0}%`, background: kind === WAIT ? "var(--muted-foreground)" : palette[kind] ?? "#9b82d2" }} />)}</div>
        <div>{entries.map(([kind, ms]) => <span key={kind}>{kind} {duration(ms)} ({total ? Math.round(ms / total * 100) : 0}%) · </span>)}</div>
        {result.summary.errors.length > 0 && <p className="traces-error">{result.summary.errors.length} error span{result.summary.errors.length === 1 ? "" : "s"}. Select a red bar for details.</p>}
        <p>Model / uninstrumented time is the part of a turn without a recorded item or wait. It is not measured model latency. Per-turn token usage is shown only where BB stored it.</p>
      </div>
    </>}
  </div>;
}

function NavPanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const [input, setInput] = useState("");
  const threadId = decodeURIComponent(subPath.split("/")[0] ?? "");
  return <div className="traces-page"><div className="traces-container">
    <form className="traces-open" onSubmit={(event) => { event.preventDefault(); const value = input.trim(); if (value) navigate.toPluginPanel("waterfall", { subPath: encodeURIComponent(value) }); }}>
      <label htmlFor="traces-thread-id">Thread ID</label><input id="traces-thread-id" value={input} onChange={(event) => setInput(event.target.value)} placeholder="thr_…" />
      <button type="submit">Open trace</button>
    </form>
    {threadId ? <Waterfall key={threadId} threadId={threadId} /> : <div className="traces-empty"><h2>Trace a thread</h2><p>Enter a thread ID, or use “Trace this thread” in a thread menu. This page reads BB's stored events without creating another database.</p></div>}
  </div></div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "waterfall", title: "Traces", icon: "traces/traces", path: "waterfall", component: NavPanel });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "trace", title: "Trace this thread",
    icon: "traces/traces", layout: "flush", component: ({ threadId }) => <Waterfall threadId={threadId} compact /> });
  app.slots.experimental_threadAction({ id: "trace-thread", title: "Trace this thread", icon: "traces/traces", group: experimental_THREAD_ACTION_GROUPS.open,
    item: ({ thread, navigate }) => ({ label: "Trace this thread", icon: "traces/traces",
      run: () => navigate.toPluginPanel("waterfall", { subPath: encodeURIComponent(thread.id) }) }) });
});
