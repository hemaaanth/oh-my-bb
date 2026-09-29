import { describe, expect, it } from "vitest";
import { PAGE_CSP } from "../render/index.js";
import { DIRECTIVE_RULE } from "./tools.js";
import { WORKSPACE, pagesHost, storageOf } from "./test-fakes.js";

type Result = { page: { id: string; title: string; sourceKey: string | null }; version: { id: string; n: number; label: string | null }; versions: unknown[]; created: boolean; directive: string };
const html = (body: string, title = "") => `<!doctype html><html><head>${title ? `<title>${title}</title>` : ""}</head><body>${body}</body></html>`;
const review = { schema: "pr-review/v1" as const, title: "Auth review", target: { kind: "pull-request" as const, label: "PR #1", headSha: "abcdef1" }, intent: "Review auth", summary: "One issue.", verdict: "changes-requested" as const, coverage: { reviewed: ["auth"], skipped: [], validation: ["tests"] }, findings: [] };
const documentInput = { producer: "pr-review", producerKey: "pr-review:example/app#1", title: "Auth review", provenance: { threadId: "thr_a", projectId: "proj_test" }, document: review };

describe("publishFile identity", () => {
  it("keeps one page per source path, adds a version on change, and stores nothing for the same bytes", async () => {
    const { harness, files } = pagesHost();
    files.set(`${storageOf("thr_a")}/t1/hello.html`, html("<h1>Hello</h1>"));
    const first = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "t1/hello.html", source: "thread-storage" }) as Result;
    expect(first).toMatchObject({ created: true, version: { n: 1 }, page: { title: "Hello", sourceKey: "storage:thr_a:t1/hello.html" } });

    const same = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "./t1/hello.html", source: "thread-storage" }) as Result;
    expect(same).toMatchObject({ created: false, version: { id: first.version.id, n: 1 } });
    expect(same.versions).toHaveLength(1);

    files.set(`${storageOf("thr_a")}/t1/hello.html`, html("<h1>Hello again</h1>"));
    const second = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "t1/hello.html", source: "thread-storage", label: "edit" }) as Result;
    expect(second).toMatchObject({ created: false, page: { id: first.page.id }, version: { n: 2, label: "edit" } });
    expect(second.directive).toBe(`::page{id="${first.page.id}" version="${second.version.id}"}`);

    // The same relative path in the workspace is a different source.
    files.set(`${WORKSPACE}/t1/hello.html`, html("<h1>Workspace</h1>"));
    const workspace = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "t1/hello.html" }) as Result;
    expect(workspace.page.id).not.toBe(first.page.id);
    expect(workspace.page.sourceKey).toBe("workspace:env_1:t1/hello.html");
    await harness.lifecycle.dispose();
  });

  it("follows a key across threads and files, and a pageId over the file's own identity", async () => {
    const { harness, files } = pagesHost();
    files.set(`${storageOf("thr_a")}/r/a.html`, html("<p>a</p>", "Daily"));
    files.set(`${storageOf("thr_b")}/r/b.html`, html("<p>b</p>", "Daily"));
    const a = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "r/a.html", source: "thread-storage", key: "daily" }) as Result;
    const b = await harness.behavior.callRpc("publishFile", { threadId: "thr_b", file: "r/b.html", source: "thread-storage", key: "daily" }) as Result;
    expect(a.page.sourceKey).toBe("key:daily");
    expect(b).toMatchObject({ created: false, page: { id: a.page.id }, version: { n: 2 } });

    files.set(`${WORKSPACE}/other.md`, "# Other notes\n\ntext");
    const byId = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "other.md", pageId: a.page.id }) as Result;
    expect(byId).toMatchObject({ page: { id: a.page.id, sourceKey: "key:daily" }, version: { n: 3 } });
    expect(await harness.behavior.callRpc("findPage", { key: "daily" })).toMatchObject({ page: { id: a.page.id }, version: { n: 3 } });
    await harness.lifecycle.dispose();
  });

  it("titles a page from the argument, <title>, <h1>, then the file name", async () => {
    const { harness, files } = pagesHost();
    const cases: Array<[string, string, string | undefined, string]> = [
      ["a.html", html("<h1>Heading</h1>", "Tab &amp; title"), undefined, "Tab & title"],
      ["b.html", html("<h1>First <em>heading</em></h1><h1>Second</h1>"), undefined, "First heading"],
      ["q3-revenue_report.html", html("<p>no headings</p>"), undefined, "Q3 revenue report"],
      ["d.html", html("<h1>Ignored</h1>", "Ignored"), "Given", "Given"],
    ];
    for (const [file, content, title, expected] of cases) {
      files.set(`${WORKSPACE}/${file}`, content);
      const result = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file, ...(title ? { title } : {}) }) as Result;
      expect(result.page.title).toBe(expected);
    }
    await harness.lifecycle.dispose();
  });

  it("rejects traversal and absolute paths before reading", async () => {
    const { harness } = pagesHost();
    for (const file of ["../secret.html", "a/../../secret.html", "/etc/passwd.html", "C:\\x.html", "notes.txt"]) {
      await expect(harness.behavior.callRpc("publishFile", { threadId: "thr_a", file })).rejects.toThrow();
    }
    expect(harness.sdk.callsTo("files.read")).toHaveLength(0);
    await harness.lifecycle.dispose();
  });
});

