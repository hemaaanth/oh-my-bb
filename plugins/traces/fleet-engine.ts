import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { MAX_EVENTS, FleetSchemaError, fleetThreadById, listFleetThreads, openFleetDb, scanFleetThread, threadMatchesFleetFilter,
  type FleetThread, type ThreadContribution } from "./fleet-db";
import { parseFleetQuery, parseFleetSince, type FleetFilter } from "./fleet-query";
import type { FleetErrorStats, FleetFacet, FleetHistogramBin, FleetMetrics, FleetMode, FleetSnapshot, FleetStatus, FleetTtft, FleetView } from "./fleet-contract";

const MAX_JOBS = 4;
const MAX_ACTIVE = 2;
const JOB_TTL_MS = 10 * 60_000;
const MAX_ROWS = 250;
const MAX_GROUPS = 200;
const MAX_SAMPLES_PER_GROUP = 10_000;
const BATCH_THREADS = 5;
const RETRY_MS = 100;

type StartInput = { query: string; since: string; view: FleetView; mode: FleetMode };
type Publish = (event: { jobId: string; status: FleetStatus; scannedThreads: number; totalThreads: number; updatedAt: number }) => void;
interface Job {
  id: string; input: StartInput; filter: FleetFilter; from: number; to: number;
  status: FleetStatus; error: string | null; startedAt: number; updatedAt: number; completedAt: number | null;
  threads: FleetThread[]; totalThreads: number; scannedThreads: number; scannedEvents: number; limited: boolean; retries: number;
  contributions: Map<string, ThreadContribution>; cancelRequested: boolean; dirty: Set<string>;
  liveSince: number | null; lastLiveEventAt: number | null; liveTimer: NodeJS.Timeout | null; liveRunning: boolean;
  done: Promise<void>; settle: () => void;
}
function percentile(samples: number[], percent: number): number | null {
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.max(0, Math.ceil(samples.length * percent / 100) - 1)]!;
}
function groupCounts(map: Map<string, number>, key: string, count: number) {
  const group = !map.has(key) && map.size >= MAX_GROUPS ? "other" : key;
  map.set(group, (map.get(group) ?? 0) + count);
}
function errorRows(map: Map<string, number>): FleetErrorStats[] {
  return [...map].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count).slice(0, 15);
}
function mergeSample(target: Map<string, { count: number; unknown: number; samples: number[]; partial: boolean }>, key: string,
  value: { count: number; unknown: number; samples: number[]; partial: boolean }) {
  const group = !target.has(key) && target.size >= MAX_GROUPS ? "other" : key;
  let entry = target.get(group);
  if (!entry) { entry = { count: 0, unknown: 0, samples: [], partial: false }; target.set(group, entry); }
  entry.count += value.count; entry.unknown += value.unknown;
  const space = MAX_SAMPLES_PER_GROUP - entry.samples.length;
  entry.samples.push(...value.samples.slice(0, space));
  if (value.partial || value.samples.length > space) entry.partial = true;
}
function spawnTree(contributions: Iterable<ThreadContribution>): FleetMetrics["spawnTree"] {
  const nodes = [...contributions].map(({ thread }) => ({ threadId: thread.id, provider: thread.provider,
    parentThreadId: thread.parentThreadId, children: 0, lastActivityAt: thread.updatedAt }));
  const byId = new Map(nodes.map((node) => [node.threadId, node]));
  for (const node of nodes) {
    const parent = node.parentThreadId ? byId.get(node.parentThreadId) : null;
    if (parent) parent.children++;
  }
  const groups = new Map<string, typeof nodes>();
  for (const node of nodes) if (node.parentThreadId && byId.has(node.parentThreadId)) {
    const siblings = groups.get(node.parentThreadId) ?? []; siblings.push(node); groups.set(node.parentThreadId, siblings);
  }
  const roots = nodes.filter((node) => !node.parentThreadId || !byId.has(node.parentThreadId))
    .sort((a, b) => b.children - a.children || b.lastActivityAt - a.lastActivityAt);
  const output: typeof nodes = [];
  function visit(node: typeof nodes[number], depth: number) {
    if (output.length >= 50 || depth > 8) return;
    output.push(node);
    for (const child of (groups.get(node.threadId) ?? []).sort((a, b) => b.lastActivityAt - a.lastActivityAt)) visit(child, depth + 1);
  }
  for (const root of roots) visit(root, 0);
  return output;
}

