import type { TraceResult, TraceSpan } from "./spans";

// Default output never contains event payloads. They can hold arbitrary tokens,
// including secrets with no recognizable prefix, so regex-only masking cannot
// be a security boundary. Reveal is an explicit request at the RPC/CLI edge.
const HIDDEN = "[hidden; use Reveal in the UI or --reveal in the CLI]";
const TOKEN = /(?:sk-[\w-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}|(?:[A-Za-z][\w-]*(?:key|token|secret|password)[\w-]*\s*[=:]\s*)[^\s,;]+)/gi;

function safeLabel(label: string): string {
  return label.replace(TOKEN, "[redacted]").slice(0, 160);
}
function safeName(kind: string, name: string, id: string): string {
  if (kind === "thread") return `Thread ${id.slice("thread:".length)}`;
  if (kind === "fileRead") return "File read";
  if (kind === "delegation") return "Delegation";
  if (kind === "backgroundTask") return "Background task";
  return safeLabel(name);
}

function hide(span: TraceSpan): TraceSpan {
  const usage = span.usage && typeof span.usage === "object" ? span.usage as Record<string, unknown> : null;
  const context = span.contextUsage && typeof span.contextUsage === "object" ? span.contextUsage as Record<string, unknown> : null;
  return {
    ...span,
    name: safeName(span.kind, span.name, span.id),
    error: span.error ? HIDDEN : null,
    metadata: { ...span.metadata, environment: span.metadata.environment?.startsWith("worktree") ? "worktree" : span.metadata.environment?.startsWith("environment") ? "environment" : span.metadata.environment && /^env_[a-z0-9]{8,20}$/.test(span.metadata.environment) ? span.metadata.environment : span.metadata.environment ? "[environment hidden]" : null },
    input: span.input === null ? null : HIDDEN,
    output: span.output === null ? null : HIDDEN,
    // The numeric usage fields are safe; snapshots can include prompt sections.
    usage: usage ? { total: usage.total, last: usage.last, modelContextWindow: usage.modelContextWindow } : null,
    contextUsage: context ? { usedTokens: context.usedTokens, modelContextWindow: context.modelContextWindow, estimated: context.estimated } : null,
    children: span.children.map(hide),
  };
}

export function presentTrace(result: TraceResult, reveal: boolean): TraceResult {
  if (reveal) return result;
  return {
    ...result,
    tree: hide(result.tree),
    summary: {
      ...result.summary,
      slowest: result.summary.slowest.map((s) => ({ ...s, name: safeName(s.kind, s.name, s.id) })),
      errors: result.summary.errors.map((e) => ({ ...e, name: safeName(e.kind, e.name, e.id), error: e.error ? HIDDEN : null })),
    },
  };
}
