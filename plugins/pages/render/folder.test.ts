import { describe, expect, it } from "vitest";
import { resolveFolderRef, rewriteFolderCss, rewriteFolderHtml, type FolderRefs } from "./index.js";

const files: Record<string, { text: string; contentType: string }> = {
  "index.html": { text: "<h1>Home</h1>", contentType: "text/html; charset=utf-8" },
  "a.png": { text: "PNG", contentType: "image/png" },
  "img/b c.png": { text: "B", contentType: "image/png" },
  "img/2x.png": { text: "2X", contentType: "image/png" },
  "css/site.css": { text: "body{background:url('../a.png')}@import \"more.css\";", contentType: "text/css; charset=utf-8" },
  "css/more.css": { text: "p{color:red}", contentType: "text/css; charset=utf-8" },
  "loop.css": { text: "@import \"loop.css\";", contentType: "text/css; charset=utf-8" },
  "clip.mp4": { text: "MP4", contentType: "video/mp4" },
  "docs/other.html": { text: "<p>Other</p>", contentType: "text/html; charset=utf-8" },
};
const refs: FolderRefs = {
  file: (file) => { const hit = files[file]; return hit ? { bytes: Buffer.from(hit.text), contentType: hit.contentType } : null; },
  link: (file) => `./a?path=${encodeURIComponent(file)}`,
};
const data = (file: string) => `data:${files[file]!.contentType.replace(/\s+/gu, "")};base64,${Buffer.from(files[file]!.text).toString("base64")}`;
const decodeCss = (url: string) => Buffer.from(url.replace(/^data:[^,]*,/u, ""), "base64").toString("utf8");

describe("resolveFolderRef", () => {
  it("resolves relative paths from the referring file, with query and fragment split off", () => {
    expect(resolveFolderRef("a.png", "index.html")).toEqual({ path: "a.png", fragment: "" });
    expect(resolveFolderRef("../a.png?v=1#x", "css/site.css")).toEqual({ path: "a.png", fragment: "#x" });
    expect(resolveFolderRef("./img/b%20c.png", "index.html")).toEqual({ path: "img/b c.png", fragment: "" });
    expect(resolveFolderRef("docs/", "index.html")).toEqual({ path: "docs/index.html", fragment: "" });
    expect(resolveFolderRef("../", "docs/other.html")).toEqual({ path: "index.html", fragment: "" });
  });

  it("leaves absolute, scheme, protocol-relative, fragment, and escaping references alone", () => {
    for (const ref of ["/a.png", "https://x.test/a.png", "//cdn.test/a.png", "data:image/png;base64,AA", "mailto:a@b.co", "#top", "", "../a.png", "?q=1", "%E0%A4%A"]) {
      expect(resolveFolderRef(ref, "index.html")).toBeNull();
    }
  });
});

describe("rewriteFolderHtml", () => {
  it("inlines src, link href, poster, and srcset; points page links at the preview route", () => {
    const html = '<link rel="stylesheet" href="css/more.css"><img src="a.png" srcset="img/2x.png 2x, img/b%20c.png 300w"><video poster="a.png"><source src="clip.mp4"></video><a href="docs/other.html#s">o</a><a href="./">home</a>';
    const out = rewriteFolderHtml(html, "index.html", refs);
    expect(out).toContain(`<link rel="stylesheet" href="${data("css/more.css")}">`);
    expect(out).toContain(`<img src="${data("a.png")}" srcset="${data("img/2x.png")} 2x, ${data("img/b c.png")} 300w">`);
    expect(out).toContain(`<video poster="${data("a.png")}"><source src="${data("clip.mp4")}"></video>`);
    expect(out).toContain('<a href="./a?path=docs%2Fother.html#s">o</a>');
    expect(out).toContain('<a href="./a?path=index.html">home</a>');
  });

  it("rewrites CSS url() in <style> and style=\"\", resolving from the referring file", () => {
    const out = rewriteFolderHtml(`<style>.x{background:url(a.png)}</style><div style="background:url(&quot;img/2x.png&quot;)"></div>`, "index.html", refs);
    expect(out).toContain(`<style>.x{background:url(${data("a.png")})}</style>`);
    expect(out).toContain(`<div style="background:url(${data("img/2x.png")})"></div>`);
    expect(rewriteFolderHtml('<img src="../a.png">', "docs/other.html", refs)).toBe(`<img src="${data("a.png")}">`);
  });

  it("leaves absolute, data:, fragment, protocol-relative, missing, and iframe references alone", () => {
    const html = '<img src="https://x.test/a.png"><img src="data:image/png;base64,AA"><a href="#top">t</a><img src="//cdn.test/a.png"><img src="/a.png"><img src="missing.png"><a href="missing.html">m</a><iframe src="docs/other.html"></iframe><script>const s = "a.png";</script>';
    expect(rewriteFolderHtml(html, "index.html", refs)).toBe(html);
  });
});

describe("rewriteFolderCss", () => {
  it("inlines url() and nested @import, and stops at circular imports", () => {
    const out = rewriteFolderCss('@import "css/site.css"; .y{background:url("a.png")} .z{background:url(missing.png)}', "index.html", refs);
    const site = /@import url\((data:[^)]*)\)/u.exec(out)![1]!;
    expect(decodeCss(site)).toContain(`url(${data("a.png")})`);
    expect(decodeCss(site)).toContain(`@import url(${data("css/more.css")})`);
    expect(out).toContain(`.y{background:url(${data("a.png")})}`);
    expect(out).toContain(".z{background:url(missing.png)}");
    // A circular import is inlined a few levels deep, then left as written.
    let css = rewriteFolderCss('@import "loop.css";', "index.html", refs);
    for (let depth = 0; depth < 4; depth += 1) css = decodeCss(/@import url\((data:[^)]*)\)/u.exec(css)![1]!);
    expect(css).toBe('@import "loop.css";');
  });
});
