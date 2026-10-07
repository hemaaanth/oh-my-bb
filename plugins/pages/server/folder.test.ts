import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FOLDER_BYTES, MAX_FOLDER_FILES } from "../contract.js";
import { PAGE_CSP } from "../render/index.js";
import { FakeHereNow } from "./share/fake-here-now.js";
import { FileSourceError, validateFolderPaths } from "./files.js";
import { WORKSPACE, pagesHost, storageOf } from "./test-fakes.js";

/** Row count of a table in the plugin's database. */
const rows = (host: ReturnType<typeof pagesHost>, table: "page_blobs" | "page_version_files") => {
  const row: unknown = host.bb.storage.database().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return row && typeof row === "object" && "n" in row ? row.n : null;
};

type Result = { page: { id: string; title: string; sourceKey: string | null }; version: { id: string; n: number; sourcePath: string | null }; created: boolean };
const DIR = `${storageOf("thr_a")}/site`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
const INDEX = '<!doctype html><html><head><title>Launch</title><link rel="stylesheet" href="css/site.css"></head><body><img src="img/logo.png"><a href="about.html">About</a></body></html>';

function writeSite(files: Map<string, string | Buffer>, extra: Record<string, string | Buffer> = {}) {
  files.set(`${DIR}/index.html`, INDEX);
  files.set(`${DIR}/css/site.css`, "body{background:url(../img/logo.png)}");
  files.set(`${DIR}/img/logo.png`, PNG);
  files.set(`${DIR}/about.html`, '<h1>About</h1><a href="index.html">Home</a>');
  for (const [file, content] of Object.entries(extra)) files.set(`${DIR}/${file}`, content);
}
const publishSite = (harness: ReturnType<typeof pagesHost>["harness"], extra: Record<string, unknown> = {}) =>
  harness.behavior.callRpc("publishFile", { threadId: "thr_a", dir: "site", source: "thread-storage", ...extra }) as Promise<Result>;

afterEach(() => { vi.unstubAllGlobals(); });

describe("validateFolderPaths", () => {
  const refused = (paths: string[]) => { try { validateFolderPaths(paths); return null; } catch (error) { expect(error).toBeInstanceOf(FileSourceError); return (error as Error).message; } };

  it("refuses each unsafe path shape with the reason", () => {
    expect(refused(["index.html", "a.png", "a.png"])).toMatch(/"a\.png" appears twice/u);
    expect(refused(["index.html", "/etc/x.png"])).toMatch(/must be relative, with forward slashes/u);
    expect(refused(["index.html", "img\\a.png"])).toMatch(/must be relative, with forward slashes/u);
    expect(refused(["index.html", "a\u0007.png"])).toMatch(/control characters/u);
    for (const file of ["img//a.png", "./a.png", "img/../a.png", "img/"]) expect(refused(["index.html", file])).toMatch(/empty, "\." or "\.\." segments/u);
    expect(refused(["index.html", "_page/theme.css"])).toMatch(/reserves for its theme/u);
    expect(refused(["index.html", "_PAGE/x.css"])).toMatch(/reserves/u);
    expect(refused(["about.html", "docs/index.html"])).toMatch(/no index\.html at its top level/u);
    expect(refused(["index.html", ...Array.from({ length: MAX_FOLDER_FILES }, (_, n) => `f${n}.png`)])).toMatch(new RegExp(`limit is ${MAX_FOLDER_FILES}`, "u"));
    expect(refused(["index.html", "page_/x.css", "docs/_page/x.css"])).toBeNull();
  });
});

