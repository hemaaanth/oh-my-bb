// Voice preferences: the voice name, the voice style, and custom voices.
import {
  CUSTOM_VOICE_NAME_MAX,
  CUSTOM_VOICE_PREFIX,
  CUSTOM_VOICE_PROMPT_MAX,
  VOICE_STYLE_CHOICES,
  VOICE_STYLE_NOTES_MAX,
} from "../../shared/constants.js";
import type { CustomVoice, VoiceStyle } from "../../shared/contract.js";

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;

/**
 * Any saved voice name is kept, listed or not, so a voice that leaves the list
 * does not change under the owner. Only a value that is not a name falls back.
 */
export function normaliseVoice(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const voice = value.trim();
  return voice === "" || voice.length > 64 ? fallback : voice;
}

export function normaliseVoiceStyle(value: unknown, fallback: VoiceStyle): VoiceStyle {
  const raw = isObject(value) ? value : {};
  return {
    pace: oneOf(VOICE_STYLE_CHOICES.pace, raw.pace, fallback.pace),
    energy: oneOf(VOICE_STYLE_CHOICES.energy, raw.energy, fallback.energy),
    expressiveness: oneOf(VOICE_STYLE_CHOICES.expressiveness, raw.expressiveness, fallback.expressiveness),
    length: oneOf(VOICE_STYLE_CHOICES.length, raw.length, fallback.length),
    backchannels: oneOf(VOICE_STYLE_CHOICES.backchannels, raw.backchannels, fallback.backchannels),
    notes: typeof raw.notes === "string" ? raw.notes.trim().slice(0, VOICE_STYLE_NOTES_MAX) : fallback.notes,
  };
}

/** OpenAI allows 100 prompt voices per organisation, so the list never needs more. */
const CUSTOM_VOICES_MAX = 100;

export function normaliseCustomVoices(value: unknown, fallback: CustomVoice[]): CustomVoice[] {
  if (!Array.isArray(value)) return fallback;
  const voices: CustomVoice[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id.startsWith(CUSTOM_VOICE_PREFIX)) continue;
    if (voices.some((voice) => voice.id === item.id)) continue;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, CUSTOM_VOICE_NAME_MAX) : "";
    voices.push({
      id: item.id,
      name: name === "" ? item.id : name,
      prompt: typeof item.prompt === "string" ? item.prompt.slice(0, CUSTOM_VOICE_PROMPT_MAX) : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    });
  }
  return voices.slice(0, CUSTOM_VOICES_MAX);
}

/** The custom voice the owner chose, or null when the voice is a name. */
export function chosenCustomVoice(preferences: { voice: string; customVoices: readonly CustomVoice[] }): CustomVoice | null {
  return preferences.customVoices.find((voice) => voice.id === preferences.voice) ?? null;
}

/** The `audio.output.voice` value: a name, or `{ id }` for a custom voice. */
export function sessionVoice(voice: string): string | { id: string } {
  return voice.startsWith(CUSTOM_VOICE_PREFIX) ? { id: voice } : voice;
}
