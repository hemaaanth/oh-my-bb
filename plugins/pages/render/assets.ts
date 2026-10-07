import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PageAssetName } from "../contract.js";
import type { InlinePageAssets } from "./inject.js";
import { DATA_TABLE_RUNTIME, LINK_BRIDGE, PAGE_RUNTIME } from "./page-runtime.js";

const CONTENT_TYPES: Record<PageAssetName, string> = {
  "theme.css": "text/css; charset=utf-8",
  "inter.roman.var.woff2": "font/woff2",
  "charts.js": "text/javascript; charset=utf-8",
};

let assetDirectory: string | undefined;
const cache = new Map<PageAssetName, Buffer>();

/**
 * The plugin's `assets/` folder. The server runs from source (`render/assets.ts`)
 * or from the bundle (`dist/server.js`), so walk up from this module until
 * `assets/theme.css` appears.
 */
function findAssetDirectory(): string {
  if (assetDirectory) return assetDirectory;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(directory, "assets");
    if (existsSync(join(candidate, "theme.css"))) return (assetDirectory = candidate);
    directory = dirname(directory);
  }
  throw new Error("Pages assets folder not found next to the plugin");
}

/** Bytes and content type for a shared page asset. The files never change at runtime, so they are read once. */
export function readPageAsset(name: PageAssetName): { bytes: Buffer; contentType: string } {
  const contentType = CONTENT_TYPES[name];
  if (!contentType) throw new Error(`Unknown page asset ${String(name)}`);
  let bytes = cache.get(name);
  if (!bytes) {
    bytes = readFileSync(join(findAssetDirectory(), name));
    cache.set(name, bytes);
  }
  return { bytes, contentType };
}

/** An asset as the BB preview routes serve it: `version` is a content hash for `?v=`, `etag` its quoted form. */
export type ServedAsset = { bytes: Buffer; contentType: string; version: string; etag: string };
const served = new Map<PageAssetName, ServedAsset>();
const FONT = "inter.roman.var.woff2";
let inlined: InlinePageAssets | undefined;

/** One-response assets for sandboxed previews, whose subrequests cannot authenticate through a remote BB tunnel. */
export function inlinedPageAssets(): InlinePageAssets {
  if (inlined) return inlined;
  const font = readPageAsset(FONT).bytes.toString("base64");
  const themeCss = readPageAsset("theme.css").bytes.toString("utf8").replaceAll(`url("${FONT}")`, `url("data:font/woff2;base64,${font}")`);
  const chartsJs = readPageAsset("charts.js").bytes.toString("utf8");
  return (inlined = { themeCss, chartsJs });
}

/**
 * Like readPageAsset, plus a content version so preview pages can ask for `_page/<asset>?v=<version>`
 * and the browser can cache it for good. theme.css names the font with its version too, so the
 * font and the preload link share one cached URL. Computed once per asset.
 */
export function servedPageAsset(name: PageAssetName): ServedAsset {
  const hit = served.get(name);
  if (hit) return hit;
  const { bytes: raw, contentType } = readPageAsset(name);
  const bytes = name === "theme.css"
    ? Buffer.from(raw.toString("utf8").replaceAll(`url("${FONT}")`, `url("${FONT}?v=${servedPageAsset(FONT).version}")`), "utf8")
    : raw;
  const version = createHash("sha256").update(bytes).digest("base64url").slice(0, 16);
  const asset = { bytes, contentType, version, etag: `"${version}"` };
  served.set(name, asset);
  return asset;
}

/** `?v=` versions for every asset, for injectPage in the BB preview routes. */
export function pageAssetVersions(): Record<PageAssetName, string> {
  return { "theme.css": servedPageAsset("theme.css").version, "inter.roman.var.woff2": servedPageAsset(FONT).version, "charts.js": servedPageAsset("charts.js").version };
}

/** A content version for the inline runtimes, so preview ETags change when a plugin update changes them. */
export function pageRuntimeVersion(): string {
  return createHash("sha256").update(`${PAGE_RUNTIME}\0${DATA_TABLE_RUNTIME}\0${LINK_BRIDGE}`).digest("base64url").slice(0, 8);
}
