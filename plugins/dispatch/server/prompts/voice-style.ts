// The "# Voice style" section of the voice prompt. GPT-Live has no speed or
// tone fields, so the owner's style choices become plain sentences here. This
// is the only place the voice prompt sets pace, tone, length, or backchannels.
import type { CustomVoice, VoiceStyle } from "../../shared/contract.js";

export const VOICE_STYLE_HEADING = "# Voice style";

type Choice = Exclude<keyof VoiceStyle, "notes">;
type Sentences<K extends Choice> = Readonly<Record<VoiceStyle[K], string>>;

export const PACE_SENTENCES: Sentences<"pace"> = {
  slower: "Speak slowly, with short pauses between ideas.",
  natural: "Speak at a natural, conversational pace.",
  faster: "Speak a little faster than usual, but keep every word clear.",
  brisk: "Speak briskly, like a quick status update.",
};

export const ENERGY_SENTENCES: Sentences<"energy"> = {
  calm: "Sound calm and steady, even when something goes wrong.",
  neutral: "Keep a neutral, matter-of-fact tone that is not overly cheerful.",
  warm: "Sound warm and friendly, but not overly cheerful.",
  upbeat: "Sound upbeat and cheerful.",
};

export const EXPRESSIVENESS_SENTENCES: Sentences<"expressiveness"> = {
  flat: "Keep your intonation even, with little emphasis.",
  balanced: "Use natural intonation, and stress only the words that matter.",
  expressive: "Use lively intonation and clear emphasis.",
};

export const LENGTH_SENTENCES: Sentences<"length"> = {
  terse: "Keep each turn to one short sentence.",
  balanced: "Keep each turn to one or two short sentences.",
  chatty: "Use up to four sentences in a turn when the extra context helps.",
};

// The OpenAI prompting guide names this heading; keep "Backchannel policy".
export const BACKCHANNEL_SENTENCES: Sentences<"backchannels"> = {
  few: "Backchannel policy: Use few backchannels, and only when the user pauses for a long time.",
  moderate: "Backchannel policy: Use moderate backchannels, and acknowledge naturally without competing with the main response.",
  frequent: 'Backchannel policy: Use frequent short backchannels, like "mm-hm" or "got it", without interrupting.',
};

/** The section text. `voice` is the chosen custom voice; its description goes first, as the OpenAI docs advise. */
export function voiceStyleSection(style: VoiceStyle, voice?: CustomVoice | null): string {
  const lines = [
    voice?.prompt ? `- Your voice: ${voice.prompt.trim()}` : null,
    `- ${PACE_SENTENCES[style.pace]}`,
    `- ${ENERGY_SENTENCES[style.energy]}`,
    `- ${EXPRESSIVENESS_SENTENCES[style.expressiveness]}`,
    `- ${LENGTH_SENTENCES[style.length]}`,
    `- ${BACKCHANNEL_SENTENCES[style.backchannels]}`,
    style.notes.trim() ? `- The user's style notes: ${style.notes.trim()}` : null,
  ];
  return [VOICE_STYLE_HEADING, "", ...lines.filter((line): line is string => line !== null)].join("\n");
}
