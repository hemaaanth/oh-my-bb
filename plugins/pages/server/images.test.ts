import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES } from "./images.js";
import { WORKSPACE, pagesHost, storageOf } from "./test-fakes.js";

type Result = { page: { id: string }; version: { id: string; n: number } };
const STORAGE = storageOf("thr_a");
const MIB = 1024 * 1024;
const png = (fill = 0, size = 16) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, fill)]);
const uri = (bytes: Buffer, type = "image/png") => `data:${type};base64,${bytes.toString("base64")}`;
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected publish to fail"); }, (error: unknown) => error as Error);
const html = (body: string) => `<!doctype html><html><head><title>Images</title></head><body>${body}</body></html>`;

function setup() {
  const host = pagesHost();
  const publish = (file: string, source: "workspace" | "thread-storage" = "thread-storage") =>
    host.harness.behavior.callRpc("publishFile", { threadId: "thr_a", file, source }) as Promise<Result>;
  const stored = async (result: Result) => (await host.harness.behavior.fetchHttp("GET", `/v?id=${result.version.id}`)).text();
  const reads = () => host.harness.sdk.callsTo("files.read").map((args) => (args[0] as { path: string }).path);
  return { ...host, publish, stored, reads };
}

describe("local image inlining at publish", () => {
  it("inlines relative paths from the page's folder and absolute paths inside the thread's roots", async () => {
    const { files, harness, publish, stored } = setup();
    const [a, b, c] = [png(1), png(2), png(3)];
    files.set(`${STORAGE}/report/img/a.png`, a);
    files.set(`${STORAGE}/shared/b.png`, b);
    files.set(`${WORKSPACE}/assets/c.png`, c);
    files.set(`${STORAGE}/report/page.html`, html(`<img src="img/a.png"><img src="../shared/b.png"><img src="${WORKSPACE}/assets/c.png"><img src="${STORAGE}/report/img/a.png">`));
    const page = await stored(await publish("report/page.html"));
    expect(page).toContain(`<img src="${uri(a)}"><img src="${uri(b)}"><img src="${uri(c)}"><img src="${uri(a)}">`);
    expect(page).not.toMatch(/src="(?!data:)/u);
    await harness.lifecycle.dispose();
  });

  it("rejects paths that escape the roots without reading them, and lists every problem", async () => {
    const { files, harness, publish, reads } = setup();
    files.set(`${STORAGE}/page.html`, html(`<img src="../../etc/x.png"><img src="/etc/secret.png"><img src="${STORAGE}/../other/y.png">`));
    const error = await failure(publish("page.html"));
    expect(error.message).toContain("Some local images could not be inlined. Fix these and publish again:");
    expect(error.message).toContain("- ../../etc/x.png resolves outside the thread-storage");
    expect(error.message).toContain("- /etc/secret.png is outside this thread's workspace and thread storage");
    expect(error.message).toContain(`- ${STORAGE}/../other/y.png is outside`);
    expect(reads()).toEqual([`${STORAGE}/page.html`]);
    await harness.lifecycle.dispose();
  });

  it("leaves remote, data:, and blob: URLs untouched", async () => {
    const { files, harness, publish, stored, reads } = setup();
    const body = `<img src="https://example.test/a.png"><img src="data:image/png;base64,AAAA"><img src="blob:abc"><div style="background:url(https://example.test/b.png)"></div>`;
    files.set(`${STORAGE}/page.html`, html(body));
    expect(await stored(await publish("page.html"))).toContain(body);
    expect(reads()).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("names missing and non-image files and how to fix them", async () => {
    const { files, harness, publish } = setup();
    files.set(`${STORAGE}/docs/env.png`, "SECRET=1");
    files.set(`${STORAGE}/docs/page.html`, html(`<img src="missing.png"><img src="env.png">`));
    const error = await failure(publish("docs/page.html"));
    expect(error.message).toContain("- missing.png was not found (looked for docs/missing.png in thread-storage). Relative paths start at the page's folder.");
    expect(error.message).toContain("- env.png is not a PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or SVG image.");
    await harness.lifecycle.dispose();
  });

  it("caps each image and the whole inlined page", async () => {
    const { files, harness, publish } = setup();
    files.set(`${STORAGE}/big.png`, png(0, MAX_IMAGE_BYTES));
    files.set(`${STORAGE}/one.html`, html(`<img src="big.png">`));
    await expect(publish("one.html")).rejects.toThrow("- big.png is 5.0 MiB; each image must be at most 5.0 MiB. Resize or compress it.");

    for (const n of [1, 2, 3]) files.set(`${STORAGE}/p${n}.png`, png(n, 3 * MIB));
    files.set(`${STORAGE}/many.html`, html(`<img src="p1.png"><img src="p2.png"><img src="p3.png">`));
    await expect(publish("many.html")).rejects.toThrow(/With its images inlined the page is 12\.0 MiB; the limit is 10\.0 MiB\. Use fewer or smaller images\./u);
    await harness.lifecycle.dispose();
  });

  it("inlines Markdown images, including paths with spaces", async () => {
    const { files, harness, publish, stored } = setup();
    const chart = png(7);
    files.set(`${WORKSPACE}/notes/my chart.png`, chart);
    files.set(`${WORKSPACE}/notes/readme.md`, "# Notes\n\n![Chart](<my chart.png>)\n\n![Remote](https://example.test/r.png)\n");
    const page = await stored(await publish("notes/readme.md", "workspace"));
    expect(page).toContain(`<img src="${uri(chart)}" alt="Chart">`);
    expect(page).toContain(`<img src="https://example.test/r.png" alt="Remote">`);
    await harness.lifecycle.dispose();
  });

  it("inlines CSS url() in <style> and style attributes, and leaves fonts alone", async () => {
    const { files, harness, publish, stored } = setup();
    const bg = png(4);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    files.set(`${STORAGE}/bg.png`, bg);
    files.set(`${STORAGE}/icon.svg`, svg.toString("utf8"));
    files.set(`${STORAGE}/page.html`, `<!doctype html><html><head><style>body{background:url("bg.png")} @font-face{src:url(f.woff2)}</style></head><body><i style="background-image:url('icon.svg')"></i></body></html>`);
    const page = await stored(await publish("page.html"));
    expect(page).toContain(`body{background:url("${uri(bg)}")} @font-face{src:url(f.woff2)}`);
    expect(page).toContain(`<i style="background-image:url('${uri(svg, "image/svg+xml")}')">`);
    await harness.lifecycle.dispose();
  });

  it("compares inlined bytes, so changing only an image adds a version", async () => {
    const { files, harness, publish } = setup();
    files.set(`${STORAGE}/chart.png`, png(1));
    files.set(`${STORAGE}/page.html`, html(`<img src="chart.png">`));
    const first = await publish("page.html");
    expect((await publish("page.html")).version).toEqual(first.version);
    files.set(`${STORAGE}/chart.png`, png(2));
    const second = await publish("page.html");
    expect(second).toMatchObject({ page: { id: first.page.id }, version: { n: 2 } });
    await harness.lifecycle.dispose();
  });
});

describe("local image inlining in the live preview", () => {
  it("inlines readable images and leaves unusable ones as written", async () => {
    const { files, harness } = setup();
    const a = png(5);
    files.set(`${STORAGE}/a.png`, a);
    files.set(`${STORAGE}/live.html`, html(`<img src="a.png"><img src="gone.png">`));
    const response = await harness.behavior.fetchHttp("GET", `/file?${new URLSearchParams({ threadId: "thr_a", source: "thread-storage", file: "live.html" })}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`<img src="${uri(a)}"><img src="gone.png">`);
    await harness.lifecycle.dispose();
  });
});
