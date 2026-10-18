// Ported from GenUI ui/components/mapMath.test.ts (Apache-2.0), plus the Media readers.
import { describe, expect, it } from "vitest";
import { autoColumns, centroid, clampView, fitView, latLng, lightText, MAX_ZOOM, MIN_ZOOM, pan, pinPercent, placeKey, project, toScreen, visibleTiles, zoomAround } from "./media-logic.js";

const size = { width: 600, height: 400 };
const lisbon = project(38.7223, -9.1393), sintra = project(38.8029, -9.3817), cascais = project(38.6979, -9.4215);

describe("project", () => {
  it("maps the equator and meridian to the centre, puts north up, and clamps the poles", () => {
    expect(project(0, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect([project(0, 180).x, project(0, -180).x]).toEqual([1, 0]);
    expect(project(60, 0).y).toBeLessThan(0.5);
    expect(project(90, 0).y).toBeCloseTo(0, 6);
    expect(project(-90, 0).y).toBeCloseTo(1, 6);
  });
});

describe("fitView", () => {
  it("shows every place inside the padding, tightly", () => {
    const view = fitView([lisbon, sintra, cascais], size, 40, 15);
    const inside = (v: typeof view) => [lisbon, sintra, cascais].every((p) => { const { left, top } = toScreen(p, v, size); return left >= 40 - 1e-6 && left <= 560 + 1e-6 && top >= 40 - 1e-6 && top <= 360 + 1e-6; });
    expect(inside(view)).toBe(true);
    expect(inside({ ...view, zoom: view.zoom + 1 })).toBe(false);
  });
  it("centres one place at the cap, and an empty map on the world", () => {
    const one = fitView([lisbon], size, 40, 14);
    expect(one.zoom).toBe(14);
    expect(toScreen(lisbon, one, size)).toEqual({ left: 300, top: 200 });
    expect(fitView([], size, 40, 14).zoom).toBe(MIN_ZOOM);
  });
});

describe("zoomAround and pan", () => {
  it("keeps the point under the anchor fixed while zooming", () => {
    const view = fitView([lisbon, sintra], size, 40, 15);
    const anchor = toScreen(sintra, view, size);
    const after = toScreen(sintra, zoomAround(view, view.zoom + 1.5, anchor, size), size);
    expect(after.left).toBeCloseTo(anchor.left, 6);
    expect(after.top).toBeCloseTo(anchor.top, 6);
  });
  it("moves with the drag, clamps zoom, keeps the world filling the height, and wraps longitude", () => {
    const view = fitView([lisbon], size, 40, 12);
    const before = toScreen(lisbon, view, size), after = toScreen(lisbon, pan(view, 30, -20, size), size);
    expect(after.left - before.left).toBeCloseTo(30, 6);
    expect(after.top - before.top).toBeCloseTo(-20, 6);
    expect(zoomAround(view, 40, { left: 0, top: 0 }, size).zoom).toBe(MAX_ZOOM);
    expect(clampView({ x: 1.25, y: 0.9, zoom: 1 }, { width: 600, height: 600 })).toEqual({ x: 0.25, y: 0.5, zoom: 1 });
    expect(clampView({ x: 0.5, y: 0.999, zoom: 5 }, size).y).toBeCloseTo(1 - 200 / (256 * 32), 9);
  });
});

describe("visibleTiles", () => {
  it("covers the viewport with tiles of the nearest level", () => {
    const tiles = visibleTiles({ ...fitView([lisbon, sintra, cascais], size, 40, 15), zoom: 10.3 }, size);
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([10]));
    expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
    expect(Math.min(...tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.left + t.size))).toBeGreaterThanOrEqual(600);
    expect(Math.max(...tiles.map((t) => t.top + t.size))).toBeGreaterThanOrEqual(400);
    expect(tiles[0].size).toBeCloseTo(256 * 2 ** 0.3, 6);
  });
  it("wraps x across the antimeridian and stays inside the world's rows", () => {
    const tiles = visibleTiles({ x: 0.001, y: 0.5, zoom: 2 }, { width: 600, height: 2000 });
    expect(tiles.every((t) => t.x >= 0 && t.x < 4 && t.y >= 0 && t.y < 4)).toBe(true);
    expect(tiles.some((t) => t.x === 3)).toBe(true);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
  });
});

describe("readers", () => {
  it("reads positions and refuses names and bad numbers", () => {
    expect(latLng([38.7, -9.1])).toEqual({ lat: 38.7, lng: -9.1 });
    expect(latLng({ lat: 1, lng: 2 })).toEqual({ lat: 1, lng: 2 });
    for (const bad of ["Lisbon", [91, 0], [1], null, undefined]) expect(latLng(bad)).toBeNull();
  });
  it("averages points, keys names, picks columns, and keeps pins on the image", () => {
    expect(centroid([{ lat: 0, lng: 0 }, { lat: 2, lng: 4 }])).toEqual({ lat: 1, lng: 2 });
    expect(centroid([])).toBeNull();
    expect(placeKey("  Belém   Tower ")).toBe("belém tower");
    expect([1, 2, 3, 4, 5].map(autoColumns)).toEqual([1, 2, 3, 2, 3]);
    expect([pinPercent(0), pinPercent(50), pinPercent(120), pinPercent("x")]).toEqual([4, 50, 96, null]);
  });
});

describe("lightText", () => {
  it("reads lightness from the common computed colour forms", () => {
    expect(lightText("oklch(0.98 0 0)")).toBe(true);
    expect(lightText("oklch(14.5% 0 0)")).toBe(false);
    expect(lightText("lab(96 0 0)")).toBe(true);
    expect(lightText("rgb(250, 250, 250)")).toBe(true);
    expect(lightText("rgba(10, 10, 10, 0.9)")).toBe(false);
    expect(lightText("color(srgb 0.95 0.95 0.95)")).toBe(true);
    expect(lightText("currentcolor")).toBe(false);
  });
});
