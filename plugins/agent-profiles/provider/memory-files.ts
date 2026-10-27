import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, chmodSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MEMORY_CHUNK_BYTES, MEMORY_PAGE_ENTRIES, isMemoryGuardName, memoryEntrySchema, operationIdSchema, profileNameSchema, relativePathSchema, type MemoryEntry, type MemoryManifest } from "./memory-contract.js";

const RESERVED = new Set(["lock.sock", "windows.sock"]);
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const manifestDigest = (entries: readonly MemoryEntry[]) => sha256(JSON.stringify(entries));
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Memory directory is not a real directory: ${path}`);
}
export function memoryFile(root: string, path: string): string {
  relativePathSchema.parse(path);
  const first = path.split("/")[0]!;
  if (RESERVED.has(first.toLowerCase()) || isMemoryGuardName(first)) throw new Error(`Reserved OptChat runtime name: ${path}`);
  privateDirectory(root);
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Memory transfers reject symbolic links: ${path}`);
  }
  return current;
}
export function atomicJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temp, path);
    if (process.platform !== "win32") { const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  } finally { rmSync(temp, { force: true }); }
}
export function readJson(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function hashFile(path: string): { size: number; digest: string; mode: number } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Memory transfers accept regular files only: ${path}`);
    const hash = createHash("sha256"), bytes = Buffer.allocUnsafe(MEMORY_CHUNK_BYTES);
    let size = 0, count: number;
    while ((count = readSync(fd, bytes, 0, bytes.length, null)) > 0) { hash.update(bytes.subarray(0, count)); size += count; }
    if (size !== stat.size) throw new Error(`Profile changed while reading: ${path}`);
    return { size, digest: hash.digest("hex"), mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}
export function snapshot(root: string): MemoryManifest {
  privateDirectory(root);
  const entries: MemoryEntry[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (isMemoryGuardName(relative)) continue;
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSocket()) continue;
      memoryFile(root, relative);
      if (stat.isDirectory()) { entries.push({ kind: "directory", path: relative, mode: stat.mode & 0o777 }); visit(path, relative); }
      else if (stat.isFile()) { const file = hashFile(path); entries.push({ kind: "file", path: relative, mode: file.mode, size: file.size, sha256: file.digest }); }
      else throw new Error(`Memory transfers reject links and special files: ${relative}`);
    }
  };
  visit(root, "");
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bytes = entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0);
  if (!Number.isSafeInteger(bytes)) throw new Error("Profile byte count is too large.");
  return { entries, digest: manifestDigest(entries), bytes };
}
export function manifestPage(manifest: MemoryManifest, cursor: number): { entries: MemoryEntry[]; nextCursor: number | null } {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > manifest.entries.length) throw new Error("Invalid memory manifest cursor.");
  const entries: MemoryEntry[] = [];
  let bytes = 0;
  for (let index = cursor; index < manifest.entries.length && entries.length < MEMORY_PAGE_ENTRIES; index++) {
    const entry = manifest.entries[index]!, size = Buffer.byteLength(JSON.stringify(entry));
    if (entries.length && bytes + size > MEMORY_CHUNK_BYTES) break;
    entries.push(entry); bytes += size;
  }
  const next = cursor + entries.length;
  return { entries, nextCursor: next < manifest.entries.length ? next : null };
}
export function receiveEntries(root: string, existing: MemoryEntry[], page: readonly MemoryEntry[]): void {
  for (const value of page) {
    const entry = memoryEntrySchema.parse(value);
    if (existing.length && existing[existing.length - 1]!.path >= entry.path) throw new Error("Memory manifest must have unique sorted paths.");
    const path = memoryFile(root, entry.path);
    if (entry.kind === "directory") privateDirectory(path);
    else { privateDirectory(dirname(path)); const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); closeSync(fd); truncateSync(path, entry.size); }
    existing.push(entry);
  }
}
export function readChunk(root: string, entry: MemoryEntry, offset: number): Buffer {
  if (entry.kind !== "file" || !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.size) throw new Error("Invalid memory file read.");
  const fd = openSync(memoryFile(root, entry.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Memory file changed type.");
    const bytes = Buffer.allocUnsafe(Math.min(MEMORY_CHUNK_BYTES, entry.size - offset));
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    if (count !== bytes.length) throw new Error(`Profile changed while transferring: ${entry.path}`);
    return bytes;
  } finally { closeSync(fd); }
}
export function writeChunk(root: string, entry: MemoryEntry, offset: number, bytes: Buffer): void {
  if (entry.kind !== "file" || !Number.isSafeInteger(offset) || offset < 0 || bytes.length < 1 || bytes.length > MEMORY_CHUNK_BYTES || offset + bytes.length > entry.size) throw new Error("Invalid memory file write.");
  const fd = openSync(memoryFile(root, entry.path), constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== entry.size) throw new Error("Memory target changed type or size.");
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written, offset + written);
      if (count <= 0) throw new Error("Memory file write made no progress.");
      written += count;
    }
  } finally { closeSync(fd); }
}
export function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function verifyReceived(root: string, entries: MemoryEntry[], expected: { digest: string; entries: number; bytes: number }): MemoryManifest {
  if (entries.length !== expected.entries || manifestDigest(entries) !== expected.digest) throw new Error("Memory manifest checksum failed.");
  // Set child permissions before parents, so a read-only directory is safe.
  for (const entry of [...entries].reverse()) {
    const path = memoryFile(root, entry.path);
    if (entry.kind === "file") {
      const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try { chmodSync(path, entry.mode); fsyncSync(fd); } finally { closeSync(fd); }
    } else { chmodSync(path, entry.mode); syncDirectory(path); }
  }
  syncDirectory(root);
  const result = snapshot(root);
  if (result.digest !== expected.digest || result.bytes !== expected.bytes) throw new Error("Memory content checksum failed.");
  return result;
}
/** BB gives each plugin sibling host-data and bridge-data dirs. The bridge writes remote copies, so host RPCs read them there. */
export function bridgeDataDir(hostDataDir: string): string {
  if (basename(hostDataDir) !== "host-data") throw new Error(`Expected the plugin host-data directory, got ${hostDataDir}.`);
  return join(dirname(hostDataDir), "bridge-data");
}
export function transferPaths(dataDir: string, operationId: string, profile: string): { root: string; home: string; profile: string } {
  operationIdSchema.parse(operationId); profileNameSchema.parse(profile);
  const root = join(dataDir, "memory-transfers", operationId), home = join(root, "optchat");
  return { root, home, profile: join(home, "profiles", profile) };
}
export function* fileChunks(entries: readonly MemoryEntry[]): Generator<{ entry: MemoryEntry; offset: number }> {
  for (const entry of entries) if (entry.kind === "file") for (let offset = 0; offset < entry.size; offset += MEMORY_CHUNK_BYTES) yield { entry, offset };
}
export async function transferChunks(entries: readonly MemoryEntry[], run: (entry: MemoryEntry, offset: number) => Promise<void>): Promise<void> {
  const chunks = fileChunks(entries);
  let failed = false, failure: unknown;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (!failed) {
      const next = chunks.next();
      if (next.done) return;
      try { await run(next.value.entry, next.value.offset); }
      catch (error) { failed = true; failure = error; return; }
    }
  }));
  if (failed) throw failure;
}
