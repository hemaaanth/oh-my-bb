import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { SandboxStore, sandboxMigrations } from "../src/store.js";
import { syntheticBrowserArtifact } from "./browser-artifact-fixture.js";

it("retains unknown legacy images and allows independently attested compatible history", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const db = fake.bb.storage.database(); fake.bb.storage.migrate(db, [...sandboxMigrations]);
  const store = new SandboxStore(db);
  store.beginImageBuild({ id: "historical", provider: "modal", name: "bb-sandbox-historical", extraPackages: [] });
  store.finishImageBuild("historical");
  expect(() => store.requireImageProvenance("historical", [syntheticBrowserArtifact])).toThrow("unknown or incompatible");
  expect(store.requireImage("historical").status).toBe("ready");
  store.recordImageProvenance("historical", `registry.example/image@sha256:${"f".repeat(64)}`, syntheticBrowserArtifact);
  const futureArtifact = { ...syntheticBrowserArtifact, sourceCommit: "e".repeat(40), archiveSha256: "d".repeat(64) };
  store.requireImageProvenance("historical", [futureArtifact, syntheticBrowserArtifact]);
  expect(() => store.requireImageProvenance("historical", [futureArtifact])).toThrow("incompatible");
  store.recordImageProvenance("historical", "registry.example/image:mutable", syntheticBrowserArtifact);
  expect(() => store.requireImageProvenance("historical", [syntheticBrowserArtifact])).toThrow("unknown or incompatible");
  await fake.harness.dispose();
});
