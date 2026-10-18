import { describe, expect, it } from "vitest";
import { specLibrary } from "../../app/spec/catalog.js";
import { BAKED_ATTRIBUTE, bakedKey, escapeSpec, type Baked } from "../../render/spec-baked.js";
import { bakeSpecs, type BakeDeps } from "./bake.js";

const block = (code: string) => `<script type="text/openui-lang">${escapeSpec(code)}</script>`;
const bakedOf = (html: string): Baked => JSON.parse(new RegExp(`<script type="application/json" ${BAKED_ATTRIBUTE}>(.*?)</script>`, "su").exec(html)![1]!);

function fakes(allowed = ["file"]) {
  const calls: string[] = [];
  const deps: BakeDeps = {
    tool: (tool, args) => allowed.includes(tool) ? (calls.push(bakedKey("tool", tool, args)), Promise.resolve({ ok: true, data: { rows: [{ n: 1 }] } })) : null,
    web: (method, input) => {
      calls.push(bakedKey("web", method, input));
      if (method === "geocode") return Promise.resolve({ ok: true, data: { lat: 38.69, lng: -9.21 } });
      if (method === "tile") return Promise.resolve({ ok: true, data: { dataUrl: "data:image/png;base64,AAAA" } });
      return Promise.resolve({ ok: true, data: { images: [] } });
    },
  };
  return { deps, calls };
}

describe("bakeSpecs", () => {
  // The server parses blocks with this schema, so it never imports the React catalog. -u regenerates it.
  it("keeps the library schema the server parses with in step with the catalog", async () => {
    await expect(`${JSON.stringify(specLibrary.toJSONSchema(), null, 1)}\n`).toMatchFileSnapshot("./library.schema.json");
  });

  it("leaves a page without blocks alone", async () => {
    const { deps, calls } = fakes();
    expect(await bakeSpecs("<p>Hi</p>", deps)).toBe("<p>Hi</p>");
    expect(calls).toEqual([]);
  });

  it("bakes literal Query calls the publish allows, and skips the rest", async () => {
    const { deps } = fakes(["file"]);
    const html = await bakeSpecs(`<h1>T</h1>${block(`data = Query("file", {path: "a.json"}, {rows: []})\nt = Query("threads", {})\nq = Query("file", {path: $p}, {rows: []})\n$p = "b.json"\nroot = Stack([TextContent("x")])`)}`, deps);
    const baked = bakedOf(html);
    expect(Object.keys(baked)).toEqual([bakedKey("tool", "file", { path: "a.json" })]);
    expect(html.indexOf(BAKED_ATTRIBUTE)).toBeLessThan(html.indexOf("text/openui-lang"));
  });

  it("bakes place names, the opening tiles in both themes, and photo searches", async () => {
    const { deps, calls } = fakes();
    const html = await bakeSpecs(block(`root = Stack([Map([Marker("Tower", "Belém Tower, Lisbon"), Marker("B", [38.7, -9.1])]), ImageSearch("  Pena Palace ", 3)])`), deps);
    expect(calls).toContain(bakedKey("web", "geocode", { name: "Belém Tower, Lisbon", near: { lat: 38.7, lng: -9.1 } }));
    expect(calls).toContain(bakedKey("web", "search", { query: "Pena Palace", count: 3 }));
    const tiles = calls.filter((call) => call.startsWith("web:tile:"));
    expect(tiles.length).toBeGreaterThan(4);
    expect(tiles.filter((call) => call.includes('"dark"')).length).toBe(tiles.length / 2);
    expect(new Set(tiles).size).toBe(tiles.length);
    expect(Object.keys(bakedOf(html))).toEqual(expect.arrayContaining(tiles));
  });

  it("bakes no web lookups when they are off, and replaces old baked answers", async () => {
    const { deps } = fakes();
    const stale = `<script type="application/json" ${BAKED_ATTRIBUTE}>{"old":1}</script>`;
    const html = await bakeSpecs(`${stale}${block(`root = Map([Marker("A", "Lisbon")])`)}`, { ...deps, web: null });
    expect(html).not.toContain(BAKED_ATTRIBUTE);
    expect(html).toContain("text/openui-lang");
  });

  it("escapes the baked answers so no string can close the script", async () => {
    const deps: BakeDeps = { tool: () => Promise.resolve({ ok: true, data: { text: "</script><img src=x onerror=alert(1)>" } }), web: null };
    const html = await bakeSpecs(block(`d = Query("file", {path: "a"}, {})\nroot = TextContent("x")`), deps);
    expect(html.match(/<\/script>/gu)).toHaveLength(2);
    expect(bakedOf(html)[bakedKey("tool", "file", { path: "a" })]).toEqual({ ok: true, data: { text: "</script><img src=x onerror=alert(1)>" } });
  });
});
