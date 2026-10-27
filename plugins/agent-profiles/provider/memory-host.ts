import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { materializeHempi } from "./bridge/hempi-extension.js";
import { MEMORY_GUARD_FILE, isMemoryGuardName, memoryEntrySchema, memoryPendingSchema, profileNameSchema, type MemoryEntry, type MemoryManifest, type MemoryPending, type MemoryHostContract } from "./memory-contract.js";
import { atomicJson, bridgeDataDir, manifestDigest, manifestPage, memoryFile, privateDirectory, readChunk, readJson, receiveEntries, snapshot, syncDirectory, transferPaths, verifyReceived, writeChunk } from "./memory-files.js";

type Input<K extends keyof MemoryHostContract> = z.input<MemoryHostContract[K]["input"]>;
interface Retention { dispose(): Promise<void> }
interface PinnedProfiles {
  dataHome(): string;
  createProfile(name: string, instructions: string): void;
  lockProfile(directory: string, description: string): Promise<() => Promise<void>>;
  ProfileBusyError: new (...args: never[]) => Error;
}
interface Receiving { entries: MemoryEntry[]; files: Map<string, MemoryEntry>; expected: { digest: string; entries: number; bytes: number }; root: string }
interface Lease { pending: MemoryPending; root: string; base: MemoryManifest; files: Map<string, MemoryEntry>; unlock(): Promise<void>; retention: Retention; receiving?: Receiving; committed: boolean }
interface RemoteSnapshot { profile: string; root: string; manifest: MemoryManifest; files: Map<string, MemoryEntry> }
const manifestSchema = z.object({ entries: z.array(memoryEntrySchema), digest: z.string(), bytes: z.number() });
const installSchema = z.object({ phase: z.enum(["moving-old", "installing-new"]), oldNames: z.array(z.string()), newNames: z.array(z.string()) });
const receiptSchema = z.object({ profile: profileNameSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) });

