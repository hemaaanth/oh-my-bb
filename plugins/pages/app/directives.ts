// Parse the three chat directives into one card reference.
//   ::page{id version height? display?}          canonical
//   ::artifact{id revision height? display?}     alias: artifact ids are page ids, revision ids are version ids
//   ::inline-vis{file source? height? display?}  alias: a live workspace or thread-storage file
// display="inline" shows the page borderless, as part of the reply; the default is the card.
// For an inline page, height is the space reserved until the page reports its own height.
// Attributes are untrusted. The server validates every id and path again.
import type { PageDisplay } from "../contract.js";

export const DEFAULT_CARD_HEIGHT = 240;
export const MIN_CARD_HEIGHT = 120;
export const MAX_CARD_HEIGHT = 1200;

export type FileSource = "workspace" | "thread-storage";
export type CardRef =
  | { kind: "page"; pageId: string; versionId: string | null; height: number; display: PageDisplay }
  | { kind: "file"; file: string; source: FileSource; height: number; display: PageDisplay };
export type DirectiveName = "page" | "artifact" | "inline-vis";
export type ParsedDirective = { ok: true; ref: CardRef } | { ok: false; message: string };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseHeight(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  if (!value) return DEFAULT_CARD_HEIGHT;
  if (!/^\d+$/u.test(value)) return null;
  const height = Number(value);
  return height >= MIN_CARD_HEIGHT && height <= MAX_CARD_HEIGHT ? height : null;
}

function parseDisplay(raw: string | undefined): PageDisplay | null {
  const value = raw?.trim() || "card";
  return value === "card" || value === "inline" ? value : null;
}

/** A source-relative path: not absolute, not home-relative, and without ".." segments. */
export function relativeFile(raw: string | undefined): string | null {
  const file = raw?.trim() ?? "";
  if (!file || file.length > 1_000 || file.includes("\0")) return null;
  if (/^(?:[/\\~]|[A-Za-z]:)/u.test(file)) return null;
  return file.split(/[/\\]/u).includes("..") ? null : file;
}

export function parseDirective(name: DirectiveName, attributes: Readonly<Record<string, string | undefined>>): ParsedDirective {
  const height = parseHeight(attributes.height);
  if (height === null) return { ok: false, message: `height must be a whole number from ${MIN_CARD_HEIGHT} to ${MAX_CARD_HEIGHT}.` };
  const display = parseDisplay(attributes.display);
  if (display === null) return { ok: false, message: "display must be card or inline." };
  if (name === "inline-vis") {
    if (!attributes.file?.trim()) return { ok: false, message: "file is required." };
    const file = relativeFile(attributes.file);
    if (!file) return { ok: false, message: "file must be a relative path without '..'." };
    const source = attributes.source?.trim() || "workspace";
    if (source !== "workspace" && source !== "thread-storage") return { ok: false, message: "source must be workspace or thread-storage." };
    return { ok: true, ref: { kind: "file", file, source, height, display } };
  }
  const versionAttribute = name === "artifact" ? "revision" : "version";
  const pageId = attributes.id?.trim() ?? "";
  if (!UUID.test(pageId)) return { ok: false, message: "id must be a page id (UUID)." };
  const versionId = attributes[versionAttribute]?.trim() || null;
  if (versionId !== null && !UUID.test(versionId)) return { ok: false, message: `${versionAttribute} must be a version id (UUID).` };
  return { ok: true, ref: { kind: "page", pageId: pageId.toLowerCase(), versionId: versionId?.toLowerCase() ?? null, height, display } };
}
