import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

describe("package independence", () => {
  it("uses only public SDK surfaces and package-local imports", () => {
    const manifest = z.object({
      dependencies: z.record(z.string(), z.string()),
      devDependencies: z.record(z.string(), z.string()),
    }).parse(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")));
    const allow = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).map(
      (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/.*)?$`),
    );
    const result = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), { allow });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
