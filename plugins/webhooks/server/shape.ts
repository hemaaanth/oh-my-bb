// Payload parsing and field extraction. The body must be one JSON object, or for
// Slack endpoints a form (slash commands) or a form with one `payload` JSON field
// (interactivity). Only declared fields leave this module; everything else in the body is dropped.
// Issues name the field and the problem, never the value.
import { LIMITS, type FieldSpec } from "../contract.js";

export type FieldValue = string | number | boolean | null;
export type FieldValues = Record<string, FieldValue>;
export type ShapeIssue = { field: string; problem: string };
export type ParseResult = { ok: true; payload: Record<string, unknown> } | { ok: false; problem: string };
export type ExtractResult = { ok: true; values: FieldValues } | { ok: false; issues: ShapeIssue[] };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function parsePayload(body: Uint8Array): ParseResult {
  const text = decode(body);
  return text === null ? { ok: false, problem: "The body is not valid UTF-8." } : parseJsonObject(text);
}

/**
 * An `application/x-www-form-urlencoded` body as Slack sends it. Each key becomes a
 * string field. A form whose only key is `payload` is a Slack interaction, and its
 * value is parsed as the JSON body instead.
 */
export function parseFormPayload(body: Uint8Array): ParseResult & { interactive?: boolean } {
  const text = decode(body);
  if (text === null) return { ok: false, problem: "The body is not valid UTF-8." };
  const entries = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(text)) {
    if (entries.has(key)) return { ok: false, problem: "The form repeats a key." };
    entries.set(key, value);
  }
  if (entries.size === 1 && entries.has("payload")) return { ...parseJsonObject(entries.get("payload")!), interactive: true };
  // fromEntries defines own properties, so a `__proto__` key stays plain data.
  return { ok: true, payload: Object.fromEntries(entries) };
}

function decode(body: Uint8Array): string | null {
  try {
    return utf8.decode(body);
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): ParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, problem: "The body is not valid JSON." };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, problem: "The body must be a JSON object." };
  if (depthOf(payload) > LIMITS.jsonDepth) return { ok: false, problem: `The body nests deeper than ${LIMITS.jsonDepth} levels.` };
  return { ok: true, payload: payload as Record<string, unknown> };
}

export function extractFields(payload: Record<string, unknown>, fields: readonly FieldSpec[]): ExtractResult {
  const values: FieldValues = {};
  const issues: ShapeIssue[] = [];
  for (const field of fields) {
    const raw = resolvePath(payload, field.path);
    if (raw === undefined || raw === null) {
      if (field.required) issues.push({ field: field.name, problem: "is required" });
      values[field.name] = null;
      continue;
    }
    const problem = checkValue(field, raw);
    if (problem) issues.push({ field: field.name, problem });
    else values[field.name] = raw as FieldValue;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, values };
}

function checkValue(field: FieldSpec, value: unknown): string | null {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return "must be a string";
      const max = field.maxLength ?? LIMITS.stringDefaultMaxLength;
      if (value.length > max) return `must be at most ${max} characters`;
      if (field.allowed && !field.allowed.includes(value)) return "is not an allowed value";
      return null;
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "must be a number";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) ? null : "must be an integer";
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
  }
}

/** Walks own properties only, so `__proto__` or `constructor` never reach the prototype. */
export function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function depthOf(value: unknown): number {
  // Iterative, so a hostile body cannot overflow the stack.
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > max) max = depth;
    if (max > LIMITS.jsonDepth) return max;
    for (const child of Object.values(node as object)) stack.push([child, depth + 1]);
  }
  return max;
}
