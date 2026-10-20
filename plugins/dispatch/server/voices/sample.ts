// Voice samples on demand. A listed voice in the default style plays the
// pre-made sample that ships in the package: no key, no API call. Anything else
// (a custom voice, or "Preview with this style") comes from the cache, or runs a
// short GPT-Live session. Live samples are refused while a call is live, and
// never write to the calls ledger.
import { createHash } from "node:crypto";
import { defaultPreferences, VOICE_SAMPLE } from "../../shared/constants.js";
import type { CustomVoice, RpcOutput, VoiceStyle } from "../../shared/contract.js";
import type { ServerContext } from "../context.js";
import { openCalls } from "../ledger.js";
import { openaiKey } from "../live-session.js";
import { readPreferences } from "../preferences.js";
import { voiceStyleSection } from "../prompts/voice-style.js";
import { hasBundledSample } from "../../shared/voice-samples.js";
import { readBundledSample } from "./bundled.js";
import { readSample, sampleKey, writeSample } from "./cache.js";
import { sessionVoice } from "./normalise.js";
import { recordSample, type SampleSessionConfig } from "./sample-session.js";
import { wrapWav } from "./wav.js";

export const SAMPLE_BUSY_ERROR = "A call is live. Play samples after it ends.";

const SAMPLE_PROMPT = `# Dispatch voice sample

You are reading one short sample line, so the user can hear your voice before they choose it. Say the line you are given once, then stop. Do not add a greeting, a question, or anything else.`;

/** Words for session.input and session.commentary.append, as the GPT-Live greeting guide does it. */
export const sampleSpeech = (text: string) => `Say this line now, in English, then stop and listen: "${text}"`;

/** The sample session's instructions: the sample rules, then the same voice style section a call uses. */
export function sampleInstructions(style: VoiceStyle, voice: CustomVoice | null): string {
  return [SAMPLE_PROMPT, voiceStyleSection(style, voice)].join("\n\n");
}

/** Identifies what a sample was made from. The pre-made samples record it, and a test checks it still matches. */
export function sampleFingerprint(model: string, instructions: string): string {
  return createHash("sha256").update([model, instructions, VOICE_SAMPLE.text].join("\n")).digest("hex");
}

export const DEFAULT_VOICE_STYLE: VoiceStyle = defaultPreferences().voiceStyle;

const isDefaultStyle = (style: VoiceStyle): boolean =>
  (Object.keys(DEFAULT_VOICE_STYLE) as Array<keyof VoiceStyle>).every((key) => style[key].trim() === DEFAULT_VOICE_STYLE[key]);

export function sampleSession(input: { model: string; voice: string; instructions: string; speak: string }): SampleSessionConfig {
  return {
    model: input.model,
    instructions: input.instructions,
    input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: input.speak }] }],
    audio: { format: { type: "audio/pcm", rate: VOICE_SAMPLE.rate }, output: { voice: sessionVoice(input.voice) } },
  };
}

/** Two plays of the same new sample share one session. */
const pending = new Map<string, Promise<Uint8Array>>();

const base64 = (audio: Uint8Array) => Buffer.from(audio).toString("base64");

/**
 * `style: "default"` plays the voice as the list shows it. `"saved"` plays it
 * with the user's voice style, for "Preview with this style".
 */
export async function voiceSample(
  ctx: ServerContext,
  input: { voice: string; style?: "default" | "saved" },
  record: typeof recordSample = recordSample,
): Promise<RpcOutput<"voiceSample">> {
  const voice = input.voice.trim();
  if (voice === "") throw new Error("Choose a voice to play.");
  const preferences = await readPreferences(ctx);
  const custom = preferences.customVoices.find((item) => item.id === voice) ?? null;
  const style = input.style === "saved" ? preferences.voiceStyle : DEFAULT_VOICE_STYLE;

  if (!custom && isDefaultStyle(style) && hasBundledSample(voice, preferences.voiceModel)) {
    const bundled = readBundledSample(voice);
    if (bundled) return { audio: base64(bundled.audio), mime: bundled.mime, source: "bundled" };
  }

  if (openCalls(ctx).length > 0) throw new Error(SAMPLE_BUSY_ERROR);
  const instructions = sampleInstructions(style, custom);
  const key = sampleKey(`${preferences.voiceModel}:${voice}`, instructions, VOICE_SAMPLE.text);

  const cached = readSample(ctx.db, key);
  if (cached) return { audio: base64(cached), mime: "audio/wav", source: "cache" };

  const apiKey = await openaiKey(ctx);
  let job = pending.get(key);
  if (!job) {
    const speak = sampleSpeech(VOICE_SAMPLE.text);
    job = record({ apiKey, session: sampleSession({ model: preferences.voiceModel, voice, instructions, speak }), speak })
      .then((pcm) => {
        const wav = wrapWav(pcm, VOICE_SAMPLE.rate);
        writeSample(ctx.db, { key, voice, wav });
        return wav;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return { audio: base64(await job), mime: "audio/wav", source: "live" };
}
