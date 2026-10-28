import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { missingTranscript, parseProviderTranscript, type PromptReadInput } from "./prompt-parser";
import type { PromptResult } from "./prompt-contract";

// Reading is bounded even on a long-lived Codex session. Nothing is written.
const MAX_READ_BYTES = 192 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 60_000;
const MAX_DIRECTORY_ENTRIES = 50_000;

export async function findTranscript(home: string, provider: PromptReadInput["provider"], sessionId: string): Promise<string | null> {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return null;
  let entries = 0;
  if (provider === "claude-code") {
    const root = join(home, ".claude", "projects");
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs) {
      if (++entries > MAX_DIRECTORY_ENTRIES) break;
      if (!dir.isDirectory()) continue;
      const candidate = join(root, dir.name, `${sessionId}.jsonl`);
      const info = await lstat(candidate).catch(() => null);
      if (info?.isFile()) return candidate;
    }
    return null;
  }
  const root = join(home, ".codex", "sessions");
  const years = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const year of years) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    const months = await readdir(join(root, year.name), { withFileTypes: true }).catch(() => []);
    for (const month of months) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
      const days = await readdir(join(root, year.name, month.name), { withFileTypes: true }).catch(() => []);
      for (const day of days) {
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
        const dir = join(root, year.name, month.name, day.name);
        const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (++entries > MAX_DIRECTORY_ENTRIES) return null;
          if (!file.isFile() || !file.name.endsWith(`-${sessionId}.jsonl`)) continue;
          return join(dir, file.name);
        }
      }
    }
  }
  return null;
}

export async function* boundedLines(path: string, scan: PromptResult["scan"], signal?: AbortSignal): AsyncGenerator<string> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let dropping = false;
  try {
    for await (const block of stream) {
      if (signal?.aborted) throw signal.reason ?? new Error("Transcript read cancelled");
      const chunk = block as Buffer;
      const remaining = MAX_READ_BYTES - scan.bytesRead;
      if (remaining <= 0) { scan.limited = true; break; }
      const bytes = Math.min(chunk.length, remaining);
      scan.bytesRead += bytes;
      let offset = 0;
      while (offset < bytes) {
        if (scan.linesRead + scan.oversizedLines >= MAX_LINES) { scan.limited = true; return; }
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 || newline >= bytes ? bytes : newline;
        const segment = chunk.subarray(offset, end);
        if (!dropping) {
          pendingBytes += segment.length;
          if (pendingBytes > MAX_LINE_BYTES) {
            pending.length = 0; pendingBytes = 0; dropping = true; scan.oversizedLines++; scan.limited = true;
          } else if (segment.length) pending.push(segment);
        }
        if (newline < 0 || newline >= bytes) break;
        if (!dropping) {
          const line = Buffer.concat(pending, pendingBytes).toString("utf8");
          pending.length = 0; pendingBytes = 0;
          if (line.trim()) yield line;
        } else dropping = false;
        offset = newline + 1;
      }
      if (bytes < chunk.length) { scan.limited = true; break; }
    }
    // A final newline is optional in JSONL. A partial invalid JSON value is
    // passed to the parser, which counts and skips it without exposing text.
    if (pendingBytes && !dropping) yield Buffer.concat(pending, pendingBytes).toString("utf8");
  } finally { stream.destroy(); }
}

export async function readPromptOnHost(input: PromptReadInput, signal?: AbortSignal): Promise<PromptResult> {
  const scan: PromptResult["scan"] = { bytesRead: 0, linesRead: 0, malformedLines: 0, oversizedLines: 0, limited: false };
  const file = await findTranscript(homedir(), input.provider, input.sessionId);
  if (!file) return missingTranscript(input, scan);
  return parseProviderTranscript(boundedLines(file, scan, signal), input, scan);
}
