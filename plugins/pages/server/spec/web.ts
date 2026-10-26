// Web lookups for spec components: map tiles, place names, web image search, image proxy.
// Tiles come from Mapbox (OpenStreetMap data), place names from Photon, photos from Wikimedia
// Commons. Those three are fixed hosts; the only model-written URL fetched is an https image,
// through the address-checked proxy in webNet.ts. Answers are cached in the plugin database.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WEB_METHODS } from "../../contract.js";
import { SpecError } from "./errors.js";
import { declaresImage, safeGet, sniffImage, type GetOptions } from "./webNet.js";
import { https, plain, record } from "./web-format.js";
import { findWikiPhoto, wikiPhotoSchema } from "./wiki.js";
import type { WikiPhoto } from "./wiki.js";
const wikiResultSchema = z.object({ photo: wikiPhotoSchema.nullable() });

export type WebMethod = (typeof WEB_METHODS)[number];

const DAY_MS = 86_400_000;
// Mapbox's own cache headers keep tiles 12 hours.
const TTL = { tile: DAY_MS / 2, image: 7 * DAY_MS, found: 30 * DAY_MS, miss: DAY_MS };
const CACHE_BYTES = 64 * 1024 * 1024;
const ROW_OVERHEAD = 256;
/** Photon is fair-use; one request a second keeps well inside it. */
const GEOCODE_SPACING_MS = 1_100;
export const MAX_TILE_ZOOM = 19;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MAPBOX = new Set(["api.mapbox.com"]);
const PHOTON = new Set(["photon.komoot.io"]);
const COMMONS = new Set(["commons.wikimedia.org"]);
const WIKI = new Set(["en.wikipedia.org", "commons.wikimedia.org"]);
const json = (hosts: ReadonlySet<string>): GetOptions => ({ accept: "application/json", maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, hosts });

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const text = z.string().trim().min(1).max(200);
const inputs = {
  tile: z.object({ z: z.number().int().min(0).max(MAX_TILE_ZOOM), x: z.number().int().min(0), y: z.number().int().min(0), theme: z.enum(["light", "dark"]).default("light") }).strict().refine((t) => t.x < 2 ** t.z && t.y < 2 ** t.z, "no such tile"),
  geocode: z.object({ name: text, near: z.object({ lat, lng }).strict().optional() }).strict(),
  search: z.object({ query: text, count: z.number().int().min(1).max(8).default(1) }).strict(),
  image: z.object({ url: z.string().trim().min(1).max(2000) }).strict(),
  wiki: z.object({ title: text }).strict(),
};

export type Located = { lat: number; lng: number };
/** A photo found for a description, with what its licence asks to be credited. */
export type FoundImage = { url: string; width: number; height: number; title: string; creator: string; license: string; licenseUrl: string | null; sourceUrl: string };

// --- Cache: one table, least recently used rows go first once it passes its size. -----------
// Ported from GenUI web/cache.ts (Apache-2.0).

