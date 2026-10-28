import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_MIGRATION_HASH, FleetSchemaError, listFleetThreads, openFleetDb, scanFleetThread } from "./fleet-db";
import { FleetEngine } from "./fleet-engine";
import { parseFleetQuery } from "./fleet-query";

const NOW = 1_000_000_000;
const homes: string[] = [];
function fixture(hash = EXPECTED_MIGRATION_HASH) {
  const home = mkdtempSync(join(tmpdir(), "traces-fleet-")); homes.push(home);
  const db = new Database(join(home, "bb.db"));
  db.exec(`CREATE TABLE __drizzle_migrations (hash TEXT, created_at INTEGER);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, deleted_at INTEGER);
    CREATE TABLE environments (id TEXT PRIMARY KEY, is_worktree INTEGER);
    CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT, environment_id TEXT, provider_id TEXT, model_override TEXT,
      parent_thread_id TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE events (id TEXT PRIMARY KEY, thread_id TEXT, sequence INTEGER, scope_kind TEXT, turn_id TEXT,
      item_id TEXT, item_kind TEXT, type TEXT, data TEXT, created_at INTEGER, parent_tool_call_id TEXT);
    CREATE INDEX events_thread_sequence_idx ON events(thread_id,sequence);
    CREATE INDEX events_thread_type_sequence_idx ON events(thread_id,type,sequence);
    CREATE INDEX threads_project_updated_idx ON threads(project_id,updated_at);`);
  db.prepare("INSERT INTO __drizzle_migrations VALUES (?,?)").run(hash, NOW);
  db.prepare("INSERT INTO projects VALUES (?,?,NULL)").run("proj_main", "Oh My BB");
  db.prepare("INSERT INTO environments VALUES (?,?)").run("env_main", 1);
  const thread = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,NULL)");
  thread.run("thr_root", "proj_main", "env_main", "codex", "gpt-6.1", null, "active", NOW - 2_000, NOW - 100);
  thread.run("thr_child", "proj_main", "env_main", "claude-code", "claude-opus-5-5", "thr_root", "idle", NOW - 1_000, NOW - 50);
  thread.run("thr_old", "proj_main", null, "pi", null, null, "idle", NOW - 10 * 86_400_000, NOW - 10 * 86_400_000);
  const event = db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const add = (threadId: string, seq: number, type: string, at: number, data: Record<string, unknown> = {}, itemId: string | null = null,
    itemKind: string | null = null, turnId: string | null = null) => event.run(`evt_${threadId}_${seq}`, threadId, seq,
      turnId ? "turn" : "thread", turnId, itemId, itemKind, type, JSON.stringify(data), at, null);
  add("thr_root", 1, "turn/started", NOW - 1_800, {}, null, null, "turnA");
  add("thr_root", 2, "item/started", NOW - 1_700, { item: { type: "toolCall", id: "toolA", tool: "executor_execute", status: "pending", arguments: { secret: "opaque-secret-value" } } }, "toolA", "toolCall", "turnA");
  add("thr_root", 3, "item/reasoning/textDelta", NOW - 1_600, { delta: "opaque-secret-value" }, null, null, "turnA");
  add("thr_root", 4, "item/completed", NOW - 700, { item: { type: "toolCall", id: "toolA", tool: "executor_execute", status: "failed", result: "opaque-secret-value" } }, "toolA", "toolCall", "turnA");
  add("thr_root", 5, "provider/error", NOW - 600, { willRetry: true, errorInfo: { category: "rate-limit" }, detail: "opaque-secret-value" }, null, null, "turnA");
  add("thr_root", 6, "thread/tokenUsage/updated", NOW - 500, { tokenUsage: { total: { inputTokens: 999_999 } } }, null, null, "turnA");
  add("thr_root", 7, "turn/completed", NOW - 400, { status: "failed" }, null, null, "turnA");
  add("thr_child", 1, "turn/started", NOW - 1_000, {}, null, null, "turnB");
  add("thr_child", 2, "item/started", NOW - 900, { item: { type: "commandExecution", id: "cmdB", command: "opaque-secret-value", status: "pending" } }, "cmdB", "commandExecution", "turnB");
  add("thr_child", 3, "item/completed", NOW - 100, { item: { type: "commandExecution", id: "cmdB", command: "opaque-secret-value", status: "completed" } }, "cmdB", "commandExecution", "turnB");
  add("thr_child", 4, "turn/completed", NOW - 80, { status: "completed" }, null, null, "turnB");
  return { home, db, add, thread };
}
afterEach(() => { vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("read-only thread-first scanner", () => {
  it("refuses schema drift and uses query_only on a valid database", () => {
    const bad = fixture("another-migration"); bad.db.close();
    expect(() => openFleetDb(bad.home)).toThrow(FleetSchemaError);
    const good = fixture(); good.db.close();
    const read = openFleetDb(good.home);
    expect(() => read.prepare("DELETE FROM events").run()).toThrow();
    read.close();
  });

  it("parameterizes a quoted project value and never indexes secret payloads", () => {
    const { home, db } = fixture(); db.close(); const read = openFleetDb(home);
    const from = NOW - 3_600_000;
    const literal = listFleetThreads(read, parseFleetQuery('project:"x\' OR 1=1"'), from);
    expect(literal.total).toBe(0);
    expect(listFleetThreads(read, parseFleetQuery('project:"Oh My BB"'), from).total).toBe(2);
    const root = listFleetThreads(read, parseFleetQuery("thread:thr_root"), from).threads[0]!;
    const result = scanFleetThread(read, root, from, NOW, parseFleetQuery(""), "events");
    expect(result.scannedEvents).toBe(7);
    expect(result.rows.find((row) => row.type === "item/completed")?.durationMs).toBe(1_000);
    expect(result.withUsageSnapshot).toBe(true);
    expect(JSON.stringify(result.rows)).not.toContain("opaque-secret-value");
    read.close();
  });
  it("uses the last stored model request before the selected time window", () => {
    const { home, db, add } = fixture();
    const from = NOW - 3_600_000;
    add("thr_root", 0, "client/turn/requested", from - 100, { execution: { model: "gpt-current" }, input: "opaque-secret-value" });
    db.close(); const read = openFleetDb(home);
    const thread = listFleetThreads(read, parseFleetQuery("thread:thr_root"), from).threads[0]!;
    const result = scanFleetThread(read, thread, from, NOW, parseFleetQuery("model:gpt-current"), "events");
    expect(result.matchedEvents).toBe(7);
    expect(result.rows.every((row) => row.model === "gpt-current")).toBe(true);
    expect(JSON.stringify(result.rows)).not.toContain("opaque-secret-value");
    read.close();
  });
  it("includes an active thread whose updated_at predates its new events", async () => {
    const { home, db } = fixture();
    db.prepare("UPDATE threads SET updated_at=? WHERE id='thr_root'").run(NOW - 2 * 3_600_000);
    db.close(); const read = openFleetDb(home);
    const selected = listFleetThreads(read, parseFleetQuery(""), NOW - 3_600_000);
    expect(selected.threads.map((thread) => thread.id)).toContain("thr_root");
    expect(selected.total).toBe(2);
    read.close();
    const engine = new FleetEngine(() => home, () => {}, () => NOW);
    const started = engine.start({ query: "thread:thr_root", since: "1h", view: "explorer", mode: "events" });
    const result = await engine.wait(started.jobId, 5_000);
    expect(result.scannedEvents).toBe(7);
    expect(result.matchedEvents).toBe(7);
    await engine.dispose();
  });
  it("does not pair a background completion with a same-id foreground start", () => {
    const { home, db, add } = fixture();
    add("thr_root", 8, "turn/started", NOW - 300, {}, null, null, "turnC");
    add("thr_root", 9, "item/started", NOW - 290, { item: { type: "backgroundTask", id: "same", status: "pending" } }, "same", "backgroundTask", "turnC");
    add("thr_root", 10, "turn/completed", NOW - 280, { status: "completed" }, null, null, "turnC");
    add("thr_root", 11, "turn/started", NOW - 270, {}, null, null, "turnD");
    add("thr_root", 12, "item/started", NOW - 260, { item: { type: "commandExecution", id: "same", status: "pending" } }, "same", "commandExecution", "turnD");
    add("thr_root", 13, "item/backgroundTask/completed", NOW - 230, { item: { type: "backgroundTask", id: "same", status: "completed" } }, "same", "backgroundTask", "turnD");
    db.close(); const read = openFleetDb(home);
    const thread = listFleetThreads(read, parseFleetQuery("thread:thr_root"), NOW - 3_600_000).threads[0]!;
    const result = scanFleetThread(read, thread, NOW - 3_600_000, NOW, parseFleetQuery(""), "events");
    expect(result.rows.find((row) => row.type === "item/backgroundTask/completed")?.durationMs).toBe(60);
    expect(result.rows.find((row) => row.seq === 12)?.durationMs).toBeNull();
    read.close();
  });
  it("uses the thread-leading index and caps rows even for a busy thread", async () => {
    const { home, db, add } = fixture();
    db.transaction(() => { for (let seq = 8; seq < 310; seq++) add("thr_root", seq, "provider/warning", NOW - 350 + seq, { message: "opaque-secret-value" }); })();
    db.close(); const read = openFleetDb(home);
    const plan = read.prepare("EXPLAIN QUERY PLAN SELECT id FROM events WHERE thread_id=? AND created_at>=? ORDER BY sequence")
      .all("thr_root", NOW - 3_600_000) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("events_thread_sequence_idx"))).toBe(true);
    const meta = listFleetThreads(read, parseFleetQuery("thread:thr_root"), NOW - 3_600_000).threads[0]!;
    const contribution = scanFleetThread(read, meta, NOW - 3_600_000, NOW, parseFleetQuery("thread:thr_root"), "events");
    expect(contribution.matchedEvents).toBe(309);
    expect(contribution.rows).toHaveLength(250);
    expect(JSON.stringify(contribution.rows)).not.toContain("opaque-secret-value");
    read.close();
    const engine = new FleetEngine(() => home, () => {}, () => NOW);
    const started = engine.start({ query: "thread:thr_root", since: "1h", view: "explorer", mode: "events" });
    const result = await engine.wait(started.jobId, 5_000);
    expect(result.rows).toHaveLength(250);
    expect(result.rowsTruncated).toBe(59);
    await engine.dispose();
  });
});

