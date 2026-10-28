import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { PromptResult, PromptSection, PromptTool, PromptUsage } from "./prompt-contract";
import "./context.css";

const display = (value: number | null | undefined) => value == null ? "not stored" : value.toLocaleString();
const short = (value: number | null | undefined) => value == null ? "—" : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
function cacheShare(usage: PromptUsage | null, provider: string): number | null {
  if (!usage || usage.cacheReadTokens === null) return null;
  const denominator = provider === "codex" ? usage.inputTokens
    : [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].reduce<number | null>((sum, value) => sum === null || value === null ? null : sum + value, 0);
  return denominator === null || denominator <= 0 ? null : Math.round(100 * usage.cacheReadTokens / denominator);
}
function time(value: number | null) { return value === null ? "—" : new Date(value).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

function SectionCard({ section, reveal }: { section: PromptSection; reveal: boolean }) {
  return <details className="traces-context-section">
    <summary><span className={`traces-context-dot traces-context-dot-${section.kind}`} aria-hidden="true" />
      <span className="traces-context-section-name">{section.label}</span>
      <span className="traces-context-estimate">{section.estimatedTokens === null ? "not stored" : `~${short(section.estimatedTokens)} tokens`}</span>
      <span className="traces-context-count">{section.chars === null ? "—" : `${short(section.chars)} chars`}</span>
    </summary>
    <div className="traces-context-section-body">
      {reveal && section.text !== null ? <pre>{section.text}{section.truncated && "\n… [bounded excerpt]"}</pre> : <p>{section.chars === null ? "Content not stored." : "Content hidden. Use Reveal sensitive data to inspect it."}</p>}
    </div>
  </details>;
}
function ToolCard({ tool, reveal }: { tool: PromptTool; reveal: boolean }) {
  return <details className="traces-context-tool">
    <summary><span className="traces-context-tool-name">{tool.name}</span><span className="traces-context-estimate">{tool.estimatedTokens === null ? "—" : `~${short(tool.estimatedTokens)} tokens`}</span></summary>
    <div className="traces-context-section-body">
      {reveal ? <>{tool.description && <pre>{tool.description}</pre>}{tool.schema && <pre>{tool.schema}</pre>}{tool.truncated && <p>Definition cut at the response limit.</p>}</>
        : <p>Definition hidden. Use Reveal sensitive data to inspect it.</p>}
    </div>
  </details>;
}

function ContextBar({ result }: { result: PromptResult }) {
  const selected = result.selected!;
  const system = selected.system.reduce((sum, section) => sum + (section.estimatedTokens ?? 0), 0);
  const tools = selected.tools.reduce((sum, tool) => sum + (tool.estimatedTokens ?? 0), 0);
  const injected = selected.injected.reduce((sum, section) => sum + (section.estimatedTokens ?? 0), 0);
  const used = selected.contextUsedTokens;
  const estimated = system + tools + injected;
  const window = selected.contextWindowTokens;
  const scale = Math.max(window ?? 0, used ?? 0, estimated, 1);
  const remainder = used === null ? 0 : Math.max(0, used - estimated);
  const free = window === null || used === null ? 0 : Math.max(0, window - Math.max(used, estimated));
  const segments = [
    { label: "System", value: system, className: "system" }, { label: "Tools", value: tools, className: "tools" },
    { label: "Injected", value: injected, className: "injected" }, { label: "Other input", value: remainder, className: "other" },
    { label: "Free", value: free, className: "free" },
  ];
  return <div className="traces-context-capacity">
    <div className="traces-context-capacity-title"><strong>Context window</strong><span>{used === null ? "usage not stored" : `${short(used)} input tokens`}{window === null ? " · capacity not stored" : ` / ${short(window)} capacity`}</span></div>
    <div className="traces-context-capacity-track" role="img" aria-label="Estimated prompt sections; exact input token usage when stored">
      {segments.map((part) => part.value > 0 && <span key={part.label} className={`traces-context-capacity-${part.className}`} style={{ width: `${part.value / scale * 100}%` }} title={`${part.label}: ${part.className === "free" || part.className === "other" ? "derived" : "estimated"} ${short(part.value)} tokens`} />)}
    </div>
    <p>Section sizes are character-based estimates. Input and cache usage comes from the provider. Unattributed input may include messages and tool results.</p>
  </div>;
}

function DiffCard({ result }: { result: PromptResult }) {
  const diff = result.selected!.diff;
  return <section className="traces-context-diff" aria-label="Diff from previous API call">
    <div className="traces-context-card-heading"><strong>Diff from call {diff.previousCall ?? "—"}</strong><span>Prompt changes</span></div>
    {diff.previousCall === null ? <p>First stored call. No previous prompt to compare.</p> : <>
      <div className="traces-context-diff-stats"><span>System {diff.systemChanged === null ? "not stored" : diff.systemChanged ? "changed" : "unchanged"}</span><span>Model {diff.modelChanged === null ? "not stored" : diff.modelChanged ? "changed" : "unchanged"}</span><span>Tools +{diff.toolsAdded.length} / −{diff.toolsRemoved.length}</span><span>Context +{diff.injectedAdded.length} / −{diff.injectedRemoved.length}</span></div>
      {(diff.toolsAdded.length > 0 || diff.toolsRemoved.length > 0 || diff.injectedAdded.length > 0 || diff.injectedRemoved.length > 0) &&
        <div className="traces-context-diff-list">
          {diff.toolsAdded.map((value, index) => <span key={`ta-${index}`} className="added">+ {value}</span>)}
          {diff.toolsRemoved.map((value, index) => <span key={`tr-${index}`} className="removed">− {value}</span>)}
          {diff.injectedAdded.map((value, index) => <span key={`ia-${index}`} className="added">+ {value}</span>)}
          {diff.injectedRemoved.map((value, index) => <span key={`ir-${index}`} className="removed">− {value}</span>)}
        </div>}
    </>}
  </section>;
}

function Ledger({ result, onSelect }: { result: PromptResult; onSelect: (index: number) => void }) {
  return <section className="traces-context-ledger" aria-label="Per-call token ledger">
    <div className="traces-context-card-heading"><strong>Token and cache ledger</strong><span>{result.callCount.toLocaleString()} API calls · showing {result.ledgerStart}–{result.ledgerStart + result.ledger.length - 1}</span></div>
    <div className="traces-context-table-wrap"><table><thead><tr><th>#</th><th>At</th><th>Model</th><th className="number">Input</th><th className="number">Cache R</th><th className="number">Cache W</th><th className="number">5m / 1h W</th><th className="number">Output</th><th className="number">Think</th><th className="number">Hit</th></tr></thead>
      <tbody>{result.ledger.map((row) => { const share = cacheShare(row.usage, result.provider); return <tr key={row.index} className={row.index === result.selectedIndex ? "selected" : ""}>
        <td><button type="button" onClick={() => onSelect(row.index)} aria-label={`Inspect API call ${row.index}`} aria-current={row.index === result.selectedIndex ? "true" : undefined}>{row.index}</button></td>
        <td>{time(row.at)}</td><td title={row.model ?? "not stored"}>{row.model ?? "—"}</td>
        <td className="number">{short(row.usage?.inputTokens)}</td><td className="number">{short(row.usage?.cacheReadTokens)}</td><td className="number">{short(row.usage?.cacheWriteTokens)}</td>
        <td className="number">{short(row.usage?.cacheWrite5mTokens)} / {short(row.usage?.cacheWrite1hTokens)}</td>
        <td className="number">{short(row.usage?.outputTokens)}</td><td className="number">{short(row.usage?.reasoningTokens)}</td>
        <td className="number">{share === null ? "—" : `${share}%`}</td>
      </tr>; })}</tbody></table></div>
    <p>— means not stored. Codex does not store a 5m/1h cache-write split. Select a call to inspect its context.</p>
  </section>;
}

export function ContextInspector({ threadId, compact = false }: { threadId: string; compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [callIndex, setCallIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(true);
  const [result, setResult] = useState<PromptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const load = useCallback(() => {
    const generation = ++request.current;
    rpc.call("traces_prompt", { threadId, call: callIndex, reveal }).then((value) => {
      if (generation !== request.current) return;
      setResult(value); setError(null);
    }, (cause: unknown) => {
      if (generation !== request.current) return;
      setError(cause instanceof Error ? cause.message : "Could not read the transcript.");
    });
  }, [rpc, threadId, callIndex, reveal]);
  useEffect(() => { load(); return () => { request.current++; }; }, [load]);
  useEffect(() => { setResult(null); setCallIndex(null); }, [threadId]);
  useEffect(() => { if (result?.selectedIndex !== null && result?.selectedIndex !== undefined) setDraft(String(result.selectedIndex)); }, [result?.selectedIndex]);
  useEffect(() => () => { window.clearTimeout(refreshTimer.current ?? undefined); }, []);
  useRealtime("traces-changed", (payload) => {
    const changed = payload as { threadId?: string };
    if (changed.threadId !== threadId || callIndex !== null || refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; load(); }, 15_000);
  });
  const current = result?.threadId === threadId ? result : null;
  const selected = current?.selected;
  const usage = selected?.usage ?? null;
  const hit = useMemo(() => cacheShare(usage, current?.provider ?? ""), [usage, current?.provider]);
  const changeCall = (index: number) => { if (current && index >= 1 && index <= current.callCount) { setResult(null); setCallIndex(index); } };
  return <section className={`traces-context ${compact ? "traces-context-compact" : ""}`} aria-label="Context Inspector">
    <header className="traces-context-header">
      <div><h2>Context Inspector</h2><p>{threadId} {current?.provider && <span>· {current.provider}</span>}</p></div>
      <div className="traces-context-actions">
        <button type="button" disabled={!selected || selected.index <= 1} onClick={() => selected && changeCall(selected.index - 1)} aria-label="Previous API call">←</button>
        <form onSubmit={(event) => { event.preventDefault(); const value = Number(draft); if (Number.isSafeInteger(value)) changeCall(value); }}>
          <label htmlFor="traces-call-index">Call</label><input id="traces-call-index" inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="API call number" />
          <span>of {current?.callCount ?? "—"}</span><button type="submit" disabled={!current}>Go</button>
        </form>
        <button type="button" disabled={!selected || selected.index >= (current?.callCount ?? 0)} onClick={() => selected && changeCall(selected.index + 1)} aria-label="Next API call">→</button>
        <label className={reveal ? "traces-context-revealed" : ""}><input type="checkbox" checked={reveal} onChange={(event) => {
          if (!event.target.checked) { request.current++; setResult(null); }
          setReveal(event.target.checked);
        }} /> Reveal sensitive data</label>
        <button type="button" onClick={load}>Refresh</button>
      </div>
    </header>
    {error && <p role="alert" className="traces-context-alert">{error}</p>}
    {!current && !error && <p className="traces-context-empty">Reading the provider transcript…</p>}
    {current && !selected && <div className="traces-context-empty"><h3>{current.status === "unsupported" ? "Provider not supported" : "Transcript unavailable"}</h3><p>{current.reason}</p><p>No prompt or token usage was inferred.</p></div>}
    {selected && current && <>
      {current.reason && <p className="traces-context-alert">Partial transcript: {current.reason}</p>}
      <div className="traces-context-summary">
        <div><span>Model</span><strong>{selected.model ?? "not stored"}</strong></div>
        <div><span>Input</span><strong>{short(usage?.inputTokens)}</strong></div>
        <div><span>Cache read</span><strong>{short(usage?.cacheReadTokens)}{hit !== null && <small> · {hit}% hit</small>}</strong></div>
        <div><span>Cache write</span><strong>{short(usage?.cacheWriteTokens)}</strong></div>
        <div><span>Output</span><strong>{short(usage?.outputTokens)}</strong></div>
        <div><span>Reasoning</span><strong>{short(usage?.reasoningTokens)}</strong></div>
      </div>
      <div className="traces-context-grid">
        <div className="traces-context-left">
          <ContextBar result={current} />
          <div className="traces-context-section-heading"><h3>System prompt</h3><span>{selected.system.length} sections</span></div>
          {selected.system.length ? selected.system.map((section) => <SectionCard key={section.id} section={section} reveal={reveal} />) : <p className="traces-context-muted">System prompt not stored.</p>}
          <div className="traces-context-section-heading"><h3>Tool definitions</h3><span>{selected.tools.length} tools</span></div>
          {selected.tools.length ? <div className="traces-context-tool-list">{selected.tools.map((tool, index) => <ToolCard key={`${tool.name}-${index}`} tool={tool} reveal={reveal} />)}</div> : <p className="traces-context-muted">Tool definitions not stored.</p>}
          <div className="traces-context-section-heading"><h3>Injected context</h3><span>{selected.injected.length} blocks</span></div>
          {selected.injected.length ? selected.injected.map((section) => <SectionCard key={section.id} section={section} reveal={reveal} />) : <p className="traces-context-muted">No injected blocks found in the stored transcript.</p>}
        </div>
        <div className="traces-context-right">
          <div className="traces-context-call-meta"><span>Response {selected.requestId ?? "not stored"}</span><span>{time(selected.at)} · {selected.durationMs === null ? "API duration not stored" : `${(selected.durationMs / 1_000).toFixed(1)}s`}</span></div>
          <div className="traces-context-request"><span>Max output {display(selected.params.maxTokens)}</span><span>Thinking {selected.params.thinking ?? "not stored"}</span><span>Effort {selected.params.effort ?? "not stored"}</span></div>
          <Ledger result={current} onSelect={changeCall} />
          <DiffCard result={current} />
          <p className="traces-context-footnote">{current.scan.linesRead.toLocaleString()} JSONL lines read on the execution host. {current.scan.oversizedLines ? `${current.scan.oversizedLines} oversized lines skipped. ` : ""}Nothing was stored by Traces.</p>
        </div>
      </div>
    </>}
  </section>;
}