describe("publishDocument", () => {
  it("requires the current version as baseVersionId to revise", async () => {
    const { harness } = pagesHost();
    const first = await harness.behavior.callRpc("publishDocument", documentInput) as Result;
    expect(first).toMatchObject({ created: true, version: { n: 1 } });
    await expect(harness.behavior.callRpc("publishDocument", { ...documentInput, document: { ...review, summary: "Two." } })).rejects.toThrow(/stale/i);
    const second = await harness.behavior.callRpc("publishDocument", { ...documentInput, baseVersionId: first.version.id, document: { ...review, summary: "Two." } }) as Result;
    expect(second).toMatchObject({ page: { id: first.page.id }, version: { n: 2 } });
    await expect(harness.behavior.callRpc("publishDocument", { ...documentInput, baseVersionId: first.version.id })).rejects.toThrow(/stale/i);
    const lookup = JSON.parse(String(await harness.behavior.callAgentTool("page_lookup", { producerKey: documentInput.producerKey }, { threadId: "thr_a", projectId: "proj_test" })));
    expect(lookup.document.summary).toBe("Two.");
    expect(JSON.stringify(lookup)).not.toMatch(/<html|password/iu);
    await harness.lifecycle.dispose();
  });

  it("forwards producer actions to pr-review only for its pages", async () => {
    const { harness, files, rpcCalls } = pagesHost();
    const page = await harness.behavior.callRpc("publishDocument", documentInput) as Result;
    await harness.behavior.callRpc("runProducerAction", { pageId: page.page.id, threadId: "thr_view", action: "fix", findingId: "finding-1" });
    expect(rpcCalls).toEqual([{ pluginId: "pr-review", method: "requestReviewAction", input: { id: page.page.id, threadId: "thr_view", action: "fix", findingId: "finding-1" } }]);
    files.set(`${WORKSPACE}/plain.html`, html("<h1>Plain</h1>"));
    const plain = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "plain.html" }) as Result;
    await expect(harness.behavior.callRpc("runProducerAction", { pageId: plain.page.id, threadId: "thr_view", action: "rerun" })).rejects.toThrow(/no producer actions/u);
    expect(rpcCalls).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("answers an archived thread with a typed result instead of an error", async () => {
    const { harness, rpcCalls, archived, rpcFailure } = pagesHost();
    const page = await harness.behavior.callRpc("publishDocument", documentInput) as Result;
    archived.add("thr_old");
    // Checked before asking pr-review, so the producer is never called.
    expect(await harness.behavior.callRpc("runProducerAction", { pageId: page.page.id, threadId: "thr_old", action: "rerun" })).toMatchObject({ ok: false, reason: "thread-archived" });
    expect(rpcCalls).toHaveLength(0);
    // Archived between the check and the send: pr-review's 409 becomes the same result.
    rpcFailure.error = new Error("HTTP 500: HTTP 409: Thread is archived");
    expect(await harness.behavior.callRpc("runProducerAction", { pageId: page.page.id, threadId: "thr_view", action: "explain" })).toMatchObject({ ok: false, reason: "thread-archived" });
    // Other failures still fail.
    rpcFailure.error = new Error("pr-review is not running");
    await expect(harness.behavior.callRpc("runProducerAction", { pageId: page.page.id, threadId: "thr_view", action: "explain" })).rejects.toThrow(/not running/u);
    await harness.lifecycle.dispose();
  });
});

