// Plugin HTTP routes. The host matches exact paths only, so ids travel in the
// query string and every page shape resolves `./_page/<asset>` to the same
// asset routes:
//   GET /v?id=<versionId>[&theme=light|dark][&frame=card|inline]            stored version
//   GET /file?threadId=&source=&file=[&theme=light|dark][&frame=card|inline] live file (::inline-vis)
//   GET /_page/theme.css | /_page/inter.roman.var.woff2 | /_page/charts.js   [?v=<content version>]
// Preview HTML asks for assets with `?v=`, so the browser caches them for good; a stored version
// never changes, so its HTML is cached briefly and revalidated by ETag. Live files are never cached.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PAGE_ASSET_NAMES } from "../contract.js";
import { PAGE_CSP, PREVIEW_SHELL_VERSION, inlinedPageAssets, inspectCharts, injectPage, pageAssetVersions, servedPageAsset } from "../render/index.js";
import { FileSourceError, readSourceFile } from "./files.js";
import { sourceHtml } from "./service.js";
import type { PageStore } from "./store.js";

const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": PAGE_CSP,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};
/** Revalidate immutable versions so a plugin update can replace their injected preview shell. */
const VERSION_CACHE = "private, no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";
const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" } });
const themeOf = (value: string | undefined) => (value === "light" || value === "dark" ? value : null);
const frameOf = (value: string | undefined) => (value === "card" || value === "inline" ? value : null);

export function registerRoutes(bb: BbPluginApi, store: PageStore) {
  const assetVersions = (() => { try { return pageAssetVersions(); } catch { return {}; } })();
  const inlineAssets = (() => { try { return inlinedPageAssets(); } catch { return undefined; } })();
  // Changes when the assets or injected scripts change, so a plugin update never revalidates to old HTML.
  const assetsTag = `${inlineAssets ? "inline" : "linked"}.${Object.values(assetVersions).join(".").slice(0, 24) || "none"}.${PREVIEW_SHELL_VERSION}`;

  bb.http.route("GET", "/v", (c) => {
    const stored = store.storedHtml(c.req.query("id") ?? "");
    if (!stored) return text(404, "Page version not found.");
    const theme = themeOf(c.req.query("theme"));
    const frame = frameOf(c.req.query("frame"));
    const etag = `"${stored.versionId}.${theme ?? "auto"}.${frame ?? "full"}.${assetsTag}"`;
    const headers = { ...pageHeaders, "cache-control": VERSION_CACHE, etag };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(injectPage(stored.html, { assetBase: "./", theme, frame, hasCharts: stored.hasCharts, assetVersions, inlineAssets }), { headers });
  });

  bb.http.route("GET", "/file", async (c) => {
    const threadId = c.req.query("threadId");
    const file = c.req.query("file");
    const source = c.req.query("source") ?? "workspace";
    if (!threadId || !file) return text(400, "threadId and file are required.");
    if (source !== "workspace" && source !== "thread-storage") return text(400, "source must be workspace or thread-storage.");
    try {
      const read = await readSourceFile(bb.sdk, threadId, file, source);
      const html = sourceHtml(read);
      return new Response(injectPage(html, { assetBase: "./", theme: themeOf(c.req.query("theme")), frame: frameOf(c.req.query("frame")), hasCharts: inspectCharts(html).hasCharts, assetVersions, inlineAssets }), { headers: pageHeaders });
    } catch (error) {
      if (error instanceof FileSourceError) return text(error.status, error.message);
      bb.log.warn(`live preview failed for ${source}:${file}: ${error instanceof Error ? error.message : String(error)}`);
      return text(502, "The file could not be read.");
    }
  });

  for (const name of PAGE_ASSET_NAMES) {
    bb.http.route("GET", `/_page/${name}`, (c) => {
      const asset = (() => { try { return servedPageAsset(name); } catch { return null; } })();
      if (!asset) return text(404, `Page asset ${name} is not available.`);
      // A URL with the current ?v= names these exact bytes, so it may be cached for good; any other URL revalidates by ETag.
      const { etag } = asset;
      const headers = { "content-type": asset.contentType, "cache-control": c.req.query("v") === asset.version ? IMMUTABLE : "no-cache", etag, "x-content-type-options": "nosniff", "access-control-allow-origin": "*" };
      if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(new Uint8Array(asset.bytes), { headers });
    }, { auth: "none" }); // Static public bytes. Sandboxed (opaque-origin) iframes fetch fonts with Origin: null, which "local" auth rejects.
  }
}
