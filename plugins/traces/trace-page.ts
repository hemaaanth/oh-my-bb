import type { TraceEvent, TraceResult, TraceSpan } from "./spans";

/** Payload search only sees the already redacted/revealed trace supplied by the caller. */
export function tracePage(result: TraceResult, offset = 0, limit = 50, search = "") {
  const spans: TraceSpan[] = [];
  const visit = (span: TraceSpan) => {
    spans.push(span);
    span.children.forEach(visit);
  };
  visit(result.tree);
  const query = search.toLowerCase();
  const matches = spans.filter(({ children: _, ...span }) => !query || JSON.stringify(span).toLowerCase().includes(query));
  const rows: unknown[] = [];
  let bytes = 0;
  for (const { children: _, ...span } of matches.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(span));
    if (rows.length && bytes + size > 500_000) break;
    rows.push(span); bytes += size;
  }
  return { spans: rows, total: matches.length, offset, nextOffset: offset + rows.length < matches.length ? offset + rows.length : null,
    eventCount: result.eventCount, lastSeq: result.lastSeq };
}

/** Search full stored events before producing bounded excerpts. Never search hidden payloads. */
export function eventPage(events: TraceEvent[], offset = 0, limit = 50, search = "", reveal = false) {
  const query = search.toLowerCase();
  const matches = events.filter(event => JSON.stringify(reveal ? event : { ...event, data: undefined }).toLowerCase().includes(query));
  let bytes = 0;
  const rows = matches.slice(offset, offset + limit).map(event => {
    const data = reveal ? JSON.stringify(event.data) : "[hidden; use --reveal]";
    const at = query && reveal ? Math.max(0, data.toLowerCase().indexOf(query) - 500) : 0;
    return { ...event, data: undefined, payload: data.slice(at, at + 4000), payloadOffset: at, payloadTruncated: data.length > 4000 };
  }).filter(row => {
    bytes += Buffer.byteLength(JSON.stringify(row));
    return bytes <= 500_000;
  });
  return { events: rows, total: matches.length, offset, nextOffset: offset + rows.length < matches.length ? offset + rows.length : null,
    lastSeq: events.at(-1)?.seq ?? 0 };
}
