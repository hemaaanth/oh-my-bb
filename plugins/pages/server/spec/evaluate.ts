import { evaluate, type ASTNode, type ElementNode, type EvaluationContext, type ParseResult } from "@openuidev/lang-core";
import { mathRuntimeFunctions } from "../../app/spec/math.js";

export type ResolveQuery = (tool: string, args: Record<string, unknown>, id: string) => unknown;
/** Evaluate the native parser's tree without importing React or running component renderers. */
export function evaluateSpec(result: ParseResult, queries: ReadonlyMap<string, unknown> = new Map(), overrides: Record<string, unknown> = {}, resolveQuery?: ResolveQuery): { root: ElementNode | null; errors: string[] } {
  const errors: string[] = [];
  const states = { ...result.stateDeclarations, ...overrides };
  const reading = new Set<string>();
  const defaults = new Map<string, unknown>();
  const ctx: EvaluationContext = {
    functions: mathRuntimeFunctions,
    reportError: (message) => { if (errors.length < 16) errors.push(message); },
    getState: (name) => {
      if (reading.has(name)) throw new Error(`Circular state default ${name}.`);
      reading.add(name);
      try { return resolve(states[name]); } finally { reading.delete(name); }
    },
    resolveRef: (name) => {
      if (queries.has(name)) return queries.get(name);
      if (defaults.has(name)) return defaults.get(name);
      const query = result.queryStatements.find((query) => query.statementId === name);
      if (query && resolveQuery) {
        const tool = query.toolAST ? evaluate(query.toolAST, ctx) : null;
        const args = query.argsAST ? evaluate(query.argsAST, ctx) : {};
        if (typeof tool !== "string" || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Query has an invalid tool name or arguments.");
        const value = resolveQuery(tool, args as Record<string, unknown>, name);
        defaults.set(name, value);
        return value;
      }
      const value = query?.defaultsAST ? evaluate(query.defaultsAST, ctx) : null;
      defaults.set(name, value);
      return value;
    },
  };
  const resolve = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if ("k" in value && typeof value.k === "string") return evaluate(value as ASTNode, ctx, { library: { components: {} } });
    if (Array.isArray(value)) {
      let updated: unknown[] | undefined;
      for (let i = 0; i < value.length; i++) {
        const item = resolve(value[i]);
        if (item !== value[i] && !updated) updated = value.slice();
        if (updated) updated[i] = item;
      }
      return updated ?? value;
    }
    const record = value as Record<string, unknown>;
    let updated: Record<string, unknown> | undefined;
    for (const [name, child] of Object.entries(record)) {
      const resolved = resolve(child);
      if (resolved !== child && !updated) updated = { ...record };
      if (updated) updated[name] = resolved;
    }
    return updated ?? value;
  };
  try {
    const root = resolve(result.root ?? result.rootExpression);
    return { root: root && typeof root === "object" && "type" in root && root.type === "element" ? root as ElementNode : null, errors };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { root: null, errors };
  }
}

/** Components in a native parsed/evaluated tree, in reading order. */
export function specElements(value: unknown, out: ElementNode[] = []): ElementNode[] {
  if (Array.isArray(value)) for (const item of value) specElements(item, out);
  else if (value && typeof value === "object") {
    const node = value as Partial<ElementNode>;
    if (node.type === "element" && typeof node.typeName === "string" && node.props && typeof node.props === "object") {
      out.push(node as ElementNode);
      specElements(node.props, out);
    } else for (const item of Object.values(value)) specElements(item, out);
  }
  return out;
}

/** A literal value, or undefined when the node needs states, references, or expressions. */
export function literal(node: ASTNode | null): unknown {
  if (!node) return undefined;
  switch (node.k) {
    case "Str": case "Num": case "Bool": return node.v;
    case "Null": return null;
    case "Arr": { const values = node.els.map(literal); return values.includes(undefined) ? undefined : values; }
    case "Obj": { const entries = node.entries.map(([key, value]) => [key, literal(value)] as const); return entries.some(([, value]) => value === undefined) ? undefined : Object.fromEntries(entries); }
    default: return undefined;
  }
}
