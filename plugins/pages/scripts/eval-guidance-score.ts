import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { checkSource } from "../server/spec/authoring.js";
import { parseCheckedSpec } from "../server/spec/check.js";
import { evaluateSpec, literal, specElements } from "../server/spec/evaluate.js";
import { runTool } from "../server/spec/data.js";
import { sourcedQuery } from "../app/spec/source-metadata.js";

export interface GuidanceCase {
  id: string; category: string; request: string; evidence: string;
  families: string[][]; negative?: boolean; fixtures?: Record<string, string>; dryReply: string;
}
export interface Fence { code: string; complete: boolean }
export interface GuidanceScore {
  id: string; category: string; hasFence: boolean; validFences: boolean; fittingComponent: boolean;
  pass: boolean; components: string[]; diagnostics: string[]; processFailure?: string;
}
/** Markdown fences are line-delimited; longer delimiters may contain shorter fences. */
export function extractOpenUiFences(reply: string): Fence[] {
  const found: Fence[] = [];
  let active: { delimiter: string; size: number; openui: boolean; lines: string[] } | undefined;
  for (const line of reply.split(/\r?\n/)) {
    if (!active) {
      const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
      if (!match || (match[1]![0] === "`" && match[2]!.includes("`"))) continue;
      active = { delimiter: match[1]![0]!, size: match[1]!.length, openui: match[2]!.trim() === "openui-lang", lines: [] };
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === active.delimiter && close[1]!.length >= active.size) {
        if (active.openui) found.push({ code: active.lines.join("\n"), complete: true });
        active = undefined;
      } else active.lines.push(line);
    }
  }
  if (active?.openui) found.push({ code: active.lines.join("\n"), complete: false });
  return found;
}

export async function scoreGuidanceReply(test: GuidanceCase, reply: string, processFailure?: string): Promise<GuidanceScore> {
  const fences = extractOpenUiFences(reply);
  const diagnostics: string[] = [];
  const components = new Set<string>();
  const files = test.fixtures ?? {};
  const { bb, harness } = createFakePluginHost({ pluginId: "pages", sdk: {
    threads: {
      get: async () => ({ id: "thr_eval", projectId: "proj_eval", environment: { id: "env_eval", path: "/eval", hostId: "host_eval" } }),
      storageLocation: async () => ({ hostId: "host_eval", storageRootPath: "/eval-storage" }),
    },
    files: { read: async ({ path }) => {
      if (!Object.hasOwn(files, path)) throw new Error(`Unknown eval fixture ${path}`);
      const content = files[path]!;
      return { path, content, contentEncoding: "utf8", sizeBytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
    } },
  } });
  try {
    for (const [index, fence] of fences.entries()) {
      if (!fence.complete) { diagnostics.push(`Fence ${index + 1}: incomplete delimiter`); continue; }
      try {
        const parsed = parseCheckedSpec(fence.code);
        // Never count dynamic/default data as observed evidence, or touch other services.
        if (parsed.queryStatements.length > 16) throw new Error("More than 16 eval Query sources");
        const queries = new Map<string, unknown>();
        for (const query of parsed.queryStatements) {
          const tool = literal(query.toolAST), args = literal(query.argsAST);
          if (tool !== "file" || !args || typeof args !== "object" || !("path" in args) || typeof args.path !== "string" || !Object.hasOwn(files, args.path)) throw new Error("Only explicit case fixture Query(file) reads are allowed");
          queries.set(query.statementId, sourcedQuery(tool, { path: args.path }, await runTool(bb, { threadId: "thr_eval", tool, args: { path: args.path } })));
        }
        const checked = await checkSource(bb, "thr_eval", fence.code, "openui-lang");
        if (!checked.ok || checked.language !== "openui-lang" || checked.issues.some(issue => issue.kind === "probe")) {
          diagnostics.push(`Fence ${index + 1}: ${JSON.stringify(checked.issues)}`); continue;
        }
        const evaluated = evaluateSpec(parsed, queries);
        if (!evaluated.root || evaluated.errors.length) throw new Error(evaluated.errors.join("; ") || "No rendered root");
        for (const node of specElements(evaluated.root)) components.add(node.typeName);
      } catch (error) { diagnostics.push(`Fence ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  } finally { await harness.lifecycle.dispose(); }
  const hasFence = fences.length > 0;
  const validFences = hasFence && diagnostics.length === 0;
  const fittingComponent = test.families.every(family => family.some(name => components.has(name)));
  const pass = !processFailure && (test.negative ? !hasFence : hasFence && validFences && fittingComponent);
  return { id: test.id, category: test.category, hasFence, validFences, fittingComponent, pass, components: [...components], diagnostics, ...(processFailure ? { processFailure } : {}) };
}
export function summarizeGuidanceRun(rows: Array<GuidanceScore & { variant: string }>) {
  const variants: Record<string, { total: number; passed: number; categories: Record<string, { total: number; passed: number }>; components: Record<string, number> }> = {};
  for (const row of rows) {
    const variant = variants[row.variant] ??= { total: 0, passed: 0, categories: {}, components: {} };
    variant.total++; variant.passed += Number(row.pass);
    const category = variant.categories[row.category] ??= { total: 0, passed: 0 };
    category.total++; category.passed += Number(row.pass);
    for (const name of row.components) variant.components[name] = (variant.components[name] ?? 0) + 1;
  }
  const baseline = variants.baseline, candidate = variants.new;
  return { caveat: "Component fit is a structural heuristic, not semantic correctness. Tool-free eval does not prove BB delivery, rendering or workflows.", variants, delta: baseline && candidate ? { passed: candidate.passed - baseline.passed, passRate: candidate.passed / candidate.total - baseline.passed / baseline.total } : null };
}
