// Finds local image references in page HTML, so publish can inline them as data: URIs.
import { scanHtml } from "./html.js";

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
};

/** One local image reference. `start`/`end` span the raw text to replace; `path` is decoded, without `?query` or `#hash`. */
export type ImageRef = { start: number; end: number; path: string };

// Attributes that load an image. srcset is handled on its own.
const IMAGE_ATTRS: Record<string, string[]> = {
  img: ["src"], source: ["src"], input: ["src"], video: ["poster"], image: ["href", "xlink:href"], feimage: ["href", "xlink:href"],
};
const SRCSET_TAGS: Record<string, true> = { img: true, source: true };
const ENTITIES: Record<string, string> = { amp: "&", quot: "\"", apos: "'", "#39": "'", lt: "<", gt: ">" };
const CSS_URL = /url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'()]*))\s*\)/dgiu;

const extensionOf = (file: string) => {
  const dot = file.lastIndexOf(".");
  return dot > file.lastIndexOf("/") ? file.slice(dot).toLowerCase() : "";
};

/** The file path a URL names when it is a local image, else null. Remote, data:, blob:, and `#` URLs are not local. */
export function localImagePath(raw: string): string | null {
  const value = raw.replace(/&(amp|quot|apos|#39|lt|gt);/giu, (_, name: string) => ENTITIES[name.toLowerCase()]!);
  if (!value || value.startsWith("#") || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
  const bare = value.replace(/[?#].*$/su, "");
  let file: string;
  try { file = decodeURIComponent(bare); } catch { file = bare; }
  return IMAGE_TYPES[extensionOf(file)] ? file : null;
}

/** A ref for `raw` at `offset`, ignoring the whitespace around it. */
function refAt(raw: string, offset: number): ImageRef | null {
  const lead = raw.length - raw.trimStart().length;
  const value = raw.trim();
  const file = localImagePath(value);
  return file ? { start: offset + lead, end: offset + lead + value.length, path: file } : null;
}

function cssRefs(css: string, offset: number, out: ImageRef[]) {
  for (const match of css.matchAll(CSS_URL)) {
    const group = match[1] !== undefined ? 1 : match[2] !== undefined ? 2 : 3;
    const span = match.indices?.[group];
    if (!span) continue;
    const ref = refAt(match[group]!, offset + span[0]);
    if (ref) out.push(ref);
  }
}

/** Splits a srcset into candidate URLs. Skips the whole value when it holds a data: URL, whose commas cannot be told apart. */
function srcsetRefs(value: string, offset: number, out: ImageRef[]) {
  if (/data:/iu.test(value)) return;
  let at = 0;
  for (const candidate of value.split(",")) {
    const url = /^\s*(\S+)/u.exec(candidate);
    if (url) {
      const ref = refAt(url[1]!, offset + at + url[0].length - url[1]!.length);
      if (ref) out.push(ref);
    }
    at += candidate.length + 1;
  }
}

/**
 * Local image references in source order: img/source src and srcset, video
 * poster, SVG <image> href, and CSS url() in style attributes and <style>.
 * Markup inside comments, scripts, and other raw text is ignored.
 */
export function findLocalImages(html: string): ImageRef[] {
  const out: ImageRef[] = [];
  for (const tag of scanHtml(html).tags) {
    if (tag.kind !== "start") continue;
    if (tag.name === "style" && tag.text !== undefined) cssRefs(tag.text, tag.end, out);
    const names = IMAGE_ATTRS[tag.name] ?? [];
    tag.attrs.forEach(([name, value], index) => {
      const [start] = tag.valueRanges[index]!;
      if (names.includes(name)) {
        const ref = refAt(value, start);
        if (ref) out.push(ref);
      } else if (name === "srcset" && SRCSET_TAGS[tag.name]) srcsetRefs(value, start, out);
      else if (name === "style") cssRefs(value, start, out);
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Replaces each ref whose path has a data URI. Refs must not overlap. */
export function replaceImages(html: string, refs: ImageRef[], dataUris: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const ref of refs) {
    const uri = dataUris.get(ref.path);
    if (uri === undefined) continue;
    parts.push(html.slice(cursor, ref.start), uri);
    cursor = ref.end;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}

const head = (bytes: Uint8Array, length: number) => String.fromCharCode(...bytes.subarray(0, length));

/**
 * Whether the bytes are an image, whatever the file is named, so a renamed
 * file or a symlink cannot carry other data, such as a secret, into a page.
 */
export function isImageBytes(bytes: Uint8Array): boolean {
  const start = head(bytes, 12);
  if (
    start.startsWith("\x89PNG") || start.startsWith("\xff\xd8\xff") || start.startsWith("GIF8") || start.startsWith("\0\0\x01\0")
    || (start.startsWith("BM") && start.slice(6, 10) === "\0\0\0\0")
    || (start.startsWith("RIFF") && start.slice(8, 12) === "WEBP")
    || /^ftyp(?:avif|avis|mif1)$/u.test(start.slice(4, 12))
  ) return true;
  // SVG: an <svg> root after an optional BOM, XML declaration, comments, and doctype.
  const text = new TextDecoder().decode(bytes.subarray(0, 4096));
  return /^﻿?\s*(?:(?:<\?[^]*?\?>|<!--[^]*?-->|<!doctype[^>[]*(?:\[[^\]]*\])?\s*>)\s*)*<svg[\s/>]/iu.test(text);
}

export const dataUri = (file: string, bytes: Uint8Array) => `data:${IMAGE_TYPES[extensionOf(file)] ?? "application/octet-stream"};base64,${Buffer.from(bytes).toString("base64")}`;
