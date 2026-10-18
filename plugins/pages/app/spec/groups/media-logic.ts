// Pure helpers for the Media group: Web Mercator math for Map, and a few small readers.
// World coordinates run 0..1 across and down; a view is the world point at the viewport centre and a fractional zoom.
// Ported from GenUI ui/components/mapMath.ts (Apache-2.0): TILE_SIZE to visibleTiles.

export const TILE_SIZE = 256;
export const MIN_ZOOM = 1;
/** z18 is already street level and keeps tile counts sane. */
export const MAX_ZOOM = 18;
const MAX_LATITUDE = 85.05112878;

export type Point = { x: number; y: number };
export type View = Point & { zoom: number };
export type Size = { width: number; height: number };
export type Tile = { z: number; x: number; y: number; key: string; left: number; top: number; size: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const worldSize = (zoom: number) => TILE_SIZE * 2 ** zoom;

/** Latitude and longitude in degrees to world coordinates. */
export function project(lat: number, lng: number): Point {
  const sin = Math.sin((clamp(lat, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI) / 180);
  return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}

/** Keeps zoom in range, the view inside the world vertically, and x in 0..1 (longitude wraps). */
export function clampView(view: View, size: Size): View {
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  const half = size.height / 2 / worldSize(zoom);
  return { x: view.x - Math.floor(view.x), y: half >= 0.5 ? 0.5 : clamp(view.y, half, 1 - half), zoom };
}

/** The view showing every point with `padding` pixels to spare, zoomed in no further than `maxZoom`. */
export function fitView(points: readonly Point[], size: Size, padding: number, maxZoom: number): View {
  if (points.length === 0) return clampView({ x: 0.5, y: 0.5, zoom: MIN_ZOOM }, size);
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const zoomFor = (span: number, pixels: number) => span === 0 ? maxZoom : Math.log2(Math.max(1, pixels - 2 * padding) / (span * TILE_SIZE));
  return clampView({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: Math.min(maxZoom, zoomFor(maxX - minX, size.width), zoomFor(maxY - minY, size.height)) }, size);
}

/** Where `point` sits in the viewport, using its copy of the world nearest the view's centre. */
export function toScreen(point: Point, view: View, size: Size): { left: number; top: number } {
  const scale = worldSize(view.zoom), dx = point.x - view.x;
  return { left: (dx - Math.round(dx)) * scale + size.width / 2, top: (point.y - view.y) * scale + size.height / 2 };
}

/** The view moved by a drag of `dx`, `dy` pixels. */
export function pan(view: View, dx: number, dy: number, size: Size): View {
  const scale = worldSize(view.zoom);
  return clampView({ x: view.x - dx / scale, y: view.y - dy / scale, zoom: view.zoom }, size);
}

/** The view at `zoom`, with the world point under `anchor` (viewport pixels) still under it. */
export function zoomAround(view: View, zoom: number, anchor: { left: number; top: number }, size: Size): View {
  const target = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const ox = anchor.left - size.width / 2, oy = anchor.top - size.height / 2;
  const before = worldSize(view.zoom), after = worldSize(target);
  return clampView({ x: view.x + ox / before - ox / after, y: view.y + oy / before - oy / after, zoom: target }, size);
}

/** The tile level drawn for a view: the nearest whole level. */
export const tileZoom = (view: View) => clamp(Math.round(view.zoom), 0, MAX_ZOOM);

/** The tiles at level `z` covering the viewport, each with its place and drawn size. A wide view can show a tile twice, so keys are per copy. */
export function visibleTiles(view: View, size: Size, z = tileZoom(view)): Tile[] {
  const count = 2 ** z, scale = worldSize(view.zoom), tileSize = scale / count;
  const left = view.x - size.width / 2 / scale, right = view.x + size.width / 2 / scale;
  const top = view.y - size.height / 2 / scale, bottom = view.y + size.height / 2 / scale;
  const tiles: Tile[] = [];
  for (let ty = Math.max(0, Math.floor(top * count)); ty <= Math.min(count - 1, Math.floor(bottom * count)); ty += 1) {
    for (let tx = Math.floor(left * count); tx <= Math.floor(right * count); tx += 1) {
      tiles.push({ z, x: ((tx % count) + count) % count, y: ty, key: `${z}/${tx}/${ty}`, left: (tx / count - view.x) * scale + size.width / 2, top: (ty / count - view.y) * scale + size.height / 2, size: tileSize });
    }
  }
  return tiles;
}

export type LatLng = { lat: number; lng: number };

/** A position as an agent writes it: [lat, lng] or {lat, lng}. Null for anything else, including a place name. */
export function latLng(value: unknown): LatLng | null {
  const [lat, lng] = Array.isArray(value) ? value : [(value as { lat?: unknown } | null)?.lat, (value as { lng?: unknown } | null)?.lng];
  return typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** The average of `points`, for an area's popup and a geocoding nudge. Null when there are none. */
export function centroid(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  return { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length };
}

/** A place-name cache key: case and spacing don't make a new lookup. */
export const placeKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** Gallery columns when none are given: one photo full width, two or four in pairs, the rest in threes. */
export const autoColumns = (count: number) => count <= 1 ? 1 : count === 2 || count === 4 ? 2 : 3;

/** A percentage kept 4%..96% so a pin never hangs off the image edge; null when not a number. */
export const pinPercent = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(96, Math.max(4, value)) : null;

/** True when a computed CSS colour is light text, which means a dark theme. Reads oklch/oklab/lab/lch lightness, rgb, or color(srgb). */
export function lightText(color: string): boolean {
  const perceptual = /^(?:oklch|oklab|lab|lch)\(\s*([\d.]+)(%?)/i.exec(color.trim());
  if (perceptual) { const l = Number(perceptual[1]); return (perceptual[2] || l > 1 ? l / 100 : l) > 0.6; }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color.trim());
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(color.trim());
  const [r, g, b] = rgb ? rgb.slice(1).map((v) => Number(v) / 255) : srgb ? srgb.slice(1).map(Number) : [0, 0, 0];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

/** The geocoding nudge for a Map: the rounded centre of the places given as coordinates. */
export function mapNear(ats: readonly unknown[]): LatLng | undefined {
  const near = centroid(ats.flatMap((at) => latLng(at) ?? []));
  const round2 = (value: number) => Math.round(value * 100) / 100;
  return near ? { lat: round2(near.lat), lng: round2(near.lng) } : undefined;
}

/** The view a Map opens at: `center` (default zoom 13), else every place fitted, at `zoom` when given. */
export function mapView(places: readonly LatLng[], center: LatLng | null, zoom: number | undefined, size: Size): View {
  if (center) return clampView({ ...project(center.lat, center.lng), zoom: zoom ?? 13 }, size);
  const world = places.map((p) => project(p.lat, p.lng));
  const fitted = fitView(world, size, 44, world.length <= 1 ? 14 : 15);
  return zoom !== undefined && world.length ? clampView({ ...fitted, zoom }, size) : fitted;
}

/** The photo search ImageSearch asks for: the trimmed query and 1..8 photos. Null when the query is empty. */
export function searchInput(query: unknown, count: unknown): { query: string; count: number } | null {
  const text = typeof query === "string" ? query.trim() : "";
  return text ? { query: text, count: Math.min(8, Math.max(1, Math.round(typeof count === "number" && Number.isFinite(count) ? count : 1))) } : null;
}

/** The map size before the first layout, and where there is no layout. The publish bakes its tiles too. */
export const MAP_FALLBACK_SIZE: Size = { width: 640, height: 288 };
