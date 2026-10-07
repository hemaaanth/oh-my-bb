import { createHash } from "node:crypto";
import type { PageAssetName } from "../contract.js";
import { FRAME_BRIDGE } from "./frame-bridge.js";
import { escapeHtml, scanHtml } from "./html.js";
import { DATA_TABLE_RUNTIME, PAGE_RUNTIME, needsDataTableRuntime, needsPageRuntime } from "./page-runtime.js";

export type InjectOptions = {
  /** Base URL (absolute or relative) under which `_page/<asset>` resolves. */
  assetBase: string;
  /** BB app theme for body.auto pages in the BB preview; null when published. */
  theme: "light" | "dark" | null;
  /** Add the chart runtime script. */
  hasCharts: boolean;
  /**
   * The chat frame, as data-bb-frame. "card" is the small framed preview; the theme shows it zoomed out, like a thumbnail.
   * "inline" is the borderless preview that is part of the reply; it fits its height to the page and never scrolls.
   */
  frame?: "card" | "inline" | null;
  /** Content versions added as `?v=` to asset URLs, so the BB preview can cache them for good. Omitted for published sites. */
  assetVersions?: Partial<Record<PageAssetName, string>>;
  /** Self-contained assets for sandboxed BB previews. Omitted for published sites, which ship separate files. */
  inlineAssets?: InlinePageAssets;
};

export type InlinePageAssets = { themeCss: string; chartsJs: string };

/**
 * Content-Security-Policy for served pages. Inline author scripts and styles
 * run; `_page/` assets and folder files load from 'self'; folder previews inline
 * their files as data: URLs (data: scripts add nothing over 'unsafe-inline');
 * images and media may also be blob: or https:; scripts get no network and no
 * eval; no remote scripts or styles.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' data:",
  "style-src 'self' 'unsafe-inline' data:",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Changes when the scripts injectPage adds change, so a cached preview revalidates to the new shell after a plugin update. */
export const PREVIEW_SHELL_VERSION = createHash("sha256").update(FRAME_BRIDGE).update(PAGE_RUNTIME).update(DATA_TABLE_RUNTIME).digest("base64url").slice(0, 8);

type Insert = { at: number; text: string };

/**
 * Add the theme link (first in <head>, so author styles win), the font preload,
 * data-bb-theme and data-bb-frame on <html>, the frame bridge (BB previews only), and before </body> the page runtime (only when the
 * page has tabs, contents, or zoomable images) and the chart runtime. Everything
 * else in the author's HTML stays byte-for-byte. Works on full documents,
 * documents without <html>/<head>/<body>, and bare fragments.
 */
export function injectPage(html: string, options: InjectOptions): string {
  const { tags, doctypeEnd } = scanHtml(html);
  const htmlTag = tags.find((tag) => tag.kind === "start" && tag.name === "html");
  const headTag = tags.find((tag) => tag.kind === "start" && tag.name === "head");
  const base = escapeHtml(options.assetBase);
  const url = (name: PageAssetName) => {
    const version = options.assetVersions?.[name];
    return `${base}_page/${name}${version ? `?v=${escapeHtml(version)}` : ""}`;
  };
  const assets = options.inlineAssets
    ? `<style>${options.inlineAssets.themeCss}</style>`
    : `<link rel="stylesheet" href="${url("theme.css")}"><link rel="preload" href="${url("inter.roman.var.woff2")}" as="font" type="font/woff2" crossorigin>`;
  const inserts: Insert[] = [];
  const top = doctypeEnd < 0 ? 0 : doctypeEnd;
  const attrs = `${options.theme ? ` data-bb-theme="${options.theme}"` : ""}${options.frame ? ` data-bb-frame="${options.frame}"` : ""}`;
  // Only BB previews (theme or frame set) talk to the BB app. Published and shared sites never get the bridge.
  const head = options.theme || options.frame ? `${assets}<script>${FRAME_BRIDGE}</script>` : assets;

  if (attrs && htmlTag) {
    // "<html" is 5 characters; ours come first, and the first duplicate attribute wins.
    inserts.push({ at: htmlTag.start + 5, text: attrs });
  }
  if (headTag) {
    // Author <head> before any <html> is impossible in a real document, so the <html> prefix (if needed) goes on top.
    if (attrs && !htmlTag) inserts.push({ at: top, text: `<html${attrs}>` });
    inserts.push({ at: headTag.end, text: head });
  } else if (htmlTag) {
    inserts.push({ at: htmlTag.end, text: `<head>${head}</head>` });
  } else {
    const open = attrs ? `<html${attrs}>` : "";
    inserts.push({ at: top, text: `${open}<head>${head}</head>` });
  }

  const runtime = needsPageRuntime(html);
  const dataTable = needsDataTableRuntime(html);
  if (runtime || dataTable || options.hasCharts) {
    const hasBodyEnd = tags.some((tag) => tag.kind === "end" && tag.name === "body");
    let at = html.length;
    for (const tag of tags) {
      // The last </body> wins; the last </html> is the fallback when there is no </body>.
      if (tag.kind === "end" && tag.name === (hasBodyEnd ? "body" : "html")) at = tag.start;
    }
    // Inline, so a shared page needs no extra file. It runs before the charts, which then draw the visible tab.
    if (runtime) inserts.push({ at, text: `<script>${PAGE_RUNTIME}</script>` });
    if (dataTable) inserts.push({ at, text: `<script>${DATA_TABLE_RUNTIME}</script>` });
    if (options.hasCharts) inserts.push({ at, text: options.inlineAssets ? `<script>${options.inlineAssets.chartsJs}</script>` : `<script src="${url("charts.js")}" defer></script>` });
  }

  let out = html;
  // Apply from the end so earlier offsets stay valid. Equal offsets keep push order.
  for (const insert of inserts.map((value, order) => ({ ...value, order })).sort((a, b) => b.at - a.at || b.order - a.order)) {
    out = out.slice(0, insert.at) + insert.text + out.slice(insert.at);
  }
  return out;
}
