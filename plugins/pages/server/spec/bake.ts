// Bakes a page's openui-lang blocks at publish time. A published page has no server to ask, so the publish
// runs what the blocks need and stores the answers in the page (render/spec-baked.ts): the Query calls the
// publish allows, place names, the Map tiles of each map's opening view, and photo searches. Tiles go in as
// data URLs, so the Mapbox token never leaves the server.
import { createParser, type ASTNode, type LibraryJSONSchema } from "@openuidev/lang-core";
import type { SpecResult, WEB_METHODS } from "../../contract.js";
import { bakedKey, bakedScript, specBlocks, withoutBaked, type Baked } from "../../render/spec-baked.js";
import { MAP_FALLBACK_SIZE, latLng, mapNear, mapView, placeKey, searchInput, visibleTiles, type LatLng, type Size } from "../../app/spec/groups/media-logic.js";
import schema from "./library.schema.json";

type WebMethod = (typeof WEB_METHODS)[number];

export type BakeDeps = {
  /** Runs a Query call, or returns null when the publish does not allow that tool. */
  tool: (tool: string, args: Record<string, unknown>) => Promise<SpecResult> | null;
  /** Runs a web lookup; null when web lookups are off. */
  web: ((method: WebMethod, input: Record<string, unknown>) => Promise<SpecResult>) | null;
};

/**
 * The map sizes baked: the page column (46rem) and a phone, less the map's border (its height is h-72),
 * and the size a map has before its first layout.
 * A reader at another width, or one who pans or zooms, may see tiles that were not baked; those stay blank.
 */
export const MAP_SIZES: readonly Size[] = [{ width: 734, height: 286 }, { width: 340, height: 286 }, MAP_FALLBACK_SIZE];
/** Baked tiles stop here, so a page of many maps stays well under the page size limit. */
export const MAX_BAKED_TILE_BYTES = 6 * 1024 * 1024;

let parser: ReturnType<typeof createParser> | undefined;
const parse = (code: string) => (parser ??= createParser(schema as unknown as LibraryJSONSchema)).parse(code);

/** A literal value, or undefined when the node needs evaluating ($state, references, expressions). */
function literal(node: ASTNode | null): unknown {
  if (!node) return undefined;
  switch (node.k) {
    case "Str": case "Num": case "Bool": return node.v;
    case "Null": return null;
    case "Arr": { const values = node.els.map(literal); return values.includes(undefined) ? undefined : values; }
    case "Obj": { const entries = node.entries.map(([key, value]) => [key, literal(value)] as const); return entries.some(([, value]) => value === undefined) ? undefined : Object.fromEntries(entries); }
    default: return undefined;
  }
}

type Element = { typeName: string; props: Record<string, unknown> };

/** Every component in a parsed tree, outermost first. */
function elements(value: unknown, out: Element[] = []): Element[] {
  if (Array.isArray(value)) for (const item of value) elements(item, out);
  else if (value && typeof value === "object") {
    const node = value as { type?: unknown; typeName?: unknown; props?: unknown };
    if (node.type === "element" && typeof node.typeName === "string" && node.props && typeof node.props === "object") {
      out.push(node as Element);
      elements(node.props, out);
    } else for (const item of Object.values(value)) elements(item, out);
  }
  return out;
}

const props = (node: unknown): Record<string, unknown> => {
  const value = (node as { props?: unknown } | null)?.props;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
};

/** Bakes the openui-lang blocks of `html`. A page without blocks comes back unchanged. */
export async function bakeSpecs(html: string, deps: BakeDeps): Promise<string> {
  const clean = withoutBaked(html);
  const blocks = specBlocks(clean);
  if (blocks.length === 0) return clean;
  const baked: Baked = {};
  let tileBytes = 0;

  const web = async (method: WebMethod, input: Record<string, unknown>): Promise<SpecResult | null> => {
    if (!deps.web) return null;
    const key = bakedKey("web", method, input);
    baked[key] ??= await deps.web(method, input);
    return baked[key];
  };

  for (const { code } of blocks) {
    const result = parse(code);
    for (const query of result.queryStatements) {
      const tool = literal(query.toolAST);
      const args = query.argsAST ? literal(query.argsAST) : {};
      if (typeof tool !== "string" || !args || typeof args !== "object" || Array.isArray(args)) continue;
      const key = bakedKey("tool", tool, args);
      if (key in baked) continue;
      const answer = deps.tool(tool, args as Record<string, unknown>);
      if (answer) baked[key] = await answer;
    }
    if (!deps.web) continue;
    for (const element of elements(result.root)) {
      if (element.typeName === "ImageSearch") {
        const input = searchInput(element.props.query, element.props.count);
        if (input) await web("search", input);
      }
      if (element.typeName !== "Map") continue;
      // Same lookups as MapBody: each place name once, nudged toward the places given as coordinates.
      const markers = Array.isArray(element.props.markers) ? element.props.markers : [];
      const areas = Array.isArray(element.props.areas) ? element.props.areas : [];
      const ats = markers.map((marker) => props(marker).at);
      const near = mapNear(ats);
      const center = element.props.center;
      const found = new Map<string, LatLng | null>();
      for (const at of [...ats, center]) {
        const name = typeof at === "string" ? at.trim() : "";
        if (!name || found.has(placeKey(name))) continue;
        const answer = await web("geocode", near ? { name, near } : { name });
        found.set(placeKey(name), answer?.ok ? latLng(answer.data) : null);
      }
      const resolve = (at: unknown) => latLng(at) ?? (typeof at === "string" ? found.get(placeKey(at)) ?? null : null);
      const places = [
        ...ats.flatMap((at) => resolve(at) ?? []),
        ...areas.flatMap((area) => {
          const points = (Array.isArray(props(area).points) ? props(area).points as unknown[] : []).flatMap((point) => latLng(point) ?? []);
          return points.length >= 3 ? points : [];
        }),
      ];
      const centerAt = center === undefined || center === null ? null : resolve(center);
      const zoom = typeof element.props.zoom === "number" ? element.props.zoom : undefined;
      for (const size of MAP_SIZES) {
        for (const tile of visibleTiles(mapView(places, centerAt, zoom, size), size)) {
          for (const theme of ["light", "dark"] as const) {
            const input = { z: tile.z, x: tile.x, y: tile.y, theme };
            if (bakedKey("web", "tile", input) in baked || tileBytes > MAX_BAKED_TILE_BYTES) continue;
            const answer = await web("tile", input);
            tileBytes += answer ? JSON.stringify(answer).length : 0;
          }
        }
      }
    }
  }
  if (Object.keys(baked).length === 0) return clean;
  const first = blocks[0]!.at;
  return `${clean.slice(0, first)}${bakedScript(baked)}${clean.slice(first)}`;
}
