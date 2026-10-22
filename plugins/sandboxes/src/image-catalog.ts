import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const sandboxImageComponents = [
  {
    category: "Agent tools",
    items: [
      "bb host daemon",
      "OMP",
      "Claude Code",
      "Codex CLI",
      "FX",
      "Pi",
      "Prime Agent",
      "FX ACP",
      "nanocodex ACP",
      "Prime Agent ACP",
    ],
  },
  {
    category: "Languages",
    items: [
      "Node.js 22",
      "Python 3.13 + uv",
      "Go 1.26.6",
      "Rust 1.97.1 + nextest",
      "Java 21",
      "Bun 1.3.14",
      "Deno 2.9.5",
    ],
  },
  {
    category: "Containers",
    items: [
      "Docker Engine",
      "Docker Compose v2",
      "Buildx",
      "bb-sandbox-docker daemon starter",
    ],
  },
  {
    category: "Visual capture and computer use",
    items: [
      "Brave",
      "agent-browser",
      "bb-browser (pinned user agent, auth state, Tailscale home egress)",
      "Tailscale",
      "VHS + ttyd",
      "freeze",
      "TigerVNC + Xvfb + openbox + x11vnc",
      "ffmpeg + ImageMagick",
      "cua computer-server (HTTP + MCP)",
      "bb-sandbox-capture",
    ],
  },
  {
    category: "Environment managers",
    items: ["Nix (flakes)", "devbox", "direnv", "process-compose", "mise"],
  },
  {
    category: "Cloud and data CLIs",
    items: [
      "AWS CLI v2",
      "kubectl",
      "Helm 3",
      "Doppler",
      "1Password CLI",
      "DuckDB",
      "ClickHouse client",
      "PostgreSQL client",
      "Redis tools",
      "SQLite",
    ],
  },
  {
    category: "Project CLIs (credentials injected per project)",
    items: [
      "PostHog",
      "Vercel",
      "Railway",
      "Notion ntn",
      "Slack",
      "HubSpot Agent",
      "Linear",
    ],
  },
  {
    category: "System and previews",
    items: [
      "build-essential",
      "Clang/CMake/Ninja",
      "protobuf-compiler",
      "ripgrep/fd/fzf",
      "tmux",
      "xdotool/wmctrl",
      "bb persistent preview supervisor",
    ],
  },
] as const;

/**
 * Everything the single sandbox Dockerfile expects beside itself. The image
 * installs the bb host daemon from npm, so no build artifact is staged here.
 */
export const sandboxImageContextFiles = [
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
}): Promise<SandboxImageBuildContext> {
  const extraPackages = normalizeExtraPackages(input.extraPackages);
  const sourceDirectory = dirname(input.dockerfilePath);
  const targetDirectory = await mkdtemp(join(tmpdir(), "bb-sandbox-image-"));
  for (const filename of sandboxImageContextFiles) {
    await cp(join(sourceDirectory, filename), join(targetDirectory, filename), { dereference: true });
  }
  const source = await readFile(input.dockerfilePath, "utf8");
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
