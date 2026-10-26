import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { renderOpenGraphImage, renderOpenGraphSvg } from "./social-assets.js";

describe("share social assets", () => {
  it("renders the live project name into a 1200 by 630 PNG", async () => {
    expect(renderOpenGraphSvg("Research & development")).toContain(
      "Research &amp; development",
    );

    const image = await renderOpenGraphImage("Research & development");
    expect(image.subarray(1, 4).toString()).toBe("PNG");
    expect(image.readUInt32BE(16)).toBe(1200);
    expect(image.readUInt32BE(20)).toBe(630);
  });
  it("loads through CommonJS and initializes once for concurrent image requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "session-share-cjs-"));
    const output = join(directory, "social-assets.cjs");
    const source = new URL("./social-assets.ts", import.meta.url);
    try {
      await build({
        entryPoints: [fileURLToPath(source)],
        outfile: output,
        bundle: true,
        platform: "node",
        format: "cjs",
        define: { "import.meta.url": JSON.stringify(source.href) },
      });
      const { renderOpenGraphImage: render } = createRequire(import.meta.url)(output) as { renderOpenGraphImage: typeof renderOpenGraphImage };
      const images = await Promise.all([render("First project"), render("Second project")]);
      for (const image of images) {
        expect(image.subarray(1, 4).toString()).toBe("PNG");
        expect(image.readUInt32BE(16)).toBe(1200);
        expect(image.readUInt32BE(20)).toBe(630);
      }
      expect(images[0].equals(images[1])).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
