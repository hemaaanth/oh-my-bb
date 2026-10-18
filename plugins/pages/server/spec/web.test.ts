import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpecError } from "./errors.js";
import type { Fetched, GetOptions } from "./webNet.js";

const calls: { url: string; options: GetOptions }[] = [];
let respond: (url: string) => Fetched = () => ({ ok: false, error: "offline" });
vi.mock("./webNet.js", async (real) => ({ ...(await real<typeof import("./webNet.js")>()), safeGet: async (url: string, options: GetOptions) => { calls.push({ url, options }); return respond(url); } }));
const { geocodeUrl, pickImages, pickLocation, prune, runWeb } = await import("./web.js");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ok = (body: Buffer | string, contentType = "application/json"): Fetched => ({ ok: true, url: "https://x/", headers: { "content-type": contentType }, body: Buffer.from(body) });
const host = () => createFakePluginHost({ pluginId: "pages" }).bb;

function page(index: number, mime = "image/jpeg", width = 4000) {
  return { index, title: `File:Photo ${index}.jpg`, imageinfo: [{ mime, width, height: 3000, url: `https://upload.wikimedia.org/o/${index}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:Photo_${index}.jpg`, thumburl: `https://upload.wikimedia.org/t/${index}.jpg?utm_source=x`, thumbwidth: 1280, thumbheight: 960, extmetadata: { Artist: { value: '<a href="//x">Ann &amp; Bo</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" } } }] };
}

beforeEach(() => { calls.length = 0; respond = () => ({ ok: false, error: "offline" }); });

describe("tile", () => {
  it("fetches a Mapbox tile for the theme and caches it", async () => {
    const bb = host();
    respond = () => ok(PNG, "image/png");
    await expect(runWeb(bb, "tile", { z: 3, x: 1, y: 2, theme: "dark" })).rejects.toThrow("Map tiles need a Mapbox token");
    expect(calls).toHaveLength(0);
    const first = await runWeb(bb, "tile", { z: 3, x: 1, y: 2, theme: "dark" }, "k&1");
    expect(first).toEqual({ dataUrl: `data:image/png;base64,${PNG.toString("base64")}` });
    expect(calls[0].url).toBe("https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/3/1/2@2x?access_token=k%261");
    expect(calls[0].options.hosts?.has("api.mapbox.com")).toBe(true);
    expect(await runWeb(bb, "tile", { z: 3, x: 1, y: 2, theme: "dark" }, "k&1")).toEqual(first);
    expect(calls).toHaveLength(1);
    await runWeb(bb, "tile", { z: 3, x: 1, y: 2 }, "k&1");
    expect(calls[1].url).toContain("/light-v11/");
  });
  it("refuses tiles off the grid and bodies that aren't png", async () => {
    const bb = host();
    await expect(runWeb(bb, "tile", { z: 2, x: 4, y: 0 }, "k")).rejects.toThrow(SpecError);
    await expect(runWeb(bb, "tile", { z: 30, x: 0, y: 0 }, "k")).rejects.toThrow(SpecError);
    await expect(runWeb(bb, "tile", { z: 1, x: 0, y: 0, theme: "neon" }, "k")).rejects.toThrow(SpecError);
    respond = () => ok("<html>", "image/png");
    await expect(runWeb(bb, "tile", { z: 1, x: 1, y: 1 }, "k")).rejects.toThrow("The map tile didn't load.");
    expect(calls).toHaveLength(1);
  });
});

describe("geocode", () => {
  it("asks Photon once and remembers hits and misses", async () => {
    const bb = host();
    respond = (url) => ok(JSON.stringify(url.includes("nowhere") ? { features: [] } : { features: [{ geometry: { coordinates: [-9.14, 38.71] } }] }));
    expect(await runWeb(bb, "geocode", { name: "  Lisbon " })).toEqual({ lat: 38.71, lng: -9.14 });
    expect(await runWeb(bb, "geocode", { name: "lisbon" })).toEqual({ lat: 38.71, lng: -9.14 });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.hosts?.has("photon.komoot.io")).toBe(true);
    await expect(runWeb(bb, "geocode", { name: "Nowhere" })).rejects.toThrow("Couldn't find “Nowhere” on the map.");
    await expect(runWeb(bb, "geocode", { name: "Nowhere" })).rejects.toThrow("Couldn't find");
    expect(calls).toHaveLength(2);
  });
  it("reports a failed fetch as a short SpecError", async () => {
    await expect(runWeb(host(), "geocode", { name: "Porto" })).rejects.toThrow("Place lookup failed: offline.");
    await expect(runWeb(host(), "geocode", { name: "" })).rejects.toThrow(SpecError);
  });
  it("builds a biased request and reads the first feature", () => {
    const url = new URL(geocodeUrl("porto", { lat: 41.1496, lng: -8.611 }));
    expect([url.host, url.searchParams.get("q"), url.searchParams.get("lat"), url.searchParams.get("lon")]).toEqual(["photon.komoot.io", "porto", "41.150", "-8.611"]);
    expect(pickLocation({ features: [{ geometry: { coordinates: [200, 10] } }] })).toBeNull();
    expect(pickLocation({})).toBeNull();
  });
});

describe("search", () => {
  it("returns credited photos, JPEGs first, and caches the answer", async () => {
    const bb = host();
    respond = () => ok(JSON.stringify({ query: { pages: [page(2, "image/png"), page(1), page(3, "image/jpeg", 100), page(4)] } }));
    const { images } = await runWeb(bb, "search", { query: "Lisbon tram", count: 3 }) as { images: { url: string; creator: string }[] };
    expect(images.map((i) => i.url)).toEqual(["https://upload.wikimedia.org/t/1.jpg", "https://upload.wikimedia.org/t/4.jpg", "https://upload.wikimedia.org/t/2.jpg"]);
    expect(images[0].creator).toBe("Ann & Bo");
    expect(new URL(calls[0].url).searchParams.get("gsrsearch")).toBe("lisbon tram filetype:bitmap");
    await runWeb(bb, "search", { query: "LISBON  tram" });
    expect(calls).toHaveLength(1);
  });
  it("says when nothing was found", async () => {
    respond = () => ok(JSON.stringify({ query: { pages: [] } }));
    await expect(runWeb(host(), "search", { query: "zzz" })).rejects.toThrow("No photos found for “zzz”.");
    expect(pickImages(null, 3)).toEqual([]);
  });
});

describe("image", () => {
  it("proxies a real image as a data URL", async () => {
    respond = () => ok(PNG, "image/png");
    expect(await runWeb(host(), "image", { url: "https://example.com/a.png" })).toEqual({ dataUrl: `data:image/png;base64,${PNG.toString("base64")}` });
    expect(calls[0].options.maxBytes).toBe(5 * 1024 * 1024);
    expect(calls[0].options.hosts).toBeUndefined();
  });
  it("refuses bodies that only claim to be images", async () => {
    respond = () => ok("<html>", "image/png");
    await expect(runWeb(host(), "image", { url: "https://example.com/b.png" })).rejects.toThrow("isn't a png");
    respond = () => ok(PNG, "text/html");
    await expect(runWeb(host(), "image", { url: "https://example.com/c.png" })).rejects.toThrow("isn't a png");
    await expect(runWeb(host(), "image", { url: "not a url" })).rejects.toThrow("valid URL");
  });
  it("serves a stale copy when the origin is down", async () => {
    const bb = host();
    respond = () => ok(PNG, "image/png");
    await runWeb(bb, "image", { url: "https://example.com/d.png" });
    bb.storage.database().prepare("UPDATE spec_web_cache SET expires_at = 0").run();
    respond = () => ({ ok: false, error: "offline" });
    expect(await runWeb(bb, "image", { url: "https://example.com/d.png" })).toHaveProperty("dataUrl");
    expect(calls).toHaveLength(2);
  });
});

describe("prune", () => {
  it("drops least recently used rows down to 80% of the cap", async () => {
    const bb = host();
    respond = () => ok(PNG, "image/png");
    for (const n of [1, 2, 3, 4, 5]) await runWeb(bb, "image", { url: `https://example.com/${n}.png` });
    const db = bb.storage.database();
    db.prepare("UPDATE spec_web_cache SET bytes = 100, used_at = CAST(substr(key, -5, 1) AS INTEGER)").run();
    prune(db, 400);
    expect(db.prepare<[], { key: string }>("SELECT key FROM spec_web_cache ORDER BY key").all().map((r) => r.key)).toEqual(["img:https://example.com/3.png", "img:https://example.com/4.png", "img:https://example.com/5.png"]);
  });
});
