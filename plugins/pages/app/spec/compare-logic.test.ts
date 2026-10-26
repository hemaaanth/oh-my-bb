// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
import { describe, expect, it } from "vitest";
import {
  changedRegions,
  diffGrid,
  formatPixelShare,
  pixelDiff,
  viewOfRegion,
} from "./compare-logic.js";

/** A width×height RGBA buffer filled with one colour. */
function canvas(width: number, height: number, rgba: readonly [number, number, number, number] = [255, 255, 255, 255]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(rgba, offset);
  return data;
}

function paint(data: Uint8ClampedArray, width: number, x: number, y: number, w: number, h: number, rgba: readonly [number, number, number, number]) {
  for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) data.set(rgba, (row * width + column) * 4);
}

describe("pixelDiff", () => {
  it("finds nothing in identical images and every pixel in opposite ones", () => {
    expect(pixelDiff(canvas(4, 3), canvas(4, 3), 4, 3, 0)).toMatchObject({ changed: 0, total: 12 });
    expect(pixelDiff(canvas(4, 3), canvas(4, 3, [0, 0, 0, 255]), 4, 3, 64).changed).toBe(12);
  });

  it("counts a channel difference only beyond the tolerance", () => {
    const a = canvas(2, 1, [100, 100, 100, 255]);
    const b = canvas(2, 1, [100, 108, 100, 255]);
    expect(pixelDiff(a, b, 2, 1, 8).changed).toBe(0);
    expect(pixelDiff(a, b, 2, 1, 7).changed).toBe(2);
  });

  it("treats fully transparent pixels as equal whatever colour they hold, and alpha as a channel", () => {
    expect(pixelDiff(canvas(1, 1, [255, 0, 0, 0]), canvas(1, 1, [0, 255, 0, 0]), 1, 1, 0).changed).toBe(0);
    expect(pixelDiff(canvas(1, 1, [255, 255, 255, 255]), canvas(1, 1, [255, 255, 255, 200]), 1, 1, 8).changed).toBe(1);
  });

  it("marks exactly the changed pixels in the mask", () => {
    const a = canvas(5, 5);
    const b = canvas(5, 5);
    paint(b, 5, 1, 2, 2, 1, [0, 0, 0, 255]);
    expect([...pixelDiff(a, b, 5, 5, 0).mask].flatMap((value, index) => (value === 1 ? [index] : []))).toEqual([11, 12]);
  });
});

describe("changedRegions", () => {
  const maskOf = (width: number, height: number, boxes: readonly [number, number, number, number][]) => {
    const mask = new Uint8Array(width * height);
    for (const [x, y, w, h] of boxes) for (let row = y; row < y + h; row++) mask.fill(1, row * width + x, row * width + x + w);
    return mask;
  };

  it("is empty for an unchanged or empty image", () => {
    expect(changedRegions(new Uint8Array(100), 10, 10)).toEqual({ regions: [], more: 0 });
    expect(changedRegions(new Uint8Array(0), 0, 0)).toEqual({ regions: [], more: 0 });
  });

  it("fits a box tightly around one changed pixel", () => {
    expect(changedRegions(maskOf(50, 50, [[33, 7, 1, 1]]), 50, 50).regions).toEqual([{ x: 33, y: 7, width: 1, height: 1, pixels: 1 }]);
  });

  it("joins letters of one word, keeps distant changes apart, largest first", () => {
    // Three "letters" 3 px apart, and a single dot far away.
    const mask = maskOf(200, 100, [
      [10, 10, 4, 8],
      [17, 10, 4, 8],
      [24, 10, 4, 8],
      [180, 90, 2, 2],
    ]);
    expect(changedRegions(mask, 200, 100).regions).toEqual([
      { x: 10, y: 10, width: 18, height: 8, pixels: 96 },
      { x: 180, y: 90, width: 2, height: 2, pixels: 4 },
    ]);
  });

  it("merges boxes that overlap after fitting, and counts what is past the cap", () => {
    // An L shape whose arms are far apart in cells but whose boxes overlap.
    const mask = maskOf(300, 300, [
      [0, 0, 200, 2],
      [0, 0, 2, 200],
      [150, 150, 10, 10],
    ]);
    const { regions } = changedRegions(mask, 300, 300, { cell: 8, gap: 0 });
    expect(regions).toEqual([{ x: 0, y: 0, width: 200, height: 200, pixels: 400 + 400 - 4 + 100 }]);
    const dots = maskOf(
      400,
      10,
      Array.from({ length: 10 }, (_, index): [number, number, number, number] => [index * 40, 0, 1, 1]),
    );
    expect(changedRegions(dots, 400, 10, { max: 4 })).toMatchObject({ more: 6 });
    expect(changedRegions(dots, 400, 10, { max: 4 }).regions).toHaveLength(4);
  });
});
describe("formatPixelShare", () => {
  it("reads like a person would say it, never 0% for a change", () => {
    expect(formatPixelShare(0, 100)).toBe("0%");
    expect(formatPixelShare(5, 0)).toBe("0%");
    expect(formatPixelShare(1, 3)).toBe("33%");
    expect(formatPixelShare(42, 1000)).toBe("4.2%");
    expect(formatPixelShare(61, 1_296_000)).toBe("0.0047%");
    expect(formatPixelShare(1, 100_000_000)).toBe("0.000001%");
  });
});

describe("viewOfRegion", () => {
  const pane = { width: 400, height: 250 };
  const image = { width: 1600, height: 1000 };

  it("zooms to a changed region with room around it, keeping context around a tiny one", () => {
    const wide = viewOfRegion({ x: 400, y: 300, width: 200, height: 50, pixels: 3000 }, pane, image);
    // 400 image px across (twice the region) fill the 400 px pane: 1 screen px per image px, 4× the fit.
    expect(wide.zoom).toBe(4);
    expect(wide.cx).toBeCloseTo(500 / 1600, 9);
    expect(wide.cy).toBeCloseTo(325 / 1000, 9);
    const tiny = viewOfRegion({ x: 800, y: 500, width: 7, height: 10, pixels: 40 }, pane, image);
    expect(tiny.zoom).toBeCloseTo(Math.min(400 / 96, 250 / 64) / 0.25, 9);
    expect(tiny.cx).toBeCloseTo(803.5 / 1600, 9);
  });
});

describe("diffGrid", () => {
  it("compares at the reference size up to 8 megapixels, scaled down past it", () => {
    expect(diffGrid({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 900, scale: 1 });
    const huge = diffGrid({ width: 4000, height: 8000 });
    expect(huge.scale).toBeCloseTo(0.5, 9);
    expect(huge).toMatchObject({ width: 2000, height: 4000 });
  });
});