function aggregate(job: Job): Pick<FleetSnapshot, "rows" | "rowsTruncated" | "histogram" | "facets" | "metrics" | "matchedEvents"> {
  const allRows: FleetSnapshot["rows"] = [];
  const bins = Array.from({ length: 25 }, () => ({ count: 0, errors: 0 }));
  const facetMaps = new Map<string, Map<string, number>>();
  const tools = new Map<string, { count: number; unknown: number; samples: number[]; partial: boolean }>();
  const providers = new Map<string, { count: number; unknown: number; samples: number[]; partial: boolean }>();
  const errors = new Map<string, number>(), errorProviders = new Map<string, number>(), errorTools = new Map<string, number>();
  const ttft = new Map<string, { count: number; unknown: number; samples: number[]; partial: boolean }>();
  const toolSamples: number[] = [];
  let toolLatencyPartial = false;
  let turns = 0, toolCalls = 0, failedTools = 0, retries = 0, fallbacks = 0, matchedEvents = 0, activeThreads = 0, snapshots = 0;
  for (const contribution of job.contributions.values()) {
    if (contribution.scannedEvents) activeThreads++;
    if (contribution.withUsageSnapshot) snapshots++;
    matchedEvents += contribution.matchedEvents;
    turns += contribution.turns; toolCalls += contribution.toolCalls; failedTools += contribution.failedTools;
    retries += contribution.retries; fallbacks += contribution.fallbacks;
    allRows.push(...contribution.rows);
    for (let i = 0; i < 25; i++) { bins[i]!.count += contribution.histogram[i]!.count; bins[i]!.errors += contribution.histogram[i]!.errors; }
    for (const [field, values] of Object.entries(contribution.facets)) {
      let map = facetMaps.get(field); if (!map) { map = new Map(); facetMaps.set(field, map); }
      for (const [value, count] of values) groupCounts(map, value, count);
    }
    for (const [name, entry] of contribution.toolDurations) {
      mergeSample(tools, name, entry);
      mergeSample(providers, contribution.thread.provider, entry);
      const space = MAX_SAMPLES_PER_GROUP - toolSamples.length;
      toolSamples.push(...entry.samples.slice(0, space));
      if (entry.partial || entry.samples.length > space) toolLatencyPartial = true;
    }
    for (const [name, entry] of contribution.ttft) mergeSample(ttft, name, { ...entry, unknown: 0 });
    for (const [name, count] of contribution.errors) groupCounts(errors, name, count);
    for (const [name, count] of contribution.errorProviders) groupCounts(errorProviders, name, count);
    for (const [name, count] of contribution.errorTools) groupCounts(errorTools, name, count);
  }
  allRows.sort((a, b) => b.at - a.at || b.seq - a.seq);
  const rows = allRows.slice(0, MAX_ROWS);
  const facets: Record<string, FleetFacet[]> = {};
  for (const [field, values] of facetMaps) facets[field] = [...values].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, 12);
  const width = (job.to - job.from) / 24;
  const histogram: FleetHistogramBin[] = bins.slice(0, 24).map((bin, index) => ({ from: job.from + index * width,
    to: job.from + (index + 1) * width, ...bin }));
  if (job.lastLiveEventAt !== null) histogram.push({ from: job.to, to: Math.max(job.to, job.lastLiveEventAt), ...bins[24]! });
  const slowTools = [...tools].map(([name, entry]) => ({ name, count: entry.count, measured: entry.count - entry.unknown,
    unknown: entry.unknown, p50Ms: percentile([...entry.samples], 50), p95Ms: percentile([...entry.samples], 95),
    partial: entry.partial || entry.samples.length < entry.count - entry.unknown }))
    .sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1)).slice(0, 15);
  const slowProviders = [...providers].map(([name, entry]) => ({ name, count: entry.count, measured: entry.count - entry.unknown,
    unknown: entry.unknown, p50Ms: percentile([...entry.samples], 50), p95Ms: percentile([...entry.samples], 95),
    partial: entry.partial || entry.samples.length < entry.count - entry.unknown }))
    .sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1)).slice(0, 15);
  const ttftRows: FleetTtft[] = [...ttft].filter(([key]) => key.includes("\0")).map(([key, entry]) => {
    const [provider, hour] = key.split("\0");
    return { provider: provider!, hour: Number(hour), count: entry.count, p50Ms: percentile([...entry.samples], 50),
      partial: entry.partial || entry.samples.length < entry.count };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.hour - b.hour);
  const metrics: FleetMetrics = { turns, toolCalls, failedTools, errorRate: toolCalls ? failedTools / toolCalls : null,
    toolP50Ms: percentile([...toolSamples], 50), toolP95Ms: percentile([...toolSamples], 95), toolLatencyPartial,
    providerRetries: retries, modelFallbacks: fallbacks, activeThreads, slowTools, slowProviders,
    errors: errorRows(errors), errorProviders: errorRows(errorProviders), errorTools: errorRows(errorTools),
    ttft: ttftRows, spawnTree: spawnTree(job.contributions.values()), tokenUsage: null,
    tokenCoverage: { threadsWithSnapshot: snapshots, threadsWithoutSnapshot: job.contributions.size - snapshots,
      reason: "BB prunes historical usage. The remaining thread totals can include work outside this window; no reliable fleet-window token total is stored." } };
  return { rows, rowsTruncated: Math.max(0, matchedEvents - rows.length), histogram, facets, metrics, matchedEvents };
}

