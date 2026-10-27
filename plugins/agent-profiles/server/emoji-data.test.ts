import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { emojiDataPath, emojiDataVersion, type EmojiData } from "./emoji-contract";
import { buildEmojiData, registerEmojiDataRoute } from "./emoji-data";

function app() {
  const hono = new Hono();
  registerEmojiDataRoute({
    http: {
      route: (method, path, handler) => hono.on(method, path, handler),
      experimental_websocket: () => {},
    },
  });
  return hono;
}

describe("emoji data", () => {
  it("builds one catalog with labels, keywords, and skin tones", () => {
    const data = buildEmojiData();
    expect(data.version).toBe(emojiDataVersion);
    expect(data.categories.map((category) => category.name)).toEqual([
      "Smileys & People",
      "Animals & Nature",
      "Food & Drink",
      "Travel & Places",
      "Activities",
      "Objects",
      "Symbols",
      "Flags",
    ]);
    const emojis = data.categories.flatMap((category) => category.emojis);
    expect(emojis.length).toBeGreaterThan(1800);
    const wave = emojis.find((emoji) => emoji.e === "👋");
    expect(wave?.n[0]).toBe("waving hand");
    expect(wave?.n).toContain("hello");
    expect(wave?.s).toEqual(["👋🏻", "👋🏼", "👋🏽", "👋🏾", "👋🏿"]);
    const handshake = emojis.find((emoji) => emoji.e === "🤝");
    expect(handshake?.s).toHaveLength(5);
    expect(handshake?.x?.length).toBe(20);
  });

  it("keeps an emoji without a full tone set searchable by its variants", () => {
    const data = buildEmojiData({
      emojis: { smileys_people: [{ n: ["Odd", "odd one"], u: "1f600", v: ["1f600-1f3fb"] }] },
    });
    expect(data.categories[0]?.emojis).toEqual([{ e: "😀", n: ["odd one", "odd"], x: ["😀🏻"] }]);
  });

  it("serves the versioned payload with long-lived caching and revalidation", async () => {
    const server = app();
    const response = await server.request(`${emojiDataPath}?v=${encodeURIComponent(emojiDataVersion)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const body = (await response.json()) as EmojiData;
    expect(body).toEqual(buildEmojiData());

    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^".+"$/);
    const revalidated = await server.request(emojiDataPath, { headers: { "if-none-match": etag! } });
    expect(revalidated.status).toBe(304);
  });

  it("does not let a mismatched version pin a long-lived copy", async () => {
    const response = await app().request(`${emojiDataPath}?v=stale`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });
});
