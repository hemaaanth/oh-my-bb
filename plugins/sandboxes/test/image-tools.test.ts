import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { defaultImageTools, imageDockerfileSchema, imageRecipePreference, imageTools, normalizeImageTools } from "../src/image-tools.js";

it("has general defaults, keeps project CLIs opt-in, and validates dependencies and names", () => {
  expect(defaultImageTools).not.toContain("goldsky");
  expect(defaultImageTools).not.toContain("hubspot");
  expect(normalizeImageTools([])).toEqual([]);
  expect(normalizeImageTools(["goldsky"])).toEqual(["goldsky"]);
  expect(() => normalizeImageTools(["bad;command"])).toThrow();
  expect(() => normalizeImageTools(["devbox"])).toThrow("requires nix");
  expect(() => normalizeImageTools(["cua"])).toThrow("requires python");
  expect(() => normalizeImageTools(["go", "go"])).toThrow("Duplicate");
});

it("keeps reads and no-op saves quiet and refuses a stale recipe", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  try {
    const recipes = imageRecipePreference(fake.bb);
    expect((await recipes.read()).tools).toEqual(defaultImageTools);
    expect(await fake.bb.storage.kv.get("image-recipe:v1")).toBeUndefined();
    await recipes.save({ revision: 0, tools: [...defaultImageTools] });
    expect(await fake.bb.storage.kv.get("image-recipe:v1")).toBeUndefined();
    await recipes.save({ revision: 0, tools: [] });
    await expect(recipes.save({ revision: 0, tools: ["goldsky"] })).rejects.toThrow("changed");
    expect(await recipes.read()).toEqual({ revision: 1, tools: [] });
    expect(fake.harness.inspection.sdk.calls).toEqual([]);
  } finally { await fake.harness.dispose(); }
});

it("the shell installers use the same defaults and respect an explicit empty selection", () => {
  const helper = new URL("../docker/image-tools.sh", import.meta.url).pathname;
  const check = (selection?: string) => execFileSync("sh", ["-c", '. "$1"; for name in $2; do if bb_image_has "$name"; then printf "%s\\n" "$name"; fi; done', "sh", helper, imageTools.map(tool => tool.id).join(" ")], { encoding: "utf8", env: { PATH: process.env.PATH, ...(selection === undefined ? {} : { BB_IMAGE_TOOLS: selection }) } }).trim().split("\n").filter(Boolean);
  expect(check()).toEqual(defaultImageTools);
  expect(check("")).toEqual([]);
  expect(check("goldsky,go")).toEqual(["go", "goldsky"]);
  for (const name of ["toolchain", "containers", "env-managers", "cloud-clis", "agent-clis", "harnesses", "gateway-harnesses", "visual-capture"]) {
    const path = new URL(`../docker/install-${name}.sh`, import.meta.url).pathname;
    execFileSync("sh", ["-n", path]);
    expect(readFileSync(path, "utf8")).toContain("bb_image_has");
  }
});

it("rejects a plugin or stale recipe before it changes image configuration", async () => {
  const { default: plugin } = await import("../src/server.js");
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  try {
    await plugin(fake.bb);
    const first = await fake.harness.callRpc("imageSettings", null) as { recipe: { revision: number; tools: string[] }; repository: string };
    const input = { repository: "ghcr.io/fixture/new", platform: "linux/amd64", packages: [], recipe: { revision: 0, tools: [] } };
    await expect(fake.harness.behavior.callRpc("updateImageConfiguration", input, { experimental_caller: { kind: "plugin", pluginId: "fixture" } })).rejects.toThrow("Owner client");
    expect(await fake.harness.callRpc("imageSettings", null)).toEqual(first);
    await fake.harness.callRpc("updateImageConfiguration", input);
    await expect(fake.harness.callRpc("updateImageConfiguration", { ...input, repository: "ghcr.io/fixture/stale", recipe: { revision: 0, tools: ["goldsky"] } })).rejects.toThrow("changed");
    expect(await fake.harness.callRpc("imageSettings", null)).toMatchObject({ repository: "ghcr.io/fixture/new", recipe: { revision: 1, tools: [] } });
  } finally { await fake.harness.dispose(); }
});

it("direct Docker builds use the same public defaults as prepared contexts", () => {
  const dockerfile = readFileSync(new URL("../docker/Dockerfile", import.meta.url), "utf8");
  const defaults = /^ARG BB_IMAGE_TOOLS=(.*)$/mu.exec(dockerfile)?.[1]?.split(",");
  expect(defaults).toEqual(defaultImageTools);
});

it("saves custom Dockerfile instructions with revision checks and supports clearing them", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  try {
    const recipes = imageRecipePreference(fake.bb);
    const dockerfile = "RUN npm install -g example@1.2.3 \\\n  && echo installed\nENV EXAMPLE=yes";
    expect(imageDockerfileSchema.parse(dockerfile)).toBe(dockerfile);
    await recipes.save({ revision: 0, tools: [], dockerfile });
    expect(await recipes.read()).toEqual({ revision: 1, tools: [], dockerfile });
    await expect(recipes.save({ revision: 1, tools: [], dockerfile: "FROM alpine" })).rejects.toThrow("Use RUN");
    await expect(recipes.save({ revision: 0, tools: [], dockerfile: "" })).rejects.toThrow("changed");
    expect((await recipes.read()).dockerfile).toBe(dockerfile);
    await recipes.save({ revision: 1, tools: [], dockerfile: "" });
    expect(await recipes.read()).toEqual({ revision: 2, tools: [] });
  } finally { await fake.harness.dispose(); }
});
