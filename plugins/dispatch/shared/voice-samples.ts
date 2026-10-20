// Pre-made voice samples that ship in the package, in voice-samples/. They use
// the default voice style, so playing one needs no key and no API call.
// scripts/make-voice-samples.ts makes them again.
import manifest from "../voice-samples/manifest.json";

export type BundledSample = { file: string; bytes: number; seconds: number };

export const BUNDLED_SAMPLES: {
  model: string;
  mime: string;
  /** sampleFingerprint() of the model, prompt, and line the files were made with. */
  fingerprint: string;
  made: string;
  voices: Readonly<Record<string, BundledSample>>;
  /** Listed voices that GPT-Live refused when the samples were made. */
  refused: readonly string[];
} = manifest;

/** Is there a pre-made sample of this voice for this voice model? */
export const hasBundledSample = (voice: string, model: string): boolean =>
  model === BUNDLED_SAMPLES.model && Object.hasOwn(BUNDLED_SAMPLES.voices, voice);
