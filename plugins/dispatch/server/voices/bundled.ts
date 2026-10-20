// Reads the pre-made samples from the package directory. The host runs the
// server from its source file or from dist/server.js, so the directory is found
// by walking up from this module.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_SAMPLES } from "../../shared/voice-samples.js";

export const SAMPLES_DIR = "voice-samples";
/** How far up from this module the package directory can be. */
const MAX_LEVELS = 6;

let found: string | null | undefined;

/** The package's voice-samples directory, or null when it cannot be found. */
export function samplesDir(): string | null {
  if (found !== undefined) return found;
  found = null;
  try {
    let at = dirname(fileURLToPath(import.meta.url));
    for (let level = 0; level < MAX_LEVELS; level += 1) {
      const candidate = join(at, SAMPLES_DIR);
      if (existsSync(join(candidate, "manifest.json"))) {
        found = candidate;
        break;
      }
      const up = dirname(at);
      if (up === at) break;
      at = up;
    }
  } catch {
    // Not a file URL. Samples are made live instead.
  }
  return found;
}

const loaded = new Map<string, Uint8Array>();

/** The pre-made sample of a listed voice, or null when none ships. */
export function readBundledSample(voice: string, dir: string | null = samplesDir()): { audio: Uint8Array; mime: string } | null {
  const entry = Object.hasOwn(BUNDLED_SAMPLES.voices, voice) ? BUNDLED_SAMPLES.voices[voice] : undefined;
  if (!entry || !dir) return null;
  const path = join(dir, entry.file);
  let audio = loaded.get(path);
  if (!audio) {
    try {
      audio = new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
    loaded.set(path, audio);
  }
  return { audio, mime: BUNDLED_SAMPLES.mime };
}
