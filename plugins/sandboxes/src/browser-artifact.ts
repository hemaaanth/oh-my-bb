import { fileURLToPath } from "node:url";
import { verifyBrowserRuntime } from "../docker/verify-browser-runtime.mjs";
import type { SandboxImageRegistryConfig } from "./config.js";
import { readRegistryImageLabel } from "./register-image.js";
import { readFileSync } from "node:fs";
import { z } from "zod";

export interface BrowserArtifact {
  version: string;
  sourceCommit: string;
  inputsSha256: string;
  archiveSha256: string;
}
export const browserArtifactLabels = {
  sourceCommit: "bb.browser.source-commit",
  inputsSha256: "bb.browser.inputs-sha256",
  archiveSha256: "bb.browser.archive-sha256",
} as const;

export function verifiedBrowserArtifact(directory = fileURLToPath(new URL("../docker/", import.meta.url))): BrowserArtifact {
  return verifyBrowserRuntime(directory);
}

/** Reviewed source/input/archive identities compatible with the native Browser contract.
 * Keep historical compatible entries when updating the current build artifact. */
export function compatibleBrowserArtifacts() {
  return z.object({
    schemaVersion: z.literal(1),
    sandboxesBrowserContract: z.literal("sandboxes-v1"),
    artifacts: z.array(z.object({
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
      inputsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }).strict()).min(1),
  }).strict().parse(JSON.parse(readFileSync(new URL("../docker/browser-runtime.compatibility.json", import.meta.url), "utf8"))).artifacts;
}

export function requireBrowserImageAttestation(expected: BrowserArtifact, actual: Record<keyof typeof browserArtifactLabels, string | null>) {
  for (const key of Object.keys(browserArtifactLabels) as Array<keyof typeof browserArtifactLabels>) {
    if (actual[key] !== expected[key]) throw new Error(`Image Browser provenance is unknown or stale (${browserArtifactLabels[key]}); rebuild from the accepted runtime artifact before registering or activating it`);
  }
}

export async function verifyRegistryBrowserArtifact(registry: SandboxImageRegistryConfig, pinnedReference: string): Promise<BrowserArtifact> {
  const expected = verifiedBrowserArtifact();
  const digest = pinnedReference.split("@")[1];
  if (!digest || !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("Browser attestation requires an immutable image digest");
  const keys = Object.keys(browserArtifactLabels) as Array<keyof typeof browserArtifactLabels>;
  const labels = await Promise.all(keys.map(key => readRegistryImageLabel({
    registry, reference: digest, platform: registry.platform, label: browserArtifactLabels[key],
  })));
  requireBrowserImageAttestation(expected, Object.fromEntries(keys.map((key, index) => [key, labels[index] ?? null])) as Record<typeof keys[number], string | null>);
  return expected;
}
