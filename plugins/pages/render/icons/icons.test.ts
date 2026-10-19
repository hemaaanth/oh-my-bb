import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { injectPage, pageIcons } from "../index.js";
import { generate } from "./generate.mjs";
import { iconPaths, type IconSet } from "./expand.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const inject = (html: string) => injectPage(html, { assetBase: "./", theme: null, hasCharts: false });
const SET: IconSet = {
  line: { star: '<path d="S"/>', home: '<path d="H"/>', home4: '<path d="H4"/>', chartline: '<path d="CL"/>' },
  fill: { star: '<path d="SF"/>', home4: '<path d="H4F"/>' },
  aliases: { house: "home4" },
};

describe("MingCute icon files", () => {
  // They are committed so the server and the app need no build step at install.
  it("match mingcute_icon and the glyph table (run npm run build:icons)", () => {
    const { json, spec, doc } = generate(`${root}node_modules/mingcute_icon/svg`);
    expect(readFileSync(`${root}assets/icons.json`, "utf8") === json).toBe(true);
    expect(readFileSync(`${root}app/spec/icons.generated.tsx`, "utf8")).toBe(spec);
    expect(readFileSync(`${root}skills/pages/references/icons.md`, "utf8")).toBe(doc);
  }, 30_000);

  it("keep only the drawn paths, coloured by the text", () => {
    const { line, fill } = pageIcons();
    const all = [...Object.values(line), ...Object.values(fill)].join("");
    expect(all).not.toMatch(/M24 0v24|M0 0h24v24|M24,0 L24,24|fill="#|url\(#/u);
    expect(Object.keys(line).length).toBeGreaterThan(1600);
  });
});

describe("iconPaths", () => {
  it("reads names without case, spaces, dashes, or underscores", () => {
    expect(iconPaths("Star", SET)).toBe('<path d="S"/>');
    expect(iconPaths("home_4", SET)).toBe('<path d="H4"/>');
    expect(iconPaths("chart-line", SET)).toBe('<path d="CL"/>');
  });

  it("prefers a familiar name, and -line or -fill reaches the exact MingCute name first", () => {
    expect(iconPaths("house", SET)).toBe('<path d="H4"/>');
    expect(iconPaths("star-fill", SET)).toBe('<path d="SF"/>');
    expect(iconPaths("home-line", SET)).toBe('<path d="H"/>');
    expect(iconPaths("house fill", SET)).toBe('<path d="H4F"/>');
    expect(iconPaths("nope", SET)).toBeUndefined();
    expect(iconPaths("nope-fill", SET)).toBeUndefined();
  });
});

describe("injectPage icons", () => {
  it("swaps an empty <i data-icon> for an inline, decorative SVG", () => {
    const out = inject('<p>Ship <i data-icon="rocket"></i> now</p>');
    expect(out).toMatch(/<p>Ship <svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" data-icon="rocket"><path d="[^"]+"\/><\/svg> now<\/p>/u);
  });

  it("keeps the author's attributes, adds to the class, and labels icons with aria-label", () => {
    const out = inject(`<button><i class="big" data-icon='star-fill' style="color:red" aria-label='A "star"'></i>Save</button>`);
    expect(out).toContain('<svg class="icon big" viewBox="0 0 24 24" fill="currentColor" role="img" data-icon="star-fill" style="color:red" aria-label="A &quot;star&quot;">');
    expect(out).toMatch(/<\/svg>Save<\/button>/u);
  });

  it("leaves unknown names, non-empty elements, and text that only looks like an icon alone", () => {
    const html = '<i data-icon="no-such-icon"></i><i data-icon="star">kept</i><script>const s = \'<i data-icon="star"></i>\'</script><!-- <i data-icon="star"></i> -->';
    expect(inject(html)).toContain(html);
  });
});
