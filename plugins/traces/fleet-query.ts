export type FleetField = "project" | "thread" | "provider" | "model" | "environment" | "worktree" | "kind" | "type" | "status" | "tool" | "child" | "category";
export interface FleetFilter {
  terms: Partial<Record<FleetField, string>>;
  duration: { op: ">" | ">=" | "<" | "<="; ms: number } | null;
}
export interface FleetMatch {
  projectId: string; projectName: string; threadId: string; provider: string; model: string | null;
  environmentId: string | null; worktree: boolean; child: boolean;
  kind: string; type: string; status: string; tool: string | null; category: string | null; durationMs: number | null;
}
const FIELDS: Record<FleetField, true> = { project: true, thread: true, provider: true, model: true, environment: true,
  worktree: true, kind: true, type: true, status: true, tool: true, child: true, category: true };
const MAX_QUERY_LENGTH = 512;
const MAX_TERMS = 12;

/** AND-only field:value terms. Quotes allow spaces; no free text, SQL or OR. */
export function parseFleetQuery(query: string): FleetFilter {
  if (query.length > MAX_QUERY_LENGTH) throw new Error("Query must be at most 512 characters.");
  const terms: FleetFilter["terms"] = {};
  let duration: FleetFilter["duration"] = null;
  let offset = 0; let count = 0;
  while (offset < query.length) {
    while (/\s/.test(query[offset] ?? "")) offset++;
    if (offset >= query.length) break;
    if (++count > MAX_TERMS) throw new Error("Query has too many terms (maximum 12).");
    const match = /^(@?[a-z]+):(?:"([^"]{1,100})"|([^\s"]{1,100}))/.exec(query.slice(offset));
    if (!match) throw new Error(`Invalid query term at character ${offset + 1}. Use field:value with spaces between terms.`);
    const field = match[1] === "@duration" ? "duration" : match[1]!;
    const value = match[2] ?? match[3]!;
    offset += match[0].length;
    if (offset < query.length && !/\s/.test(query[offset]!)) throw new Error(`Invalid query term at character ${offset + 1}.`);
    if (field === "duration") {
      if (duration) throw new Error("Duration can appear only once.");
      const parsed = /^(>=|<=|>|<)(\d{1,8})(ms|s|m|h)$/.exec(value);
      if (!parsed) throw new Error("Duration must look like duration:>5s or duration:<=100ms.");
      const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[parsed[3] as "ms" | "s" | "m" | "h"];
      duration = { op: parsed[1] as ">" | ">=" | "<" | "<=", ms: Number(parsed[2]) * multiplier };
    } else {
      if (!Object.hasOwn(FIELDS, field)) throw new Error(`Unsupported query field: ${field}.`);
      const key = field as FleetField;
      if (terms[key] !== undefined) throw new Error(`Duplicate query field: ${key}.`);
      if (key === "thread" && !/^thr_[a-z0-9]+$/.test(value)) throw new Error("Thread must be a BB thread ID.");
      if (key === "environment" && !/^env_[a-z0-9]+$/.test(value)) throw new Error("Environment must be a BB environment ID.");
      if (key !== "project" && key !== "child" && key !== "worktree" && !/^[\w./:-]+$/.test(value))
        throw new Error(`Invalid ${key} value.`);
      terms[key] = value;
    }
  }
  return { terms, duration };
}

export function parseFleetSince(since: string, now = Date.now()): { from: number; to: number; hours: number } {
  const match = /^([1-9]\d?)(h|d)$/.exec(since);
  if (!match) throw new Error("Window must be 1h–99h or 1d–7d (for example 24h or 7d).");
  const hours = Number(match[1]) * (match[2] === "d" ? 24 : 1);
  if (hours > 168) throw new Error("Fleet scans cannot exceed 7 days.");
  return { from: now - hours * 3_600_000, to: now, hours };
}

export function matchesFleetFilter(row: FleetMatch, filter: FleetFilter): boolean {
  const t = filter.terms;
  if (t.project && t.project !== row.projectId && t.project.toLowerCase() !== row.projectName.toLowerCase()) return false;
  if (t.thread && t.thread !== row.threadId) return false;
  if (t.provider && t.provider !== row.provider) return false;
  if (t.model && t.model !== row.model) return false;
  if (t.environment && t.environment !== row.environmentId) return false;
  if (t.worktree && (t.worktree === "true") !== row.worktree) return false;
  if (t.child && (t.child === "true") !== row.child) return false;
  if (t.kind && t.kind !== row.kind) return false;
  if (t.type && t.type !== row.type) return false;
  if (t.status && t.status !== row.status) return false;
  if (t.tool && t.tool !== row.tool) return false;
  if (t.category && t.category !== row.category) return false;
  if (filter.duration) {
    if (row.durationMs === null) return false;
    const { op, ms } = filter.duration;
    if (!(op === ">" ? row.durationMs > ms : op === ">=" ? row.durationMs >= ms : op === "<" ? row.durationMs < ms : row.durationMs <= ms)) return false;
  }
  return true;
}
