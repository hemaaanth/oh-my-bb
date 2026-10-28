// Pure event-to-span conversion. No BB runtime, database, or React dependency.
// The same builder can consume SDK events now and read-only fleet scans later.
export interface TraceEvent {
  id: string; threadId: string; seq: number; type: string; createdAt: number;
  scope: { kind: "thread" } | { kind: "turn"; turnId: string };
  data: Record<string, unknown>;
}
export interface TraceThread {
  id: string; title: string | null; providerId: string; environmentId: string | null; environmentLabel?: string;
  parentThreadId: string | null; createdAt: number; updatedAt: number; status: string;
  originKind?: string | null; originPluginId?: string | null;
}
export interface TraceMetadata {
  model: string | null; provider: string; reasoningLevel: string | null;
  permissionMode: string | null; environment: string | null; initiator: string | null;
}
export interface TraceSpan {
  id: string; threadId: string; turnId: string | null; itemId: string | null;
  kind: string; name: string; start: number; end: number | null; durationMs: number | null;
  status: string; error: string | null; input: string | null; output: string | null;
  inputSize: number | null; outputSize: number | null;
  metadata: TraceMetadata; usage: unknown | null; contextUsage: unknown | null;
  children: TraceSpan[];
}
export interface TraceSummary {
  elapsedMs: number; activeMs: number; counts: Record<string, number>;
  // Exclusive wall time: model is the uncovered time inside turns, not an API timer.
  timeMs: Record<string, number>; slowest: Array<{ id: string; kind: string; name: string; durationMs: number }>;
  errors: Array<{ id: string; kind: string; name: string; error: string | null }>;
}
export interface TraceResult { tree: TraceSpan; summary: TraceSummary; lastSeq: number; eventCount: number }

