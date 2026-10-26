import { describe, expect, it } from "vitest";
import { prepareSceneObjects } from "./expression.js";
import { readScene, sceneAssets } from "./scene.js";

describe("OpenUI scene expressions", () => {
  it("evaluates time and bound inputs without a JavaScript function", () => {
    const objects = prepareSceneObjects('[{shape: "sphere", at: [@Cos($t) * $radius, 0, @Sin($t) * $radius]}]', { radius: 2 });
    const start = readScene(objects, 0);
    const quarter = readScene(objects, Math.PI / 2);
    expect(start.errors).toEqual([]);
    expect(quarter.errors).toEqual([]);
    expect(start.objects[0]).toMatchObject({ shape: "sphere", at: [2, 0, 0] });
    const point = quarter.objects[0];
    expect(point.shape).toBe("sphere");
    if (point.shape !== "sphere") throw new Error("Expected a sphere");
    expect(point.at[0]).toBeCloseTo(0);
    expect(point.at[2]).toBeCloseTo(2);
  });

  it("samples a surface with x, z, time and named inputs", () => {
    const objects = prepareSceneObjects([{ shape: "surface", x: [0, 2], z: [0, 2], detail: 2, f: "$x + $z + $t * $speed" }], { speed: 3 });
    const scene = readScene(objects, 2);
    expect(scene.errors).toEqual([]);
    expect(scene.objects[0]).toMatchObject({ shape: "surface", values: [[6, 7, 8], [7, 8, 9], [8, 9, 10]] });
  });

  it("rejects unknown scope and non-finite functions instead of drawing broken geometry", () => {
    for (const source of ["$secret", "window.document", '@Sqrt(-1)']) {
      const objects = prepareSceneObjects([{ shape: "surface", x: [0, 1], z: [0, 1], detail: 2, f: source }]);
      const scene = readScene(objects, 0);
      expect(scene.objects).toEqual([]);
      expect(scene.errors.some((message) => /failed|number|input|reference/u.test(message))).toBe(true);
    }
  });

  it("keeps strict shape validation and gathers only explicit asset references", () => {
    expect(readScene([{ shape: "box", at: [0, 0, 0], widht: 2 }], 0).objects).toEqual([]);
    const scene = readScene([
      { shape: "model", src: "models/part.glb", at: [0, 0, 0] },
      { shape: "environment", src: "studio.hdr" },
      { shape: "box", at: [1, 0, 0], texture: "wood.webp" },
      { shape: "sprite", at: [0, 1, 0], src: "wood.webp" },
    ], 0);
    expect(scene.errors).toEqual([]);
    expect(sceneAssets(scene.objects)).toEqual(["models/part.glb", "studio.hdr", "wood.webp"]);
  });
});
