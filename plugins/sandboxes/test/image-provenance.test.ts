import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { SandboxStore, sandboxMigrations } from "../src/store.js";
import { syntheticBrowserArtifact } from "./browser-artifact-fixture.js";

it("retains image records and reports build provenance without exposing manual activation", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const db = fake.bb.storage.database(); fake.bb.storage.migrate(db, [...sandboxMigrations]);
  const store = new SandboxStore(db);
  store.beginImageBuild({ id: "historical", provider: "modal", name: "bb-sandbox-historical", extraPackages: [] });
  store.finishImageBuild("historical");
  expect(store.imageProvenanceState("historical", [syntheticBrowserArtifact])).toBe("unknown");
  expect(store.requireImage("historical").status).toBe("ready");
  store.recordImageProvenance("historical", `registry.example/image@sha256:${"f".repeat(64)}`, syntheticBrowserArtifact);
  const futureArtifact = { ...syntheticBrowserArtifact, sourceCommit: "e".repeat(40), archiveSha256: "d".repeat(64) };
  expect(store.imageProvenanceState("historical", [futureArtifact, syntheticBrowserArtifact])).toBe("verified");
  expect(store.imageProvenanceState("historical", [futureArtifact])).toBe("incompatible");
  store.recordImageProvenance("historical", "registry.example/image:mutable", syntheticBrowserArtifact);
  expect(store.imageProvenanceState("historical", [syntheticBrowserArtifact])).toBe("unknown");
  await fake.harness.dispose();
});