const MAX_TEXT = 2_000;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const nonempty = (v: unknown) => typeof v === "string" && v.length > 0 ? v : null;
function render(v: unknown): { value: string | null; size: number | null } {
  if (v === null || v === undefined) return { value: null, size: null };
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return { value: null, size: null };
  const size = Buffer.byteLength(s, "utf8");
  return { value: s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… [truncated, ${size} bytes originally]` : s, size };
}
function metadata(thread: TraceThread, execution: Record<string, unknown> = {}, initiator: string | null = null): TraceMetadata {
  return { model: nonempty(execution.model), provider: thread.providerId, reasoningLevel: nonempty(execution.reasoningLevel),
    permissionMode: nonempty(execution.permissionMode), environment: thread.environmentLabel ?? thread.environmentId, initiator };
}
function span(args: {
  id: string; thread: TraceThread; turnId?: string | null; itemId?: string | null; kind: string; name: string;
  start: number; end?: number | null; status?: string; error?: string | null; input?: unknown; output?: unknown; metadata: TraceMetadata;
}): TraceSpan {
  const input = render(args.input); const output = render(args.output);
  const end = args.end ?? null;
  return { id: args.id, threadId: args.thread.id, turnId: args.turnId ?? null, itemId: args.itemId ?? null,
    kind: args.kind, name: args.name, start: args.start, end, durationMs: end === null ? null : Math.max(0, end - args.start),
    status: args.status ?? "completed", error: args.error ?? null, input: input.value, output: output.value,
    inputSize: input.size, outputSize: output.size, metadata: args.metadata, usage: null, contextUsage: null, children: [] };
}
const byTime = (a: TraceSpan, b: TraceSpan) => a.start - b.start || a.id.localeCompare(b.id);
function eventTurn(event: TraceEvent): string | null { return event.scope.kind === "turn" ? event.scope.turnId : null; }
function itemName(item: Record<string, unknown>): string {
  switch (item.type) {
    case "toolCall": return nonempty(item.tool) ?? "toolCall";
    case "commandExecution": return "Command";
    case "fileRead": return nonempty(item.path) ?? "File read";
    case "fileChange": return "File change";
    case "search": return "Search";
    case "webSearch": return "Web search";
    case "webFetch": return "Web fetch";
    case "delegation": return nonempty(item.label) ?? "Delegation";
    case "backgroundTask": return nonempty(item.description) ?? "Background task";
    case "reasoning": return "Reasoning";
    case "agentMessage": return "Message";
    case "contextCompaction": return "Compaction";
    default: return nonempty(item.type) ?? "Item";
  }
}
function itemInput(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case "toolCall": return { server: item.server, tool: item.tool, arguments: item.arguments };
    case "commandExecution": return { command: item.command, cwd: item.cwd };
    case "fileRead": return { path: item.path, cmd: item.cmd };
    case "fileChange": return item.changes;
    case "search": return { query: item.query, path: item.path, mode: item.mode };
    case "webSearch": return item.queries;
    case "webFetch": return { url: item.url, prompt: item.prompt };
    case "delegation": return { childRef: item.childRef, label: item.label };
    case "backgroundTask": return item.description;
    default: return null;
  }
}
function itemOutput(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case "toolCall": return item.result;
    case "commandExecution": return item.aggregatedOutput;
    case "webSearch": case "webFetch": return item.resultText;
    case "reasoning": return item.content;
    case "agentMessage": return item.text;
    case "fileChange": return item.changes;
    case "delegation": case "backgroundTask": return item.summary;
    default: return null;
  }
}
function errorOf(item: Record<string, unknown>): string | null {
  return nonempty(item.error) ?? (item.status === "failed" ? `Item failed${typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : ""}` : null);
}
function wait(parent: TraceSpan, event: TraceEvent, kind: string, name: string, end: number, data: unknown = null) {
  if (end <= event.createdAt) return;
  parent.children.push(span({ id: `${event.id}:wait`, thread: { id: event.threadId, title: null, providerId: parent.metadata.provider,
    environmentId: parent.metadata.environment, parentThreadId: null, createdAt: event.createdAt, updatedAt: end, status: "" },
    turnId: parent.turnId, kind, name, start: event.createdAt, end, status: "waiting", input: data, metadata: parent.metadata }));
}

/** Pair item lifecycles within one thread and turn, consuming the nearest unmatched start. */
export function buildTrace(thread: TraceThread, events: readonly TraceEvent[], children: readonly TraceResult[] = []): TraceResult {
  const rows = [...events].sort((a, b) => a.seq - b.seq);
  const first = rows[0]?.createdAt ?? thread.createdAt;
  let last = rows.reduce((max, row) => Math.max(max, row.createdAt), first);
  for (const child of children) last = Math.max(last, child.tree.end ?? child.tree.start);
  const root = span({ id: `thread:${thread.id}`, thread, kind: "thread", name: thread.title ?? thread.id,
    start: Math.min(first, thread.createdAt), end: last, status: thread.status, metadata: metadata(thread) });
  const turns = new Map<string, TraceSpan>();
  const opens = new Map<string, TraceSpan[]>();
  const backgroundStarts = new Map<string, TraceSpan[]>();
  const pendingRequests: TraceEvent[] = [];
  const pendingWaits = new Map<string, { event: TraceEvent; parent: TraceSpan; kind: string; name: string }>();
  const currentItem = new Map<string, TraceSpan>();
  let currentTurn: TraceSpan | null = null;
  const firstOutputSeen = new Set<string>();
  let provisioning: TraceEvent | null = null;
  let retry: TraceEvent | null = null;
  let fallback: TraceEvent | null = null;
  let lastTurnEnd: number | null = null;
  const nestedParents = new Map<string, TraceSpan>();
  const owner = (row: TraceEvent) => turns.get(eventTurn(row) ?? "") ?? currentTurn ?? root;
  const key = (row: TraceEvent, id: string) => `${row.threadId}\0${eventTurn(row) ?? ""}\0${id}`;
  const attach = (parent: TraceSpan, child: TraceSpan, parentToolCallId: unknown) => {
    const id = nonempty(parentToolCallId);
    const parentItem = id && currentItem.get(`${parent.threadId}\0${parent.turnId ?? ""}\0${id}`);
    (parentItem || parent).children.push(child);
  };
  for (const row of rows) {
    const d = object(row.data);
    const turnId = eventTurn(row);
    if (row.type === "client/turn/requested") {
      if (lastTurnEnd !== null && row.createdAt > lastTurnEnd) {
        wait(root, { ...row, createdAt: lastTurnEnd }, "idle", "Idle between turns", row.createdAt);
        lastTurnEnd = null;
      }
      pendingRequests.push(row);
      continue;
    }
    if (row.type === "system/thread-provisioning") {
      if (!provisioning && d.status === "active") provisioning = row;
      if (d.status === "completed" && provisioning) { wait(root, provisioning, "wait", "Provisioning", row.createdAt); provisioning = null; }
      continue;
    }
    if ((retry || fallback) && (row.type === "item/started" || row.type === "item/completed" || row.type.endsWith("/delta") || row.type === "turn/completed")) {
      if (retry && row.seq > retry.seq) { wait(owner(retry), retry, "wait", "Provider retry", row.createdAt, retry.data); retry = null; }
      if (fallback && row.seq > fallback.seq) { wait(owner(fallback), fallback, "wait", "Model fallback", row.createdAt, fallback.data); fallback = null; }
    }
    if (row.type === "turn/started" && turnId) {
      const requestId = nonempty(d.clientRequestId);
      const parentId = nonempty(d.parentToolCallId);
      const requestIndex = requestId ? pendingRequests.findIndex((r) => r.data.requestId === requestId) : 0;
      const request = parentId ? undefined : pendingRequests.splice(Math.max(0, requestIndex), pendingRequests.length ? 1 : 0)[0];
      const execution = object(request?.data.execution);
      const meta = request ? metadata(thread, execution, nonempty(request.data.initiator)) : currentTurn?.metadata ?? metadata(thread);
      const turn = span({ id: `turn:${thread.id}:${turnId}`, thread, turnId, kind: "turn", name: turnId,
        start: row.createdAt, status: "running", input: request?.data.input ?? null, metadata: meta });
      turns.set(turnId, turn);
      const parentItem = parentId && currentTurn && currentItem.get(`${thread.id}\0${currentTurn.turnId ?? ""}\0${parentId}`);
      if (parentItem && currentTurn) nestedParents.set(turnId, currentTurn);
      (parentItem || root).children.push(turn);
      currentTurn = turn;
      if (request) wait(root, request, "wait", "Queue", row.createdAt);
      continue;
    }
    if (row.type === "turn/completed" && turnId) {
      const turn = turns.get(turnId);
      if (turn) {
        turn.end = row.createdAt; turn.durationMs = Math.max(0, row.createdAt - turn.start);
        turn.status = nonempty(d.status) ?? "completed"; turn.error = nonempty(object(d.error).message);
        if (currentTurn === turn) currentTurn = nestedParents.get(turnId) ?? null;
        if (!nestedParents.has(turnId)) lastTurnEnd = row.createdAt;
      }
      continue;
    }
    if (row.type === "item/started" || row.type === "item/completed" || row.type === "item/backgroundTask/completed") {
      const item = object(d.item);
      const id = nonempty(item.id);
      if (!id) continue;
      const itemKey = key(row, id);
      if (row.type === "item/started") {
        const parent = owner(row);
        const s = span({ id: `item:${row.id}`, thread, turnId, itemId: id, kind: nonempty(item.type) ?? "item", name: itemName(item),
          start: row.createdAt, status: nonempty(item.status) ?? "pending", input: itemInput(item), metadata: parent.metadata });
        attach(parent, s, item.parentToolCallId ?? d.parentToolCallId);
        const list = opens.get(itemKey) ?? []; list.push(s); opens.set(itemKey, list);
        if (item.type === "backgroundTask") backgroundStarts.set(`${row.threadId}\0${id}`, list);
        currentItem.set(itemKey, s);
        continue;
      }
      if (turnId && !firstOutputSeen.has(turnId)) {
        const turn = turns.get(turnId);
        if (turn) wait(turn, { ...row, createdAt: turn.start }, "wait", "First output", row.createdAt);
        firstOutputSeen.add(turnId);
      }
      // A background completion may arrive in another turn; never consume a
      // same-id foreground item from that turn.
      const list = row.type === "item/backgroundTask/completed"
        ? backgroundStarts.get(`${row.threadId}\0${id}`) : opens.get(itemKey);
      const matched = list?.pop();
      const parent = matched ? null : owner(row);
      const s = matched ?? span({ id: `item:${row.id}`, thread, turnId, itemId: id, kind: nonempty(item.type) ?? "item", name: itemName(item),
        start: typeof item.durationMs === "number" ? Math.max(0, row.createdAt - item.durationMs) : row.createdAt,
        status: nonempty(item.status) ?? "completed", metadata: parent!.metadata });
      s.end = row.createdAt; s.durationMs = Math.max(0, s.end - s.start);
      s.status = nonempty(item.status) ?? "completed"; s.error = errorOf(item);
      const output = render(itemOutput(item)); s.output = output.value; s.outputSize = output.size;
      if (!matched) attach(parent!, s, item.parentToolCallId ?? d.parentToolCallId);
      continue;
    }
    if (row.type === "item/agentMessage/delta" || row.type === "item/reasoning/textDelta") {
      if (turnId && !firstOutputSeen.has(turnId)) {
        const turn = turns.get(turnId);
        if (turn) wait(turn, { ...row, createdAt: turn.start }, "wait", "First output", row.createdAt);
        firstOutputSeen.add(turnId);
      }
      continue;
    }
    if (row.type === "system/interaction/lifecycle" || row.type === "system/userQuestion/lifecycle" || row.type === "system/permissionGrant/lifecycle") {
      const interaction = row.type === "system/interaction/lifecycle" ? object(d.interaction) : d;
      const id = nonempty(interaction.id) ?? nonempty(interaction.interactionId);
      if (id) {
        if (interaction.status === "pending") pendingWaits.set(id, { event: row, parent: owner(row), kind: "wait", name: row.type === "system/userQuestion/lifecycle" ? "User question" : "Approval / input" });
        else {
          const pending = pendingWaits.get(id);
          if (pending) { wait(pending.parent, pending.event, pending.kind, pending.name, row.createdAt, interaction); pendingWaits.delete(id); }
        }
      }
      continue;
    }
    if (row.type === "provider/error" && d.willRetry === true) retry = row;
    if (row.type === "provider/modelFallback") fallback = row;
    if (row.type === "thread/tokenUsage/updated" || row.type === "thread/contextWindowUsage/updated") {
      const turn = turns.get(turnId ?? "");
      if (turn) {
        if (row.type === "thread/tokenUsage/updated") turn.usage = d.tokenUsage ?? null;
        else turn.contextUsage = d.contextWindowUsage ?? null;
      } else if (row.type === "thread/tokenUsage/updated") root.usage = d.tokenUsage ?? null;
      else root.contextUsage = d.contextWindowUsage ?? null;
      continue;
    }
    if (row.type === "turn/input/accepted" || row.type === "client/thread/start" || row.type === "thread/identity" || row.type === "thread/extensionState/updated"
      || row.type === "item/commandExecution/outputDelta" || row.type === "item/toolCall/progress" || row.type === "item/mcpToolCall/progress"
      || row.type === "item/backgroundTask/progress" || row.type === "item/delegation/progress") continue;
    const parent = owner(row);
    const kind = row.type === "provider/error" || row.type === "system/error" || row.type === "client/turn/rejected" ? "error" : row.type.includes("compact") ? "contextCompaction" : "event";
    attach(parent, span({ id: `event:${row.id}`, thread, turnId, kind, name: row.type, start: row.createdAt, end: row.createdAt,
      status: kind === "error" ? "failed" : "completed", error: kind === "error" ? (nonempty(object(d.errorInfo).category) ?? nonempty(d.message) ?? row.type) : null,
      input: d, metadata: parent.metadata }), d.parentToolCallId);
  }
  // A pending wait is not an elapsed duration until it ends. Display it as open.
  for (const pending of pendingWaits.values()) {
    const p = pending.parent;
    p.children.push(span({ id: `${pending.event.id}:wait`, thread, turnId: p.turnId, kind: "wait", name: pending.name,
      start: pending.event.createdAt, status: "waiting", metadata: p.metadata }));
  }
  for (const child of children) {
    const linked = [...turns.values()].flatMap((t) => [t, ...t.children]).find((s) => s.kind === "delegation" && s.input?.includes(child.tree.threadId));
    (linked ?? root).children.push(child.tree);
  }
  function sort(s: TraceSpan) { s.children.sort(byTime); for (const child of s.children) sort(child); }
  sort(root);
  const summary = summarize(root);
  return { tree: root, summary, lastSeq: rows.at(-1)?.seq ?? 0, eventCount: rows.length };
}

/** Exclusive wall-time accounting. Child threads cannot inflate parent time. */
export function summarize(root: TraceSpan): TraceSummary {
  const counts: Record<string, number> = {}; const timeMs: Record<string, number> = {};
  const slowest: TraceSummary["slowest"] = []; const errors: TraceSummary["errors"] = [];
  type Interval = { start: number; end: number; kind: string; priority: number; turn: boolean };
  const intervals: Interval[] = [];
  function walk(s: TraceSpan, depth: number) {
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    if (s.status === "failed" || s.error) errors.push({ id: s.id, kind: s.kind, name: s.name, error: s.error });
    if (s.kind !== "thread" && s.kind !== "turn" && s.durationMs !== null) slowest.push({ id: s.id, kind: s.kind, name: s.name, durationMs: s.durationMs });
    const end = s.end ?? (s.kind === "turn" ? root.end : null);
    if ((s.threadId === root.threadId || (s.kind === "thread" && s.threadId !== root.threadId)) && (s.kind !== "thread" || s.threadId !== root.threadId) && end !== null && end > s.start) {
      const kind = s.kind === "thread" ? "child thread" : s.kind === "turn" || s.kind === "agentMessage" || s.kind === "reasoning" ? "model / uninstrumented"
        : s.kind === "wait" || s.kind === "idle" ? s.kind : s.status === "failed" ? `failed ${s.kind}` : s.kind;
      const priority = s.kind === "thread" ? 0.5 : s.kind === "idle" ? 0 : s.kind === "turn" ? 1 : s.kind === "reasoning" || s.kind === "agentMessage" ? 2 : s.kind === "wait" ? 10 : 3 + depth;
      intervals.push({ start: s.start, end, kind, priority, turn: s.kind === "turn" });
    }
    for (const child of s.children) walk(child, depth + 1);
  }
  walk(root, 0);
  const bounds = intervals.flatMap((x) => [
    { at: Math.max(root.start, x.start), interval: x, opening: true },
    { at: Math.min(root.end ?? x.end, x.end), interval: x, opening: false },
  ]).sort((a, b) => a.at - b.at || Number(a.opening) - Number(b.opening));
  const active = new Set<Interval>();
  let previous = root.start;
  let activeMs = 0;
  for (const point of [...bounds, { at: root.end ?? root.start, interval: null, opening: false }]) {
    if (point.at > previous) {
      let chosen: Interval | null = null;
      let inTurn = false;
      for (const candidate of active) {
        if (candidate.turn) inTurn = true;
        if (!chosen || candidate.priority > chosen.priority) chosen = candidate;
      }
      const elapsed = point.at - previous;
      if (inTurn) activeMs += elapsed;
      const kind = chosen?.kind ?? "idle";
      timeMs[kind] = (timeMs[kind] ?? 0) + elapsed;
    }
    if (point.interval) {
      if (point.opening) active.add(point.interval);
      else active.delete(point.interval);
    }
    previous = point.at;
  }
  slowest.sort((a, b) => b.durationMs - a.durationMs);
  return { elapsedMs: root.durationMs ?? 0, activeMs, counts, timeMs, slowest: slowest.slice(0, 10), errors: errors.slice(0, 30) };
}
