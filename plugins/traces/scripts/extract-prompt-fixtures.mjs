#!/usr/bin/env node
// Regenerate small shape-preserving fixtures from existing provider JSONL.
// No original prompt text, tool schema, tool output, path, key or secret is saved.
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
const cases = [
  { provider: "claude", session: "c0b4f488-91b5-4306-8fbc-a13f76725dba", thread: "thr_kxvdvw5nsh" },
  { provider: "codex", session: "01a17b8a-d681-7962-a989-093329e58e6e", thread: "thr_mtpqihzx7a" },
];
const safe = (value) => typeof value === "string" && /^[a-zA-Z0-9_./:-]{1,90}$/.test(value) ? value : "[redacted]";
const marker = (value) => {
  const text = typeof value === "string" ? value : "";
  const label = /AGENTS\.md/i.test(text) ? "AGENTS.md" : /\bskills?\b/i.test(text) ? "skills" : "prompt";
  return `[redacted ${/<system-reminder|<system_instructions/i.test(text) ? "system-reminder " : ""}${label} content; ${text.length} original chars]`;
};
const usage = (value) => value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, v]) =>
  [key, typeof v === "number" ? v : v && typeof v === "object" ? usage(v) : null])) : value;

for (const spec of cases) {
  const pattern = spec.provider === "claude"
    ? `${HOME}/.claude/projects/*/${spec.session}.jsonl`
    : `${HOME}/.codex/sessions/*/*/*/rollout-*-${spec.session}.jsonl`;
  const [path] = globSync(pattern);
  if (!path) throw new Error(`No ${spec.provider} transcript for ${spec.thread}`);
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const out = [];
  if (spec.provider === "claude") {
    const requests = rows.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((r) => r && r.type === "api-request").slice(0, 2);
    const refs = new Set(requests.map((r) => r.id));
    const shapeHashes = new Set(requests.map((r) => r.shapeHash));
    const blobHashes = new Set(requests.flatMap((r) => r.tail ?? []));
    for (const line of rows) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type === "api-request-shape" && shapeHashes.has(r.shapeHash)) out.push({ type: r.type, shapeHash: r.shapeHash, timestamp: r.timestamp,
        shape: { system: (r.shape?.system ?? []).map((b) => ({ type: safe(b.type), text: marker(b.text) })),
          tools: (r.shape?.tools ?? []).slice(0, 20).map((t) => ({ name: safe(t.name), description: marker(t.description), input_schema: { type: "object", properties: {} } })) } });
      if (r.type === "api-request-blob" && blobHashes.has(r.hash)) out.push({ type: r.type, hash: r.hash,
        message: { role: safe(r.message?.role), content: (r.message?.content ?? []).map((b) => typeof b === "string" ? marker(b) : ({ type: safe(b.type), text: marker(b.text) })) } });
      if (r.type === "api-request" && refs.has(r.id)) out.push({ type: r.type, id: r.id, timestamp: r.timestamp, shapeHash: r.shapeHash,
        base: r.base ?? null, keep: r.keep ?? 0, tail: r.tail ?? [], params: { model: safe(r.params?.model), max_tokens: r.params?.max_tokens ?? null,
          thinking: { type: safe(r.params?.thinking?.type) } } });
      if (r.type === "assistant" && refs.has(r.requestRef)) out.push({ type: r.type, timestamp: r.timestamp, requestRef: r.requestRef,
        requestId: safe(r.requestId), effort: safe(r.effort), message: { model: safe(r.message?.model), usage: usage(r.message?.usage) } });
    }
  } else {
    let tokens = 0;
    for (const line of rows) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      const p = r.payload ?? {};
      if (r.type === "session_meta") out.push({ type: r.type, timestamp: r.timestamp, payload: {
        base_instructions: { text: marker(p.base_instructions?.text) }, context_window: p.context_window?.model_context_window ?? null,
        dynamic_tools: (p.dynamic_tools ?? []).slice(0, 80).map((t) => ({ name: safe(t.name), description: marker(t.description), inputSchema: { type: "object", properties: {} } })) } });
      if (r.type === "event_msg" && p.type === "task_started") out.push({ type: r.type, timestamp: r.timestamp,
        payload: { type: "task_started", turn_id: p.turn_id, model_context_window: p.model_context_window ?? null } });
      if (r.type === "turn_context") out.push({ type: r.type, timestamp: r.timestamp,
        payload: { turn_id: p.turn_id, model: safe(p.model), effort: safe(p.effort) } });
      if (r.type === "response_item" && (p.role === "developer" || p.role === "system")) out.push({ type: r.type, timestamp: r.timestamp,
        payload: { type: "message", role: p.role, content: (p.content ?? []).map((b) => ({ type: safe(b.type), text: marker(b.text) })) } });
      if (r.type === "token_usage_record") {
        out.push({ type: r.type, timestamp: r.timestamp, payload: { turn_id: p.turn_id, response_id: p.response_id, usage: usage(p.usage) } });
        if (++tokens >= 4) break;
      }
    }
  }
  const target = new URL(`../fixtures/prompt-${spec.provider}.jsonl`, import.meta.url);
  writeFileSync(target, out.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(`${spec.provider}: ${out.length} records, ${out.filter((r) => r.type === "token_usage_record" || r.type === "api-request").length} calls`);
}