const ready = new WeakSet<Database.Database>();
function database(bb: BbPluginApi): Database.Database {
  const db = bb.storage.database();
  if (!ready.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS spec_web_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS spec_web_cache_used ON spec_web_cache (used_at);`);
    ready.add(db);
  }
  return db;
}

type Hit = { value: unknown; expired: boolean };
function cacheGet(bb: BbPluginApi, key: string): Hit | null {
  try {
    const db = database(bb);
    const row = db.prepare<[string], { value: string; expires_at: number }>("SELECT value, expires_at FROM spec_web_cache WHERE key = ?").get(key);
    if (!row) return null;
    const now = Date.now();
    db.prepare("UPDATE spec_web_cache SET used_at = ? WHERE key = ?").run(now, key);
    return { value: JSON.parse(row.value), expired: row.expires_at <= now };
  } catch (error) {
    bb.log.warn(`spec web cache read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function cachePut(bb: BbPluginApi, key: string, value: unknown, ttl: number) {
  try {
    const db = database(bb);
    const body = JSON.stringify(value);
    const now = Date.now();
    db.prepare(`INSERT INTO spec_web_cache (key, value, bytes, expires_at, used_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, expires_at = excluded.expires_at, used_at = excluded.used_at`).run(key, body, body.length + key.length + ROW_OVERHEAD, now + ttl, now);
    prune(db, CACHE_BYTES);
  } catch (error) {
    bb.log.warn(`spec web cache write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Drops least recently used rows until the cache is under 80% of `cap`. */
export function prune(db: Database.Database, cap: number) {
  let total = db.prepare<[], { total: number }>("SELECT COALESCE(SUM(bytes), 0) AS total FROM spec_web_cache").get()?.total ?? 0;
  if (total <= cap) return;
  const oldest = db.prepare<[], { key: string; bytes: number }>("SELECT key, bytes FROM spec_web_cache ORDER BY used_at ASC LIMIT 64");
  const remove = db.prepare("DELETE FROM spec_web_cache WHERE key = ?");
  while (total > cap * 0.8) {
    const rows = oldest.all();
    if (rows.length === 0) return;
    db.transaction(() => { for (const row of rows) { if (total <= cap * 0.8) break; remove.run(row.key); total -= row.bytes; } })();
  }
}

// --- Fetch scheduling. Ported from GenUI web/lookups.ts (Apache-2.0). ------------------------

function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try { return await task(); } finally { active -= 1; waiting.shift()?.(); }
  };
}
const limits = { tile: limiter(4), image: limiter(4), api: limiter(2) };
let nextGeocodeAt = 0;

const inFlight = new Map<string, Promise<unknown>>();
/** One lookup per key at a time; concurrent callers share it. */
function once<T>(key: string, task: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const started = task().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

/**
 * The cached answer for `key`, or `fetch()`'s. A fresh hit skips the network; a stale one is
 * served when the fetch fails. `fetch` returns the value to keep and how long, or throws SpecError.
 */
function lookup<T>(bb: BbPluginApi, key: string, fetch: () => Promise<{ value: T; ttl: number }>, valid: (value: unknown) => value is T): Promise<T> {
  return once(key, async () => {
    const hit = cacheGet(bb, key);
    const kept = hit && valid(hit.value) ? hit.value : undefined;
    if (hit && !hit.expired && kept !== undefined) return kept;
    try {
      const { value, ttl } = await fetch();
      cachePut(bb, key, value, ttl);
      return value;
    } catch (error) {
      if (kept !== undefined) return kept;
      throw error;
    }
  });
}

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const dataUrl = (mime: string, body: Buffer) => `data:${mime};base64,${body.toString("base64")}`;
const isDataUrl = (value: unknown): value is { dataUrl: string } => typeof (value as { dataUrl?: unknown } | null)?.dataUrl === "string";
const parseJson = (body: Buffer): unknown => { try { return JSON.parse(body.toString("utf8")); } catch { return undefined; } };

async function get(url: string, options: GetOptions, what: string) {
  const fetched = await safeGet(url, options);
  if (!fetched.ok) throw new SpecError(`${what}: ${fetched.error}.`);
  return fetched;
}

// --- Responses. Ported from GenUI web/geocode.ts and web/commons.ts (Apache-2.0). -----------

/** Photon's request for `name`, nudged toward `near` (the places already on the map). */
export function geocodeUrl(name: string, near?: Located): string {
  const params = new URLSearchParams({ q: name, limit: "1" });
  if (near) for (const [k, v] of [["lat", near.lat.toFixed(3)], ["lon", near.lng.toFixed(3)], ["zoom", "8"], ["location_bias_scale", "0.3"]]) params.set(k, v);
  return `https://photon.komoot.io/api/?${params}`;
}

const photon = z.object({ features: z.array(z.object({ geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]).rest(z.number()) }) })).min(1) });
/** The first feature's position in a Photon GeoJSON response, or null. */
export function pickLocation(response: unknown): Located | null {
  const parsed = photon.safeParse(response);
  if (!parsed.success) return null;
  const [lng, lat] = parsed.data.features[0].geometry.coordinates;
  return Math.abs(lat) > 90 || Math.abs(lng) > 180 ? null : { lat, lng };
}

const THUMB_WIDTH = 1280;
const MIN_WIDTH = 480;
/** Commons' search for `query`: bitmap files only, with the metadata a credit needs. */
export function searchUrl(query: string): string {
  return `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: "query", format: "json", formatversion: "2", generator: "search", gsrsearch: `${query} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "12",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: String(THUMB_WIDTH), iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|ObjectName", maxlag: "5",
  })}`;
}


/**
 * Up to `count` photos from a Commons search response, in search order with JPEGs first
 * (PNGs there are mostly diagrams and screenshots). Too-small and non-photo files are dropped.
 */
export function pickImages(response: unknown, count: number): FoundImage[] {
  const pages = record(record(response).query).pages;
  if (!Array.isArray(pages)) return [];
  const found = pages.map(record).sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0)).flatMap((page): (FoundImage & { jpeg: boolean })[] => {
    const info = record(Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined);
    const mime = typeof info.mime === "string" ? info.mime : "";
    const width = Number(info.width), height = Number(info.height);
    const url = https(info.thumburl) ?? https(info.url), sourceUrl = https(info.descriptionurl);
    if (!url || !sourceUrl || !Number.isFinite(width) || !Number.isFinite(height) || width < MIN_WIDTH || height < MIN_WIDTH * 0.5) return [];
    if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return [];
    const fields = record(info.extmetadata);
    const meta = (name: string) => plain(record(fields[name]).value);
    const fileTitle = typeof page.title === "string" ? page.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "") : "";
    const tw = Number(info.thumbwidth), th = Number(info.thumbheight);
    const scaled = Number.isFinite(tw) && Number.isFinite(th) && tw > 0;
    return [{ jpeg: mime === "image/jpeg", url, width: scaled ? tw : width, height: scaled ? th : height, title: (meta("ObjectName") || fileTitle).slice(0, 200), creator: (meta("Artist") || "Unknown author").slice(0, 120), license: meta("LicenseShortName") || "See source page", licenseUrl: https(record(fields.LicenseUrl).value), sourceUrl }];
  });
  return [...found.filter((f) => f.jpeg), ...found.filter((f) => !f.jpeg)].slice(0, count).map(({ jpeg: _jpeg, ...image }) => image);
}

// --- Methods. --------------------------------------------------------------------------------

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new SpecError(`That lookup has bad input: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
  return parsed.data;
}

