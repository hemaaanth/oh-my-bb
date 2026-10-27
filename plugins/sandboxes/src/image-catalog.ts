import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { verifiedBrowserArtifact } from "./browser-artifact.js";

export { imageTools } from "./image-tools.js";
import { defaultImageTools, imageTools, normalizeImageTools } from "./image-tools.js";
export const sandboxRequiredImageComponents = ["Node.js 22", "BB host daemon", "Git + GitHub CLI + SSH", "Brave + bb-browser + Tailscale", "Virtual desktop + FFmpeg + ImageMagick", "BB preview and connection helpers"];
export function imageComponentsFor(selected: readonly string[]) {
  return [
    { category: "Required runtime", items: sandboxRequiredImageComponents },
    ...[...new Set(imageTools.map(tool => tool.category))].map(category => ({ category, items: imageTools.filter(tool => tool.category === category && selected.includes(tool.id)).map(tool => tool.label) })).filter(group => group.items.length),
  ];
}


/**
 * Everything the single sandbox Dockerfile expects beside itself. The image
 * installs the bb host daemon from npm, so no build artifact is staged here.
 */
export const sandboxImageContextFiles = [
  "image-tools.sh",
  "agent-guard.sh",
  "agent-shim.sh",
  "attach.sh",
  "capture.sh",
  "computer-start.sh",
  "display-start.sh",
  "docker-start.sh",
  "entrypoint.sh",
  "install-agent-clis.sh",
  "install-cloud-clis.sh",
  "install-containers.sh",
  "install-env-managers.sh",
  "install-harnesses.sh",
  "install-gateway-harnesses.sh",
  "install-toolchain.sh",
  "install-visual-capture.sh",
  "preview-supervisor.mjs",
  "smoke-test.sh",
  "browser-runtime.tar",
  "browser-runtime.provenance.json",
  "verify-browser-runtime.mjs",
] as const;

const extraPackagesMarker = "# bb:extra-packages";

const packageNamePattern = /^[a-z0-9][a-z0-9+.-]*$/u;

export function normalizeExtraPackages(packages: string[]): string[] {
  const normalized = [
    ...new Set(packages.map((item) => item.trim()).filter(Boolean)),
  ].sort();
  for (const packageName of normalized) {
    if (!packageNamePattern.test(packageName)) {
      throw new Error(
        `Invalid Debian package ${JSON.stringify(packageName)}; use package names containing lowercase letters, numbers, +, ., or -`,
      );
    }
  }
  return normalized;
}

export interface SandboxImageBuildContext {
  contextDir: string;
  dockerfilePath: string;
  cleanup(): Promise<void>;
}

export async function prepareImageBuildContext(input: {
  dockerfilePath: string;
  extraPackages: string[];
  tools?: string[];
}): Promise<SandboxImageBuildContext> {
  const extraPackages = normalizeExtraPackages(input.extraPackages);
  const sourceDirectory = dirname(input.dockerfilePath);
  verifiedBrowserArtifact(sourceDirectory);
  const tools = normalizeImageTools(input.tools ?? defaultImageTools);
  const targetDirectory = await mkdtemp(join(tmpdir(), "bb-sandbox-image-"));
  for (const filename of sandboxImageContextFiles) {
    await cp(join(sourceDirectory, filename), join(targetDirectory, filename), { dereference: true });
  }
  let source = (await readFile(input.dockerfilePath, "utf8")).replace(/^ARG BB_IMAGE_TOOLS=.*$/mu, `ARG BB_IMAGE_TOOLS=${tools.join(",")}`);
  source = source.replace(/bb\.harness\.([a-z-]+)="[^"\n]*"/gu, (label, tool: string) => tools.includes(tool as typeof tools[number]) ? label : `bb.harness.${tool}="disabled"`);
  const lines = source.split("\n");
  const markerIndex = lines.findIndex(
    (line) => line.trim() === extraPackagesMarker,
  );
  if (markerIndex < 0) {
    await rm(targetDirectory, { recursive: true, force: true });
    throw new Error(
      `The sandbox Dockerfile no longer has the ${extraPackagesMarker} extension point`,
    );
  }
  lines.splice(
    markerIndex,
    1,
    ...(extraPackages.length === 0
      ? []
      : [
          "RUN apt-get update \\",
          `  && apt-get install --yes --no-install-recommends ${extraPackages.join(" ")} \\`,
          "  && apt-get clean \\",
          "  && rm -rf /var/lib/apt/lists/*",
        ]),
  );
  const dockerfilePath = join(targetDirectory, basename(input.dockerfilePath));
  await writeFile(dockerfilePath, lines.join("\n"));
  return {
    contextDir: targetDirectory,
    dockerfilePath,
    cleanup: () => rm(targetDirectory, { recursive: true, force: true }),
  };
}
