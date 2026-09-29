import { describe, expect, it } from "vitest";
import { PAGE_CSP, injectPage } from "./index.js";

const THEME = '<link rel="stylesheet" href="./_page/theme.css">';
const CHARTS = '<script src="./_page/charts.js" defer></script>';
const inject = (html: string, theme: "light" | "dark" | null = null, hasCharts = false) => injectPage(html, { assetBase: "./", theme, hasCharts });

describe("injectPage", () => {
  it("puts the theme first in <head>, before author styles, and leaves the rest untouched", () => {
    const html = '<!doctype html><html lang="en"><head><style>body{color:red}</style></head><body><p>x</p></body></html>';
    const out = inject(html);
    expect(out.indexOf(THEME)).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf(THEME)).toBeLessThan(out.indexOf("<style>"));
    expect(out).toContain('<link rel="preload" href="./_page/inter.roman.var.woff2" as="font" type="font/woff2" crossorigin>');
    expect(out.replace(/<link[^>]*>/gu, "")).toBe(html);
  });

  it("ignores </head>, <head>, and <html> inside scripts and comments", () => {
    const html = '<!-- <head> <html> --><!doctype html><html><head><script>const s = "</head><body>"; // <html></script></head><body></body></html>';
    const out = inject(html, "dark");
    expect(out).toContain(`<html data-bb-theme="dark"><head>${THEME}`);
    expect(out).toContain('<!-- <head> <html> -->');
    expect(out).toContain('const s = "</head><body>"; // <html></script>');
  });

  it("does not mistake a quoted '>' in an attribute for the end of <head>", () => {
    const out = inject('<html data-x="a>b"><head data-y=\'</head>\'><title>t</title></head><body></body></html>', "light");
    expect(out.startsWith('<html data-bb-theme="light" data-x="a>b"><head data-y=\'</head>\'><link')).toBe(true);
  });

  it("puts data-bb-theme first so it wins over an author duplicate", () => {
    expect(inject('<HTML data-bb-theme="light"><body></body></HTML>', "dark")).toMatch(/^<HTML data-bb-theme="dark" data-bb-theme="light">/u);
  });

  it("creates <head> after <html> when the document has none", () => {
    expect(inject("<html><body>x</body></html>")).toBe(`<html><head>${THEME}<link rel="preload" href="./_page/inter.roman.var.woff2" as="font" type="font/woff2" crossorigin></head><body>x</body></html>`);
  });

  it("wraps a bare fragment, after any doctype", () => {
    const fragment = inject("<h1>Hi</h1><p>there</p>", "dark", true);
    expect(fragment.startsWith(`<html data-bb-theme="dark"><head>${THEME}`)).toBe(true);
    expect(fragment.endsWith(`<h1>Hi</h1><p>there</p>${CHARTS}`)).toBe(true);
    expect(inject("<!DOCTYPE html>\n<p>x</p>").startsWith(`<!DOCTYPE html><head>${THEME}`)).toBe(true);
  });

  it("adds the chart runtime before the last real </body>, not one inside a script", () => {
    const html = '<html><head></head><body><script>document.write("</body>")</script><p>end</p></body></html>';
    expect(inject(html, null, true)).toContain(`<p>end</p>${CHARTS}</body></html>`);
    expect(inject("<html><body><p>x</p></html>", null, true)).toContain(`<p>x</p>${CHARTS}</html>`);
    expect(inject("<p>x</p>", null, false)).not.toContain("charts.js");
  });

  it("adds ?v= versions to asset URLs only when given (BB preview, not published sites)", () => {
    const out = injectPage("<p>x</p>", { assetBase: "./", theme: null, hasCharts: true, assetVersions: { "theme.css": "t1", "inter.roman.var.woff2": "f1", "charts.js": "c1" } });
    expect(out).toContain('href="./_page/theme.css?v=t1"');
    expect(out).toContain('href="./_page/inter.roman.var.woff2?v=f1"');
    expect(out).toContain('src="./_page/charts.js?v=c1"');
    expect(inject("<p>x</p>", null, true)).not.toContain("?v=");
  });

  it("can inline every preview asset without changing published-page output", () => {
    const out = injectPage("<p>x</p>", { assetBase: "./", theme: null, hasCharts: true, inlineAssets: { themeCss: "body { color: red; }", chartsJs: "globalThis.chart = true;" } });
    expect(out).toContain("<style>body { color: red; }</style>");
    expect(out).toContain("<script>globalThis.chart = true;</script>");
    expect(out).not.toContain("_page/");
    expect(inject("<p>x</p>")).toContain(THEME);
  });

  it("adds component runtimes only when needed, before the charts", () => {
    expect(inject("<p class=\"lede\">x</p>")).not.toContain("<script>");
    for (const html of ['<body><div class="tabs"><section data-tab="A"></section></div></body>', '<body><nav class="toc"></nav></body>']) {
      const out = inject(html, null, true);
      expect(out).toMatch(/<script>\(\(\) => \{[\s\S]*<\/script><script src="\.\/_page\/charts\.js" defer><\/script><\/body>$/u);
    }
    const table = inject('<body><div class="data-table"><script type="application/json">{"columns":[],"rows":[]}</script></div></body>');
    expect(table).toContain("const ROW_HEIGHT = 40");
    expect(table).not.toContain("// ---- Tabs:");
  });

  it("escapes the asset base", () => {
    expect(injectPage("<p>x</p>", { assetBase: '"><script>', theme: null, hasCharts: false })).not.toContain('"><script>_page');
  });
});

describe("PAGE_CSP", () => {
  const directives = Object.fromEntries(PAGE_CSP.split(";").map((part) => part.trim().split(/\s+/u)).map(([name, ...values]) => [name, values]));

  it("allows inline author code and self assets, and nothing remote for code", () => {
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(directives["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives["font-src"]).toEqual(["'self'", "data:"]);
    expect(directives["img-src"]).toEqual(["data:", "blob:", "https:"]);
    expect(directives["media-src"]).toEqual(["data:", "blob:", "https:"]);
    expect(directives["connect-src"]).toEqual(["'none'"]);
    expect(PAGE_CSP).not.toContain("unsafe-eval");
  });
});
