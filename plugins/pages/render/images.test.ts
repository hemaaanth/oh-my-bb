import { describe, expect, it } from "vitest";
import { findLocalImages, isImageBytes, localImagePath, replaceImages } from "./images.js";

const paths = (html: string) => findLocalImages(html).map((ref) => ref.path);
const spans = (html: string) => findLocalImages(html).map((ref) => html.slice(ref.start, ref.end));

describe("findLocalImages", () => {
  it("finds src, srcset, poster, SVG href, and CSS url() in style attributes and <style>", () => {
    const html = `<style>.a{background:url("img/bg.png")} .b{background:url(img/b.webp)} @font-face{src:url(font.woff2)}</style>
<img src="a.png" srcset="a-1x.png 1x, a-2x.png 2x"><video poster='p.jpg'></video>
<svg><image href="s.svg"/></svg><div style="background-image: url('d.gif')"></div>`;
    expect(paths(html)).toEqual(["img/bg.png", "img/b.webp", "a.png", "a-1x.png", "a-2x.png", "p.jpg", "s.svg", "d.gif"]);
    expect(spans(html)).toEqual(["img/bg.png", "img/b.webp", "a.png", "a-1x.png", "a-2x.png", "p.jpg", "s.svg", "d.gif"]);
  });

  it("leaves remote, data:, blob:, fragment, and non-image URLs alone", () => {
    const html = `<img src="https://x.test/a.png"><img src="//cdn.test/a.png"><img src="data:image/png;base64,AAAA"><img src="blob:abc">
<img src="#frag"><img src="notes.txt"><img src="C:\\pics\\a.png"><img srcset="data:image/png;base64,AA, local.png 2x"><a href="x.png">x</a>`;
    expect(paths(html)).toEqual([]);
  });

  it("ignores markup in comments and scripts", () => {
    expect(paths(`<!-- <img src="a.png"> --><script>const s = '<img src="b.png">'</script><img src="c.png">`)).toEqual(["c.png"]);
  });

  it("decodes entities and %-escapes and drops ?query and #hash", () => {
    expect(localImagePath("my%20chart.png?v=2#x")).toBe("my chart.png");
    expect(localImagePath("a&amp;b.svg")).toBe("a&b.svg");
    expect(localImagePath(" padded.png ")).toBeNull(); // callers trim; refAt keeps the span exact
    expect(spans(`<img src=" padded.png ">`)).toEqual(["padded.png"]);
  });

  it("replaces only refs with a data URI, keeping the rest byte for byte", () => {
    const html = `<img src="a.png"><img src="b.png"><div style="background:url(a.png)"></div>`;
    const out = replaceImages(html, findLocalImages(html), new Map([["a.png", "data:image/png;base64,QQ=="]]));
    expect(out).toBe(`<img src="data:image/png;base64,QQ=="><img src="b.png"><div style="background:url(data:image/png;base64,QQ==)"></div>`);
  });
});

describe("isImageBytes", () => {
  it("accepts image signatures and SVG roots, and rejects other bytes", () => {
    expect(isImageBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(isImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isImageBytes(Buffer.from('<?xml version="1.0"?>\n<!-- c --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
    expect(isImageBytes(Buffer.from("SECRET_TOKEN=abc"))).toBe(false);
    expect(isImageBytes(Buffer.from("<html><svg></svg></html>"))).toBe(false);
  });
});
