import { describe, expect, it } from "vitest";
import { VOICE_STYLE_CHOICES, defaultPreferences } from "../../shared/constants.js";
import type { VoiceStyle } from "../../shared/contract.js";
import { APP_CONTEXT, makeContext } from "../core-test-host.js";
import { writePreferences } from "../preferences.js";
import { assemblePrompts } from "./index.js";
import {
  BACKCHANNEL_SENTENCES,
  ENERGY_SENTENCES,
  EXPRESSIVENESS_SENTENCES,
  LENGTH_SENTENCES,
  PACE_SENTENCES,
  VOICE_STYLE_HEADING,
  voiceStyleSection,
} from "./voice-style.js";

const base = (): VoiceStyle => defaultPreferences().voiceStyle;
const sentences = {
  pace: PACE_SENTENCES,
  energy: ENERGY_SENTENCES,
  expressiveness: EXPRESSIVENESS_SENTENCES,
  length: LENGTH_SENTENCES,
  backchannels: BACKCHANNEL_SENTENCES,
} as const;

const cases = Object.entries(VOICE_STYLE_CHOICES).flatMap(([key, choices]) => choices.map((choice) => [key, choice] as const));

describe("voice style section", () => {
  it.each(cases)("writes one sentence for %s %s", (key, choice) => {
    const text = voiceStyleSection({ ...base(), [key]: choice });
    const sentence = (sentences[key as keyof typeof sentences] as Record<string, string>)[choice]!;
    expect(sentence).toMatch(/^[A-Z][^\n]*[.!?]$/);
    expect(sentence.replace(/^Backchannel policy: /, "").split(/(?<=[.!?])\s/)).toHaveLength(1);
    expect(text.split("\n")).toContain(`- ${sentence}`);
  });

  it("gives every choice its own sentence", () => {
    for (const map of Object.values(sentences)) {
      const values = Object.values(map);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("writes the default section", () => {
    expect(voiceStyleSection(base())).toBe(
      [
        VOICE_STYLE_HEADING,
        "",
        "- Speak at a natural, conversational pace.",
        "- Keep a neutral, matter-of-fact tone that is not overly cheerful.",
        "- Use natural intonation, and stress only the words that matter.",
        "- Keep each turn to one or two short sentences.",
        "- Backchannel policy: Use moderate backchannels, and acknowledge naturally without competing with the main response.",
      ].join("\n"),
    );
  });

  it("puts a custom voice description first and the notes last", () => {
    const lines = voiceStyleSection(
      { ...base(), notes: "  Spell out numbers.  " },
      { id: "voice_a", name: "Calm", prompt: " A calm voice. ", createdAt: "" },
    ).split("\n");
    expect(lines[2]).toBe("- Your voice: A calm voice.");
    expect(lines.at(-1)).toBe("- The user's style notes: Spell out numbers.");
  });

  it("is the one place the voice prompt sets turn length, and stays out of the backend prompt", async () => {
    const { ctx } = await makeContext();
    await writePreferences(ctx, { voiceStyle: { length: "terse" } });
    const prompts = await assemblePrompts(ctx, { context: APP_CONTEXT });
    expect(prompts.voice.builtIn).toContain(`${VOICE_STYLE_HEADING}\n`);
    expect(prompts.voice.builtIn).toContain(`- ${LENGTH_SENTENCES.terse}`);
    expect(prompts.voice.builtIn).not.toContain(LENGTH_SENTENCES.balanced);
    expect(prompts.backend.assembled).not.toContain(VOICE_STYLE_HEADING);
  });
});
