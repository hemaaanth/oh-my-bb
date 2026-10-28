import { createHash } from "node:crypto";
import type { PromptCall, PromptResult, PromptSection, PromptTool, PromptUsage } from "./prompt-contract";

type RecordValue = Record<string, unknown>;
export type PromptReadInput = { threadId: string; provider: "claude-code" | "codex"; sessionId: string; call: number | null; reveal: boolean };
type Input = PromptReadInput;
type Scan = PromptResult["scan"];
const MAX_CALLS = 5_000;
const MAX_TOOLS = 100;
const MAX_INJECTED = 32;
const MAX_TEXT = 20_000;
const MAX_TOOL_TEXT = 2_000;
const MAX_SELECTED_TEXT = 160_000;
const LEDGER_RADIUS = 35;

const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const stamp = (value: unknown): number | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const identifier = (value: unknown): string | null => typeof value === "string" && /^[\w./:-]{1,120}$/.test(value) ? value : null;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const estimate = (chars: number) => Math.ceil(chars / 4); // A byte/character estimate, never reported as exact tokens.

function emptyUsage(): PromptUsage {
  return { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheWrite5mTokens: null,
    cacheWrite1hTokens: null, outputTokens: null, reasoningTokens: null };
}
function usageFromClaude(raw: unknown): PromptUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = object(raw); const cache = object(u.cache_creation); const output = object(u.output_tokens_details);
  return { inputTokens: number(u.input_tokens), cacheReadTokens: number(u.cache_read_input_tokens),
    cacheWriteTokens: number(u.cache_creation_input_tokens), cacheWrite5mTokens: number(cache.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: number(cache.ephemeral_1h_input_tokens), outputTokens: number(u.output_tokens),
    reasoningTokens: number(output.thinking_tokens) };
}
function usageFromCodex(raw: unknown): PromptUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = object(raw);
  return { inputTokens: number(u.input_tokens), cacheReadTokens: number(u.cached_input_tokens),
    cacheWriteTokens: number(u.cache_write_input_tokens), cacheWrite5mTokens: null, cacheWrite1hTokens: null,
    outputTokens: number(u.output_tokens), reasoningTokens: number(u.reasoning_output_tokens) };
}
function sumUsage(rows: readonly { usage: PromptUsage | null }[]): PromptUsage | null {
  if (!rows.some((row) => row.usage)) return null;
  const totals = emptyUsage();
  for (const row of rows) if (row.usage) for (const key of Object.keys(totals) as (keyof PromptUsage)[]) {
    const value = row.usage[key];
    if (value !== null) totals[key] = (totals[key] ?? 0) + value;
  }
  return totals;
}
function contextUsed(provider: Input["provider"], usage: PromptUsage | null): number | null {
  if (!usage) return null;
  if (provider === "codex") return usage.inputTokens;
  const values = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].filter((n): n is number => n !== null);
  return values.length ? values.reduce((sum, n) => sum + n, 0) : null;
}
function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  const texts = array(content).map((part) => typeof part === "string" ? part : string(object(part).text)).filter((value): value is string => value !== null);
  return texts.length ? texts.join("\n") : null;
}
function section(id: string, label: string, kind: PromptSection["kind"], original: string | null, reveal: boolean, budget: { remaining: number }, originalChars = original?.length ?? null): PromptSection {
  if (original === null) return { id, label, kind, chars: originalChars, estimatedTokens: originalChars === null ? null : estimate(originalChars), text: null, truncated: false };
  const count = Math.min(MAX_TEXT, budget.remaining);
  const text = reveal ? original.slice(0, count) : null;
  if (reveal) budget.remaining -= text!.length;
  return { id, label, kind, chars: originalChars, estimatedTokens: originalChars === null ? null : estimate(originalChars), text,
    truncated: originalChars !== null && originalChars > count };
}
function tool(value: unknown, reveal: boolean, budget: { remaining: number }): PromptTool {
  const raw = object(value);
  const name = identifier(raw.name) ?? "Unnamed tool";
  const description = string(raw.description);
  const schema = raw.input_schema ?? raw.inputSchema;
  const schemaText = schema === undefined ? null : JSON.stringify(schema);
  const chars = description === null && schemaText === null ? null : (description?.length ?? 0) + (schemaText?.length ?? 0);
  const descriptionLimit = Math.min(MAX_TOOL_TEXT, budget.remaining);
  const desc = reveal && description !== null ? description.slice(0, descriptionLimit) : null;
  if (desc !== null) budget.remaining -= desc.length;
  const schemaLimit = Math.min(MAX_TOOL_TEXT, budget.remaining);
  const spec = reveal && schemaText !== null ? schemaText.slice(0, schemaLimit) : null;
  if (spec !== null) budget.remaining -= spec.length;
  return { name, chars, estimatedTokens: chars === null ? null : estimate(chars), description: desc, schema: spec,
    truncated: (description !== null && description.length > descriptionLimit) || (schemaText !== null && schemaText.length > schemaLimit) };
}
function changed(previous: readonly string[], current: readonly string[]) {
  const before = new Set(previous); const after = new Set(current);
  return { added: current.filter((value) => !before.has(value)).slice(0, 30), removed: previous.filter((value) => !after.has(value)).slice(0, 30) };
}
function unavailable(input: Input, reason: string, scan: Scan): PromptResult {
  return { status: "unavailable", reason, threadId: input.threadId, provider: input.provider, sessionId: input.sessionId,
    callCount: 0, selectedIndex: null, selected: null, ledger: [], ledgerStart: 0, totals: null, scan };
}
function finish(input: Input, rows: PromptResult["ledger"], selected: PromptCall | null, scan: Scan): PromptResult {
  const index = input.call ?? rows.length;
  const start = Math.max(0, Math.min(rows.length, index - 1) - LEDGER_RADIUS);
  if (!selected) return { ...unavailable(input, scan.limited ? `Call ${input.call ?? "latest"} was not found in the bounded scan; the transcript may contain more records.`
    : input.call ? `Call ${input.call} is not stored in this transcript.` : "No API calls are stored in this transcript.", scan),
    callCount: rows.length, ledger: rows.slice(start, start + 2 * LEDGER_RADIUS + 1), ledgerStart: start + 1, totals: sumUsage(rows) };
  return { status: scan.limited ? "truncated" : "available", reason: scan.limited ? scan.oversizedLines > 0
    ? `${scan.oversizedLines} oversized transcript lines were skipped; some context may be missing.`
    : "The bounded transcript scan omitted records." : null,
    threadId: input.threadId, provider: input.provider, sessionId: input.sessionId, callCount: rows.length,
    selectedIndex: selected.index, selected, ledger: rows.slice(start, start + 2 * LEDGER_RADIUS + 1), ledgerStart: start + 1,
    totals: sumUsage(rows), scan };
}