function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}
export class FleetEngine {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly dataDir: () => string, private readonly publish: Publish, private readonly now = Date.now) {}

  private notify(job: Job) {
    job.updatedAt = this.now();
    this.publish({ jobId: job.id, status: job.status, scannedThreads: job.scannedThreads, totalThreads: job.totalThreads, updatedAt: job.updatedAt });
  }
  private prune(reserveSlot = false) {
    for (const [id, job] of this.jobs) if (job.completedAt !== null && this.now() - job.completedAt > JOB_TTL_MS) {
      clearTimeout(job.liveTimer ?? undefined); this.jobs.delete(id);
    }
    while (this.jobs.size > MAX_JOBS - (reserveSlot ? 1 : 0)) {
      const entry = [...this.jobs].find(([, job]) => job.status !== "running" && job.status !== "cancelling");
      if (!entry) break;
      clearTimeout(entry[1].liveTimer ?? undefined);
      this.jobs.delete(entry[0]);
    }
  }
  start(input: StartInput): FleetSnapshot {
    const filter = parseFleetQuery(input.query);
    const { from, to } = parseFleetSince(input.since, this.now());
    if ([...this.jobs.values()].filter((job) => job.status === "running" || job.status === "cancelling").length >= MAX_ACTIVE)
      throw new Error("Two fleet scans are running. Cancel one before starting another.");
    this.prune(true);
    const id = `scan_${randomBytes(8).toString("hex")}`;
    const { promise: done, resolve: settle } = Promise.withResolvers<void>();
    const job: Job = { id, input, filter, from, to, status: "running", error: null, startedAt: this.now(), updatedAt: this.now(),
      completedAt: null, threads: [], totalThreads: 0, scannedThreads: 0, scannedEvents: 0, limited: false, retries: 0,
      contributions: new Map(), cancelRequested: false, dirty: new Set(), liveSince: null, lastLiveEventAt: null,
      liveTimer: null, liveRunning: false, done, settle };
    this.jobs.set(id, job);
    try {
      const db = openFleetDb(this.dataDir());
      try {
        const candidates = listFleetThreads(db, filter, from);
        job.threads = candidates.threads; job.totalThreads = candidates.total; job.limited = candidates.limited;
      } catch (cause) { db.close(); throw cause; }
      void this.run(job, db);
    } catch (cause) {
      job.status = cause instanceof FleetSchemaError ? "schema-mismatch" : "error";
      job.error = cause instanceof FleetSchemaError ? cause.message : "Fleet storage is unavailable. Per-thread traces still work.";
      job.completedAt = this.now(); job.settle(); this.notify(job);
    }
    return this.snapshot(id);
  }

  private async run(job: Job, db: Database.Database) {
    try {
      await nextTurn();
      for (const thread of job.threads) {
        if (job.cancelRequested || job.scannedEvents >= MAX_EVENTS) { job.limited ||= job.scannedEvents >= MAX_EVENTS; break; }
        let contribution: ThreadContribution | null = null;
        for (let attempt = 0; attempt < 3 && !contribution; attempt++) {
          try { contribution = scanFleetThread(db, thread, job.from, job.to, job.filter, job.input.mode); }
          catch (cause) {
            if (!(cause instanceof Error && "code" in cause && (cause.code === "SQLITE_BUSY" || cause.code === "SQLITE_LOCKED")) || attempt === 2) throw cause;
            job.retries++;
            const pause = Promise.withResolvers<void>();
            setTimeout(pause.resolve, RETRY_MS);
            await pause.promise;
          }
        }
        if (!contribution) break;
        job.contributions.set(thread.id, contribution);
        job.scannedThreads++; job.scannedEvents += contribution.scannedEvents;
        job.limited ||= contribution.limited;
        if (job.scannedThreads % BATCH_THREADS === 0) { this.notify(job); await nextTurn(); }
      }
      job.status = job.cancelRequested ? "cancelled" : "complete";
      if (job.status === "complete") job.liveSince = this.now();
    } catch {
      job.status = "error"; job.error = "Fleet scan failed. The database may have changed; retry or use a per-thread trace.";
    } finally {
      db.close(); job.completedAt = this.now(); job.settle(); this.notify(job);
      if (job.status === "complete" && job.dirty.size) this.scheduleLive(job);
    }
  }

  snapshot(id: string): FleetSnapshot {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new Error("Scan job expired. Start a new scan.");
    const result = aggregate(job);
    return { jobId: id, view: job.input.view, mode: job.input.mode, query: job.input.query, since: job.input.since,
      status: job.status, error: job.error, from: job.from, to: job.to,
      startedAt: job.startedAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
      scannedThreads: job.scannedThreads, totalThreads: job.totalThreads, scannedEvents: job.scannedEvents,
      ...result, freshness: job.status === "cancelled" ? "cancelled" : job.status === "error" || job.status === "schema-mismatch" ? "unavailable"
        : job.lastLiveEventAt !== null ? "live-since-completion" : job.status === "complete" ? "snapshot" : "scanning",
      liveSince: job.liveSince, lastLiveEventAt: job.lastLiveEventAt, limited: job.limited, retries: job.retries };
  }
  cancel(id: string): FleetSnapshot {
    const job = this.jobs.get(id); if (!job) throw new Error("Scan job expired. Start a new scan.");
    if (job.status === "running" || job.status === "cancelling") {
      job.cancelRequested = true; job.status = "cancelling"; this.notify(job);
    }
    if (job.liveTimer) { clearTimeout(job.liveTimer); job.liveTimer = null; }
    return this.snapshot(id);
  }
  async wait(id: string, ms: number, signal?: AbortSignal): Promise<FleetSnapshot> {
    const job = this.jobs.get(id); if (!job) throw new Error("Scan job expired. Start a new scan.");
    if (job.status === "running" || job.status === "cancelling") {
      if (signal?.aborted) { this.cancel(id); return this.snapshot(id); }
      const timeout = Promise.withResolvers<void>();
      const timer = setTimeout(timeout.resolve, ms);
      const onAbort = () => { this.cancel(id); timeout.resolve(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try { await Promise.race([job.done, timeout.promise]); }
      finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    }
    return this.snapshot(id);
  }
  onThreadEvent(threadId: string) {
    for (const job of this.jobs.values()) {
      if (job.status !== "complete" && job.status !== "running") continue;
      job.dirty.add(threadId);
      if (job.status === "complete") this.scheduleLive(job);
    }
  }
  private scheduleLive(job: Job) {
    if (job.liveTimer || job.liveRunning || job.status !== "complete") return;
    job.liveTimer = setTimeout(() => { job.liveTimer = null; void this.flushLive(job); }, 1_000);
  }
  private async flushLive(job: Job) {
    if (job.liveRunning || job.status !== "complete") return;
    job.liveRunning = true;
    const ids = [...job.dirty].slice(0, 20); for (const id of ids) job.dirty.delete(id);
    try {
      const db = openFleetDb(this.dataDir());
      try {
        for (const id of ids) {
          if (job.status !== "complete") break;
          const thread = fleetThreadById(db, id);
          if (!thread || (thread.updatedAt < job.from && thread.status !== "active") || !threadMatchesFleetFilter(thread, job.filter)) { job.contributions.delete(id); continue; }
          const contribution = scanFleetThread(db, thread, job.from, this.now() + 1, job.filter, job.input.mode, job.to);
          if (contribution.scannedEvents) job.contributions.set(id, contribution);
          else job.contributions.delete(id);
          job.limited ||= contribution.limited;
          await nextTurn();
        }
        const candidates = listFleetThreads(db, job.filter, job.from);
        job.totalThreads = candidates.total; job.limited ||= candidates.limited;
      } finally { db.close(); }
      job.scannedThreads = job.contributions.size;
      job.scannedEvents = [...job.contributions.values()].reduce((sum, value) => sum + value.scannedEvents, 0);
      job.lastLiveEventAt = this.now(); this.notify(job);
    } catch (cause) {
      if (cause instanceof FleetSchemaError) { job.status = "schema-mismatch"; job.error = cause.message; this.notify(job); }
    } finally {
      job.liveRunning = false;
      if (job.dirty.size) this.scheduleLive(job);
    }
  }
  async dispose() {
    for (const job of this.jobs.values()) {
      job.cancelRequested = true;
      clearTimeout(job.liveTimer ?? undefined);
    }
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
    this.jobs.clear();
  }
}
