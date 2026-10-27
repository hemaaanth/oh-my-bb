import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { memorySignature } from "../memory-auth.js";
import { MEMORY_HTTP_BYTES, memoryHostContract, type MemoryEntry, type MemoryRequest } from "../memory-contract.js";
import { atomicJson, manifestPage, privateDirectory, readChunk, receiveEntries, snapshot, transferChunks, transferPaths, verifyReceived, writeChunk } from "../memory-files.js";

type Action<T> = T extends MemoryRequest ? Omit<T, "operationId"> : never;
const preparedSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local"), profile: z.string(), home: z.string() }),
  z.object({ mode: z.literal("remote"), profile: z.string(), digest: z.string(), entries: z.number(), bytes: z.number() }),
]);
export class AgentMemoryBusyError extends Error { readonly code = 75; }
export class AgentMemoryTurn {
  readonly operationId = randomUUID();
  private readonly profile: string;
  private readonly url: string;
  private readonly key: string;
  private readonly secret: string;
  private readonly mode: "local" | "remote";
  private readonly paths: ReturnType<typeof transferPaths>;
  private prepared = false;
  private running = false;
  private attempted = false;
  private ended = false;
  private home: string | undefined;
  private link: string | undefined;
  private lost: Error | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private finishing: Promise<void> | undefined;
  constructor(private readonly options: { memoryKey: string; env: NodeJS.ProcessEnv; dataDir: string; signal: AbortSignal; onLost(error: Error): void }) {
    this.profile = options.memoryKey;
    const { AGENT_MEMORY_URL: url, AGENT_MEMORY_KEY: key, AGENT_MEMORY_SECRET: secret, AGENT_MEMORY_MODE: mode, AGENT_MEMORY_PROFILE: profile } = options.env;
    if (!url || !key || !secret || (mode !== "local" && mode !== "remote") || profile !== this.profile) throw new Error("Agent memory coordinator is missing or does not match this agent. Refusing to launch Pi with an independent memory.");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Agent memory requires an HTTP(S) coordinator URL.");
    this.url = url; this.key = key; this.secret = secret; this.mode = mode;
    this.paths = transferPaths(options.dataDir, this.operationId, this.profile);
  }
  get homeOverride(): string | undefined { return this.home; }
  check(): void { if (this.lost) throw this.lost; }
  private async request(input: Action<MemoryRequest>, signal?: AbortSignal): Promise<unknown> {
    const body = JSON.stringify({ ...input, operationId: this.operationId });
    if (Buffer.byteLength(body) > MEMORY_HTTP_BYTES) throw new Error("Memory request exceeds 128 KiB.");
    const time = String(Date.now()), nonce = randomUUID();
    const timeout = AbortSignal.timeout(input.action === "prepare" || input.action === "commit" ? 30 * 60_000 : 30_000);
    const response = await fetch(this.url, {
      method: "POST", redirect: "error", body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "content-type": "application/json", "x-agent-memory-key": this.key, "x-agent-memory-time": time, "x-agent-memory-nonce": nonce, "x-agent-memory-signature": memorySignature(this.secret, time, nonce, body) },
    });
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    if (!reader) throw new Error("Memory coordinator returned an empty response.");
    try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > MEMORY_HTTP_BYTES) { await reader.cancel(); throw new Error("Memory response exceeds 128 KiB."); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString("utf8");
    let json: unknown;
    try { json = JSON.parse(text); }
    catch { throw new Error(`Memory coordinator returned HTTP ${response.status} without JSON: ${text.slice(0, 120)}`); }
    const result = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), result: z.unknown() }), z.object({ ok: z.literal(false), error: z.object({ message: z.string(), code: z.number().optional() }) })]).parse(json);
    if (!result.ok) { if (result.error.code === 75) throw new AgentMemoryBusyError(result.error.message); throw new Error(result.error.message); }
    if (!response.ok) throw new Error(`Memory coordinator returned HTTP ${response.status}.`);
    return result.result;
  }
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    let pending = false;
    this.heartbeat = setInterval(() => {
      if (pending || this.ended || this.finishing) return;
      pending = true;
      void this.request({ action: "heartbeat" }).catch((error: unknown) => {
        if (this.ended || this.finishing) return;
        this.lost = new Error("Authoritative agent memory became unavailable. Stop Pi; retain the remote copy for recovery.", { cause: error });
        this.options.onLost(this.lost);
      }).finally(() => { pending = false; });
    }, 20_000);
    this.heartbeat.unref?.();
  }
  async prepare(): Promise<void> {
    this.check(); this.options.signal.throwIfAborted(); this.startHeartbeat();
    if (this.prepared && this.mode === "remote") { await this.request({ action: "heartbeat" }, this.options.signal); return; }
    this.attempted = true;
    const prepared = preparedSchema.parse(await this.request({ action: "prepare", directory: this.paths.profile }, this.options.signal));
    if (prepared.profile !== this.profile || prepared.mode !== this.mode) throw new Error("Memory coordinator changed this turn's profile or host identity.");
    if (prepared.mode === "local") { this.home = prepared.home; this.prepared = true; return; }
    if (existsSync(this.paths.root)) throw new Error(`Remote working copy already exists: ${this.paths.root}`);
    privateDirectory(dirname(this.paths.root)); mkdirSync(this.paths.root, { mode: 0o700 });
    privateDirectory(this.paths.profile);
    const entries: MemoryEntry[] = [];
    let cursor: number | null = 0;
    do {
      const page = memoryHostContract.memoryPage.output.parse(await this.request({ action: "page", cursor }, this.options.signal));
      receiveEntries(this.paths.profile, entries, page.entries); cursor = page.nextCursor;
    } while (cursor !== null);
    await transferChunks(entries, async (entry, offset) => {
      const chunk = memoryHostContract.memoryRead.output.parse(await this.request({ action: "read", path: entry.path, offset }, this.options.signal));
      writeChunk(this.paths.profile, entry, offset, Buffer.from(chunk.data, "base64"));
    });
    verifyReceived(this.paths.profile, entries, prepared);
    // Pi binds a Unix socket inside the profile. Under a deep machine dataDir that
    // path passes the OS limit (107 bytes), so Pi gets a short private link instead.
    this.link = mkdtempSync(join(tmpdir(), "oc-"));
    symlinkSync(this.paths.home, join(this.link, "h"), "dir");
    this.home = join(this.link, "h"); this.prepared = true;
    await this.request({ action: "running" }, this.options.signal);
    this.running = true; this.check();
  }
  finish(): Promise<void> { return this.finishing ??= this.finalize(); }
  private async finalize(): Promise<void> {
    try {
      if (!this.attempted) return;
      if (this.mode === "local") { if (this.prepared) await this.request({ action: "commit" }); return; }
      if (!this.prepared) { await this.request({ action: "release", failed: false }); rmSync(this.paths.root, { recursive: true, force: true }); return; }
      // Only the caller that has awaited Pi exit may publish this recovery marker.
      const manifest = snapshot(this.paths.profile);
      atomicJson(join(this.paths.root, "ready.json"), { profile: this.profile, manifest });
      await this.request({ action: "receive", digest: manifest.digest, entries: manifest.entries.length, bytes: manifest.bytes });
      let cursor: number | null = 0;
      do { const page = manifestPage(manifest, cursor); await this.request({ action: "receivePage", entries: page.entries }); cursor = page.nextCursor; } while (cursor !== null);
      await transferChunks(manifest.entries, async (entry, offset) => { const data = readChunk(this.paths.profile, entry, offset); await this.request({ action: "write", path: entry.path, offset, data: data.toString("base64") }); });
      await this.request({ action: "commit" });
      rmSync(this.paths.root, { recursive: true, force: true });
    } catch (error) {
      const released = await this.request({ action: "release", failed: this.running || this.prepared }).catch(() => null);
      if (typeof released === "object" && released !== null && "committed" in released && released.committed === true) { rmSync(this.paths.root, { recursive: true, force: true }); return; }
      throw new Error(`Agent memory copy-back failed. The remote copy is retained at ${this.paths.profile}; the next turn must recover it before running. Cause: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally { this.ended = true; clearInterval(this.heartbeat); if (this.link) rmSync(this.link, { recursive: true, force: true }); }
  }
}