describe("progressive fleet engine", () => {
  it("reports schema drift without disabling per-thread features", async () => {
    const { home, db } = fixture("new-core-migration"); db.close();
    const engine = new FleetEngine(() => home, () => {}, () => NOW);
    const result = engine.start({ query: "", since: "1h", view: "explorer", mode: "events" });
    expect(result.status).toBe("schema-mismatch");
    expect(result.freshness).toBe("unavailable");
    expect(result.error).toContain("per-thread Waterfall and Context Inspector still work");
    await engine.dispose();
  });
  it("counts tool errors and TTFT while leaving pruned window token totals unknown", async () => {
    const { home, db } = fixture(); db.close();
    const progress: number[] = [];
    const engine = new FleetEngine(() => home, ({ scannedThreads }) => progress.push(scannedThreads), () => NOW);
    const started = engine.start({ query: "", since: "1h", view: "metrics", mode: "events" });
    expect(started.status).toBe("running");
    const result = await engine.wait(started.jobId, 5_000);
    expect(result.status).toBe("complete");
    expect(result.totalThreads).toBe(2);
    expect(result.scannedThreads).toBe(2);
    expect(result.metrics.toolCalls).toBe(2);
    expect(result.metrics.failedTools).toBe(1);
    expect(result.metrics.errorRate).toBe(0.5);
    expect(result.metrics.slowTools.find((tool) => tool.name === "executor_execute")?.p95Ms).toBe(1_000);
    expect(result.metrics.toolP50Ms).toBe(800);
    expect(result.metrics.toolP95Ms).toBe(1_000);
    expect(result.metrics.ttft.find((entry) => entry.provider === "codex")?.p50Ms).toBe(200);
    expect(result.metrics.tokenUsage).toBeNull();
    expect(result.metrics.tokenCoverage.threadsWithSnapshot).toBe(1);
    expect(result.metrics.spawnTree.some((entry) => entry.threadId === "thr_root" && entry.children === 1)).toBe(true);
    expect(result.histogram.reduce((sum, bin) => sum + bin.count, 0)).toBe(result.matchedEvents);
    expect(progress.at(-1)).toBe(2);
    await engine.dispose();
  });

  it("retains four completed jobs and evicts only when a fifth starts", async () => {
    const { home, db } = fixture(); db.close();
    const engine = new FleetEngine(() => home, () => {}, () => NOW);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const started = engine.start({ query: "", since: "1h", view: "explorer", mode: "events" });
      ids.push(started.jobId);
      await engine.wait(started.jobId, 5_000);
    }
    for (const id of ids) expect(engine.snapshot(id).status).toBe("complete");
    const fifth = engine.start({ query: "", since: "1h", view: "explorer", mode: "events" });
    expect(() => engine.snapshot(ids[0]!)).toThrow(/expired/);
    await engine.wait(fifth.jobId, 5_000);
    await engine.dispose();
  });
  it("publishes progress, cancels between batches, and caps concurrent jobs", async () => {
    const { home, db, thread } = fixture();
    for (let i = 0; i < 12; i++) thread.run(`thr_extra${i}`, "proj_main", "env_main", "pi", null, null, "idle", NOW - 1_000, NOW - i);
    db.close();
    let engine: FleetEngine; let cancelled = false; const progress: number[] = [];
    engine = new FleetEngine(() => home, ({ jobId, scannedThreads }) => {
      progress.push(scannedThreads);
      if (scannedThreads >= 5 && !cancelled) { cancelled = true; engine.cancel(jobId); }
    }, () => NOW);
    const first = engine.start({ query: "", since: "1h", view: "explorer", mode: "events" });
    const second = engine.start({ query: "", since: "1h", view: "metrics", mode: "events" });
    expect(() => engine.start({ query: "", since: "1h", view: "metrics", mode: "events" })).toThrow(/Two fleet scans/);
    const result = await engine.wait(first.jobId, 5_000);
    expect(result.status).toBe("cancelled");
    expect(result.scannedThreads).toBeLessThan(result.totalThreads);
    expect(progress).toContain(5);
    await engine.wait(second.jobId, 5_000);
    await engine.dispose();
  });

  it("replaces a changed thread contribution on live rescan without duplicate rows", async () => {
    const { home, db, add } = fixture();
    let now = NOW;
    const live = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>(); let updates = 0;
    const engine = new FleetEngine(() => home, ({ status }) => {
      if (status !== "complete" || now <= NOW) return;
      if (++updates === 1) live.resolve(); else second.resolve();
    }, () => now);
    const started = engine.start({ query: "provider:codex", since: "1h", view: "explorer", mode: "events" });
    const first = await engine.wait(started.jobId, 5_000);
    expect(first.scannedThreads).toBe(1);
    now = NOW + 200;
    add("thr_root", 8, "provider/modelFallback", NOW + 100, { originalModel: "a", fallbackModel: "b" });
    db.prepare("UPDATE threads SET updated_at=? WHERE id='thr_root'").run(now);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    engine.onThreadEvent("thr_root"); engine.onThreadEvent("thr_root");
    await vi.advanceTimersByTimeAsync(1_000);
    await live.promise;
    const fresh = engine.snapshot(started.jobId);
    expect(fresh.freshness).toBe("live-since-completion");
    expect(fresh.metrics.modelFallbacks).toBe(1);
    expect(fresh.rows.filter((row) => row.seq === 8)).toHaveLength(1);
    expect(fresh.histogram.at(-1)?.count).toBe(1);
    now = NOW + 400;
    add("thr_child", 5, "provider/error", NOW + 300, { errorInfo: { category: "overloaded" } });
    db.prepare("UPDATE threads SET updated_at=? WHERE id='thr_child'").run(now);
    engine.onThreadEvent("thr_child");
    await vi.advanceTimersByTimeAsync(1_000);
    await second.promise;
    const filtered = engine.snapshot(started.jobId);
    expect(filtered.scannedThreads).toBe(1);
    expect(filtered.matchedEvents).toBe(fresh.matchedEvents);
    expect(filtered.rows.some((row) => row.threadId === "thr_child")).toBe(false);
    db.close(); await engine.dispose();
  });
});
