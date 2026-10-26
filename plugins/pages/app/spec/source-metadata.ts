import type { ASTNode, ParseResult } from "@openuidev/lang-core";

const SOURCED: Record<string, true> = { Table: true, Chart: true, Stat: true };
const META = "__pagesSources";
const SOURCE_VALUE = "__pagesSource";

/** Decorate native dynamic props before asynchronous Query answers resolve.
 * Captions follow the resolved result, not a requested path that is still loading.
 * This changes no authored source, component argument order, or evaluator behavior.
 */
export function annotateSources(result: ParseResult | null): void {
  if (!result?.queryStatements.length) return;
  const paths = new Map<string, ASTNode>();
  for (const query of result.queryStatements) {
    paths.set(query.statementId, { k: "Member", obj: { k: "RuntimeRef", n: query.statementId, refType: "query" }, field: SOURCE_VALUE });
  }
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const node = value as { k?: string; type?: string; name?: string; typeName?: string; props?: Record<string, unknown>; mappedProps?: Record<string, unknown> };
    const name = node.type === "element" ? node.typeName : node.k === "Comp" ? node.name : undefined;
    const props = node.type === "element" ? node.props : node.mappedProps;
    if (name && SOURCED[name] && props && !Object.hasOwn(props, META)) {
      const reached = new Set<string>();
      const scanned = new WeakSet<object>();
      const collect = (part: unknown): void => {
        if (!part || typeof part !== "object" || scanned.has(part)) return;
        scanned.add(part);
        const ref = part as { k?: string; n?: string; refType?: string };
        if (ref.k === "RuntimeRef" && ref.refType === "query" && ref.n && paths.has(ref.n)) reached.add(ref.n);
        for (const [key, child] of Object.entries(part)) if (key !== META) collect(child);
      };
      collect(props);
      if (reached.size) props[META] = { k: "Arr", els: [...reached].map((name) => paths.get(name)!) } satisfies ASTNode;
    }
    for (const [key, child] of Object.entries(value)) if (key !== META) visit(child);
  };
  visit(result.root);
  visit(result.rootExpression);
}

/** Non-enumerable metadata leaves the file result's public fields and JSON unchanged. */
export function sourcedQuery(name: string, args: Record<string, unknown>, value: unknown): unknown {
  if (name !== "file" || typeof args.path !== "string" || !value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.defineProperty({ ...value }, SOURCE_VALUE, { value: args.path });
}
