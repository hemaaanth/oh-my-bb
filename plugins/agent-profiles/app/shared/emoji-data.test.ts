import { afterEach, describe, expect, it, vi } from "vitest";
import { emojiDataUrl, type EmojiData } from "../../server/emoji-contract";
import {
  loadedEmojiData,
  loadEmojiData,
  readRecentEmoji,
  rememberRecentEmoji,
  resetEmojiDataForTests,
  searchEmoji,
  withSkinTone,
} from "./emoji-data";

const data: EmojiData = {
  version: "test",
  categories: [
    {
      id: "smileys_people",
      name: "Smileys & People",
      emojis: [
        { e: "😀", n: ["grinning face", "happy", "smile"] },
        { e: "👍", n: ["thumbs up", "+1", "yes"], s: ["👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"] },
      ],
    },
    { id: "food_drink", name: "Food & Drink", emojis: [{ e: "🍕", n: ["pizza", "slice"] }] },
  ],
};

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

afterEach(() => resetEmojiDataForTests());

describe("emoji data loading", () => {
  it("fetches the versioned dataset once per window", async () => {
    const fetcher = vi.fn(() => ok(data));
    const [first, second] = await Promise.all([loadEmojiData(fetcher), loadEmojiData(fetcher)]);
    expect(first).toBe(second);
    expect(await loadEmojiData(fetcher)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(emojiDataUrl);
    expect(loadedEmojiData()).toBe(first);
    expect(first.byCharacter.get("👍🏽")?.e).toBe("👍");
  });

  it("forgets a failed load so retry fetches again", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve(null) })
      .mockReturnValueOnce(ok({ nope: true }))
      .mockReturnValueOnce(ok(data));
    await expect(loadEmojiData(fetcher)).rejects.toThrow("503");
    expect(loadedEmojiData()).toBeNull();
    await expect(loadEmojiData(fetcher)).rejects.toThrow("malformed");
    await expect(loadEmojiData(fetcher)).resolves.toMatchObject({ data });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("emoji search", () => {
  const found = (query: string) => searchEmoji(data, query).flatMap((category) => category.emojis.map((emoji) => emoji.e));

  it("matches names and keywords case-insensitively, keeping categories", () => {
    expect(found("SMILE")).toEqual(["😀"]);
    expect(found("s")).toEqual(["😀", "👍", "🍕"]);
    expect(searchEmoji(data, "pizza").map((category) => category.name)).toEqual(["Food & Drink"]);
    expect(found("zzz")).toEqual([]);
  });

  it("matches by emoji character, including skin tone variants", () => {
    expect(found("👍")).toEqual(["👍"]);
    expect(found("👍🏾")).toEqual(["👍"]);
    expect(found("🍕")).toEqual(["🍕"]);
  });

  it("applies a skin tone only where the emoji has one", () => {
    const [smile, thumbs] = data.categories[0]!.emojis;
    expect(withSkinTone(thumbs!, 0)).toBe("👍");
    expect(withSkinTone(thumbs!, 3)).toBe("👍🏽");
    expect(withSkinTone(smile!, 3)).toBe("😀");
  });
});

describe("recent reactions", () => {
  it("reads and writes emoji-picker-react's history format, newest first", () => {
    const storage = memoryStorage();
    storage.setItem("epr_suggested", JSON.stringify([{ unified: "1f600", original: "1f600", count: 2 }]));
    rememberRecentEmoji(storage, "👍🏽", "👍");
    rememberRecentEmoji(storage, "😀");
    expect(readRecentEmoji(storage)).toEqual(["😀", "👍🏽"]);
    expect(JSON.parse(storage.getItem("epr_suggested")!)).toEqual([
      { unified: "1f600", original: "1f600", count: 3 },
      { unified: "1f44d-1f3fd", original: "1f44d", count: 1 },
    ]);
  });

  it("ignores corrupt history", () => {
    const storage = memoryStorage();
    storage.setItem("epr_suggested", "{");
    expect(readRecentEmoji(storage)).toEqual([]);
    storage.setItem("epr_suggested", JSON.stringify([{ unified: "<img>" }, { unified: "2764-fe0f" }]));
    expect(readRecentEmoji(storage)).toEqual(["❤️"]);
  });
});
