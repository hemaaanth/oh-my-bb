import { version as datasetVersion } from "emoji-picker-react/package.json";

// Shared by the server route and the app's reaction picker. The app only
// needs these few bytes; the dataset itself stays on the server and is
// fetched the first time a reaction picker opens.

/** Bump when the payload shape or its derivation changes. */
const payloadFormat = 1;

/** Keys the long-lived cache: changes with the dataset or payload shape. */
export const emojiDataVersion = `${payloadFormat}.${datasetVersion}`;

export const emojiDataPath = "/emoji-data";

export const emojiDataUrl = `/api/v1/plugins/agent-profiles/http${emojiDataPath}?v=${encodeURIComponent(emojiDataVersion)}`;

/** Light to dark, in the order `EmojiEntry.s` lists its variants. */
export const skinToneModifiers = ["1f3fb", "1f3fc", "1f3fd", "1f3fe", "1f3ff"] as const;

export type EmojiEntry = {
  /** The emoji character. */
  e: string;
  /** Lowercase search names; the first is the display label. */
  n: string[];
  /** One variant per skin tone, in `skinToneModifiers` order. */
  s?: string[];
  /** Further variants (mixed tones), matched by search only. */
  x?: string[];
};

export type EmojiCategory = {
  id: string;
  name: string;
  emojis: EmojiEntry[];
};

export type EmojiData = {
  version: string;
  categories: EmojiCategory[];
};