describe("realtime signals", () => {
  it("name the page, the version, and the file's source key", async () => {
    const { harness, files } = pagesHost();
    files.set(`${storageOf("thr_a")}/s.html`, html("<h1>S</h1>"));
    const result = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "s.html", source: "thread-storage" }) as Result;
    expect(harness.inspection.realtimeSignals.at(-1)).toEqual({ channel: "pages-changed", payload: { pageId: result.page.id, versionId: result.version.id, sourceKey: "storage:thr_a:s.html" } });
    const document = await harness.behavior.callRpc("publishDocument", documentInput) as Result;
    expect(harness.inspection.realtimeSignals.at(-1)?.payload).toEqual({ pageId: document.page.id, versionId: document.version.id });
    await harness.lifecycle.dispose();
  });
});

describe("page routes", () => {
  it("serves a stored version as HTML with the page CSP", async () => {
    const { harness, files } = pagesHost();
    files.set(`${WORKSPACE}/r.html`, html("<h1>R</h1>"));
    const result = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "r.html" }) as Result & { previewUrl: string };
    expect(result.previewUrl).toBe(`/api/v1/plugins/pages/http/v?id=${result.version.id}`);
    const response = await harness.behavior.fetchHttp("GET", `/v?id=${result.version.id}&theme=dark`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("<h1>R</h1>");
    expect((await harness.behavior.fetchHttp("GET", "/v?id=00000000-0000-4000-8000-000000000000")).status).toBe(404);

    await harness.behavior.callRpc("deletePage", { pageId: result.page.id });
    expect((await harness.behavior.fetchHttp("GET", `/v?id=${result.version.id}`)).status).toBe(404);
    await harness.lifecycle.dispose();
  });

  it("caches a stored version briefly and revalidates it by ETag", async () => {
    const { harness, files } = pagesHost();
    files.set(`${WORKSPACE}/c.html`, html("<h1>C</h1>"));
    const result = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "c.html" }) as Result;
    const first = await harness.behavior.fetchHttp("GET", `/v?id=${result.version.id}&theme=dark&frame=card`);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toContain(result.version.id);
    const again = await harness.behavior.fetchHttp("GET", `/v?id=${result.version.id}&theme=dark&frame=card`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    // Another theme is another document.
    const light = await harness.behavior.fetchHttp("GET", `/v?id=${result.version.id}&theme=light&frame=card`, { headers: { "if-none-match": etag } });
    expect(light.status).toBe(200);
    await harness.lifecycle.dispose();
  });

  it("makes previews self-contained so sandboxed frames make no asset requests", async () => {
    const { harness, files } = pagesHost();
    files.set(`${WORKSPACE}/a.html`, html('<h1>A</h1><figure class="chart"><script type="application/json">{"series":[]}</script></figure>'));
    const result = await harness.behavior.callRpc("publishFile", { threadId: "thr_a", file: "a.html" }) as Result;
    const page = await (await harness.behavior.fetchHttp("GET", `/v?id=${result.version.id}`)).text();
    expect(page).toContain("<style>");
    expect(page).toContain("data:font/woff2;base64,");
    expect(page).toContain("<script>");
    expect(page).not.toMatch(/(?:href|src)="\.\/_page\//u);
    await harness.lifecycle.dispose();
  });

  it("looks up a thread's roots once for repeated previews", async () => {
    const { harness, files } = pagesHost();
    files.set(`${storageOf("thr_a")}/live.md`, "# Live");
    const query = new URLSearchParams({ threadId: "thr_a", source: "thread-storage", file: "live.md" });
    for (let load = 0; load < 3; load += 1) expect((await harness.behavior.fetchHttp("GET", `/file?${query}`)).status).toBe(200);
    await harness.behavior.callRpc("resolveFile", { threadId: "thr_a", file: "live.md", source: "thread-storage" });
    expect(harness.sdk.callsTo("threads.storageLocation")).toHaveLength(1);
    expect(harness.sdk.callsTo("files.read")).toHaveLength(3);
    await harness.lifecycle.dispose();
  });

  it("opens only the static asset routes to any origin; page routes stay local", async () => {
    const { harness } = pagesHost();
    const auth = Object.fromEntries(harness.registrations.httpRoutes.map((route) => [route.path, route.auth]));
    expect(auth).toEqual({ "/v": "local", "/file": "local", "/_page/theme.css": "none", "/_page/inter.roman.var.woff2": "none", "/_page/charts.js": "none" });
    const font = await harness.behavior.fetchHttp("GET", "/_page/inter.roman.var.woff2", { headers: { origin: "null" } });
    expect(font.status).toBe(200);
    expect(font.headers.get("access-control-allow-origin")).toBe("*");
    const revalidated = await harness.behavior.fetchHttp("GET", "/_page/inter.roman.var.woff2", { headers: { "if-none-match": font.headers.get("etag") ?? "" } });
    expect(revalidated.status).toBe(304);
    await harness.lifecycle.dispose();
  });

  it("serves a live file preview and rejects traversal", async () => {
    const { harness, files } = pagesHost();
    files.set(`${storageOf("thr_a")}/notes.md`, "# Notes\n\nbody");
    const live = await harness.behavior.fetchHttp("GET", `/file?${new URLSearchParams({ threadId: "thr_a", source: "thread-storage", file: "notes.md" })}`);
    expect(live.status).toBe(200);
    expect(live.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(await live.text()).toContain("Notes");
    expect((await harness.behavior.fetchHttp("GET", `/file?${new URLSearchParams({ threadId: "thr_a", file: "../x.html" })}`)).status).toBe(400);
    expect((await harness.behavior.fetchHttp("GET", `/file?${new URLSearchParams({ threadId: "thr_a", file: "missing.html" })}`)).status).toBe(404);
    await harness.lifecycle.dispose();
  });
});

