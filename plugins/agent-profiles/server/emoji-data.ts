import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import dataset from "emoji-picker-react/dist/data/emojis-en";
import {
  emojiDataPath,
  emojiDataVersion,
  skinToneModifiers,
  type EmojiData,
  type EmojiEntry,
} from "./emoji-contract";

// The reaction picker's emoji dataset lives here rather than in app.js, which
// every BB window downloads and parses at startup. The app fetches it the
// first time a reaction picker opens (see app/shared/emoji-data.ts).

const categories = [
  ["smileys_people", "Smileys & People"],
  ["animals_nature", "Animals & Nature"],
  ["food_drink", "Food & Drink"],
  ["travel_places", "Travel & Places"],
  ["activities", "Activities"],
  ["objects", "Objects"],
  ["symbols", "Symbols"],
  ["flags", "Flags"],
] as const;

type SourceEmoji = { n: string[]; u: string; v?: string[] };
type Source = { emojis: Record<string, SourceEmoji[] | undefined> };

const character = (unified: string) =>
  String.fromCodePoint(...unified.split("-").map((part) => parseInt(part, 16)));

function entry(emoji: SourceEmoji): EmojiEntry {
  // The source lists its display label last.
  const label = emoji.n.at(-1);
  const names = [...new Set([label, ...emoji.n].filter((name) => name !== undefined).map((name) => name.toLowerCase()))];
  const result: EmojiEntry = { e: character(emoji.u), n: names };
  const variants = emoji.v ?? [];
  const toned = skinToneModifiers.map((tone) => variants.find((variant) => variant.split("-").includes(tone)));
  if (toned.every((variant) => variant !== undefined)) result.s = toned.map(character);
  const rest = variants.filter((variant) => !result.s || !toned.includes(variant));
  if (rest.length > 0) result.x = rest.map(character);
  return result;
}

export function buildEmojiData(source: Source = dataset): EmojiData {
  return {
    version: emojiDataVersion,
    categories: categories.map(([id, name]) => ({
      id,
      name,
      emojis: (source.emojis[id] ?? []).map(entry),
    })),
  };
}

export function registerEmojiDataRoute(bb: Pick<BbPluginApi, "http">) {
  let payload: { body: string; etag: string } | undefined;
  bb.http.route("GET", emojiDataPath, (context) => {
    if (!payload) {
      const body = JSON.stringify(buildEmojiData());
      payload = { body, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"` };
    }
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      ETag: payload.etag,
      // The app requests ?v=<emojiDataVersion>, so a matching URL never
      // changes content; anything else revalidates against the ETag.
      "Cache-Control":
        context.req.query("v") === emojiDataVersion
          ? "private, max-age=31536000, immutable"
          : "no-cache",
    };
    if (context.req.header("if-none-match") === payload.etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(payload.body, { headers });
  });
}
