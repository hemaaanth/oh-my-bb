import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import type { FleetSnapshot } from "./fleet-contract";
import type { FleetEngine } from "./fleet-engine";

const MAX_BYTES = 1_000_000;
const WAIT_MS = 25_000;
function state(snapshot: FleetSnapshot): string {
  const suffix = snapshot.status === "running" || snapshot.status === "cancelling"
    ? ` Continue with bb traces job ${snapshot.jobId}.` : "";
  return `${snapshot.status} · ${snapshot.scannedThreads}/${snapshot.totalThreads} threads · ${snapshot.scannedEvents.toLocaleString()} events · ${snapshot.matchedEvents.toLocaleString()} matches${snapshot.limited ? " · bounded/partial" : ""}.${suffix}`;
}
function output(value: unknown, text: string, snapshot: FleetSnapshot) {
  const stdout = text === "json" ? JSON.stringify(value) : text;
  if (Buffer.byteLength(stdout, "utf8") > MAX_BYTES) throw new PluginCliError("Fleet result exceeds the CLI output limit.", { hint: `Use bb traces job ${snapshot.jobId} --limit 20.` });
  return { exitCode: snapshot.status === "error" || snapshot.status === "schema-mismatch" ? 1 : 0, stdout };
}
function preview(snapshot: FleetSnapshot, limit: number): FleetSnapshot {
  return { ...snapshot, rows: snapshot.rows.slice(0, limit), rowsTruncated: snapshot.rowsTruncated + Math.max(0, snapshot.rows.length - limit) };
}
function duration(ms: number | null) { return ms === null ? "not measured" : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`; }

export function fleetCliCommands(engine: FleetEngine) {
  return {
    query: cliCommand({
      summary: "Search bounded BB events or derived spans across threads",
      positionals: [{ name: "query", description: "AND-only field:value filters; quote values with spaces" }],
      options: {
        since: { type: "string", default: "24h", description: "Lookback: 1h–99h or 1d–7d (default 24h)" },
        mode: { type: "enum", values: ["events", "spans"], default: "events", description: "Raw event metadata or derived spans" },
        limit: { type: "integer", min: 1, max: 100, default: 40, description: "Maximum returned rows (1–100)" },
        json: { type: "boolean", description: "Return structured result and progress" },
      },
      async run(input, ctx) {
        const started = engine.start({ query: input.positionals.query ?? "", since: input.options.since, view: "explorer", mode: input.options.mode });
        const result = await engine.wait(started.jobId, WAIT_MS, ctx.signal);
        const bounded = preview(result, input.options.limit);
        const lines = [state(result)];
        if (result.error) lines.push(result.error);
        for (const row of bounded.rows) lines.push(`${new Date(row.at).toISOString()}  ${row.threadId}  ${row.kind}  ${row.tool ?? "—"}  ${row.status}  ${duration(row.durationMs)}  ${row.id}`);
        if (bounded.rowsTruncated) lines.push(`${bounded.rowsTruncated} matching rows omitted from this bounded response.`);
        return output(bounded, input.options.json ? "json" : lines.join("\n"), result);
      },
    }),
    slow: cliCommand({
      summary: "Rank tool or provider latency by measured p50/p95",
      options: {
        since: { type: "string", default: "24h", description: "Lookback: 1h–99h or 1d–7d" },
        by: { type: "enum", values: ["tool", "provider"], default: "tool", description: "Latency grouping" },
        p: { type: "enum", values: ["50", "95"], default: "95", description: "Sort by p50 or p95" },
        filter: { type: "string", default: "", description: "Optional field:value query" },
        json: { type: "boolean", description: "Return structured latency groups" },
      },
      async run(input, ctx) {
        const started = engine.start({ query: input.options.filter, since: input.options.since, view: "metrics", mode: "events" });
        const result = await engine.wait(started.jobId, WAIT_MS, ctx.signal);
        const groups = input.options.by === "provider" ? result.metrics.slowProviders : result.metrics.slowTools;
        const sorted = [...groups].sort((a, b) => ((input.options.p === "50" ? b.p50Ms : b.p95Ms) ?? -1) - ((input.options.p === "50" ? a.p50Ms : a.p95Ms) ?? -1));
        const lines = [state(result), `Latency by ${input.options.by} · p${input.options.p} · measured calls only; unknown durations excluded.`];
        if (result.error) lines.push(result.error);
        for (const group of sorted) lines.push(`${group.name}  p50 ${duration(group.p50Ms)}  p95 ${duration(group.p95Ms)}  ${group.measured}/${group.count} measured${group.partial ? " · sampled/partial" : ""}`);
        return output({ jobId: result.jobId, status: result.status, scannedThreads: result.scannedThreads, totalThreads: result.totalThreads,
          limited: result.limited, groups: sorted }, input.options.json ? "json" : lines.join("\n"), result);
      },
    }),
    errors: cliCommand({
      summary: "Group stored provider and item failures by category, provider, or tool",
      options: {
        since: { type: "string", default: "24h", description: "Lookback: 1h–99h or 1d–7d" },
        group: { type: "enum", values: ["category", "provider", "tool"], default: "category", description: "Error grouping" },
        filter: { type: "string", default: "", description: "Optional field:value query" },
        json: { type: "boolean", description: "Return structured error groups" },
      },
      async run(input, ctx) {
        const started = engine.start({ query: input.options.filter, since: input.options.since, view: "metrics", mode: "events" });
        const result = await engine.wait(started.jobId, WAIT_MS, ctx.signal);
        const groups = input.options.group === "provider" ? result.metrics.errorProviders : input.options.group === "tool" ? result.metrics.errorTools : result.metrics.errors;
        const lines = [state(result), `Errors by ${input.options.group} (recorded failures; no payload text).`];
        if (result.error) lines.push(result.error);
        for (const group of groups) lines.push(`${group.category}  ${group.count.toLocaleString()}`);
        return output({ jobId: result.jobId, status: result.status, scannedThreads: result.scannedThreads, totalThreads: result.totalThreads,
          limited: result.limited, groups }, input.options.json ? "json" : lines.join("\n"), result);
      },
    }),
    job: cliCommand({
      summary: "Read or cancel a progressive fleet scan",
      positionals: [{ name: "id", description: "scan_ job ID", required: true }],
      options: {
        cancel: { type: "boolean", description: "Cancel remaining thread scans" },
        limit: { type: "integer", min: 1, max: 100, default: 40, description: "Maximum returned rows" },
        json: { type: "boolean", description: "Return structured snapshot" },
      },
      async run(input) {
        if (!/^scan_[a-z0-9]+$/.test(input.positionals.id)) throw new PluginCliError("Invalid scan job ID.");
        const result = input.options.cancel ? engine.cancel(input.positionals.id) : engine.snapshot(input.positionals.id);
        const bounded = preview(result, input.options.limit);
        const lines = [state(result)];
        if (result.error) lines.push(result.error);
        for (const row of bounded.rows) lines.push(`${new Date(row.at).toISOString()}  ${row.threadId}  ${row.kind}  ${row.status}  ${duration(row.durationMs)}`);
        return output(bounded, input.options.json ? "json" : lines.join("\n"), result);
      },
    }),
  };
}
