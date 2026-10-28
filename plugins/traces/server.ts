import { cliCommand, defineCli, defineRpcContract, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildTrace, type TraceEvent, type TraceResult, type TraceThread, type TraceSpan } from "./spans";
import { presentTrace } from "./redact";
import { promptHostContract, promptResultSchema, type PromptResult } from "./prompt-contract";
import { presentPrompt } from "./prompt-redact";
import { registerFleet } from "./fleet-server";
import { fleetCliCommands } from "./fleet-cli";

const MAX_CLI_BYTES = 1_000_000;
const PAGE_SIZE = "100"; // BB's events.list maximum is 100.
const CACHE_LIMIT = 5;
const CHANNEL = "traces-changed";

export const rpcContract = defineRpcContract({
  traces_thread: {
    input: z.object({ threadId: z.string().min(1), includeChildren: z.boolean().default(false), reveal: z.boolean().default(false) }),
    output: z.custom<TraceResult>(),
  },
  traces_prompt: {
    input: z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/), call: z.number().int().min(1).max(100_000).nullable().default(null), reveal: z.boolean().default(false) }).strict(),
    output: promptResultSchema,
  },
});

type CacheEntry = { result: TraceResult; dependencies: Set<string> };

export default function plugin(bb: BbPluginApi) {
  const cache = new Map<string, CacheEntry>();
  const promptHost = bb.hosts.experimental_client({ contract: promptHostContract });
  const fleet = registerFleet(bb);
  let epoch = 0;

  async function readEvents(threadId: string): Promise<TraceEvent[]> {
    const rows: TraceEvent[] = [];
    let afterSeq = "0";
    while (true) {
      const page = await bb.sdk.threads.events.list({ threadId, afterSeq, limit: PAGE_SIZE, order: "asc" });
      rows.push(...page as TraceEvent[]);
      if (page.length < Number(PAGE_SIZE)) break;
      const next = page.at(-1)!.seq.toString();
      if (next === afterSeq) throw new Error(`events.list did not advance for ${threadId}`);
      afterSeq = next;
    }
    return rows;
  }

  async function readTree(threadId: string, includeChildren: boolean, visited: Set<string>, deps: Set<string>): Promise<TraceResult> {
    if (visited.has(threadId)) throw new Error(`Thread parent cycle at ${threadId}`);
    visited.add(threadId); deps.add(threadId);
    const response = await bb.sdk.threads.get({ threadId });
    const thread: TraceThread = { id: response.id, title: response.title, providerId: response.providerId,
      environmentId: response.environmentId, parentThreadId: response.parentThreadId,
      createdAt: response.createdAt, updatedAt: response.updatedAt, status: response.status,
      originKind: response.originKind, originPluginId: response.originPluginId };
    if (response.environmentId) {
      try {
        const env = await bb.sdk.environments.get({ environmentId: response.environmentId });
        thread.environmentLabel = `${env.isWorktree ? "worktree" : "environment"} · ${env.branchName ?? env.name ?? env.path}`;
      } catch { /* The environment may have been removed; preserve its ID. */ }
    }
    const events = await readEvents(threadId);
    const descendants: TraceResult[] = [];
    if (includeChildren) {
      let offset = 0;
      while (true) {
        const page = await bb.sdk.threads.list({ parentThreadId: threadId, limit: 100, offset, includeHidden: true });
        for (const child of page) {
          if (visited.has(child.id)) continue;
          descendants.push(await readTree(child.id, true, visited, deps));
        }
        if (page.length < 100) break;
        offset += page.length;
      }
      // Some delegations point at a BB child ID even without parent_thread_id.
      // Provider-specific childRef values are not resolvable by the SDK.
      for (const event of events) {
        if (event.type !== "item/started") continue;
        const item = event.data.item;
        if (!item || typeof item !== "object" || !("type" in item) || item.type !== "delegation" || !("childRef" in item)) continue;
        const ref = item.childRef;
        if (typeof ref !== "string" || !/^thr_[a-z0-9]+$/.test(ref) || visited.has(ref)) continue;
        try { await bb.sdk.threads.get({ threadId: ref }); }
        catch { continue; }
        descendants.push(await readTree(ref, true, visited, deps));
      }
    }
    return buildTrace(thread, events, descendants);
  }

  async function trace(threadId: string, includeChildren: boolean, reveal: boolean): Promise<TraceResult> {
    const cacheKey = `${threadId}:${includeChildren}`;
    let cached = cache.get(cacheKey);
    if (!cached) {
      let started = epoch;
      let dependencies = new Set<string>();
      let result = await readTree(threadId, includeChildren, new Set(), dependencies);
      if (epoch !== started) {
        started = epoch;
        dependencies = new Set<string>();
        result = await readTree(threadId, includeChildren, new Set(), dependencies);
      }
      // If activity continued during both reads, return the latest tree but
      // do not cache it. The next event signal will trigger another read.
      if (epoch !== started) return presentTrace(result, reveal);
      cached = { result, dependencies };
      cache.set(cacheKey, cached);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    } else {
      cache.delete(cacheKey); cache.set(cacheKey, cached);
    }
    return presentTrace(cached.result, reveal);
  }
  function emptyPrompt(threadId: string, provider: string, status: PromptResult["status"], reason: string, sessionId: string | null = null): PromptResult {
    return { status, reason, threadId, provider, sessionId, callCount: 0, selectedIndex: null, selected: null,
      ledger: [], ledgerStart: 0, totals: null,
      scan: { bytesRead: 0, linesRead: 0, malformedLines: 0, oversizedLines: 0, limited: false } };
  }
  async function prompt(threadId: string, call: number | null, reveal: boolean): Promise<PromptResult> {
    const thread = await bb.sdk.threads.get({ threadId });
    const provider = thread.providerId;
    if (provider !== "claude-code" && provider !== "codex")
      return emptyPrompt(threadId, provider, "unsupported", `Provider ${provider} has no supported transcript parser.`);
    const identity = await bb.sdk.threads.events.list({ threadId, types: ["thread/identity"], order: "desc", limit: "1" });
    const sessionId = identity[0]?.type === "thread/identity" ? identity[0].data.providerThreadId : null;
    if (!sessionId || !/^[a-f0-9-]{36}$/i.test(sessionId))
      return emptyPrompt(threadId, provider, "unavailable", "No provider session ID is stored for this thread.");
    let hostId: string | null;
    if (thread.environmentId) {
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      hostId = environment.hostId;
    } else hostId = (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) return emptyPrompt(threadId, provider, "unavailable", "The thread's execution host cannot be resolved.", sessionId);
    try {
      const result = await promptHost.call("promptRead", { threadId, provider, sessionId, call, reveal }, { hostId, timeoutMs: 90_000 });
      return presentPrompt(result, reveal);
    } catch {
      // Do not expose host errors: paths and parser input can include secrets.
      return emptyPrompt(threadId, provider, "unavailable", "The transcript host is unavailable or the read failed.", sessionId);
    }
  }
  function invalidate(ids: readonly (string | null)[], threadId: string, parentThreadId: string | null) {
    epoch++;
    for (const [cacheKey, entry] of cache) if (ids.some((id) => id !== null && entry.dependencies.has(id))) cache.delete(cacheKey);
    bb.realtime.publish(CHANNEL, { threadId, parentThreadId });
  }

  bb.events.on("experimental_thread.events", ({ thread }) => invalidate([thread.id], thread.id, thread.parentThreadId));
  bb.events.on("thread.created", ({ thread }) => invalidate([thread.parentThreadId], thread.id, thread.parentThreadId));
  bb.events.on("thread.deleted", ({ thread }) => invalidate([thread.id, thread.parentThreadId], thread.id, thread.parentThreadId));
  bb.events.on("experimental_thread.parentChanged", ({ thread, previousParentThreadId }) =>
    invalidate([thread.id, previousParentThreadId, thread.parentThreadId], thread.id, thread.parentThreadId));
  bb.rpc.register(rpcContract, { traces_thread: ({ threadId, includeChildren, reveal }) => trace(threadId, includeChildren, reveal),
    traces_prompt: ({ threadId, call, reveal }) => prompt(threadId, call, reveal) });

  function formatMs(ms: number | null) {
    if (ms === null) return "open";
    return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
  }
  function formatTree(result: TraceResult, reveal: boolean): string {
    const lines: string[] = [];
    const { tree, summary } = result;
    lines.push(`Trace: ${tree.name} [${tree.threadId}] · ${formatMs(tree.durationMs)} · ${tree.metadata.provider}`);
    lines.push(`Time: ${Object.entries(summary.timeMs).sort((a, b) => b[1] - a[1]).map(([kind, ms]) => `${kind} ${formatMs(ms)}`).join(" · ") || "no completed turns"}`);
    lines.push(`Usage: ${tree.children.some((s) => s.kind === "turn" && s.usage) ? "latest stored snapshot per turn; others not stored" : "not stored"}`);
    if (summary.errors.length) {
      lines.push("Errors:");
      for (const e of summary.errors.slice(0, 10)) lines.push(`  ${e.kind} · ${e.name}${e.error ? `: ${e.error}` : ""}`);
    }
    if (summary.slowest.length) {
      lines.push("Slowest spans:");
      for (const s of summary.slowest.slice(0, 8)) lines.push(`  ${formatMs(s.durationMs).padStart(7)}  ${s.kind} · ${s.name}`);
    }
    lines.push("Waterfall:");
    let written = 0;
    function visit(s: TraceSpan, depth: number) {
      if (written++ >= 500) return;
      lines.push(`${"  ".repeat(Math.min(depth, 8))}${formatMs(s.durationMs).padStart(7)}  ${s.kind} · ${s.name}${s.status === "failed" ? "  FAILED" : ""}${s.kind === "turn" ? `  usage=${s.usage ? "stored" : "not stored"}` : ""}`);
      if (reveal) {
        if (s.input) lines.push(`${"  ".repeat(Math.min(depth + 1, 9))}input (${s.inputSize} bytes): ${s.input}`);
        if (s.output) lines.push(`${"  ".repeat(Math.min(depth + 1, 9))}output (${s.outputSize} bytes): ${s.output}`);
      }
      for (const child of s.children) visit(child, depth + 1);
    }
    visit(tree, 0);
    if (written > 500) lines.push(`… ${written - 500} spans hidden in text; use --json for the full tree.`);
    return lines.join("\n");
  }

  function formatPrompt(result: PromptResult, reveal: boolean): string {
    if (!result.selected) return `${result.provider} · ${result.status}: ${result.reason ?? "Transcript not available."}`;
    const call = result.selected;
    const count = (value: number | null) => value === null ? "not stored" : value.toLocaleString();
    const lines = [
      `Context · ${result.provider} · ${result.threadId} · call ${call.index}/${result.callCount}${result.status === "truncated" ? " (partial scan)" : ""}`,
      `Model ${call.model ?? "not stored"} · response ${call.requestId ?? "not stored"} · ${call.at === null ? "time not stored" : new Date(call.at).toISOString()} · duration ${call.durationMs === null ? "not stored" : formatMs(call.durationMs)}`,
      `Tokens: input ${count(call.usage?.inputTokens ?? null)} · cache read ${count(call.usage?.cacheReadTokens ?? null)} · cache write ${count(call.usage?.cacheWriteTokens ?? null)} (5m ${count(call.usage?.cacheWrite5mTokens ?? null)} / 1h ${count(call.usage?.cacheWrite1hTokens ?? null)}) · output ${count(call.usage?.outputTokens ?? null)} · reasoning ${count(call.usage?.reasoningTokens ?? null)}`,
      `Context used ${count(call.contextUsedTokens)} / window ${count(call.contextWindowTokens)} tokens`,
      `System sections (${call.system.length}):`,
    ];
    for (const section of call.system) {
      lines.push(`  ${section.label} · ${section.chars === null ? "not stored" : `~${section.estimatedTokens} tokens, ${section.chars} chars`}${section.truncated ? " · cut" : ""}`);
      if (reveal && section.text !== null) lines.push(section.text);
    }
    lines.push(`Tools (${call.tools.length}):`);
    for (const tool of call.tools) {
      lines.push(`  ${tool.name} · ${tool.estimatedTokens === null ? "not stored" : `~${tool.estimatedTokens} tokens`}${tool.truncated ? " · cut" : ""}`);
      if (reveal) { if (tool.description) lines.push(tool.description); if (tool.schema) lines.push(tool.schema); }
    }
    lines.push(`Injected context (${call.injected.length}):`);
    for (const section of call.injected) {
      lines.push(`  ${section.label} · ${section.chars === null ? "not stored" : `~${section.estimatedTokens} tokens, ${section.chars} chars`}${section.truncated ? " · cut" : ""}`);
      if (reveal && section.text !== null) lines.push(section.text);
    }
    const diff = call.diff;
    if (diff.previousCall === null) lines.push("Diff: first stored call; no previous prompt to compare.");
    else {
      lines.push(`Diff vs ${diff.previousCall}: system ${diff.systemChanged === null ? "not stored" : diff.systemChanged ? "changed" : "same"} · model ${diff.modelChanged === null ? "not stored" : diff.modelChanged ? "changed" : "same"} · tools +${diff.toolsAdded.length}/-${diff.toolsRemoved.length} · context +${diff.injectedAdded.length}/-${diff.injectedRemoved.length}`);
      if (diff.toolsAdded.length) lines.push(`  Added tools: ${diff.toolsAdded.join(", ")}`);
      if (diff.toolsRemoved.length) lines.push(`  Removed tools: ${diff.toolsRemoved.join(", ")}`);
      if (diff.injectedAdded.length) lines.push(`  Added context: ${diff.injectedAdded.join(", ")}`);
      if (diff.injectedRemoved.length) lines.push(`  Removed context: ${diff.injectedRemoved.join(", ")}`);
    }
    lines.push(`Ledger · calls ${result.ledgerStart}–${result.ledgerStart + result.ledger.length - 1} of ${result.callCount} (in / cache R / cache W / out / think):`);
    for (const row of result.ledger) lines.push(`${row.index === call.index ? ">" : " "}${String(row.index).padStart(4)} ${row.at === null ? "—" : new Date(row.at).toISOString().slice(11, 19)}  ${[row.usage?.inputTokens, row.usage?.cacheReadTokens, row.usage?.cacheWriteTokens, row.usage?.outputTokens, row.usage?.reasoningTokens].map((value) => value == null ? "—" : String(value)).join(" / ")}`);
    if (result.scan.limited || result.scan.malformedLines || result.scan.oversizedLines) lines.push(`Scan: ${result.scan.linesRead} lines; malformed ${result.scan.malformedLines}; oversized ${result.scan.oversizedLines}${result.scan.limited ? "; limited" : ""}.`);
    return lines.join("\n");
  }
  bb.cli.register(defineCli({
    name: "traces", summary: "Inspect BB thread timing, tool calls, waits, and errors",
    commands: {
      thread: cliCommand({
        summary: "Read a thread's event waterfall (SDK-only, read-only)",
        positionals: [{ name: "id", description: "Thread ID; use --self for the calling thread" }],
        options: {
          self: { type: "boolean", description: "Use the current calling thread" },
          json: { type: "boolean", description: "Return the full span tree and time summary" },
          children: { type: "boolean", description: "Include descendant threads" },
          reveal: { type: "boolean", description: "Explicitly show sensitive inputs, outputs, and event payloads" },
        },
        async run(input, ctx) {
          if (input.options.self && input.positionals.id) throw new PluginCliError("Choose either a thread ID or --self, not both.");
          const threadId = input.options.self ? ctx.threadId : input.positionals.id;
          if (!threadId) throw new PluginCliError("A thread ID is required.", { hint: "Pass <id> or --self inside a thread." });
          const result = await trace(threadId, input.options.children, input.options.reveal);
          const stdout = input.options.json ? JSON.stringify(result) : formatTree(result, input.options.reveal);
          if (Buffer.byteLength(stdout, "utf8") > MAX_CLI_BYTES) throw new PluginCliError("The trace exceeds the CLI output limit.", {
            hint: "Use the Traces UI for very large threads, or omit --children." });
          return { exitCode: 0, stdout };
        },
      }),
      prompt: cliCommand({
        summary: "Inspect a provider's stored API prompt, tools and token ledger",
        positionals: [{ name: "id", description: "Thread ID; use --self for the calling thread" }],
        options: {
          self: { type: "boolean", description: "Use the current calling thread" },
          call: { type: "integer", min: 1, max: 100_000, description: "Select a 1-based API call (default: latest)" },
          json: { type: "boolean", description: "Return bounded structured context and ledger" },
          reveal: { type: "boolean", description: "Explicitly show system prompt, tools and injected context" },
        },
        async run(input, ctx) {
          if (input.options.self && input.positionals.id) throw new PluginCliError("Choose either a thread ID or --self, not both.");
          const threadId = input.options.self ? ctx.threadId : input.positionals.id;
          if (!threadId || !/^thr_[a-z0-9]+$/.test(threadId)) throw new PluginCliError("A valid thread ID is required.", { hint: "Pass <id> or --self inside a thread." });
          const result = await prompt(threadId, input.options.call ?? null, input.options.reveal);
          const stdout = input.options.json ? JSON.stringify(result) : formatPrompt(result, input.options.reveal);
          if (Buffer.byteLength(stdout, "utf8") > MAX_CLI_BYTES) throw new PluginCliError("The prompt exceeds the CLI output limit.", { hint: "Try without --reveal, or select a different --call." });
          return { exitCode: result.status === "unsupported" || result.status === "unavailable" ? 1 : 0, stdout };
        },
      }),
      ...fleetCliCommands(fleet),
    },
  }));
  bb.log.info("Traces loaded (read-only BB storage)");
}
