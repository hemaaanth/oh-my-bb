import { describe, expect, it } from "vitest";
import { renderOpenGraphImage, renderOpenGraphSvg } from "./social-assets.js";

describe("share social assets", () => {
  it("renders the live project name into a 1200 by 630 PNG", () => {
    expect(renderOpenGraphSvg("Research & development")).toContain(
      "Research &amp; development",
    );

    const image = renderOpenGraphImage("Research & development");
    expect(image.subarray(1, 4).toString()).toBe("PNG");
    expect(image.readUInt32BE(16)).toBe(1200);
    expect(image.readUInt32BE(20)).toBe(630);
  });
});