describe("folder publish", () => {
  it("page_publish stores the folder as one version and skips dotfiles and node_modules", async () => {
    const { harness, files } = pagesHost();
    writeSite(files, { ".env": "SECRET=1", ".git/config": "x", "node_modules/lib/index.js": "x", "img/.DS_Store": "x" });
    const text = String(await harness.behavior.callAgentTool("page_publish", { dir: "site", source: "thread-storage" }, { threadId: "thr_a", projectId: "proj_test" }));
    expect(text).toMatch(/"Launch" created v1\. To update it, publish the same path again, or pass pageId "[0-9a-f-]{36}"\./u);
    const pageId = /id="([^"]+)"/u.exec(text)![1]!;
    const detail = await harness.behavior.callRpc("getPage", { pageId }) as Result;
    expect(detail).toMatchObject({ page: { title: "Launch", sourceKey: "storage:thr_a:site" }, version: { n: 1, sourcePath: "site" } });
    const stored = await (await harness.behavior.fetchHttp("GET", `/a?${new URLSearchParams({ id: detail.version.id, path: ".env" })}`)).status;
    expect(stored).toBe(404);
    expect((await harness.behavior.fetchHttp("GET", `/a?${new URLSearchParams({ id: detail.version.id, path: "css/site.css" })}`)).status).toBe(200);
    await harness.lifecycle.dispose();
  });

  it("rejects a folder without index.html, a missing folder, and one over the size limit", async () => {
    const { harness, files } = pagesHost();
    files.set(`${DIR}/about.html`, "<h1>About</h1>");
    await expect(publishSite(harness)).rejects.toThrow(/no index\.html/u);
    await expect(harness.behavior.callRpc("publishFile", { threadId: "thr_a", dir: "nope", source: "thread-storage" })).rejects.toThrow(/not found/iu);
    files.set(`${DIR}/index.html`, "<h1>Big</h1>");
    files.set(`${DIR}/big.bin`, Buffer.alloc(MAX_FOLDER_BYTES));
    await expect(publishSite(harness)).rejects.toThrow(/larger than 25 MB/u);
    await expect(harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "x.html", dir: "site" })).rejects.toThrow();
    await harness.lifecycle.dispose();
  });

  it("adds a version only when a file changes, and stores unchanged bytes once", async () => {
    const host = pagesHost();
    const { harness, files } = host;
    writeSite(files);
    const first = await publishSite(harness);
    expect((await publishSite(harness)).version.id).toBe(first.version.id);
    files.set(`${DIR}/about.html`, "<h1>About us</h1>");
    const second = await publishSite(harness, { label: "about" });
    expect(second).toMatchObject({ page: { id: first.page.id }, version: { n: 2 } });
    // Renaming a file is a change too.
    files.delete(`${DIR}/img/logo.png`);
    files.set(`${DIR}/img/mark.png`, PNG);
    const third = await publishSite(harness);
    expect(third.version.n).toBe(3);

    // css, logo (= mark), about v1, about v2: four distinct blobs across three versions.
    expect(rows(host, "page_blobs")).toBe(4);
    expect(rows(host, "page_version_files")).toBe(9);
    await harness.lifecycle.dispose();
  });

  it("serves folder files at /a with their content type and nosniff, and 404s unknown paths", async () => {
    const { harness, files } = pagesHost();
    writeSite(files);
    const { version } = await publishSite(harness);
    const get = (file: string, init?: RequestInit) => harness.behavior.fetchHttp("GET", `/a?${new URLSearchParams({ id: version.id, path: file })}`, init);
    const logo = await get("img/logo.png");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await logo.arrayBuffer())).toEqual(PNG);
    expect((await get("img/logo.png", { headers: { "if-none-match": logo.headers.get("etag") ?? "" } })).status).toBe(304);

    const css = await get("css/site.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe(`body{background:url(data:image/png;base64,${PNG.toString("base64")})}`);

    const about = await get("about.html");
    expect(about.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(await about.text()).toContain(`<a href="./v?id=${version.id}">Home</a>`);

    for (const file of ["missing.png", "../index.html", ""]) expect((await get(file)).status).toBe(404);
    expect((await harness.behavior.fetchHttp("GET", `/a?id=00000000-0000-4000-8000-000000000000&path=img%2Flogo.png`)).status).toBe(404);
    expect(harness.registrations.httpRoutes.find((route) => route.path === "/a")?.auth).toBe("local");
    await harness.lifecycle.dispose();
  });

  it("serves index.html at /v with subresources inlined and page links on the preview routes", async () => {
    const { harness, files } = pagesHost();
    writeSite(files);
    const { version } = await publishSite(harness);
    const page = await (await harness.behavior.fetchHttp("GET", `/v?id=${version.id}`)).text();
    expect(page).toContain(`<img src="data:image/png;base64,${PNG.toString("base64")}">`);
    expect(page).toMatch(/<link rel="stylesheet" href="data:text\/css;charset=utf-8;base64,[^"]+">/u);
    expect(page).toContain(`<a href="./a?id=${version.id}&amp;path=about.html">About</a>`);
    await harness.lifecycle.dispose();
  });

  it("removes blobs no version uses when a page is deleted, and keeps shared ones", async () => {
    const host = pagesHost();
    const { harness, files } = host;
    writeSite(files);
    const kept = await publishSite(harness);
    files.set(`${WORKSPACE}/other/index.html`, "<h1>Other</h1>");
    files.set(`${WORKSPACE}/other/img/logo.png`, PNG);
    files.set(`${WORKSPACE}/other/only.txt`, "only here");
    const other = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", dir: "other" }) as Result;
    expect(rows(host, "page_blobs")).toBe(4); // css, logo (shared), about, only.txt
    await harness.behavior.callRpc("deletePage", { pageId: other.page.id });
    expect(rows(host, "page_blobs")).toBe(3);
    expect((await harness.behavior.fetchHttp("GET", `/a?${new URLSearchParams({ id: kept.version.id, path: "img/logo.png" })}`)).status).toBe(200);
    await harness.behavior.callRpc("deletePage", { pageId: kept.page.id });
    expect(rows(host, "page_blobs")).toBe(0);
    await harness.lifecycle.dispose();
  });
});

