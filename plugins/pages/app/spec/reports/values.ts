import type { Value } from "./types.js";
/** Report objects exclude renderer-owned node, action, binding, and function records. */
export function isPlainObject(value: Value): value is { readonly [key: string]: Value } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !("kind" in value && (value.kind === "node" || value.kind === "action" || value.kind === "binding" || value.kind === "function"));
}
