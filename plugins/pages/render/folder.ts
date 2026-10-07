// Relative references in folder pages, for the BB preview.
// A sandboxed preview frame has an opaque origin, so its subrequests and its own link
// navigations carry no BB session cookie and fail through the remote BB tunnel. So
// subresources (src, link href, srcset, poster, CSS url() and @import) become data: URLs,
// and links to other folder files become `./v` or `./a` preview URLs that the frame bridge
// hands to the BB app, which loads them into the frame. Absolute, scheme (data:, https:, …),
// protocol-relative, fragment-only, and escaping references are left alone, and so are
// references to files the folder does not have. URLs built by scripts are not rewritten.
import path from "node:path";
import { escapeHtml, scanHtml } from "./html.js";

export type FolderFileBytes = { bytes: Buffer; contentType: string };
export type FolderRefs = {
  /** A folder file's bytes, by folder-relative path (index.html included), or null. */
  file(path: string): FolderFileBytes | null;
  /** The preview URL that opens a folder file as the page. */
  link(path: string): string;
};

const SCHEME = /^[a-z][a-z\d+.-]*:/iu;
/** Nested CSS @import depth that is still inlined. Deeper (or circular) imports stay as written. */
const MAX_CSS_DEPTH = 4;

/** Resolves a reference made in folder file `from`. `fragment` is "" or starts with "#". */
export function resolveFolderRef(raw: string, from: string): { path: string; fragment: string } | null {
  const ref = raw.trim();
  if (!ref || ref.startsWith("#") || ref.startsWith("/") || ref.startsWith("\\") || SCHEME.test(ref)) return null;
  const cut = ref.search(/[?#]/u);
  const pathPart = cut < 0 ? ref : ref.slice(0, cut);
  if (!pathPart) return null;
  const hash = ref.indexOf("#");
  let decoded: string;
  try { decoded = decodeURIComponent(pathPart); } catch { return null; }
  const joined = path.posix.join(path.posix.dirname(from), decoded);
  if (joined === ".." || joined.startsWith("../")) return null;
  const file = joined === "." || joined === "./" ? "index.html" : joined.endsWith("/") ? `${joined}index.html` : joined;
  return { path: file, fragment: hash < 0 ? "" : ref.slice(hash) };
}

const dataUrl = (file: FolderFileBytes) => `data:${file.contentType.replace(/\s+/gu, "")};base64,${file.bytes.toString("base64")}`;

function inlineRef(raw: string, from: string, refs: FolderRefs, depth: number): string | null {
  const ref = resolveFolderRef(raw, from);
  const file = ref && refs.file(ref.path);
  if (!ref || !file) return null;
  if (/^text\/css\b/iu.test(file.contentType)) {
    if (depth >= MAX_CSS_DEPTH) return null;
    return dataUrl({ contentType: file.contentType, bytes: Buffer.from(rewriteFolderCss(file.bytes.toString("utf8"), ref.path, refs, depth + 1), "utf8") }) + ref.fragment;
  }
  return dataUrl(file) + ref.fragment;
}

const CSS_REF = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/giu;

/** Rewrites `url()` and `@import "…"` in CSS from folder file `from`. Data URLs are written unquoted, so the result is safe inside a quoted style="" attribute. */
export function rewriteFolderCss(css: string, from: string, refs: FolderRefs, depth = 0): string {
  return css.replace(CSS_REF, (whole, double?: string, single?: string, bare?: string, importDouble?: string, importSingle?: string) => {
    const isImport = importDouble !== undefined || importSingle !== undefined;
    const inlined = inlineRef(double ?? single ?? bare ?? importDouble ?? importSingle ?? "", from, refs, depth);
    if (!inlined) return whole;
    return isImport ? `@import url(${inlined})` : `url(${inlined})`;
  });
}

/** srcset candidates are "url [descriptor]" separated by commas; a data: URL may itself contain commas. */
function rewriteSrcset(value: string, from: string, refs: FolderRefs): string | null {
  const candidates: string[] = [];
  let changed = false;
  let at = 0;
  while (at < value.length) {
    while (at < value.length && /[\s,]/u.test(value[at]!)) at += 1;
    if (at >= value.length) break;
    let stop = at;
    while (stop < value.length && !/\s/u.test(value[stop]!)) stop += 1;
    let url = value.slice(at, stop);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/u, "");
    } else {
      const comma = value.indexOf(",", stop);
      descriptor = value.slice(stop, comma < 0 ? value.length : comma).trim();
      stop = comma < 0 ? value.length : comma;
    }
    at = stop;
    const inlined = inlineRef(url, from, refs, 0);
    if (inlined) changed = true;
    candidates.push(descriptor ? `${inlined ?? url} ${descriptor}` : inlined ?? url);
  }
  return changed ? candidates.join(", ") : null;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", "#39": "'", "#x27": "'" };

/**
 * Rewrites the relative references of folder HTML file `from` (see the file comment).
 * Everything else stays byte-for-byte.
 */
export function rewriteFolderHtml(html: string, from: string, refs: FolderRefs): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const tag of scanHtml(html).tags) {
    if (tag.kind !== "start") continue;
    if (tag.name === "style" && tag.text) {
      const css = rewriteFolderCss(tag.text, from, refs);
      if (css !== tag.text) edits.push({ start: tag.end, end: tag.end + tag.text.length, text: css });
    }
    for (const [index, [name, raw]] of tag.attrs.entries()) {
      if (!raw) continue;
      const [at] = tag.valueRanges[index]!;
      const value = raw.replace(/&(amp|quot|apos|lt|gt|#39|#x27);/giu, (whole, entity: string) => ENTITIES[entity.toLowerCase()] ?? whole);
      let text: string | null = null;
      if (name === "href" && (tag.name === "a" || tag.name === "area")) {
        const ref = resolveFolderRef(value, from);
        if (ref && refs.file(ref.path)) text = escapeHtml(refs.link(ref.path) + ref.fragment);
      } else if ((name === "href" && tag.name === "link") || (name === "src" && tag.name !== "iframe" && tag.name !== "frame") || name === "poster") {
        text = inlineRef(value, from, refs, 0);
      } else if (name === "srcset") {
        const srcset = rewriteSrcset(value, from, refs);
        text = srcset === null ? null : escapeHtml(srcset);
      } else if (name === "style") {
        const css = rewriteFolderCss(value, from, refs);
        text = css === value ? null : escapeHtml(css);
      }
      if (text !== null) edits.push({ start: at, end: at + raw.length, text });
    }
  }
  let out = html;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}