async function tile(bb: BbPluginApi, input: unknown, token: string) {
  const { z: zoom, x, y, theme } = parse(inputs.tile, input);
  if (!token) throw new SpecError("Map tiles need a Mapbox token. Add one in the Pages settings.");
  const style = theme === "dark" ? "dark-v11" : "light-v11";
  return lookup(bb, `tile:mapbox:${style}/${zoom}/${x}/${y}`, async () => {
    // 256 keeps the usual z/x/y grid; @2x makes each tile 512px for sharp screens.
    const fetched = await limits.tile(() => get(`https://api.mapbox.com/styles/v1/mapbox/${style}/tiles/256/${zoom}/${x}/${y}@2x?access_token=${encodeURIComponent(token)}`, { accept: "image/png", maxBytes: 1024 * 1024, timeoutMs: 15_000, hosts: MAPBOX }, "The map tile didn't load"));
    if (sniffImage(fetched.body) !== "image/png") throw new SpecError("The map tile didn't load.");
    return { value: { dataUrl: dataUrl("image/png", fetched.body) }, ttl: TTL.tile };
  }, isDataUrl);
}

async function geocode(bb: BbPluginApi, input: unknown): Promise<Located> {
  const { name, near } = parse(inputs.geocode, input);
  const key = `geo:${normalize(name)}|${near ? `${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : ""}`;
  const value = await lookup(bb, key, async () => {
    const now = Date.now(), slot = Math.max(now, nextGeocodeAt);
    nextGeocodeAt = slot + GEOCODE_SPACING_MS;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
    const fetched = await get(geocodeUrl(normalize(name), near), json(PHOTON), "Place lookup failed");
    const found = pickLocation(parseJson(fetched.body));
    return { value: found ?? { missing: true }, ttl: found ? TTL.found : TTL.miss };
  }, (v): v is Located | { missing: true } => typeof record(v).lat === "number" || record(v).missing === true);
  if ("missing" in value) throw new SpecError(`Couldn't find “${name}” on the map.`);
  return value;
}

async function search(bb: BbPluginApi, input: unknown): Promise<{ images: FoundImage[] }> {
  const { query, count } = parse(inputs.search, input);
  const images = await lookup(bb, `search:${normalize(query)}`, async () => {
    const fetched = await limits.api(() => get(searchUrl(normalize(query)), json(COMMONS), "Photo search failed"));
    const found = pickImages(parseJson(fetched.body), 8);
    return { value: found, ttl: found.length ? TTL.found : TTL.miss };
  }, (v): v is FoundImage[] => Array.isArray(v));
  if (images.length === 0) throw new SpecError(`No photos found for “${query}”.`);
  return { images: images.slice(0, count) };
}

async function wiki(bb: BbPluginApi, input: unknown) {
  const { title } = parse(inputs.wiki, input);
  return lookup(bb, `wiki:${title.replace(/\s+/g, " ")}`, async () => {
    const found = await findWikiPhoto(title, url => limits.api(() => safeGet(url, json(WIKI))));
    if (!found.ok) throw new SpecError(`Place photo: ${found.error}.`);
    return { value: { photo: found.photo }, ttl: found.photo ? TTL.found : TTL.miss };
  }, (value): value is { photo: WikiPhoto | null } => wikiResultSchema.safeParse(value).success);
}

async function image(bb: BbPluginApi, input: unknown) {
  const { url: raw } = parse(inputs.image, input);
  let url: string;
  try { url = new URL(raw).href; } catch { throw new SpecError("That image link isn't a valid URL."); }
  return lookup(bb, `img:${url}`, async () => {
    const fetched = await limits.image(() => get(url, { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.8", maxBytes: MAX_IMAGE_BYTES, timeoutMs: 20_000 }, "The image didn't load"));
    const mime = sniffImage(fetched.body);
    if (!mime || !declaresImage(fetched.headers["content-type"])) throw new SpecError("That link isn't a png, jpeg, gif, webp, avif, or svg image.");
    return { value: { dataUrl: dataUrl(mime, fetched.body) }, ttl: TTL.image };
  }, isDataUrl);
}

export async function runWeb(bb: BbPluginApi, method: WebMethod, input: Record<string, unknown>, mapboxToken = ""): Promise<unknown> {
  switch (method) {
    case "tile": return tile(bb, input, mapboxToken);
    case "geocode": return geocode(bb, input);
    case "search": return search(bb, input);
    case "image": return image(bb, input);
    case "wiki": return wiki(bb, input);
  }
}
