import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifiedBrowserArtifact, requireBrowserImageAttestation } from "../src/browser-artifact.js";
import { writeBrowserArtifactFixture } from "./browser-artifact-fixture.js";
import { prepareImageBuildContext } from "../src/image-catalog.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const directory = await mkdtemp(join(tmpdir(), "bb-browser-provenance-")); directories.push(directory); await writeBrowserArtifactFixture(directory); return directory; }

it("accepts exact build inputs and rejects changed bytes even when version is unchanged", async () => {
  const directory = await fixture();
  const receipt = verifiedBrowserArtifact(directory);
  expect(receipt.version).toBe("0.3.0");
  const archive = await readFile(join(directory, "browser-runtime.tar"));
  archive[513] = archive[513]! ^ 1;
  await writeFile(join(directory, "browser-runtime.tar"), archive);
  expect(() => verifiedBrowserArtifact(directory)).toThrow("SHA-256");
  await expect(prepareImageBuildContext({ dockerfilePath: join(directory, "Dockerfile"), extraPackages: [] })).rejects.toThrow("SHA-256");
});

it("rejects missing receipts, altered input digests and sibling runtime links", async () => {
  const directory = await fixture();
  const path = join(directory, "browser-runtime.provenance.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.inputs["package.json"].sha256 = "f".repeat(64);
  await writeFile(path, JSON.stringify(receipt));
  expect(() => verifiedBrowserArtifact(directory)).toThrow("build inputs");
  await rm(path);
  expect(() => verifiedBrowserArtifact(directory)).toThrow();
  await writeBrowserArtifactFixture(directory);
  const archive = join(directory, "browser-runtime.tar");
  await rm(archive); await symlink("artifact-source/package.json", archive);
  expect(() => verifiedBrowserArtifact(directory)).toThrow("sibling symlink");
});

it("requires source, inputs and archive labels rather than Browser version equality", async () => {
  const expected = verifiedBrowserArtifact(await fixture());
  expect(() => requireBrowserImageAttestation(expected, { ...expected, archiveSha256: null })).toThrow("unknown or stale");
  expect(() => requireBrowserImageAttestation(expected, { ...expected, sourceCommit: "f".repeat(40) })).toThrow("unknown or stale");
  requireBrowserImageAttestation(expected, expected);
});