type ClaudeRequest = { id: string; at: number | null; shapeHash: string | null; base: string | null; keep: number; tail: string[]; params: RecordValue };
type ClaudeShape = { system: unknown[]; tools: unknown[] };
type ClaudeResponse = { requestId: string | null; at: number | null; model: string | null; effort: string | null; usage: PromptUsage | null };

async function parseClaude(lines: AsyncIterable<string> | Iterable<string>, input: Input, scan: Scan): Promise<PromptResult> {
  const requests: ClaudeRequest[] = [];
  const shapes = new Map<string, ClaudeShape>();
  const blobs = new Map<string, { role: string | null; text: string | null; chars: number | null; itemKind: string | null }>();
  const answers = new Map<string, ClaudeResponse>();
  for await (const line of lines) {
    scan.linesRead++;
    if (!line.trimEnd().endsWith("}")) { scan.malformedLines++; continue; }
    if (!/"type"\s*:\s*"(?:api-request|api-request-shape|api-request-blob|assistant)"/.test(line)) continue;
    let value: RecordValue;
    try { value = object(JSON.parse(line)); } catch { scan.malformedLines++; continue; }
    if (value.type === "api-request" && requests.length < MAX_CALLS) {
      const id = identifier(value.id);
      if (!id) continue;
      const tail = array(value.tail).map(identifier).filter((v): v is string => v !== null);
      if (tail.length > 256 || (number(value.keep) ?? 0) > 256) scan.limited = true;
      requests.push({ id, at: stamp(value.timestamp), shapeHash: identifier(value.shapeHash), base: identifier(value.base),
        keep: Math.max(0, Math.min(256, number(value.keep) ?? 0)), tail: tail.slice(0, 256), params: object(value.params) });
    } else if (value.type === "api-request" && requests.length >= MAX_CALLS) scan.limited = true;
    else if (value.type === "api-request-shape") {
      const id = identifier(value.shapeHash); if (!id) continue;
      if (!shapes.has(id) && shapes.size >= 128) { scan.limited = true; continue; }
      const shape = object(value.shape);
      if (array(shape.system).length > 32 || array(shape.tools).length > MAX_TOOLS) scan.limited = true;
      shapes.set(id, { system: array(shape.system).slice(0, 32), tools: array(shape.tools).slice(0, MAX_TOOLS) });
    } else if (value.type === "api-request-blob") {
      const id = identifier(value.hash); if (!id) continue;
      if (!blobs.has(id) && blobs.size >= 512) { scan.limited = true; continue; }
      const message = object(value.message); const raw = contentText(message.content);
      const parts = array(message.content);
      const itemKind = parts.some((part) => object(part).type === "tool_result") ? "Tool result"
        : parts.some((part) => object(part).type === "tool_use") ? "Tool call" : null;
      blobs.set(id, { role: string(message.role), text: raw?.slice(0, 100_000) ?? null, chars: raw?.length ?? null, itemKind });
    } else if (value.type === "assistant") {
      const ref = identifier(value.requestRef); if (!ref) continue;
      const message = object(value.message);
      answers.set(ref, { requestId: identifier(value.requestId), at: stamp(value.timestamp), model: identifier(message.model),
        effort: identifier(value.effort), usage: usageFromClaude(message.usage) });
    }
  }
  const byId = new Map(requests.map((request) => [request.id, request]));
  const hashCache = new Map<string, string[]>();
  function messageHashes(request: ClaudeRequest, visited = new Set<string>()): string[] {
    const cached = hashCache.get(request.id); if (cached) return cached;
    if (visited.has(request.id) || visited.size > 128) { scan.limited = true; return request.tail; }
    visited.add(request.id);
    const prior = request.base ? byId.get(request.base) : null;
    const retained = prior ? messageHashes(prior, visited).slice(0, request.keep) : [];
    const all = [...retained, ...request.tail];
    if (all.length > 256) scan.limited = true;
    const result = all.slice(-256);
    hashCache.set(request.id, result);
    return result;
  }
  const rows = requests.map((request, i) => {
    const response = answers.get(request.id);
    return { index: i + 1, at: request.at, model: identifier(request.params.model) ?? response?.model ?? null,
      requestId: response?.requestId ?? null, turnId: null, durationMs: request.at !== null && response?.at != null ? Math.max(0, response.at - request.at) : null,
      usage: response?.usage ?? null };
  });
  const index = input.call ?? rows.length;
  const request = requests[index - 1];
  if (!request) return finish(input, rows, null, scan);
  const row = rows[index - 1]!;
  const budget = { remaining: MAX_SELECTED_TEXT };
  const shape = request.shapeHash ? shapes.get(request.shapeHash) : null;
  const system = shape ? shape.system.map((block, i) => section(`system-${i + 1}`, `System block ${i + 1}`, "system", string(object(block).text), input.reveal, budget)) : [];
  const tools = shape ? shape.tools.map((entry) => tool(entry, input.reveal, budget)) : [];
  const ids = messageHashes(request);
  const injected: PromptSection[] = [];
  for (const id of ids) {
    const blob = blobs.get(id);
    if (!blob) continue;
    const hasInjectedReminder = /<system-reminder|<system_instructions|\[redacted system-reminder/i.test(blob.text ?? "");
    if (blob.role !== "system" && blob.role !== "developer" && !hasInjectedReminder) continue;
    if (injected.length >= MAX_INJECTED) { scan.limited = true; break; }
    const label = /AGENTS\.md/i.test(blob.text ?? "") ? "AGENTS.md · prompt block" : /\bskills?\b/i.test(blob.text ?? "") ? "Skills · prompt block" : `${blob.role ?? "prompt"} block`;
    injected.push(section(id.slice(0, 12), label, "injected", blob.text, input.reveal, budget, blob.chars));
  }
  const previous = requests[index - 2];
  const previousShape = previous?.shapeHash ? shapes.get(previous.shapeHash) : null;
  const previousNames = previousShape?.tools.map((entry) => identifier(object(entry).name) ?? "Unnamed tool") ?? [];
  const currentNames = tools.map((entry) => entry.name);
  const toolDiff = changed(previousNames, currentNames);
  const previousIds = previous ? messageHashes(previous).filter((id) => blobs.has(id)) : [];
  const injectedDiff = changed(previousIds, ids.filter((id) => blobs.has(id)));
  const labelFor = (id: string) => {
    const blob = blobs.get(id); if (!blob) return "Prompt block";
    return blob.itemKind ?? (/AGENTS\.md/i.test(blob.text ?? "") ? "AGENTS.md" : /\bskills?\b/i.test(blob.text ?? "") ? "Skills" : `${blob.role ?? "Prompt"} block`);
  };
  const thinking = object(request.params.thinking);
  const selected: PromptCall = { ...row, system, tools, injected,
    contextUsedTokens: contextUsed("claude-code", row.usage), contextWindowTokens: null,
    params: { maxTokens: number(request.params.max_tokens), thinking: identifier(thinking.type), effort: answers.get(request.id)?.effort ?? null },
    diff: { previousCall: previous ? index - 1 : null,
      systemChanged: previous ? JSON.stringify(previousShape?.system ?? null) !== JSON.stringify(shape?.system ?? null) : null,
      modelChanged: previous ? previous.params.model !== request.params.model : null,
      toolsAdded: toolDiff.added, toolsRemoved: toolDiff.removed,
      injectedAdded: injectedDiff.added.map(labelFor), injectedRemoved: injectedDiff.removed.map(labelFor) } };
  return finish(input, rows, selected, scan);
}

type CodexCall = PromptResult["ledger"][number] & { docs: Array<{ id: string; label: string; text: string; chars: number }> | null; effort: string | null; window: number | null;
  docIds: string[]; baseText: string | null; baseTools: unknown[] | null; baseHash: string | null; toolNames: string[] };
async function parseCodex(lines: AsyncIterable<string> | Iterable<string>, input: Input, scan: Scan): Promise<PromptResult> {
  const calls: CodexCall[] = [];
  let baseText: string | null = null;
  let baseTools: unknown[] = [];
  let baseHash: string | null = null;
  let toolNames: string[] = [];
  let window: number | null = null;
  let currentTurn: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  let docs: Array<{ id: string; label: string; text: string; chars: number }> = [];
  for await (const line of lines) {
    scan.linesRead++;
    if (!line.trimEnd().endsWith("}")) { scan.malformedLines++; continue; }
    const relevant = /"type"\s*:\s*"(?:session_meta|turn_context|token_usage_record)"/.test(line)
      || (/"type"\s*:\s*"event_msg"/.test(line) && /"type"\s*:\s*"task_started"/.test(line));
    const developer = /"type"\s*:\s*"response_item"/.test(line) && /"role"\s*:\s*"(?:developer|system)"/.test(line);
    if (!relevant && !developer) continue;
    let value: RecordValue;
    try { value = object(JSON.parse(line)); } catch { scan.malformedLines++; continue; }
    const payload = object(value.payload);
    if (value.type === "session_meta") {
      baseText = string(object(payload.base_instructions).text);
      if (array(payload.dynamic_tools).length > MAX_TOOLS) scan.limited = true;
      baseTools = array(payload.dynamic_tools).slice(0, MAX_TOOLS);
      baseHash = baseText === null ? null : hash(baseText);
      toolNames = baseTools.map((entry) => identifier(object(entry).name) ?? "Unnamed tool");
      window = number(payload.context_window);
    } else if (value.type === "event_msg" && payload.type === "task_started") {
      const id = identifier(payload.turn_id);
      if (id !== currentTurn) { currentTurn = id; docs = []; }
      window = number(payload.model_context_window);
    } else if (value.type === "turn_context") {
      const id = identifier(payload.turn_id);
      if (id !== currentTurn) { currentTurn = id; docs = []; }
      model = identifier(payload.model); effort = identifier(payload.effort);
      window = number(payload.model_context_window) ?? window;
    } else if (developer) {
      const text = contentText(payload.content);
      if (text && docs.length >= MAX_INJECTED) scan.limited = true;
      if (text && docs.length < MAX_INJECTED) {
        const role = identifier(payload.role) ?? "developer";
        const label = /AGENTS\.md/i.test(text) ? "AGENTS.md · developer context" : /\bskills?\b/i.test(text) ? "Skills · developer context" : `${role} context`;
        docs = [...docs, { id: hash(text), label, text: text.slice(0, 100_000), chars: text.length }];
      }
    } else if (value.type === "token_usage_record") {
      if (calls.length >= MAX_CALLS) { scan.limited = true; continue; }
      const turnId = identifier(payload.turn_id);
      const sameTurn = turnId === currentTurn;
      const usage = usageFromCodex(payload.usage);
      const selected = input.call === null || input.call === calls.length + 1;
      calls.push({ index: calls.length + 1, at: stamp(value.timestamp), model: sameTurn ? model : null,
        requestId: identifier(payload.response_id), turnId, durationMs: null, usage,
        docs: selected && sameTurn ? docs : null, effort: sameTurn ? effort : null,
        window: sameTurn ? window : null, docIds: sameTurn ? docs.map((doc) => doc.id) : [],
        baseText: selected ? baseText : null, baseTools: selected ? baseTools : null, baseHash, toolNames });
    }
  }
  const rows = calls.map(({ docs: _docs, effort: _effort, window: _window, docIds: _docIds, baseText: _baseText, baseTools: _baseTools, baseHash: _baseHash, toolNames: _toolNames, ...row }) => row);
  const index = input.call ?? rows.length;
  const call = calls[index - 1];
  if (!call) return finish(input, rows, null, scan);
  const previous = calls[index - 2];
  const budget = { remaining: MAX_SELECTED_TEXT };
  const system = [section("base", "Base instructions", "system", call.baseText, input.reveal, budget)];
  const tools = (call.baseTools ?? []).map((entry) => tool(entry, input.reveal, budget));
  const injected = (call.docs ?? []).map((doc) => section(doc.id, doc.label, "developer", doc.text, input.reveal, budget, doc.chars));
  const docDiff = changed(previous?.docIds ?? [], call.docIds);
  const toolDiff = changed(previous?.toolNames ?? [], call.toolNames);
  const docLabel = (id: string) => (call.docs ?? []).find((doc) => doc.id === id)?.label ?? "Developer context changed";
  const selected: PromptCall = { ...rows[index - 1]!, system, tools, injected,
    contextUsedTokens: contextUsed("codex", call.usage), contextWindowTokens: call.window,
    params: { maxTokens: null, thinking: null, effort: call.effort },
    diff: { previousCall: previous ? index - 1 : null, systemChanged: previous && previous.baseHash !== null && call.baseHash !== null ? previous.baseHash !== call.baseHash : null,
      modelChanged: previous ? previous.model !== call.model : null, toolsAdded: toolDiff.added, toolsRemoved: toolDiff.removed,
      injectedAdded: docDiff.added.map(docLabel), injectedRemoved: docDiff.removed.map(docLabel) } };
  return finish(input, rows, selected, scan);
}

export async function parseProviderTranscript(lines: AsyncIterable<string> | Iterable<string>, input: Input, scan: Scan): Promise<PromptResult> {
  return input.provider === "claude-code" ? parseClaude(lines, input, scan) : parseCodex(lines, input, scan);
}
export function missingTranscript(input: Input, scan: Scan): PromptResult {
  return unavailable(input, "Transcript not found on the thread's execution host.", scan);
}