describe("agent tool and CLI", () => {
  it("page_publish starts with the directive rule", async () => {
    const { harness, files } = pagesHost();
    files.set(`${storageOf("thr_a")}/t.html`, html("<h1>T</h1>"));
    const text = String(await harness.behavior.callAgentTool("page_publish", { file: "t.html", source: "thread-storage" }, { threadId: "thr_a", projectId: "proj_test" }));
    const [rule, line] = text.split("\n");
    expect(rule).toBe(DIRECTIVE_RULE);
    expect(line).toMatch(/^::page\{id="[0-9a-f-]{36}" version="[0-9a-f-]{36}"\}$/u);
    expect(text).not.toMatch(/https?:/u);
    await harness.lifecycle.dispose();
  });

  it("browses prior pages and folders in the current project", async () => {
    const { harness, files } = pagesHost();
    files.set(`${storageOf("thr_a")}/weekly.html`, html("<h1>Weekly activation</h1>"));
    await harness.behavior.callAgentTool("page_publish", { file: "weekly.html", source: "thread-storage", folder: "Reports / Weekly" }, { threadId: "thr_a", projectId: "proj_test" });
    const result = JSON.parse(String(await harness.behavior.callAgentTool("page_browse", { query: "activation" }, { threadId: "thr_fresh", projectId: "proj_test" })));
    expect(result).toMatchObject({
      projectId: "proj_test",
      folders: [{ projectId: "proj_test", path: "Reports/Weekly", count: 1 }],
      pages: [{ title: "Weekly activation", folder: "Reports/Weekly", currentVersion: { n: 1 }, versionCount: 1 }],
      hasMore: false,
    });
    await harness.lifecycle.dispose();
  });

  it("maps absolute and relative CLI paths to the calling thread's roots", async () => {
    const { harness, files } = pagesHost();
    files.set(`${storageOf("thr_a")}/reports/x.html`, html("<h1>X</h1>"));
    files.set(`${WORKSPACE}/docs/y.md`, "# Y");
    const fromStorage = await harness.behavior.runCli(["publish", `${storageOf("thr_a")}/reports/x.html`, "--json"], { threadId: "thr_a" });
    expect(fromStorage.exitCode).toBe(0);
    expect(JSON.parse(fromStorage.stdout ?? "")).toMatchObject({ page: { sourceKey: "storage:thr_a:reports/x.html" } });
    const fromWorkspace = await harness.behavior.runCli(["publish", "y.md", "--json"], { threadId: "thr_a", cwd: `${WORKSPACE}/docs` });
    expect(JSON.parse(fromWorkspace.stdout ?? "")).toMatchObject({ page: { sourceKey: "workspace:env_1:docs/y.md" } });

    const outside = await harness.behavior.runCli(["publish", "/tmp/elsewhere.html"], { threadId: "thr_a" });
    expect(outside.exitCode).not.toBe(0);
    expect(outside.stderr).toMatch(/outside this thread/u);
    const noThread = await harness.behavior.runCli(["publish", `${storageOf("thr_a")}/reports/x.html`], {});
    expect(noThread.exitCode).not.toBe(0);
    await harness.lifecycle.dispose();
  });
});
