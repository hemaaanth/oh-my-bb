import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintPageStyles, formatStyleIssues } from "./style-lint.js";
import { checkApp } from "./app-lint.js";
import { readPageAsset } from "../../render/assets.js";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/style/${name}.html`, import.meta.url), "utf8");
const rules = (html: string) => lintPageStyles(html).map(issue => issue.rule);

describe("author style guard", () => {
  it("locates the security-suite conflicts and gives concrete replacements", () => {
    const html = fixture("security-suite");
    const issues = lintPageStyles(html);
    expect(rules(html)).toEqual(expect.arrayContaining(["base-element", "font-family", "page-width", "heavy-weight", "raw-color", "left-accent"]));
    for (const issue of issues) {
      expect(issue.line).toBeGreaterThan(0); expect(issue.column).toBeGreaterThan(0);
      expect(html.slice(0, issue.offset).split("\n")).toHaveLength(issue.line);
    }
    expect(checkApp(html).ok).toBe(false);
  });
  it("finds anonymous wrapper widths, shorthand fonts and inline colors", () => {
    expect(rules(fixture("console-v3"))).toEqual(expect.arrayContaining(["page-width", "font-family", "heavy-weight", "raw-color"]));
  });
  it("accepts theme classes, tokens and local chart widths", () => {
    expect(lintPageStyles(fixture("theme-only"))).toEqual([]);
    expect(lintPageStyles('<style>.chart{width:100%}.caption{color:var(--bb-muted)}.table,[data-label="body"]{padding:2px}</style>')).toEqual([]);
    expect(lintPageStyles('<style>.page > .chart{width:100%}body .caption{color:var(--bb-muted)}.tile/*body*/{padding:2px}</style>')).toEqual([]);
    expect(rules('<style>.report{max-width:70rem}</style><body><div class="report">Report</div></body>')).toEqual(["page-width"]);
  });
  it("waives only the exact style block or element, never descendants or sandbox rules", () => {
    const mockup = fixture("icon-mockup");
    expect(lintPageStyles(mockup)).toEqual([]);
    expect(rules(mockup.replaceAll(' data-pages-style="custom"', ""))).toContain("raw-color");
    expect(rules(mockup + '<style>.neighbor{color:#fff}</style>')).toEqual(["raw-color"]);
    expect(rules('<body data-pages-style="custom"><div style="color:#fff"></div></body>')).toEqual(["raw-color"]);
    expect(rules('<div data-pages-style="CUSTOM" style="color:#fff"></div>')).toEqual(["raw-color"]);
    expect(checkApp(mockup + '<script>const broken = ;</script><img src="https://example.test/a.png">').ok).toBe(false);
  });
  it("recognizes only exact bundled raw and font-inlined themes", () => {
    const raw = readPageAsset("theme.css").bytes.toString("utf8");
    const font = readPageAsset("inter.roman.var.woff2").bytes.toString("base64");
    for (const css of [raw, raw.replaceAll('url("inter.roman.var.woff2")', `url("data:font/woff2;base64,${font}")`)]) expect(lintPageStyles(`<style>${css}</style>`)).toEqual([]);
    expect(rules(`<style>${raw}\n.x{color:#fff}</style>`)).toContain("raw-color");
    expect(rules('<style>/* Pages theme */ .x{color:#fff}</style>')).toEqual(["raw-color"]);
  });
  it("ignores comments, script strings, quoted text and data URLs", () => {
    expect(lintPageStyles(`<!--<style>body{color:#fff}</style>--><script>const s = '<style>body{color:#fff}</style>';</script><style>.tile{content:"#fff;body{font:600}";background:url("data:image/svg+xml;#fff");mask:url(#abc)}</style>`)).toEqual([]);
  });
  it("handles nested and uppercase CSS, entities and var fallbacks", () => {
    expect(rules('<STYLE>@media screen { :is(BODY,.table) { COLOR:var(--bb-text,#fff); FONT:700 12px Inter } }</STYLE>')).toEqual(expect.arrayContaining(["base-element", "raw-color", "font-family", "heavy-weight"]));
    const html = '<div style="font-family:&quot;Inter&quot;;color:&#35;fff"></div>';
    const issues = lintPageStyles(html);
    expect(issues.map(issue => issue.rule)).toEqual(["font-family", "raw-color"]);
    expect(issues.every(issue => issue.offset === html.indexOf("font-family"))).toBe(true);
  });
  it("joins repeated eyebrow rules and respects weight/reset boundaries", () => {
    expect(rules('<style>.meta{text-transform:uppercase}.meta{letter-spacing:.1em}.a{font-weight:599;border-left:0}.b{font-weight:600;border-inline-start:none}.c{background:linear-gradient(var(--bb-text),var(--bb-surface))}</style>')).toEqual(["eyebrow", "heavy-weight", "gradient"]);
  });
  it.each(["inherit", "unset", "revert", "revert-layer", "initial", "var(--bb-font-sans)", "var( --bb-font-mono )"])("accepts theme-owned font-family value %s", value => {
    expect(checkApp(`<span style="font-family:${value}">id</span>`).ok).toBe(true);
  });
  it.each(["--bb-font-sans", "--bb-font-mono"])("rejects direct rebinding of %s but permits unchanged references and custom visuals", token => {
    const css = `.caption{${token}:"Comic Sans MS";font-family:var(${token})}`;
    const html = `<style>${css}</style><div class="caption">Report</div>`;
    expect(rules(html)).toEqual(["font-family"]);
    expect(checkApp(html).ok).toBe(false);
    expect(rules(`<span style='${token}:"Comic Sans MS";font-family:var(${token})'>Report</span>`)).toEqual(["font-family"]);
    expect(lintPageStyles(`<style>.caption{font-family:var(${token})}</style>`)).toEqual([]);
    expect(lintPageStyles(`<style data-pages-style="custom">${css}</style>`)).toEqual([]);
    expect(lintPageStyles(`<span data-pages-style="custom" style='${token}:"Comic Sans MS";font-family:var(${token})'>Art</span>`)).toEqual([]);
  });
  it("allows only thin theme-rule separators, not accent rails", () => {
    for (const prop of ["border-left", "border-inline-start"]) {
      for (const width of ["1px", "thin"]) expect(lintPageStyles(`<div style="${prop}:${width} solid var(--bb-rule)">row</div>`)).toEqual([]);
      expect(rules(`<div style="${prop}:3px solid var(--bb-rule)">row</div>`)).toContain("left-accent");
      expect(rules(`<div style="${prop}:1px solid var(--bb-warning)">row</div>`)).toContain("left-accent");
    }
    expect(rules('<span style="font-family:Inter">id</span>')).toEqual(["font-family"]);
  });
  it("ignores :not/:has conditions while retaining positive :is/:where targets", () => {
    for (const selector of [".chart:not(body)", ".chart:has(h1)", '.chart:not(:is(body,[data-label=")"]))', ".chart:has(:where(main,.page))"]) {
      expect(lintPageStyles(`<style>${selector}{color:var(--bb-text);width:100%}</style>`)).toEqual([]);
    }
    for (const selector of [":is(body,.chart)", ":where(body,.chart)", ":is(.chart:not(body),h1)"]) {
      expect(rules(`<style>${selector}{color:var(--bb-text)}</style>`)).toContain("base-element");
    }
  });
  it("uses the final compound in every positive :is/:where branch, not its ancestors", () => {
    for (const selector of [":is(body .caption,.tile)", ":where(body .caption,.tile)", ":is(:where(body .caption),.tile)", ":where(.page > .caption,.tile)"]) {
      const html = `<style>${selector}{padding:1rem;width:100%}</style>`;
      expect(lintPageStyles(html), selector).toEqual([]);
      expect(checkApp(html).ok, selector).toBe(true);
    }
    for (const selector of [":where(.caption h1,.tile)", ":is(body,.chart)", ":is(:where(.caption h1),.tile)"]) {
      expect(rules(`<style>${selector}{padding:1rem}</style>`), selector).toContain("base-element");
    }
    expect(rules('<style>:where(.caption main,.tile){width:100%}</style>')).toContain("page-width");
  });
  it("keeps unrelated at-rule scopes separate and joins identical scopes", () => {
    expect(lintPageStyles('<style>@media (min-width:900px){.meta{text-transform:uppercase}}@media (max-width:600px){.meta{letter-spacing:.1em}}</style>')).toEqual([]);
    expect(rules('<style>@media screen{.meta{text-transform:uppercase}}@media screen{.meta{letter-spacing:.1em}}</style>')).toEqual(["eyebrow"]);
    expect(rules('<style>@media screen{@supports (display:grid){.meta{text-transform:uppercase}.meta{letter-spacing:.1em}}}</style>')).toEqual(["eyebrow"]);
  });
  it("lets root and enclosing eyebrow declarations contribute to nested scopes", () => {
    const upper = ".meta{text-transform:uppercase}";
    const tracked = ".meta{letter-spacing:.1em}";
    for (const css of [
      `${upper}@media screen{${tracked}}`,
      `@media screen{${tracked}}${upper}`,
      `${tracked}@media screen{${upper}}`,
      `${upper}@media screen{@supports (display:grid){${tracked}}}`,
      `@media screen{${upper}@supports (display:grid){${tracked}}}`,
    ]) expect(rules(`<style>${css}</style>`), css).toEqual(["eyebrow"]);
    expect(lintPageStyles(`<style>${upper}@media screen{.other{letter-spacing:.1em}}</style>`)).toEqual([]);
    expect(lintPageStyles(`<style>@media (min-width:900px){${upper}}@media (max-width:600px){${tracked}}</style>`)).toEqual([]);
  });
  it("deduplicates identical inline findings without hiding other rules", () => {
    const issues = lintPageStyles('<span style="font:700 12px var(--bb-font-sans);font-weight:700;color:#fff">x</span>');
    expect(issues.map(issue => issue.rule)).toEqual(["font-family", "heavy-weight", "raw-color"]);
    expect(new Set(issues.map(issue => JSON.stringify([issue.rule, issue.offset, issue.context]))).size).toBe(issues.length);
  });
  it("reports CSS parse failures and bounds formatted output without a clean result", () => {
    expect(rules('<style>.a {color:</style>')).toContain("css-syntax");
    const issues = lintPageStyles('<style>' + Array.from({length: 60}, (_, n) => `.n${n}{color:#fff}`).join("") + '</style>');
    expect(issues).toHaveLength(60);
    expect(formatStyleIssues(issues)).toContain("10 more style findings omitted");
    const bounded = checkApp('<style>' + Array.from({length: 60}, (_, n) => `.n${n}{color:#fff}`).join("") + '</style>');
    expect(bounded).toMatchObject({ ok: false, issues: expect.any(Array) });
    expect(bounded.issues).toHaveLength(50);
    expect(bounded.report).toContain("10 more style findings omitted");
    expect(checkApp('<style>body {font:600 16px Inter;max-width:62rem;color:#fff}</style><script>const n=1;</script>').ok).toBe(false);
  });
});
