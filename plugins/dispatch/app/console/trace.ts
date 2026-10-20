// Turns raw trace events into transcript rows (CONTRACTS §4.3). Pure: no DOM,
// no RPC. The console renders the rows, and the tests read this file directly.
import type { TraceRow } from "../../shared/contract.js";

export type ActionStatus = "running" | "ok" | "error";

export type TraceItem =
  | { type: "speech"; id: number; at: number; who: "user" | "agent"; text: string }
  | { type: "action"; id: number; at: number; title: string; status: ActionStatus; args: unknown; output: string | null; callId: string | null }
  | { type: "notice"; id: number; at: number; text: string }
  | { type: "error"; id: number; at: number; text: string }
  | { type: "system"; id: number; at: number; events: TraceRow[] };

export type TraceFilter = "all" | "talk" | "actions" | "errors";

/** Plain verb phrases for the tools the voice agent has. Anything else is spelled out from its name. */
const VERBS: Record<string, string> = {
  get_context: "Looked at the current screen",
  list_projects: "Listed projects",
  list_machines: "Listed machines",
  list_providers: "Listed providers",
  list_live_threads: "Listed live threads",
  list_threads: "Listed threads",
  search_threads: "Searched threads",
  read_thread: "Read a thread",
  get_thread_error: "Read a thread's error",
  focus_thread: "Opened a thread",
  focus_threads: "Opened several threads",
  manage_views: "Managed views",
  set_view_behavior: "Changed how views open",
  set_pane: "Changed a pane",
  send_to_thread: "Sent a message to a thread",
  set_thread_model: "Changed a thread's model",
  start_thread: "Started a thread",
  stop_thread: "Stopped a thread",
  archive_thread: "Archived a thread",
  rename_thread: "Renamed a thread",
  show_diff: "Showed a diff",
  update_instructions: "Updated its instructions",
  recall_calls: "Looked up past calls",
  set_composer_text: "Wrote in the composer",
  append_composer_text: "Added to the composer",
};

const sentence = (name: string): string => {
  const words = name.replace(/[._-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
};

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The short title of one tool call. A plugin command reads like the line the owner would type. */
export function toolTitle(name: string, args: unknown): string {
  if (name === "run_plugin_command") {
    const input = record(args);
    const argv = Array.isArray(input?.argv) ? input.argv.map(String) : [];
    return ["bb", text(input?.plugin_id), ...argv].filter(Boolean).join(" ");
  }
  return VERBS[name] ?? sentence(name);
}

const OK_STATUS = /^(ok|success|succeeded|done)$/i;

/** The first occurrence of each kind decides the row type. */
function classify(kind: string): "speech" | "action" | "notice" | "error" | "system" {
  if (kind.startsWith("speech.")) return "speech";
  if (kind.startsWith("tool.") || kind === "send" || kind === "composer" || kind === "thread.focus") return "action";
  if (kind === "notice") return "notice";
  if (kind === "error" || kind === "call.failed") return "error";
  return "system";
}

const SIMPLE_ACTIONS: Record<string, (payload: Record<string, unknown>) => string> = {
  send: () => "Sent the message",
  composer: (payload) => (payload.action ? `Composer: ${text(payload.action)}` : "Used the composer"),
  "thread.focus": (payload) => (payload.how ? `Opened a thread (${text(payload.how)})` : "Opened a thread"),
};

/** Group events, oldest first, into rows. A tool result joins the call it answers. */
export function groupTrace(rows: readonly TraceRow[]): TraceItem[] {
  const items: TraceItem[] = [];
  const running = new Map<string, Extract<TraceItem, { type: "action" }>>();
  let system: Extract<TraceItem, { type: "system" }> | null = null;

  for (const row of rows) {
    const payload = row.payload ?? {};
    const group = classify(row.kind);
    if (group !== "system") system = null;

    if (group === "system") {
      if (system) system.events.push(row);
      else items.push((system = { type: "system", id: row.id, at: row.at, events: [row] }));
    } else if (group === "speech") {
      items.push({ type: "speech", id: row.id, at: row.at, who: row.kind === "speech.user" ? "user" : "agent", text: text(payload.text) });
    } else if (group === "notice") {
      items.push({ type: "notice", id: row.id, at: row.at, text: text(payload.digest) });
    } else if (group === "error") {
      items.push({ type: "error", id: row.id, at: row.at, text: text(row.kind === "error" ? payload.message : payload.detail) || (row.kind === "error" ? "An error" : "The call failed") });
    } else if (row.kind === "tool.call") {
      const name = text(payload.name);
      const item: Extract<TraceItem, { type: "action" }> = { type: "action", id: row.id, at: row.at, title: toolTitle(name, payload.args), status: "running", args: payload.args ?? null, output: null, callId: text(payload.callId) || null };
      items.push(item);
      if (item.callId) running.set(item.callId, item);
    } else if (row.kind === "tool.result") {
      const callId = text(payload.callId);
      const status: ActionStatus = OK_STATUS.test(text(payload.status)) ? "ok" : "error";
      const output = typeof payload.output === "string" ? payload.output : payload.output === undefined ? null : JSON.stringify(payload.output);
      const open = callId ? running.get(callId) : undefined;
      if (open) {
        open.status = status;
        open.output = output;
        running.delete(callId);
      } else {
        items.push({ type: "action", id: row.id, at: row.at, title: toolTitle(text(payload.name), null), status, args: null, output, callId: callId || null });
      }
    } else {
      items.push({ type: "action", id: row.id, at: row.at, title: SIMPLE_ACTIONS[row.kind]?.(payload) ?? sentence(row.kind), status: "ok", args: row.payload, output: null, callId: null });
    }
  }
  return items;
}

/** Talk covers what was said and the notices the agent heard. Errors include a tool that failed. System rows show only under All. */
export function filterItems(items: readonly TraceItem[], filter: TraceFilter): TraceItem[] {
  switch (filter) {
    case "all":
      return [...items];
    case "talk":
      return items.filter((item) => item.type === "speech" || item.type === "notice");
    case "actions":
      return items.filter((item) => item.type === "action");
    case "errors":
      return items.filter((item) => item.type === "error" || (item.type === "action" && item.status === "error"));
  }
}

/** Add events to a loaded list. Known ids are replaced, never duplicated. The result is oldest first. */
export function mergeRows(current: readonly TraceRow[], incoming: readonly TraceRow[]): TraceRow[] {
  const byId = new Map<number, TraceRow>();
  for (const row of current) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id - b.id);
}

/** Cut long text for display and say so. */
export function clip(value: string, max = 600): string {
  return value.length > max ? `${value.slice(0, max)}… (${value.length - max} more characters)` : value;
}
