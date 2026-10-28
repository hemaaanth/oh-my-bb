import { useMemo, useState } from "react";
import type { TraceSpan } from "./spans";
import { groupTurnCalls, turnMetrics } from "./investigate";
import "./turn-analysis.css";

const displayMs = (ms: number | null) => ms === null ? "not measured" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m`
  : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;

export function CallGroups({ turn, onOpen }: { turn: TraceSpan; onOpen: (span: TraceSpan) => void }) {
  const groups = useMemo(() => groupTurnCalls(turn), [turn]);
  const [visible, setVisible] = useState(20);
  const [runLimits, setRunLimits] = useState<Record<string, number>>({});
  return <section className="traces-call-groups" aria-label="Calls by command or tool">
    <p>Total is the sum of measured call durations, not exclusive wall time. Unknown durations are counted, not estimated.</p>
    {groups.length === 0 ? <p>No calls in this turn.</p> : <div className="traces-call-group-list">
      {groups.slice(0, visible).map((group) => {
        const runs = runLimits[group.key] ?? 20;
        return <details key={group.key} className="traces-call-group"><summary>
          <span className="traces-call-name">{group.label}</span>
          <span>{group.count} runs</span><span>{displayMs(group.totalMs)} measured · {group.unknown} unknown{group.failures ? ` · ${group.failures} failed` : ""}</span>
        </summary><div className="traces-call-runs">{group.runs.slice(0, runs).map((span, index) => <button type="button" key={span.id} onClick={() => onOpen(span)}>
          <span>Run {index + 1}{span.children.length ? ` · ${span.children.length} child spans` : ""}</span>
          <span>{displayMs(span.durationMs)}{span.status === "failed" ? " · failed" : ""}</span>
        </button>)}
        {group.runs.length > runs && <button type="button" onClick={() => setRunLimits((previous) => ({ ...previous, [group.key]: runs + 20 }))}>
          Show {Math.min(20, group.runs.length - runs)} more runs</button>}</div></details>;
      })}
      {groups.length > visible && <button type="button" className="traces-call-more" onClick={() => setVisible(visible + 20)}>
        Show {Math.min(20, groups.length - visible)} more groups</button>}
    </div>}
  </section>;
}

export function TurnComparison({ previous, current, previousNumber, currentNumber }: { previous: TraceSpan; current: TraceSpan;
  previousNumber: number; currentNumber: number }) {
  const a = useMemo(() => turnMetrics(previous), [previous]);
  const b = useMemo(() => turnMetrics(current), [current]);
  const phases = [...new Set([...Object.keys(a.timeMs ?? {}), ...Object.keys(b.timeMs ?? {})])].sort((x, y) =>
    Math.max(b.timeMs?.[y] ?? 0, a.timeMs?.[y] ?? 0) - Math.max(b.timeMs?.[x] ?? 0, a.timeMs?.[x] ?? 0));
  return <section className="traces-turn-comparison" aria-label="Turn comparison">
    <h3>Turn {previousNumber} → Turn {currentNumber}</h3>
    {(previous.end === null || current.end === null) && <p>Running turn: duration and time allocation are incomplete; call counts may still change.</p>}
    <div className="traces-compare-wrap"><table><thead><tr><th>Measure</th><th>Turn {previousNumber}</th><th>Turn {currentNumber}</th><th>Change</th></tr></thead><tbody>
      <tr><th>Duration</th><td>{displayMs(a.durationMs)}</td><td>{displayMs(b.durationMs)}</td><td>{a.durationMs === null || b.durationMs === null ? "—" : `${b.durationMs < a.durationMs ? "−" : "+"}${displayMs(Math.abs(b.durationMs - a.durationMs))}`}</td></tr>
      <tr><th>Calls</th><td>{a.calls}</td><td>{b.calls}</td><td>{b.calls - a.calls > 0 ? "+" : ""}{b.calls - a.calls}</td></tr>
      <tr><th>Failed calls</th><td>{a.failures}</td><td>{b.failures}</td><td>{b.failures - a.failures > 0 ? "+" : ""}{b.failures - a.failures}</td></tr>
      <tr><th>Failed/error spans</th><td>{a.errors}</td><td>{b.errors}</td><td>{b.errors - a.errors > 0 ? "+" : ""}{b.errors - a.errors}</td></tr>
      {phases.map((phase) => { const difference = (b.timeMs?.[phase] ?? 0) - (a.timeMs?.[phase] ?? 0);
        return <tr key={phase}><th>{phase}</th><td>{a.timeMs === null ? "incomplete" : displayMs(a.timeMs[phase] ?? 0)}</td>
          <td>{b.timeMs === null ? "incomplete" : displayMs(b.timeMs[phase] ?? 0)}</td>
          <td>{a.timeMs === null || b.timeMs === null ? "—" : `${difference < 0 ? "−" : "+"}${displayMs(Math.abs(difference))}`}</td></tr>; })}
      <tr><th>Last stored input tokens</th><td>{a.lastInputTokens?.toLocaleString() ?? "not stored"}</td><td>{b.lastInputTokens?.toLocaleString() ?? "not stored"}</td><td>snapshot only</td></tr>
      <tr><th>Last stored output tokens</th><td>{a.lastOutputTokens?.toLocaleString() ?? "not stored"}</td><td>{b.lastOutputTokens?.toLocaleString() ?? "not stored"}</td><td>snapshot only</td></tr>
    </tbody></table></div>
    <p>Phase durations are exclusive wall time when a turn is complete. Usage is the last stored per-call snapshot, not a turn total.</p>
  </section>;
}
