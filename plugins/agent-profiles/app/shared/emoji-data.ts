import { emojiDataUrl, type EmojiCategory, type EmojiData, type EmojiEntry } from "../../server/emoji-contract";

export type { EmojiCategory, EmojiData, EmojiEntry } from "../../server/emoji-contract";

type Fetch = (url: string) => Promise<Pick<Response, "ok" | "status" | "json">>;

export type EmojiIndex = {
  data: EmojiData;
  /** Every character (base and variants) to its entry, for labels and recents. */
  byCharacter: Map<string, EmojiEntry>;
};

let loading: Promise<EmojiIndex> | null = null;
let loaded: EmojiIndex | null = null;

/** The dataset if this window already loaded it, so reopening skips the loading state. */
export const loadedEmojiData = () => loaded;

/**
 * Fetch the emoji dataset once per window. A failed load is forgotten so the
 * next call (the picker's retry) fetches again.
 */
export function loadEmojiData(fetcher: Fetch = (url) => fetch(url)): Promise<EmojiIndex> {
  loading ??= (async () => {
    const response = await fetcher(emojiDataUrl);
    if (!response.ok) throw new Error(`Emoji data request failed (${response.status})`);
    const data = (await response.json()) as EmojiData | null;
    if (!data || !Array.isArray(data.categories)) throw new Error("Emoji data is malformed");
    loaded = indexEmojiData(data);
    return loaded;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export function resetEmojiDataForTests() {
  loading = null;
  loaded = null;
}

export function indexEmojiData(data: EmojiData): EmojiIndex {
  const byCharacter = new Map<string, EmojiEntry>();
  for (const category of data.categories) {
    for (const emoji of category.emojis) {
      for (const character of [emoji.e, ...(emoji.s ?? []), ...(emoji.x ?? [])]) {
        if (!byCharacter.has(character)) byCharacter.set(character, emoji);
      }
    }
  }
  return { data, byCharacter };
}

/**
 * Matches a name or keyword containing the query (case-insensitive), or an
 * emoji character containing it, so pasting 👍 or 👍🏽 finds thumbs up.
 */
export function emojiMatcher(query: string): (emoji: EmojiEntry) => boolean {
  const needle = query.toLowerCase();
  return (emoji) =>
    emoji.n.some((name) => name.includes(needle)) ||
    [emoji.e, ...(emoji.s ?? []), ...(emoji.x ?? [])].some((character) => character.includes(needle));
}

/** Categories narrowed to the query's matches; empty categories are dropped. */
export function searchEmoji(data: EmojiData, query: string): EmojiCategory[] {
  const matches = emojiMatcher(query);
  return data.categories
    .map((category) => ({ ...category, emojis: category.emojis.filter(matches) }))
    .filter((category) => category.emojis.length > 0);
}

/** 0 is the default (yellow) tone; 1–5 index `EmojiEntry.s` from light to dark. */
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;

export const withSkinTone = (emoji: EmojiEntry, tone: SkinTone) =>
  (tone > 0 && emoji.s?.[tone - 1]) || emoji.e;

// Recently used reactions, in the format emoji-picker-react kept under the
// same key, so history from before the picker was replaced carries over.
const recentKey = "epr_suggested";
const recentLimit = 14;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type RecentItem = { unified: string; original: string; count: number };

const unifiedOf = (character: string) =>
  [...character].map((part) => part.codePointAt(0)!.toString(16)).join("-");

const characterOf = (unified: string) =>
  String.fromCodePoint(...unified.split("-").map((part) => parseInt(part, 16)));

function readRecentItems(storage: Storage): RecentItem[] {
  try {
    const value = JSON.parse(storage.getItem(recentKey) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is RecentItem => typeof item?.unified === "string" && /^[0-9a-f]+(-[0-9a-f]+)*$/i.test(item.unified))
      : [];
  } catch {
    return [];
  }
}

export function readRecentEmoji(storage: Storage): string[] {
  return readRecentItems(storage).map((item) => characterOf(item.unified));
}

export function rememberRecentEmoji(storage: Storage, emoji: string, base: string = emoji) {
  const unified = unifiedOf(emoji);
  const recent = readRecentItems(storage);
  const existing = recent.find((item) => item.unified === unified);
  const next = [
    { unified, original: existing?.original ?? unifiedOf(base), count: (existing?.count ?? 0) + 1 },
    ...recent.filter((item) => item !== existing),
  ].slice(0, recentLimit);
  try {
    storage.setItem(recentKey, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: recents are best-effort.
  }
}
