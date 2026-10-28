#!/usr/bin/env node
// Builds the span-builder test fixtures from real events in ~/.bb/bb.db.
//
// Read-only: the database opens with readOnly and query_only. Every query
// filters by thread_id; the table has millions of rows and no time index.
// Arbitrary text, paths, tool arguments, outputs, environment values, and raw provider events are replaced.
// Streaming deltas are thinned to their first occurrence per item.
//
// Usage: node scripts/extract-fixtures.mjs [path/to/bb.db]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? join(homedir(), ".bb", "bb.db");
const outDir = new URL("../fixtures/", import.meta.url);

// One entry per fixture: a provider, a thread, and a sequence window.
const SPECS = [
  { name: "claude-code-plan", threadId: "thr_kxvdvw5nsh", from: 1, to: 340, note: "Long planning turn: background task, compaction, token usage, provisioning, env dump." },
  { name: "claude-code-errors", threadId: "thr_yc7g5hdt49", around: ["provider/error", "system/error", "system/thread/interrupted", "system/interaction/lifecycle"], note: "Provider retries, a system error, an interaction wait, and an interrupt." },
  { name: "claude-code-fallback", threadId: "thr_xqa9szqhtn", from: 252, to: 540, note: "A turn with a model fallback after a refusal." },
  { name: "claude-code-reuse", threadId: "thr_y66unqnw58", around: ["item/started"], aroundItem: "da6f343971-i382", note: "One item id started and completed twice in one turn." },
  { name: "codex-delegation", threadId: "thr_wa7gnd7kjb", from: 794, to: 1380, note: "A delegation item whose child turn runs nested in the same thread. The window ends before the parent turn completes, so the parent turn is still open." },
  { name: "codex-retries", threadId: "thr_j58y9qzx5j", from: 1, to: 562, note: "Stream-disconnected provider errors with willRetry." },
  { name: "acp-omp-worktree", threadId: "thr_486gacbzkn", from: 1, to: 120, note: "A worktree child thread: provisioning, file reads, commands." },
  { name: "acp-omp-plan", threadId: "thr_s39ximyzg5", from: 1, to: 340, note: "Completed-only planSteps and fileChange items, interactions." },
  { name: "pi-tools", threadId: "thr_zjv3792zht", from: 1, to: 406, note: "Pi tool calls and started-only agent messages." },
];
const SAFE_SCALAR = new Set(["id", "itemId", "type", "status", "taskStatus", "category", "willRetry", "providerId", "kind", "model", "reasoningLevel", "permissionMode", "initiator", "source", "mode", "childRef", "background", "exitCode", "durationMs", "createdAt", "usedTokens", "modelContextWindow", "estimated", "totalTokens", "inputTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "requestId", "clientRequestId", "parentToolCallId", "interactionId", "retryOfRequestId", "retryAttempt", "providerRequestId", "httpStatusCode"]);
const DELTA_TYPES = new Set(["item/agentMessage/delta", "item/reasoning/textDelta", "item/commandExecution/outputDelta", "item/toolCall/progress", "item/mcpToolCall/progress"]);

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec("PRAGMA query_only = 1");

function scrub(value, key = "", depth = 0) {
  if (depth > 5 && value && typeof value === "object") return "[fixture nested object]";
  if (Array.isArray(value)) return value.slice(0, 6).map((entry) => scrub(entry, key, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "presentation" || childKey === "providerThreadId" || childKey === "rawEvent" || childKey === "snapshot") continue;
      out[childKey] = scrub(child, childKey, depth + 1);
    }
    return out;
  }
  // Arbitrary text, command arguments, results, paths and titles can hold
  // unknown secret formats. Whitelist only structural fields needed by tests.
  return typeof value === "string" && !(SAFE_SCALAR.has(key) && value.length <= 80 && /^[a-zA-Z0-9_./:-]+$/.test(value)) ? `[fixture text ${value.length} chars]` : value;
}

function shrinkData(type, data) {
  if (type === "thread/identity") return {};
  if (type === "provider.env-resolved") {
    return { entries: (data.entries ?? []).slice(0, 6).map((entry) => ({ name: "[env variable]", source: entry.source, value: "[fixture redacted]" })) };
  }
  if (type === "provider/unhandled") return { providerId: data.providerId, rawType: "[provider raw type]" };
  if (type === "thread/extensionState/updated") return { kind: data.kind, payload: null };
  if (type === "thread/contextWindowUsage/updated" && data.contextWindowUsage) {
    const { snapshot: _snapshot, ...usage } = data.contextWindowUsage;
    return { contextWindowUsage: usage };
  }
  if (type === "client/turn/requested") return scrub({ ...data, inputGroups: undefined });
  return scrub(data);
}

function windowFor(spec) {
  if (spec.from !== undefined) return [spec.from, spec.to];
  const placeholders = spec.around.map(() => "?").join(",");
  const params = [spec.threadId, ...spec.around];
  let sql = `SELECT min(sequence) AS lo, max(sequence) AS hi FROM events WHERE thread_id = ? AND type IN (${placeholders})`;
  if (spec.aroundItem) { sql += " AND item_id = ?"; params.push(spec.aroundItem); }
  const { lo, hi } = db.prepare(sql).get(...params);
  // Widen to the enclosing turns so waits and pairing stay intact.
  const first = db.prepare("SELECT max(sequence) AS seq FROM events WHERE thread_id = ? AND type = 'client/turn/requested' AND sequence <= ?").get(spec.threadId, lo).seq ?? lo;
  const last = db.prepare("SELECT min(sequence) AS seq FROM events WHERE thread_id = ? AND type = 'turn/completed' AND sequence >= ?").get(spec.threadId, hi).seq ?? hi;
  return [first, Math.min(last, first + 600)];
}

mkdirSync(outDir, { recursive: true });
for (const spec of SPECS) {
  const thread = db.prepare(`SELECT id, project_id, environment_id, provider_id, title, status, parent_thread_id, origin_kind, origin_plugin_id, created_at, updated_at
    FROM threads WHERE id = ?`).get(spec.threadId);
  if (!thread) { console.error(`skip ${spec.name}: thread missing`); continue; }
  const [from, to] = windowFor(spec);
  const rows = db.prepare(`SELECT id, scope_kind, turn_id, sequence, type, data, created_at FROM events
    WHERE thread_id = ? AND sequence BETWEEN ? AND ? ORDER BY sequence`).all(spec.threadId, from, to);
  const deltaSeen = new Set();
  const events = [];
  for (const row of rows) {
    const data = JSON.parse(row.data);
    if (DELTA_TYPES.has(row.type)) {
      // Keep the first delta per item: it marks first output.
      const key = `${row.turn_id}:${data.itemId}`;
      if (deltaSeen.has(key)) continue;
      deltaSeen.add(key);
    }
    events.push({
      id: row.id,
      threadId: thread.id,
      seq: row.sequence,
      type: row.type,
      scope: row.scope_kind === "turn" ? { kind: "turn", turnId: row.turn_id } : { kind: "thread" },
      createdAt: row.created_at,
      data: shrinkData(row.type, data),
    });
  }
  const fixture = {
    note: spec.note,
    source: { threadId: thread.id, fromSeq: from, toSeq: to, extractedEvents: rows.length, keptEvents: events.length },
    thread: {
      id: thread.id, projectId: thread.project_id, environmentId: thread.environment_id, providerId: thread.provider_id,
      title: `[fixture ${spec.name}]`, status: thread.status, parentThreadId: thread.parent_thread_id,
      originKind: thread.origin_kind, originPluginId: thread.origin_plugin_id, createdAt: thread.created_at, updatedAt: thread.updated_at,
    },
    events,
  };
  const text = `${JSON.stringify(fixture)}\n`;
  writeFileSync(new URL(`${spec.name}.json`, outDir), text);
  console.log(`${spec.name}: ${events.length}/${rows.length} events, ${(text.length / 1024).toFixed(1)} KiB`);
}
db.close();
