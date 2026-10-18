import { expect, it } from "vitest";
import { gridTemplate } from "./layout.js";

it("fits by width, or clamps columns to 1-6", () => {
  expect(gridTemplate(undefined)).toContain("auto-fit");
  expect(gridTemplate(Number.NaN)).toContain("auto-fit");
  expect(gridTemplate(2)).toContain("(100% - 1 * 0.75rem) / 2");
  expect(gridTemplate(99)).toContain("/ 6");
  expect(gridTemplate(0)).toContain("/ 1");
});
