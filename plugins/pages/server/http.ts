// Plugin HTTP routes. The host matches exact paths only, so ids travel in the
// query string and every page shape resolves `./_page/<asset>` to the same
// asset routes:
//   GET /v?id=<versionId>[&theme=light|dark][&frame=card|inline]               stored version
//   GET /a?id=<versionId>&path=<file>[&theme=light|dark][&frame=card|inline]   one file of a folder version
//   GET /file?threadId=&source=&file=[&theme=light|dark][&frame=card|inline]    live file (::inline-vis; single files only)
//   GET /_page/theme.css | /_page/inter.roman.var.woff2 | /_page/charts.js   [?v=<content version>]
// Preview HTML asks for assets with `?v=`, so the browser caches them for good; a stored version
// never changes, so its HTML is cached briefly and revalidated by ETag. Live files are never cached.
// Folder HTML (and CSS) is served with its relative subresources inlined as data: URLs and its
// links to other folder files pointed at `./v` or `./a`; see render/folder.ts for why.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PAGE_ASSET_NAMES } from "../contract.js";
import { PAGE_CSP, PREVIEW_SHELL_VERSION, inlinedPageAssets, inspectCharts, injectPage, pageAssetVersions, rewriteFolderCss, rewriteFolderHtml, servedPageAsset, type FolderRefs } from "../render/index.js";
import { FileSourceError, readSourceFile } from "./files.js";
import { inlineLocalImages } from "./images.js";
import { sourceHtml } from "./service.js";
import type { PageStore, StoredHtml } from "./store.js";

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

  /** Folder file lookup for the rewriter. index.html is the version's HTML. */
  const folderRefs = (stored: StoredHtml): FolderRefs => {
    const entries = new Map(store.versionFiles(stored.versionId).map((entry) => [entry.path, entry]));
    return {
      file: (file) => {
        if (file === "index.html") return { bytes: Buffer.from(stored.html, "utf8"), contentType: "text/html; charset=utf-8" };
        const entry = entries.get(file);
        const bytes = entry ? store.blobBytes(entry.sha256) : null;
        return entry && bytes ? { bytes, contentType: entry.contentType } : null;
      },
      link: (file) => file === "index.html" ? `./v?id=${encodeURIComponent(stored.versionId)}` : `./a?${new URLSearchParams({ id: stored.versionId, path: file })}`,
    };
  };

  /** A themed preview of stored page HTML (index.html, or another .html file of a folder version). */
  const servePage = (c: Parameters<Parameters<BbPluginApi["http"]["route"]>[2]>[0], stored: StoredHtml, file: string, html: string, hasCharts: boolean) => {
    const theme = themeOf(c.req.query("theme"));
    const frame = frameOf(c.req.query("frame"));
    const etag = `"${stored.versionId}.${file === "index.html" ? "" : `${encodeURIComponent(file)}.`}${theme ?? "auto"}.${frame ?? "full"}.${assetsTag}"`;
    const headers = { ...pageHeaders, "cache-control": VERSION_CACHE, etag };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const page = stored.folder ? rewriteFolderHtml(html, file, folderRefs(stored)) : html;
    return new Response(injectPage(page, { assetBase: "./", theme, frame, hasCharts, assetVersions, inlineAssets }), { headers });
  };

  bb.http.route("GET", "/v", (c) => {
    const stored = store.storedHtml(c.req.query("id") ?? "");
    if (!stored) return text(404, "Page version not found.");
    return servePage(c, stored, "index.html", stored.html, stored.hasCharts);
  });

  bb.http.route("GET", "/a", (c) => {
    const stored = store.storedHtml(c.req.query("id") ?? "");
    if (!stored) return text(404, "Page version not found.");
    const file = c.req.query("path") ?? "";
    if (file === "index.html") return servePage(c, stored, file, stored.html, stored.hasCharts);
    const found = folderRefs(stored).file(file);
    if (!found) return text(404, "This page has no such file.");
    if (/^text\/html\b/iu.test(found.contentType)) {
      const html = found.bytes.toString("utf8");
      return servePage(c, stored, file, html, inspectCharts(html).hasCharts);
    }
    const etag = `"${stored.versionId}.${encodeURIComponent(file)}"`;
    const headers = { "content-type": found.contentType, "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff", "cache-control": VERSION_CACHE, etag };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const bytes = /^text\/css\b/iu.test(found.contentType) ? Buffer.from(rewriteFolderCss(found.bytes.toString("utf8"), file, folderRefs(stored)), "utf8") : found.bytes;
    return new Response(new Uint8Array(bytes), { headers });
  });

  bb.http.route("GET", "/file", async (c) => {
    const threadId = c.req.query("threadId");
    const file = c.req.query("file");
    const source = c.req.query("source") ?? "workspace";
    if (!threadId || !file) return text(400, "threadId and file are required.");
    if (source !== "workspace" && source !== "thread-storage") return text(400, "source must be workspace or thread-storage.");
    try {
      const read = await readSourceFile(bb.sdk, threadId, file, source);
      // Unusable images stay as written here; publish reports them.
      const html = await inlineLocalImages(bb.sdk, threadId, read, sourceHtml(read), { strict: false });
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
