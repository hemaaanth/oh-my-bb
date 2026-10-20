// Makes the pre-made voice samples in voice-samples/ again: one GPT-Live
// session per listed voice, in the default voice style, then MP3 with ffmpeg.
//
//   npm run samples -- --env <dotenv file with OPENAI_API_KEY> [--voices quartz,gleam]
//
// It costs about 1¢ per voice. The key is read from the dotenv file and only
// goes into the Authorization header; it is never printed. The report shows
// timings for each session, so slow steps are easy to see.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VOICE_MODELS, VOICE_OPTIONS, VOICE_SAMPLE } from "../shared/constants.js";
import type { BundledSample } from "../shared/voice-samples.js";
import { SAMPLES_DIR } from "../server/voices/bundled.js";
import { DEFAULT_VOICE_STYLE, sampleFingerprint, sampleInstructions, sampleSession, sampleSpeech } from "../server/voices/sample.js";
import { recordSample, type SampleStep } from "../server/voices/sample-session.js";
import { wrapWav } from "../server/voices/wav.js";

const MIME = "audio/mpeg";
const BITRATE = "32k";
/** Sessions at once. Each one is a separate GPT-Live session. */
const PARALLEL = 3;
/** Shorter audio than this means the voice did not say the line. */
const MIN_SECONDS = 2;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** Reads one variable from a dotenv file. The value is returned, never printed. */
function readDotenv(path: string, name: string): string {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1] !== name) continue;
    const raw = match[2] ?? "";
    return /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  throw new Error(`${name} is not set in the dotenv file.`);
}

/** OpenAI errors can quote part of a key. */
const redact = (text: string) => text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-…");

type Timings = Partial<Record<"open" | "started" | "firstAudio" | "firstVoice" | "lastVoice" | "lastAudio" | "end" | "closed" | "settled", number>> & { ending?: "quiet" | "cap" | "closed" };

async function makeOne(apiKey: string, voice: string, work: string) {
  const model = VOICE_MODELS[0];
  const instructions = sampleInstructions(DEFAULT_VOICE_STYLE, null);
  const speak = sampleSpeech(VOICE_SAMPLE.text);
  const start = performance.now();
  const at = () => Math.round(performance.now() - start);
  const timings: Timings = {};
  const events = new Set<string>();
  const trace = (step: SampleStep, detail?: string) => {
    if (step === "open") timings.open = at();
    else if (step === "event") {
      events.add(detail ?? "unknown");
      if (detail === "session.started") timings.started = at();
      if (detail === "session.output_audio.delta") timings.lastAudio = at();
    } else if (step === "first-audio") timings.firstAudio = at();
    else if (step === "first-voice") timings.firstVoice = at();
    else if (step === "voiced") timings.lastVoice = at();
    else if (step === "quiet" || step === "cap") {
      timings.end = at();
      timings.ending = step;
    } else if (step === "closed") {
      timings.closed = at();
      if (timings.end === undefined) {
        timings.end = at();
        timings.ending = "closed";
      }
    } else if (step === "settled") timings.settled = at();
  };
  try {
    const pcm = await recordSample({ apiKey, session: sampleSession({ model, voice, instructions, speak }), speak, trace });
    const seconds = pcm.length / 2 / VOICE_SAMPLE.rate;
    if (seconds < MIN_SECONDS) return { voice, timings, events, error: `only ${seconds.toFixed(1)} s of audio` };
    const wav = join(work, `${voice}.wav`);
    const file = `${voice}.mp3`;
    writeFileSync(wav, wrapWav(pcm, VOICE_SAMPLE.rate));
    // Trim silence at both ends, then encode mono MP3 at the session rate.
    const trim = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse";
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-af", trim, "-ac", "1", "-c:a", "libmp3lame", "-b:a", BITRATE, "-map_metadata", "-1", join(outDir, file)]);
    const sample: BundledSample = { file, bytes: statSync(join(outDir, file)).size, seconds: Number(seconds.toFixed(2)) };
    return { voice, timings, events, sample };
  } catch (error) {
    return { voice, timings, events, error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
// The script is bundled into node_modules/.cache, so look for the package by its manifest.
let root = here;
while (!statSync(join(root, "package.json"), { throwIfNoEntry: false })) root = dirname(root);
const outDir = join(root, SAMPLES_DIR);

const envPath = option("env");
if (!envPath) throw new Error("Pass --env <dotenv file with OPENAI_API_KEY>.");
const apiKey = readDotenv(envPath, "OPENAI_API_KEY");
const only = option("voices")?.split(",").map((name) => name.trim());
const voices = VOICE_OPTIONS.map((voice) => voice.name).filter((name) => !only || only.includes(name));
const work = mkdtempSync(join(tmpdir(), "dispatch-samples-"));

const results: Awaited<ReturnType<typeof makeOne>>[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < voices.length) {
      const voice = voices[next++]!;
      const result = await makeOne(apiKey, voice, work);
      results.push(result);
      const t = result.timings;
      console.log(
        [
          voice.padEnd(9),
          result.error ? `FAILED ${result.error}` : `ok ${result.sample!.seconds}s ${result.sample!.bytes} B`,
          `open ${t.open ?? "-"}`,
          `started ${t.started ?? "-"}`,
          `first-audio ${t.firstAudio ?? "-"}`,
          `first-voice ${t.firstVoice ?? "-"}`,
          `last-voice ${t.lastVoice ?? "-"}`,
          `last-audio ${t.lastAudio ?? "-"}`,
          `end ${t.end ?? "-"} (${t.ending ?? "-"})`,
          `closed ${t.closed ?? "-"}`,
          `settled ${t.settled ?? "-"}`,
        ].join("  "),
      );
    }
  }),
);
rmSync(work, { recursive: true, force: true });

const made = results.filter((result) => result.sample).sort((a, b) => a.voice.localeCompare(b.voice));
// With --voices, the other voices keep their entries.
const before = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as { voices: Record<string, BundledSample>; refused: string[] };
const kept = only ? Object.entries(before.voices).filter(([voice]) => !voices.includes(voice)) : [];
const keptRefused = only ? before.refused.filter((voice) => !voices.includes(voice)) : [];
const manifest = {
  model: VOICE_MODELS[0],
  mime: MIME,
  fingerprint: sampleFingerprint(VOICE_MODELS[0], sampleInstructions(DEFAULT_VOICE_STYLE, null)),
  made: new Date().toISOString().slice(0, 10),
  voices: Object.fromEntries([...kept, ...made.map((result) => [result.voice, result.sample!] as const)].sort(([a], [b]) => a.localeCompare(b))),
  refused: [...keptRefused, ...results.filter((result) => result.error).map((result) => result.voice)].sort(),
};
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const events = [...new Set(results.flatMap((result) => [...result.events]))].sort();
console.log(`\nServer event types seen: ${events.join(", ")}`);
console.log(`Made ${made.length}. Without a sample: ${manifest.refused.join(", ") || "none"}`);
console.log(`Total ${made.reduce((sum, result) => sum + result.sample!.bytes, 0)} bytes in ${outDir}`);
