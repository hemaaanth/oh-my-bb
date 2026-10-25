// The Traces view's rows, kept free of React so they can be tested.
import type { CalendarActivity, FeedEvent } from "./server";

type Call = NonNullable<CalendarActivity["calls"]>[number];

export type TraceRow =
  | { kind: "turn"; key: string; threadId: string; at: number; end: number | null }
  | { kind: FeedEvent["kind"]; key: string; threadId: string; at: number; detail: string | null }
  /** A Dispatch call. It belongs to no thread or project. */
  | { kind: "call"; key: string; at: number; end: number | null; call: Call };

/** Turns, the events of traced threads, and calls, newest first. */
export function traceRows(turns: CalendarActivity["turns"], events: readonly FeedEvent[], calls: readonly Call[] = []): TraceRow[] {
  const traced = new Set(turns.map((turn) => turn.threadId));
  return [
    ...turns.map((turn): TraceRow => ({ kind: "turn", key: `turn:${turn.threadId}:${turn.start}`, threadId: turn.threadId, at: turn.start, end: turn.end })),
    // Events follow the filters through their thread's turns.
    ...events.filter((event) => traced.has(event.threadId))
      .map((event): TraceRow => ({ kind: event.kind, key: `event:${event.id}`, threadId: event.threadId, at: event.occurredAt, detail: event.preview })),
    ...calls.map((call): TraceRow => ({ kind: "call", key: `call:${call.id}`, at: call.start, end: call.end, call })),
  ].sort((a, b) => b.at - a.at);
}
