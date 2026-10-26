// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
import { z } from "zod";
import type { Fetched } from "./webNet.js";
import { https, plain, record } from "./web-format.js";
const API = "https://commons.wikimedia.org/w/api.php";
const foundImageSchema = z.object({ url:z.string(), width:z.number(), height:z.number(), title:z.string(), creator:z.string(), license:z.string(), licenseUrl:z.string().nullable(), sourceUrl:z.string() });
const metadata = (fields: Readonly<Record<string, unknown>>, name: string) => plain(record(fields[name]).value);
const parseJson = (body: Buffer): unknown => { try { return JSON.parse(body.toString("utf8")); } catch { return undefined; } };
/** A Wikipedia article's lead photo, credited like a search result, with the article it came from. */
export const wikiPhotoSchema = foundImageSchema.extend({ articleUrl: z.string() });

export type WikiPhoto = z.infer<typeof wikiPhotoSchema>;

/** Where Wikimedia serves Commons originals; scaled renditions come from either host. */
const ORIGINAL_HOSTS: Readonly<Record<string, true>> = { "upload.wikimedia.org": true };
const RENDITION_HOSTS: Readonly<Record<string, true>> = { "upload.wikimedia.org": true, "thumb.wikimedia.org": true };
/** The rendition a Map card shows: a standard thumbnail step, sharp at card width on a 2× screen. */
const CARD_WIDTH = 500;

/** The REST page summary of an English Wikipedia article: its title, lead image and links. */
export function summaryUrl(title: string): string {
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
}

/**
 * The Commons file name (underscores, not spaces) a Wikimedia media URL
 * serves, original (`/wikipedia/commons/a/ab/Name.jpg`) or scaled
 * (`/wikipedia/commons/thumb/a/ab/Name.jpg/500px-Name.jpg`); null for other
 * hosts and for files local to one wiki (`/wikipedia/en/…`: often non-free).
 */
function commonsFile(value: unknown, hosts: Readonly<Record<string, true>>): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !Object.hasOwn(hosts, url.hostname)) return null;
    const match = /^\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)(?:\/[^/]+)?$/.exec(url.pathname);
    return match === null ? null : decodeURIComponent(match[1]).replace(/ /g, "_");
  } catch {
    return null;
  }
}

/** The Commons file an article summary leads with, and the article's page; null when it has none we can credit. */
export function leadFile(summary: unknown): { readonly file: string; readonly articleUrl: string } | null {
  const page = record(summary);
  // A disambiguation page's image belongs to whichever meaning it happens to show.
  if (page.type === "disambiguation") return null;
  const file = commonsFile(record(page.originalimage).source, RENDITION_HOSTS);
  // The thumbnail must be the same file, or the credit would name a different picture.
  if (file === null || commonsFile(record(page.thumbnail).source, RENDITION_HOSTS) !== file) return null;
  const article = https(record(record(page.content_urls).desktop).page);
  if (article === null || new URL(article).hostname !== "en.wikipedia.org") return null;
  return { file, articleUrl: article };
}

/** The Commons request for one file: its scaled rendition, size, type and the metadata a credit needs. */
export function fileInfoUrl(file: string): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    titles: `File:${file}`,
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: String(CARD_WIDTH),
    iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|ObjectName",
    maxlag: "5",
  });
  return `${API}?${params}`;
}

/** Licences a photo can be shown under with a credit: Creative Commons (CC BY, CC BY-SA, CC0) or public domain. */
const REUSABLE = /^(?:CC0|CC[ -]|Public domain$)/i;

/**
 * The photo in a Commons answer for `lead.file`, or null unless that very
 * file (original on upload.wikimedia.org, rendition of the same name) is a
 * bitmap with a named author and a reusable licence. No guessing: a photo we
 * can't credit, or that may not be the one the article shows, is no photo.
 */
export function pickWikiPhoto(response: unknown, lead: { readonly file: string; readonly articleUrl: string }): WikiPhoto | null {
  const pages = record(record(response).query).pages;
  const page = record(Array.isArray(pages) ? pages[0] : undefined);
  if (typeof page.title !== "string" || page.title.replace(/ /g, "_") !== `File:${lead.file}`) return null;
  const info = record(Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined);
  if (commonsFile(info.url, ORIGINAL_HOSTS) !== lead.file) return null;
  // Commons hands back the original as the rendition when it is already small, so one always comes.
  if (commonsFile(info.thumburl, RENDITION_HOSTS) !== lead.file) return null;
  const url = https(info.thumburl);
  const mime = typeof info.mime === "string" ? info.mime : "";
  // SVG leads are maps, flags and coats of arms, not a photo of the place.
  if (url === null || !mime.startsWith("image/") || mime === "image/svg+xml") return null;
  const fields = record(info.extmetadata);
  const creator = metadata(fields, "Artist");
  const license = metadata(fields, "LicenseShortName");
  if (creator === "" || !REUSABLE.test(license)) return null;
  const width = Number(info.thumbwidth);
  const height = Number(info.thumbheight);
  if (!(width > 0 && height > 0)) return null;
  const described = https(info.descriptionurl);
  return {
    url,
    width,
    height,
    title: (metadata(fields, "ObjectName") || lead.file.replace(/_/g, " ").replace(/\.[a-z0-9]+$/i, "")).slice(0, 200),
    creator: creator.slice(0, 120),
    license,
    licenseUrl: https(record(fields.LicenseUrl).value),
    sourceUrl:
      described !== null && new URL(described).hostname === "commons.wikimedia.org"
        ? described
        : `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(lead.file)}`,
    articleUrl: lead.articleUrl,
  };
}

/** A definite answer (`photo` null: the article has no photo we can credit, or doesn't exist), or a lookup that failed. */
export type WikiLookup = { readonly ok: true; readonly photo: WikiPhoto | null } | { readonly ok: false; readonly error: string };

/** The credited lead photo of the English Wikipedia article `title`, fetched with `get`. */
export async function findWikiPhoto(title: string, get: (url: string) => Promise<Fetched>): Promise<WikiLookup> {
  const summary = await get(summaryUrl(title));
  if (!summary.ok) return { ok: false, error: summary.error };
  const lead = leadFile(parseJson(summary.body));
  if (lead === null) return { ok: true, photo: null };
  const info = await get(fileInfoUrl(lead.file));
  if (!info.ok) return { ok: false, error: info.error };
  return { ok: true, photo: pickWikiPhoto(parseJson(info.body), lead) };
}
