// assets/spec.js is a committed build output. Its header names the hash of the source files it was built
// from, so a component changed or added in chat without rebuilding the page runtime fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { sourceHash, specOptions } from "./options.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("assets/spec.js", () => {
  it("is built from the current components (run npm run build)", async () => {
    const result = await build({ ...specOptions(root, ""), outfile: `${root}assets/spec.js`, write: false, metafile: true });
    const header = /^\/\*! Pages spec runtime (\S+)\./u.exec(readFileSync(`${root}assets/spec.js`, "utf8"))?.[1];
    expect(header).toBe(sourceHash(root, result.metafile));
  }, 30_000);
});
