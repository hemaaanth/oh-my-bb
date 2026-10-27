/**
 * The outside world `bb sandbox upgrade` reads and drives: npm and GitHub for
 * the latest harness releases, and
 * the registry for the active image's version labels.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { SandboxImageRegistryConfig } from "./config.js";
import { readRegistryImageLabel } from "./register-image.js";
import {
  harnessNames,
  type CarriedVersions,
  type HarnessName,
  type HarnessVersions,
} from "./upgrade.js";

const run = promisify(execFile);
const GH_TIMEOUT_MS = 60_000;

/** The OCI label each harness version is stamped under (docker/Dockerfile). */
export const harnessImageLabels: Record<HarnessName, string> = {
  "claude-code": "bb.harness.claude-code",
  codex: "bb.harness.codex",
  omp: "bb.harness.omp",
  fx: "bb.harness.fx",
  pi: "bb.harness.pi",
  "prime-agent": "bb.harness.prime-agent",
  "fx-acp": "bb.harness.fx-acp",
  "nanocodex-acp": "bb.harness.nanocodex-acp",
  "prime-agent-acp": "bb.harness.prime-agent-acp",
};

export function adaptersRef(): string {
  const installer = readFileSync(new URL("../docker/install-gateway-harnesses.sh", import.meta.url), "utf8");
  return process.env.BB_SANDBOX_ADAPTERS_REF?.trim() ||
    /ADAPTERS_REF="\$\{ADAPTERS_REF:-(.+)\}"/u.exec(installer)![1]!;
}

async function adapterDigest(name: string): Promise<string> {
  const ref = adaptersRef();
  if (!/^[0-9a-f]{40}$/u.test(ref)) {
    throw new Error("Set the immutable oh-my-bb adapter commit in ADAPTERS_REF before rollout");
  }
  const response = await fetch(`https://raw.githubusercontent.com/hemaaanth/oh-my-bb/${ref}/agents/${name}/${name}.mjs`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cannot read ${name} at ${ref} (${response.status})`);
  return createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
}

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("gh", args, {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail =
      error !== null && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : "";
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("The GitHub CLI (gh) is not on the bb server's PATH; install it and run gh auth login");
    }
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed${detail.length > 0 ? `: ${detail}` : ""}`);
  }
}

async function npmLatest(name: string): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`npm has no latest release of ${name} (${response.status})`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string") throw new Error(`npm returned no version for ${name}`);
  return body.version;
}

async function githubLatest(repository: string): Promise<string> {
  const tag = (await gh(["api", `repos/${repository}/releases/latest`, "--jq", ".tag_name"])).trim();
  if (tag.length === 0) throw new Error(`${repository} has no latest release`);
  return tag.replace(/^v/u, "");
}

export async function latestHarnessVersions(): Promise<HarnessVersions> {
  const [claudeCode, codex, omp, fx, pi, prime, fxAcp, nanocodexAcp, primeAcp] = await Promise.all([
    npmLatest("@anthropic-ai/claude-code"),
    npmLatest("@openai/codex"),
    githubLatest("can1357/oh-my-pi"),
    githubLatest("vercel-labs/fx"),
    npmLatest("@earendil-works/pi-coding-agent"),
    githubLatest("PrimeIntellect-ai/prime-agent"),
    adapterDigest("fx-acp"),
    adapterDigest("nanocodex-acp"),
    adapterDigest("prime-agent-acp"),
  ]);
  return { "claude-code": claudeCode, codex, omp, fx, pi, "prime-agent": prime,
    "fx-acp": fxAcp, "nanocodex-acp": nanocodexAcp, "prime-agent-acp": primeAcp };
}


/** The bb and harness versions an image's labels name, read without pulling. */
export async function readImageVersions(input: {
  registry: SandboxImageRegistryConfig;
  tag: string;
}): Promise<CarriedVersions> {
  const read = (label: string) =>
    readRegistryImageLabel({
      registry: input.registry,
      reference: input.tag,
      label,
      platform: input.registry.platform,
    });
  const [bb, ...harness] = await Promise.all([
    read("bb.app.version"),
    ...harnessNames.map((name) => read(harnessImageLabels[name])),
  ]);
  return {
    bb: bb ?? null,
    harness: Object.fromEntries(
      harnessNames.map((name, index) => [name, harness[index] ?? null]),
    ) as Record<HarnessName, string | null>,
  };
}
