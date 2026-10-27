import { randomBytes, randomUUID } from "node:crypto";
import type { ExperimentalHostClient, PluginRpcResult } from "@get-bb/plugin-sdk";
import { MEMORY_CLOCK_WINDOW_MS, memorySignature, validMemorySignature } from "../provider/memory-auth";
import { MEMORY_HTTP_BYTES, memoryRequestSchema, type MemoryHostContract, type MemoryPending } from "../provider/memory-contract";
import { transferChunks } from "../provider/memory-files";
import type { MemoryEntry } from "../provider/memory-contract";

type Output<K extends keyof MemoryHostContract> = PluginRpcResult<MemoryHostContract[K]>;
export type MemoryHostClient = Pick<ExperimentalHostClient<MemoryHostContract>, "call">;
interface Capability {
  secret: string; expires: number; profile: string; instructions: string; threadId: string; hostId: string; primary: string;
  operationId?: string; acquiring?: Promise<Output<"memoryAcquire">>; acquired: boolean; abandoned: boolean; completed: boolean; sent: number; received: number; nonces: Map<string, number>;
  loggedOutcome?: string;
}
const CAPABILITY_IDLE_MS = 15 * 60_000;
class BusyMemoryError extends Error { readonly code = 75; }
export function createAgentMemoryService(options: { host: MemoryHostClient; primaryHostId(): Promise<string | null>; info(message: string): void }) {
  const capabilities = new Map<string, Capability>();
  const recoveries = new Map<string, Promise<void>>();
  const host = options.host;
  async function issue(input: { profile: string; instructions: string; threadId: string; hostId: string }) {
    const primary = await options.primaryHostId();
    if (!primary) throw new Error("Agent memory requires a configured primary BB host.");
    const now = Date.now();
    for (const [key, cap] of capabilities) if (cap.expires < now && !cap.acquired && !cap.acquiring) capabilities.delete(key);
    const key = randomUUID(), secret = randomBytes(32).toString("hex");
    capabilities.set(key, { ...input, primary, secret, expires: now + CAPABILITY_IDLE_MS, acquired: false, abandoned: false, completed: false, sent: 0, received: 0, nonces: new Map() });
    return { key, secret, profile: input.profile, mode: input.hostId === primary ? "local" : "remote" };
  }
  function log(cap: Capability, outcome: string) {
    if (cap.loggedOutcome === outcome) return;
    cap.loggedOutcome = outcome;
    options.info(`Agent memory ${cap.profile}: ${outcome}; downloaded ${cap.sent} bytes, uploaded ${cap.received} bytes; turn ${cap.operationId}.`);
  }
  async function cleanupRemote(pending: Pick<MemoryPending, "operationId" | "hostId">) {
    try { await host.call("memoryRemoteDelete", { operationId: pending.operationId }, { hostId: pending.hostId }); }
    catch { options.info(`Agent memory committed; retained remote copy ${pending.operationId} on ${pending.hostId} could not be removed.`); }
  }
  async function recover(profile: string, primary: string): Promise<void> {
    const existing = recoveries.get(profile);
    if (existing) return existing;
    const recovering = (async () => {
      const state = await host.call("memoryState", { profile }, { hostId: primary });
      if (!state.pending) return;
      if (state.held) throw new BusyMemoryError("Another BB turn holds this profile.");
      const pending = state.pending, remote = { hostId: pending.hostId };
      const recoveryInput = { operationId: pending.operationId, profile, hostId: pending.hostId, threadId: pending.threadId, directory: pending.directory, instructions: "", recover: true };
      const acquired = await host.call("memoryAcquire", recoveryInput, { hostId: primary, timeoutMs: 30 * 60_000 });
      if (acquired.status === "busy") throw new BusyMemoryError(acquired.message);
      if (acquired.status === "committed") {
        options.info(`Agent memory ${profile}: recovered already-installed memory; transferred 0 bytes; turn ${pending.operationId}.`);
        await cleanupRemote(pending);
        return;
      }
      if (pending.phase === "prepared") {
        // Pi cannot start until the durable running transition has been acknowledged.
        await host.call("memoryRelease", { operationId: pending.operationId, failed: false }, { hostId: primary });
        await cleanupRemote(pending);
        return;
      }
      let bytes = 0;
      try {
        const settled = await host.call("memoryRemote", { operationId: pending.operationId }, remote);
        if (!settled.ready || settled.profile !== profile) throw new Error(`Previous remote turn ${pending.operationId} on ${pending.hostId} has not confirmed Pi exit. Memory is blocked, not reset. Keep ${pending.directory} for recovery.`);
        await host.call("memoryReceive", { operationId: pending.operationId, digest: settled.digest, entries: settled.entries, bytes: settled.bytes }, { hostId: primary });
        const entries: MemoryEntry[] = [];
        let cursor: number | null = 0;
        do {
          const page: Output<"memoryRemotePage"> = await host.call("memoryRemotePage", { operationId: pending.operationId, cursor }, remote);
          entries.push(...page.entries);
          await host.call("memoryReceivePage", { operationId: pending.operationId, entries: page.entries }, { hostId: primary });
          cursor = page.nextCursor;
        } while (cursor !== null);
        await transferChunks(entries, async (entry, offset) => {
          const data = await host.call("memoryRemoteRead", { operationId: pending.operationId, path: entry.path, offset }, remote);
          bytes += Buffer.from(data.data, "base64").length;
          await host.call("memoryWrite", { operationId: pending.operationId, path: entry.path, offset, data: data.data }, { hostId: primary });
        });
        await host.call("memoryCommit", { operationId: pending.operationId }, { hostId: primary, timeoutMs: 30 * 60_000 });
        await host.call("memoryRelease", { operationId: pending.operationId, failed: false }, { hostId: primary });
        options.info(`Agent memory ${profile}: recovered ${bytes} bytes from ${pending.hostId}; turn ${pending.operationId}.`);
        await cleanupRemote(pending);
      } catch (error) {
        await host.call("memoryRelease", { operationId: pending.operationId, failed: true }, { hostId: primary }).catch(() => undefined);
        throw new Error(`Memory recovery failed for ${profile}: ${error instanceof Error ? error.message : String(error)}. Remote copy ${pending.operationId} on ${pending.hostId} was retained.`, { cause: error });
      }
    })();
    recoveries.set(profile, recovering);
    try { await recovering; } finally { if (recoveries.get(profile) === recovering) recoveries.delete(profile); }
  }
  async function bodyText(request: Request): Promise<string> {
    if (!request.body) throw new Error("Missing memory request body.");
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > MEMORY_HTTP_BYTES) { await reader.cancel(); throw new Error("Memory request exceeds 128 KiB."); } chunks.push(next.value); }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
  }
  function response(result: unknown, status = 200): Response { return Response.json(result, { status, headers: { "Cache-Control": "no-store" } }); }
  async function handle(request: Request): Promise<Response> {
    const key = request.headers.get("x-agent-memory-key") ?? "", cap = capabilities.get(key);
    if (!cap || cap.expires < Date.now()) return response({ ok: false, error: { message: "Memory capability expired or unknown." } }, 401);
    try {
      const text = await bodyText(request), time = request.headers.get("x-agent-memory-time") ?? "", nonce = request.headers.get("x-agent-memory-nonce") ?? "";
      const timestamp = Number(time), now = Date.now();
      if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MEMORY_CLOCK_WINDOW_MS || !/^[a-f0-9-]{36}$/.test(nonce) || cap.nonces.has(nonce) || !validMemorySignature(memorySignature(cap.secret, time, nonce, text), request.headers.get("x-agent-memory-signature") ?? "")) return response({ ok: false, error: { message: "Invalid or replayed memory signature." } }, 401);
      for (const [seen, at] of cap.nonces) { if (at >= now - MEMORY_CLOCK_WINDOW_MS * 2) break; cap.nonces.delete(seen); }
      cap.nonces.set(nonce, now); cap.expires = now + CAPABILITY_IDLE_MS;
      const input = memoryRequestSchema.parse(JSON.parse(text));
      if (cap.operationId && cap.operationId !== input.operationId) throw new Error("Memory capability is bound to another turn.");
      cap.operationId = input.operationId;
      const target = { hostId: cap.primary }, operation = { operationId: input.operationId };
      if (input.action === "prepare") {
        if (cap.completed || cap.abandoned) throw new Error("Memory capability already finished or cancelled its turn.");
        if (cap.acquired) {
          const acquired = await host.call("memoryAcquire", { ...operation, profile: cap.profile, hostId: cap.hostId, threadId: cap.threadId, directory: input.directory, instructions: cap.instructions, recover: false }, target);
          if (acquired.status === "busy") throw new BusyMemoryError(acquired.message);
          if (acquired.status !== "acquired") throw new Error("Memory operation was already committed. Start a fresh turn.");
          return response({ ok: true, result: { mode: "remote", profile: cap.profile, digest: acquired.digest, entries: acquired.entries, bytes: acquired.bytes } });
        }
        const state = await host.call("memoryState", { profile: cap.profile }, target);
        if (state.held) throw new BusyMemoryError("Another turn holds this agent profile.");
        if (state.pending) await recover(cap.profile, cap.primary);
        if (cap.abandoned) throw new Error("Memory turn was cancelled before acquiring its profile.");
        if (cap.hostId === cap.primary) return response({ ok: true, result: { mode: "local", profile: cap.profile, home: state.home } });
        const acquiring = host.call("memoryAcquire", { ...operation, profile: cap.profile, hostId: cap.hostId, threadId: cap.threadId, directory: input.directory, instructions: cap.instructions, recover: false }, { ...target, timeoutMs: 30 * 60_000 });
        cap.acquiring = acquiring;
        try {
          const acquired = await acquiring;
          if (acquired.status === "busy") throw new BusyMemoryError(acquired.message);
          if (acquired.status !== "acquired") throw new Error("Memory operation was already committed. Start a fresh turn.");
          cap.acquired = true;
          return response({ ok: true, result: { mode: "remote", profile: cap.profile, digest: acquired.digest, entries: acquired.entries, bytes: acquired.bytes } });
        } finally { if (cap.acquiring === acquiring) cap.acquiring = undefined; }
      }
      if (input.action === "heartbeat") {
        if (cap.acquired) { const state = await host.call("memoryState", { profile: cap.profile }, target); if (!state.held || state.pending?.operationId !== input.operationId) throw new Error("The authoritative memory lock was lost. Stop Pi and retain the remote copy."); }
        return response({ ok: true, result: null });
      }
      if (input.action === "release") {
        cap.abandoned = true;
        await cap.acquiring?.catch(() => undefined);
        const result = cap.acquired ? await host.call("memoryRelease", { ...operation, failed: input.failed }, target) : { committed: cap.completed };
        cap.acquired = false;
        if (result.committed) { cap.completed = true; log(cap, "committed"); await cleanupRemote({ ...operation, hostId: cap.hostId }); }
        else if (input.failed) log(cap, "copy-back failed; remote copy retained");
        else log(cap, "cancelled before Pi start");
        return response({ ok: true, result });
      }
      if (input.action === "commit" && cap.hostId === cap.primary) { cap.completed = true; log(cap, "local"); return response({ ok: true, result: { committed: true } }); }
      if (!cap.acquired || cap.completed) throw new Error("Memory operation has no held authoritative lock.");
      switch (input.action) {
        case "page": return response({ ok: true, result: await host.call("memoryPage", { ...operation, cursor: input.cursor }, target) });
        case "read": { const result = await host.call("memoryRead", { ...operation, path: input.path, offset: input.offset }, target); cap.sent += Buffer.from(result.data, "base64").length; return response({ ok: true, result }); }
        case "running": await host.call("memoryRunning", operation, target); break;
        case "receive": await host.call("memoryReceive", { ...operation, digest: input.digest, entries: input.entries, bytes: input.bytes }, target); break;
        case "receivePage": await host.call("memoryReceivePage", { ...operation, entries: input.entries }, target); break;
        case "write": await host.call("memoryWrite", { ...operation, path: input.path, offset: input.offset, data: input.data }, target); cap.received += Buffer.from(input.data, "base64").length; break;
        case "commit": await host.call("memoryCommit", operation, { ...target, timeoutMs: 30 * 60_000 }); await host.call("memoryRelease", { ...operation, failed: false }, target); cap.acquired = false; cap.completed = true; log(cap, "committed"); await cleanupRemote({ ...operation, hostId: cap.hostId }); return response({ ok: true, result: { committed: true } });
      }
      return response({ ok: true, result: null });
    } catch (error) {
      const code = error instanceof BusyMemoryError ? 75 : 1;
      if (code !== 75) options.info(`Agent memory ${cap.profile}: request failed: ${error instanceof Error ? error.message : String(error)}; turn ${cap.operationId ?? "unbound"}.`);
      return response({ ok: false, error: { code, message: error instanceof Error ? error.message : "Memory operation failed." } }, code === 75 ? 409 : 500);
    }
  }
  const sweeping = new Set<Capability>();
  const watchdog = setInterval(() => {
    const staleBefore = Date.now() + CAPABILITY_IDLE_MS - 90_000;
    for (const cap of capabilities.values()) {
      if (!cap.acquired || !cap.operationId || cap.expires > staleBefore || sweeping.has(cap)) continue;
      sweeping.add(cap);
      const operationId = cap.operationId;
      void (async () => {
        const state = await host.call("memoryState", { profile: cap.profile }, { hostId: cap.primary });
        if (cap.expires > staleBefore || !state.held || state.pending?.operationId !== operationId) return;
        // No timeout steals a running profile. A settled remote marker is required.
        if (state.pending.phase !== "prepared") {
          const remote = await host.call("memoryRemote", { operationId }, { hostId: cap.hostId });
          if (!remote.ready) return;
        }
        await host.call("memoryRelease", { operationId, failed: state.pending.phase !== "prepared" }, { hostId: cap.primary });
        cap.acquired = false;
        cap.abandoned = true;
        log(cap, "disconnected turn; profile released only after Pi exit or before Pi start");
      })().catch(() => undefined).finally(() => sweeping.delete(cap));
    }
  }, 30_000);
  watchdog.unref?.();
  return { issue, handle, dispose() { clearInterval(watchdog); capabilities.clear(); } };
}
