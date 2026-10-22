/**
 * The outside world `bb sandbox upgrade` reads and drives: npm and GitHub for
 * the latest harness releases, the `gh` CLI for the image build workflow, and
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
  type ImageBuildDispatcher,
} from "./upgrade.js";

const run = promisify(execFile);
const GH_TIMEOUT_MS = 60_000;
const IMAGE_WORKFLOW = "sandbox-image.yml";
const RUN_LOOKUP_ATTEMPTS = 20;

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

/** `owner/repo` from a GitHub remote URL, or null for anything else. */
export function githubRepository(remote: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(remote.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/**
 * The repository whose `sandbox-image.yml` builds the image: an explicit
 * `BB_SANDBOX_IMAGE_BUILD_REPO`, or the GitHub origin of the checkout this
 * plugin runs from.
 */
export async function imageBuildRepository(pluginDirectory: string): Promise<string> {
  const explicit = process.env.BB_SANDBOX_IMAGE_BUILD_REPO?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  try {
    const { stdout } = await run("git", ["-C", pluginDirectory, "remote", "get-url", "origin"], {
      timeout: 10_000,
    });
    const repository = githubRepository(stdout);
    if (repository !== null) return repository;
  } catch {
    // Fall through to the explanatory error.
  }
  throw new Error(
    "Cannot tell which GitHub repository builds the sandbox image; set BB_SANDBOX_IMAGE_BUILD_REPO=<owner/repo> for the bb server",
  );
}

export function githubImageBuilds(
  repository: () => Promise<string>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): ImageBuildDispatcher {
  return {
    async dispatch({ tag, bbAppVersion, harness }) {
      const repo = await repository();
      await gh([
        "workflow", "run", IMAGE_WORKFLOW, "-R", repo,
        "-f", `version=${tag}`,
        "-f", `bb_app_version=${bbAppVersion}`,
        "-f", `claude_code_version=${harness["claude-code"]}`,
        "-f", `codex_version=${harness.codex}`,
        "-f", `omp_version=${harness.omp}`,
        "-f", `fx_version=${harness.fx}`,
        "-f", `pi_version=${harness.pi}`,
        "-f", `prime_agent_version=${harness["prime-agent"]}`,
        "-f", `adapters_ref=${adaptersRef()}`,
      ]);
      // `gh workflow run` does not return the run; the workflow's run-name
      // carries the tag, so find it by that.
      const title = `Sandbox image ${tag}`;
      for (let attempt = 0; attempt < RUN_LOOKUP_ATTEMPTS; attempt += 1) {
        await sleep(3_000);
        const runs = JSON.parse(
          await gh([
            "run", "list", "-R", repo, "--workflow", IMAGE_WORKFLOW,
            "--event", "workflow_dispatch", "-L", "20",
            "--json", "databaseId,displayTitle,url",
          ]),
        ) as Array<{ databaseId: number; displayTitle: string; url: string }>;
        const found = runs.find((candidate) => candidate.displayTitle === title);
        if (found !== undefined) return { runId: String(found.databaseId), url: found.url };
      }
      throw new Error(`Dispatched ${IMAGE_WORKFLOW} in ${repo} but found no run named "${title}"`);
    },
    async status(runId) {
      const repo = await repository();
      const view = JSON.parse(
        await gh(["run", "view", runId, "-R", repo, "--json", "status,conclusion,url"]),
      ) as { status: string; conclusion: string | null; url: string };
      return {
        status: view.status,
        conclusion: view.conclusion === "" ? null : view.conclusion,
        url: view.url,
      };
    },
  };
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