export class AgentMemoryHost {
  private readonly leases = new Map<string, Lease>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly remotes = new Map<string, RemoteSnapshot>();
  private profiles: Promise<PinnedProfiles> | undefined;
  constructor(readonly dataDir: string) {}
  private pinned(): Promise<PinnedProfiles> {
    // The embedded revision is materialized under the worker's runtime dataDir, not a build-time import path.
    return this.profiles ??= import(pathToFileURL(join(dirname(dirname(materializeHempi(this.dataDir))), "node/src/optchat/profiles.mjs")).href) as Promise<PinnedProfiles>;
  }
  private async home(): Promise<string> {
    const profiles = await this.pinned();
    const home = profiles.dataHome();
    mkdirSync(join(home, "profiles"), { recursive: true, mode: 0o700 });
    return realpathSync.native(home);
  }
  private marker(profile: string): string { profileNameSchema.parse(profile); return join(this.dataDir, "agent-memory", `${profile}.json`); }
  private operation(operationId: string): string { z.string().uuid().parse(operationId); return join(this.dataDir, "agent-memory", "operations", operationId); }
  private receipt(operationId: string): z.infer<typeof receiptSchema> | null {
    const path = join(this.operation(operationId), "committed.json");
    if (!existsSync(path)) return null;
    try { return receiptSchema.parse(readJson(path)); }
    catch (error) { throw new Error(`Invalid memory commit receipt ${path}; manual recovery is required.`, { cause: error }); }
  }
  private pending(profile: string): MemoryPending | null {
    const path = this.marker(profile);
    if (!existsSync(path)) return null;
    return memoryPendingSchema.parse(readJson(path));
  }
  private persist(pending: MemoryPending): void { atomicJson(this.marker(pending.profile), pending); }
  private held(profile: string): boolean { return [...this.leases.values()].some((lease) => lease.pending.profile === profile); }
  private lease(operationId: string): Lease { const lease = this.leases.get(operationId); if (!lease) throw new Error("Memory operation has no held profile lock. Recovery is required."); return lease; }
  private serial<T>(profile: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(profile) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.queues.set(profile, next);
    void next.finally(() => { if (this.queues.get(profile) === next) this.queues.delete(profile); }).catch(() => undefined);
    return next;
  }
  async state(input: Input<"memoryState">) { return { home: await this.home(), pending: this.pending(input.profile), held: this.held(input.profile) }; }
  async acquire(input: Input<"memoryAcquire">, retain: () => Retention, signal?: AbortSignal) {
    return this.serial(input.profile, async () => {
      signal?.throwIfAborted();
      const previous = this.pending(input.profile);
      const existing = this.leases.get(input.operationId);
      if (existing) return { status: "acquired" as const, digest: existing.base.digest, entries: existing.base.entries.length, bytes: existing.base.bytes };
      if (this.held(input.profile)) return { status: "busy" as const, message: "The agent profile is held by another BB turn." };
      if (previous && (!input.recover || previous.operationId !== input.operationId)) throw new Error(`Previous memory operation ${previous.operationId} needs recovery on ${previous.hostId}.`);
      const pinned = await this.pinned(), home = await this.home();
      const root = join(realpathSync.native(join(home, "profiles")), input.profile);
      let unlock: () => Promise<void>;
      try { unlock = await pinned.lockProfile(root, `BB ${input.threadId} on ${input.hostId}`); }
      catch (error) { if (error instanceof pinned.ProfileBusyError) return { status: "busy" as const, message: error.message }; throw error; }
      let retention: Retention | undefined;
      try {
        signal?.throwIfAborted();
        retention = retain();
        if (!existsSync(root)) {
          if (previous) throw new Error("Central profile is missing while remote recovery is pending. Keep the remote copy for manual recovery.");
          pinned.createProfile(input.profile, input.instructions);
        }
        if (!previous && existsSync(join(root, MEMORY_GUARD_FILE))) throw new Error("Central profile has a recovery marker without its server journal. Keep both copies for manual recovery.");
        if (input.recover && previous && this.acceptInstalled(root, previous)) return { status: "committed" as const };
        if (input.recover) this.rollbackInterrupted(root, input.operationId);
        const base = snapshot(root);
        if (previous && previous.phase !== "prepared" && base.digest !== previous.baseDigest) throw new Error(`Central memory changed after ${previous.operationId}; refusing to overwrite it. Remote copy remains on ${previous.hostId}.`);
        const pending: MemoryPending = previous ?? { operationId: input.operationId, profile: input.profile, hostId: input.hostId, threadId: input.threadId, directory: input.directory, phase: "prepared", baseDigest: base.digest };
        atomicJson(join(this.operation(input.operationId), "base.json"), base);
        this.persist(pending);
        atomicJson(join(root, MEMORY_GUARD_FILE), { hostId: pending.hostId, operationId: pending.operationId, directory: pending.directory, baseDigest: pending.baseDigest });
        this.leases.set(input.operationId, { pending, root, base, files: new Map(base.entries.map((entry) => [entry.path, entry])), unlock, retention, committed: false });
        return { status: "acquired" as const, digest: base.digest, entries: base.entries.length, bytes: base.bytes };
      } finally { if (!this.leases.has(input.operationId)) { await unlock(); await retention?.dispose(); } }
    });
  }
  page(input: Input<"memoryPage">) { return manifestPage(this.lease(input.operationId).base, input.cursor); }
  read(input: Input<"memoryRead">) {
    const lease = this.lease(input.operationId), entry = lease.files.get(input.path);
    if (!entry) throw new Error("File is not in the locked memory snapshot.");
    return { data: readChunk(lease.root, entry, input.offset).toString("base64") };
  }
  running(input: Input<"memoryRunning">): null {
    const lease = this.lease(input.operationId);
    lease.pending.phase = "running"; this.persist(lease.pending); return null;
  }
  receive(input: Input<"memoryReceive">): null {
    const lease = this.lease(input.operationId);
    const root = join(dirname(lease.root), `.${lease.pending.profile}.${input.operationId}.incoming`);
    rmSync(root, { recursive: true, force: true }); privateDirectory(root);
    lease.receiving = { root, entries: [], files: new Map(), expected: { digest: input.digest, entries: input.entries, bytes: input.bytes } };
    return null;
  }
  receivePage(input: Input<"memoryReceivePage">): null {
    const receiving = this.lease(input.operationId).receiving;
    if (!receiving) throw new Error("Memory receiver was not initialized.");
    receiveEntries(receiving.root, receiving.entries, input.entries);
    for (const entry of input.entries) receiving.files.set(entry.path, entry);
    return null;
  }
  write(input: Input<"memoryWrite">): null {
    const receiving = this.lease(input.operationId).receiving;
    if (!receiving) throw new Error("Memory receiver was not initialized.");
    const entry = receiving.files.get(input.path);
    if (!entry) throw new Error("File is not in the incoming manifest.");
    writeChunk(receiving.root, entry, input.offset, Buffer.from(input.data, "base64")); return null;
  }
  private installPaths(root: string, operationId: string) {
    return { journal: join(this.operation(operationId), "install.json"), backup: join(dirname(root), `.${root.split(/[\\/]/).at(-1)}.${operationId}.previous`) };
  }
  private clearGuard(root: string): void {
    for (const name of readdirSync(root)) if (isMemoryGuardName(name)) rmSync(join(root, name), { force: true });
    syncDirectory(root);
  }
  private clearCommitted(root: string, pending: MemoryPending): void {
    const paths = this.installPaths(root, pending.operationId);
    this.clearGuard(root);
    rmSync(this.marker(pending.profile), { force: true }); syncDirectory(dirname(this.marker(pending.profile)));
    rmSync(paths.journal, { force: true });
    rmSync(paths.backup, { recursive: true, force: true });
    rmSync(join(dirname(root), `.${pending.profile}.${pending.operationId}.incoming`), { recursive: true, force: true });
    for (const name of ["base.json", "incoming.json"]) rmSync(join(this.operation(pending.operationId), name), { force: true });
  }
  private acceptInstalled(root: string, pending: MemoryPending): boolean {
    const receipt = this.receipt(pending.operationId);
    if (receipt && receipt.profile !== pending.profile) throw new Error("Memory commit receipt belongs to a different profile; refusing recovery.");
    if (!receipt) {
      const incomingPath = join(this.operation(pending.operationId), "incoming.json");
      if (!existsSync(incomingPath)) return false;
      const incoming = manifestSchema.parse(readJson(incomingPath));
      if (snapshot(root).digest !== incoming.digest) return false;
      atomicJson(join(this.operation(pending.operationId), "committed.json"), { profile: pending.profile, digest: incoming.digest });
    }
    this.clearCommitted(root, pending);
    return true;
  }
  private rollbackInterrupted(root: string, operationId: string): void {
    const paths = this.installPaths(root, operationId);
    if (!existsSync(paths.journal)) return;
    const journal = installSchema.parse(readJson(paths.journal));
    const old = manifestSchema.parse(readJson(join(this.operation(operationId), "base.json")));
    const next = manifestSchema.parse(readJson(join(this.operation(operationId), "incoming.json")));
    // Never erase a manual/native write made after a crashed worker released its lock.
    const allowed = new Map((journal.phase === "moving-old" ? old : next).entries.map((entry) => [entry.path, JSON.stringify(entry)]));
    for (const entry of snapshot(root).entries) if (allowed.get(entry.path) !== JSON.stringify(entry)) throw new Error("Central memory changed during interrupted copy-back; manual recovery is required.");
    const oldEntries = new Map(old.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
    if (existsSync(paths.backup)) for (const entry of snapshot(paths.backup).entries) if (oldEntries.get(entry.path) !== JSON.stringify(entry)) throw new Error("Memory rollback backup changed; manual recovery is required.");
    if (journal.phase === "installing-new") for (const name of journal.newNames) rmSync(memoryFile(root, name), { recursive: true, force: true });
    for (const name of journal.oldNames) { const backup = memoryFile(paths.backup, name); if (existsSync(backup)) renameSync(backup, memoryFile(root, name)); }
    if (snapshot(root).digest !== old.digest) throw new Error("Memory rollback is incomplete; the old and remote copies were retained.");
    rmSync(paths.journal, { force: true }); rmSync(paths.backup, { recursive: true, force: true });
  }
  commit(input: Input<"memoryCommit">): null {
    const lease = this.lease(input.operationId);
    if (lease.committed) return null;
    const receiving = lease.receiving;
    if (!receiving) throw new Error("Memory receiver was not initialized.");
    const incoming = verifyReceived(receiving.root, receiving.entries, receiving.expected);
    if (snapshot(lease.root).digest !== lease.base.digest) throw new Error("Central memory changed during the turn; refusing copy-back.");
    const paths = this.installPaths(lease.root, input.operationId);
    privateDirectory(paths.backup);
    const names = (root: string) => readdirSync(root).filter((name) => !isMemoryGuardName(name) && !lstatSync(join(root, name)).isSocket());
    const journal = { phase: "moving-old" as "moving-old" | "installing-new", oldNames: names(lease.root), newNames: names(receiving.root) };
    atomicJson(join(this.operation(input.operationId), "incoming.json"), incoming);
    atomicJson(paths.journal, journal);
    try {
      // Keep the profile directory and its OS-owned socket stable throughout installation.
      for (const name of journal.oldNames) renameSync(memoryFile(lease.root, name), memoryFile(paths.backup, name));
      syncDirectory(lease.root); syncDirectory(paths.backup);
      journal.phase = "installing-new"; atomicJson(paths.journal, journal);
      for (const name of journal.newNames) renameSync(memoryFile(receiving.root, name), memoryFile(lease.root, name));
      syncDirectory(lease.root); syncDirectory(receiving.root);
      if (snapshot(lease.root).digest !== incoming.digest) throw new Error("Installed memory checksum failed.");
      atomicJson(join(this.operation(input.operationId), "committed.json"), { profile: lease.pending.profile, digest: incoming.digest });
      lease.committed = true;
      this.clearCommitted(lease.root, lease.pending);
      return null;
    } catch (error) {
      if (!lease.committed) {
        try { this.rollbackInterrupted(lease.root, input.operationId); }
        catch (rollbackError) { throw new Error(`Copy-back and rollback failed. Keep ${paths.backup} and the remote copy for recovery.`, { cause: rollbackError }); }
      }
      throw error;
    }
  }
  async release(input: Input<"memoryRelease">): Promise<{ committed: boolean }> {
    const lease = this.leases.get(input.operationId);
    if (!lease) return { committed: this.receipt(input.operationId) !== null };
    if (!lease.committed) {
      if (!input.failed && lease.pending.phase !== "prepared") throw new Error("A running memory operation cannot be abandoned. Copy back or record failure first.");
      if (input.failed) { if (lease.pending.phase !== "prepared") lease.pending.phase = "failed"; this.persist(lease.pending); }
      else {
        this.clearGuard(lease.root);
        rmSync(this.marker(lease.pending.profile), { force: true });
        if (lease.receiving) rmSync(lease.receiving.root, { recursive: true, force: true });
        rmSync(this.operation(input.operationId), { recursive: true, force: true });
      }
    }
    this.leases.delete(input.operationId);
    await lease.unlock(); await lease.retention.dispose(); return { committed: lease.committed };
  }
  private remoteManifest(operationId: string): RemoteSnapshot | null {
    const cached = this.remotes.get(operationId);
    if (cached) return cached;
    const statePath = join(bridgeDataDir(this.dataDir), "memory-transfers", z.string().uuid().parse(operationId), "ready.json");
    if (!existsSync(statePath)) return null;
    const state = z.object({ profile: profileNameSchema, manifest: manifestSchema }).parse(readJson(statePath));
    if (manifestDigest(state.manifest.entries) !== state.manifest.digest) throw new Error("Retained remote manifest is corrupt.");
    const paths = transferPaths(bridgeDataDir(this.dataDir), operationId, state.profile);
    const result = { profile: state.profile, root: paths.profile, manifest: state.manifest, files: new Map(state.manifest.entries.map((entry) => [entry.path, entry])) };
    this.remotes.set(operationId, result);
    return result;
  }
  remote(input: Input<"memoryRemote">) {
    const remote = this.remoteManifest(input.operationId);
    return remote ? { ready: true as const, profile: remote.profile, digest: remote.manifest.digest, entries: remote.manifest.entries.length, bytes: remote.manifest.bytes } : { ready: false as const };
  }
  remotePage(input: Input<"memoryRemotePage">) { const remote = this.remoteManifest(input.operationId); if (!remote) throw new Error("Remote Pi has not confirmed exit. Refusing recovery."); return manifestPage(remote.manifest, input.cursor); }
  remoteRead(input: Input<"memoryRemoteRead">) {
    const remote = this.remoteManifest(input.operationId);
    const entry = remote?.files.get(input.path);
    if (!remote || !entry) throw new Error("File is not in a settled remote snapshot.");
    return { data: readChunk(remote.root, entry, input.offset).toString("base64") };
  }
  remoteDelete(input: Input<"memoryRemoteDelete">): null {
    const operationId = z.string().uuid().parse(input.operationId);
    this.remotes.delete(operationId);
    rmSync(join(bridgeDataDir(this.dataDir), "memory-transfers", operationId), { recursive: true, force: true });
    return null;
  }
  async dispose(): Promise<void> { for (const operationId of [...this.leases.keys()]) await this.release({ operationId, failed: true }); }
}
