import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../src/server.js";
import { imageBuildRepositoryPreference, resolveImageBuildRepository } from "../src/image-build-repository.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(disposals.splice(0).map(dispose => dispose())); });
const imported = { schemaVersion: 1 as const, sourceGeneration: "synthetic-generation-1", sourceSemanticDigest: "a".repeat(64), repository: "fixture-owner/private-builder" };

it("has no origin or owner default and validates the highest-precedence value", () => {
  expect(() => resolveImageBuildRepository({})).toThrow("No sandbox image builder configured");
  expect(resolveImageBuildRepository({ override: "fixture/env", explicit: "fixture/saved", imported: "fixture/import" })).toBe("fixture/env");
  expect(resolveImageBuildRepository({ explicit: "fixture/saved", imported: "fixture/import" })).toBe("fixture/saved");
  expect(() => resolveImageBuildRepository({ explicit: "", imported: "fixture/import" })).toThrow("No sandbox image builder");
  expect(() => resolveImageBuildRepository({ override: "https://token@github.com/a/b", explicit: "fixture/saved" })).toThrow();
});

it("commits one generation atomically and preserves explicit empty/false destination choices", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" }); disposals.push(() => fake.harness.dispose());
  vi.stubEnv("BB_SANDBOX_IMAGE_BUILD_REPO", "");
  const preference = imageBuildRepositoryPreference(fake.bb);
  await preference.save("fixture/saved");
  await preference.import(imported);
  expect(await preference.resolve()).toBe("fixture/saved");
  const before = await fake.bb.storage.kv.get("image-build-repository:v1");
  await preference.import(imported);
  expect(await fake.bb.storage.kv.get("image-build-repository:v1")).toEqual(before);
  await expect(preference.import({ ...imported, repository: "fixture/changed" })).rejects.toThrow("mismatch");
  await expect(preference.import({ ...imported, sourceSemanticDigest: "b".repeat(64) })).rejects.toThrow("mismatch");
  await preference.save("");
  await preference.import(imported);
  await expect(preference.resolve()).rejects.toThrow("No sandbox image builder");
  vi.stubEnv("BB_SANDBOX_IMAGE_BUILD_REPO", "fixture/env");
  expect(await preference.resolve()).toBe("fixture/env");
});

it("rejects plugin attempts to import a route and supports an explicit owner CLI import without dispatch", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" }); disposals.push(() => fake.harness.dispose());
  vi.stubEnv("BB_SANDBOX_IMAGE_BUILD_REPO", "");
  await plugin(fake.bb);
  await expect(fake.harness.behavior.callRpc("importImageBuildRepository", imported, { experimental_caller: { kind: "plugin", pluginId: "fixture" } })).rejects.toThrow("Owner client required");
  expect((await fake.harness.behavior.runCli(["import-image-builder", "--repository", imported.repository, "--generation", imported.sourceGeneration, "--digest", imported.sourceSemanticDigest, "--yes"])).exitCode).toBe(0);
  expect(await fake.harness.behavior.callRpc("imageBuildRepository", null)).toMatchObject({ repository: imported.repository, source: "import", imported: true });
  expect(fake.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
});