describe("folder CLI", () => {
  it("publishes a folder path and pulls it back into a folder", async () => {
    const { harness, files } = pagesHost();
    writeSite(files);
    const published = await harness.behavior.runCli(["publish", DIR, "--json"], { threadId: "thr_a" });
    expect(published.exitCode).toBe(0);
    const { page } = JSON.parse(published.stdout ?? "") as Result;
    expect(page.sourceKey).toBe("storage:thr_a:site");

    const toStdout = await harness.behavior.runCli(["pull", page.id], { threadId: "thr_a" });
    expect(toStdout.exitCode).not.toBe(0);
    expect(toStdout.stderr).toMatch(/--out/u);

    const pulled = await harness.behavior.runCli(["pull", page.id, "--out", `${storageOf("thr_a")}/copy`], { threadId: "thr_a" });
    expect(pulled.exitCode).toBe(0);
    expect(String(files.get(`${storageOf("thr_a")}/copy/index.html`))).toBe(INDEX);
    expect(files.get(`${storageOf("thr_a")}/copy/img/logo.png`)).toEqual(PNG);
    expect(String(files.get(`${storageOf("thr_a")}/copy/css/site.css`))).toBe("body{background:url(../img/logo.png)}");
    // Same bytes again: fine. Other bytes in the way: refused.
    expect((await harness.behavior.runCli(["pull", page.id, "--out", `${storageOf("thr_a")}/copy`], { threadId: "thr_a" })).exitCode).toBe(0);
    files.set(`${storageOf("thr_a")}/copy/about.html`, "mine");
    const blocked = await harness.behavior.runCli(["pull", page.id, "--out", `${storageOf("thr_a")}/copy`], { threadId: "thr_a" });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr).toMatch(/already exists/u);
    await harness.lifecycle.dispose();
  });
});

describe("folder share", () => {
  it("uploads every folder file at its path, with the theme on its HTML pages", async () => {
    const fake = new FakeHereNow();
    vi.stubGlobal("fetch", fake.fetch);
    const { harness, files } = pagesHost();
    await harness.behavior.setSettings({ hereNowApiKey: "test-key" });
    writeSite(files, { "docs/guide.html": "<h1>Guide</h1>" });
    const { page } = await publishSite(harness);
    // The app's sharePage RPC is the owner's own click; only the agent tool asks for confirmation.
    const shared = await harness.behavior.callRpc("sharePage", { pageId: page.id, access: "password" }) as { slug: string };
    const live = fake.sites.get(shared.slug)!.live;
    expect([...live.keys()].sort()).toEqual(["_page/inter.roman.var.woff2", "_page/theme.css", "about.html", "css/site.css", "docs/guide.html", "img/logo.png", "index.html"]);
    expect(live.get("img/logo.png")).toEqual(PNG);
    expect(live.get("css/site.css")!.toString()).toBe("body{background:url(../img/logo.png)}");
    expect(live.get("index.html")!.toString()).toContain('<img src="img/logo.png">');
    expect(live.get("about.html")!.toString()).toContain('href="./_page/theme.css"');
    expect(live.get("docs/guide.html")!.toString()).toContain('href="../_page/theme.css"');
    await harness.lifecycle.dispose();
  });
});
