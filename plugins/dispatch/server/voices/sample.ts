// Voice samples on demand. A cached sample comes back at once; a new one runs
// a short GPT-Live session with the saved voice style. Samples are refused
// while a call is live, and never write to the calls ledger.
import { VOICE_SAMPLE } from "../../shared/constants.js";
import type { CustomVoice, RpcOutput, VoiceStyle } from "../../shared/contract.js";
import type { ServerContext } from "../context.js";
import { openCalls } from "../ledger.js";
import { openaiKey } from "../live-session.js";
import { readPreferences } from "../preferences.js";
import { voiceStyleSection } from "../prompts/voice-style.js";
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

export async function voiceSample(
  ctx: ServerContext,
  input: { voice: string },
  record: typeof recordSample = recordSample,
): Promise<RpcOutput<"voiceSample">> {
  if (openCalls(ctx).length > 0) throw new Error(SAMPLE_BUSY_ERROR);
  const voice = input.voice.trim();
  if (voice === "") throw new Error("Choose a voice to play.");
  const preferences = await readPreferences(ctx);
  const custom = preferences.customVoices.find((item) => item.id === voice) ?? null;
  const instructions = sampleInstructions(preferences.voiceStyle, custom);
  const key = sampleKey(`${preferences.voiceModel}:${voice}`, instructions, VOICE_SAMPLE.text);

  const cached = readSample(ctx.db, key);
  if (cached) return { wav: Buffer.from(cached).toString("base64"), cached: true };

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
  const wav = await job;
  return { wav: Buffer.from(wav).toString("base64"), cached: false };
}
