import { summarize, type TraceSpan } from "./spans";

const CALL_KINDS: Record<string, true> = { commandExecution: true, toolCall: true, fileRead: true, fileChange: true,
  search: true, webSearch: true, webFetch: true, delegation: true, backgroundTask: true };

export interface CallGroup {
  key: string; label: string; count: number; measured: number; totalMs: number; unknown: number; failures: number;
  slowest: TraceSpan | null; runs: TraceSpan[];
}

/** Groups invocations within one turn. Children stay on their original spans. Totals sum measured calls, not exclusive wall time. */
export function groupTurnCalls(turn: TraceSpan): CallGroup[] {
  const groups = new Map<string, CallGroup>();
  const visit = (span: TraceSpan) => {
    if (Object.hasOwn(CALL_KINDS, span.kind)) {
      const label = span.kind === "commandExecution" ? span.name.startsWith("Command · ") ? span.name : "Command · other" : `${span.kind} · ${span.name}`;
      const key = `${span.kind}\0${label}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, label, count: 0, measured: 0, totalMs: 0, unknown: 0, failures: 0, slowest: null, runs: [] };
        groups.set(key, group);
      }
      group.count++; group.runs.push(span);
      if (span.status === "failed" || span.error) group.failures++;
      if (span.durationMs === null) group.unknown++;
      else {
        group.measured++; group.totalMs += span.durationMs;
        if (!group.slowest || span.durationMs > group.slowest.durationMs!) group.slowest = span;
      }
    }
    for (const child of span.children) visit(child);
  };
  visit(turn);
  return [...groups.values()].sort((a, b) => b.totalMs - a.totalMs || b.count - a.count || a.label.localeCompare(b.label));
}

export interface TurnMetrics {
  durationMs: number | null; timeMs: Record<string, number> | null; calls: number; failures: number; errors: number;
  lastInputTokens: number | null; lastOutputTokens: number | null;
}

export function turnMetrics(turn: TraceSpan): TurnMetrics {
  const groups = groupTurnCalls(turn);
  const last = turn.usage && typeof turn.usage === "object" && "last" in turn.usage ? turn.usage.last : null;
  const usage = last && typeof last === "object" ? last as Record<string, unknown> : null;
  let errors = 0;
  const stack = [turn];
  while (stack.length) {
    const span = stack.pop()!;
    if (span.kind === "error" || span.status === "failed" || span.error) errors++;
    stack.push(...span.children);
  }
  return { durationMs: turn.durationMs, timeMs: turn.end === null ? null : summarize(turn).timeMs,
    calls: groups.reduce((count, group) => count + group.count, 0),
    failures: groups.reduce((count, group) => count + group.failures, 0),
    errors,
    lastInputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : null,
    lastOutputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : null };
}

export interface TimeWindow { from: number; to: number }
const MIN_WINDOW_MS = 20;
export function clampWindow(window: TimeWindow, total: number): TimeWindow {
  const full = Math.max(MIN_WINDOW_MS, total);
  const width = Math.min(Math.max(window.to - window.from, MIN_WINDOW_MS), full);
  const from = Math.min(Math.max(window.from, 0), full - width);
  return { from, to: from + width };
}
export function zoomWindow(window: TimeWindow, total: number, factor: number, anchor = 0.5): TimeWindow {
  const width = window.to - window.from;
  if (factor < 1 && width <= MIN_WINDOW_MS) return clampWindow(window, total);
  const at = window.from + Math.min(1, Math.max(0, anchor)) * width;
  const next = width * factor;
  return clampWindow({ from: at - anchor * next, to: at + (1 - anchor) * next }, total);
}
export function panWindow(window: TimeWindow, total: number, delta: number): TimeWindow {
  return clampWindow({ from: window.from + delta, to: window.to + delta }, total);
}
export function fitWindow(start: number, end: number, total: number): TimeWindow {
  const pad = Math.max((end - start) * 0.12, 10);
  return clampWindow({ from: start - pad, to: end + pad }, total);
}

export function projectSpan(start: number, end: number, window: TimeWindow): { left: number; width: number } | null {
  if (start >= window.to || end < window.from) return null;
  const left = Math.max(0, Math.min(100, 100 * (Math.max(start, window.from) - window.from) / (window.to - window.from)));
  const right = Math.max(left, Math.min(100, 100 * (Math.min(end, window.to) - window.from) / (window.to - window.from)));
  return { left, width: Math.min(100 - left, Math.max(0.4, right - left)) };
}
