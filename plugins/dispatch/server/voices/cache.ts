// The voice sample cache. One row per (voice, style, sample text), in the
// plugin database. The total size is capped; the least recently played go first.
import { createHash } from "node:crypto";
import { VOICE_SAMPLE } from "../../shared/constants.js";
import type { ServerContext } from "../context.js";

type Db = ServerContext["db"];

/** The cache key. Any change to the voice, the style text, or the sample line makes a new sample. */
export function sampleKey(voice: string, instructions: string, text: string): string {
  return createHash("sha256").update(JSON.stringify([voice, instructions, text])).digest("hex");
}

export function readSample(db: Db, key: string, now = Date.now()): Uint8Array | null {
  const row = db.prepare("SELECT wav FROM voice_samples WHERE key = ?").get(key) as { wav: Uint8Array } | undefined;
  if (!row) return null;
  db.prepare("UPDATE voice_samples SET used_at = ? WHERE key = ?").run(now, key);
  return new Uint8Array(row.wav);
}

/** Store a sample, then drop the least recently used until the total fits under `capBytes`. */
export function writeSample(
  db: Db,
  input: { key: string; voice: string; wav: Uint8Array },
  options: { now?: number; capBytes?: number } = {},
): void {
  const now = options.now ?? Date.now();
  const cap = options.capBytes ?? VOICE_SAMPLE.cacheBytes;
  db.prepare(
    `INSERT INTO voice_samples (key, voice, wav, bytes, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET wav = excluded.wav, bytes = excluded.bytes, used_at = excluded.used_at`,
  ).run(input.key, input.voice, Buffer.from(input.wav), input.wav.length, now, now);
  const rows = db.prepare("SELECT key, bytes FROM voice_samples ORDER BY used_at DESC, created_at DESC").all() as Array<{
    key: string;
    bytes: number;
  }>;
  const drop = db.prepare("DELETE FROM voice_samples WHERE key = ?");
  let total = 0;
  let full = false;
  for (const row of rows) {
    // The new sample always stays, even when it alone is over the cap.
    if (row.key !== input.key && (full || total + row.bytes > cap)) {
      full = true;
      drop.run(row.key);
      continue;
    }
    total += row.bytes;
  }
}
