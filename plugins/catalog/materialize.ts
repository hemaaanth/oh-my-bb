import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ApprovedSkill } from "./store.js";

const harnesses = [
  { id: "bb", name: "bb", mode: "native", detail: "Uses catalog_search and catalog_read for assigned skills without adding a duplicate copy to provider prompts." },
  { id: "claude-code", name: "Claude Code", mode: "native", detail: "Reads ~/.claude/skills and a workspace's .claude/skills." },
  { id: "codex", name: "Codex", mode: "shared-skills", detail: "Reads the shared Agent Skills projection, globally and inside the workspace." },
  { id: "omp", name: "OMP (omp.sh)", mode: "shared-skills", detail: "Reads .agents/skills and can also discover Claude and Codex sources." },
  { id: "pi", name: "Pi", mode: "shared-skills", detail: "Reads .agents/skills natively." },
  { id: "prime-agent", name: "Prime Agent", mode: "shared-skills", detail: "Reads .agents/skills natively, including Python-backed skill packages." },
  { id: "exo", name: "Exo", mode: "executor", detail: "Uses the selected executor's skill projection (for example Codex or Claude Code)." },
  { id: "fx", name: "fx (fx.sh)", mode: "shared-skills", detail: "Walks .agents/skills and .claude/skills up from the workspace, then the same roots in your home; its own installs stay in ~/.fx/skills." },
] as const;

export function harnessCatalog() { return harnesses.map((value) => ({ ...value })); }

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "source";
}

function projectedName(skill: ApprovedSkill): string {
  return `catalog-${slug(skill.sourceName)}-${slug(skill.name)}`.slice(0, 64).replace(/-+$/u, "");
}

const projectedDescriptionLimit = 160;
const projectionFormatVersion = 2;

function compactDescription(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= projectedDescriptionLimit) return normalized;
  const sentence = normalized.match(/^.{40,160}?[.!?](?:\s|$)/u)?.[0]?.trim();
  if (sentence) return sentence;
  const clipped = normalized.slice(0, projectedDescriptionLimit - 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary >= 80 ? boundary : undefined).trimEnd()}…`;
}

function projectFrontmatter(content: string, name: string, description: string): string {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) return content;
  const lines = match[1]!.split(/\r?\n/u);
  const replaceField = (field: string, value: string) => {
    const start = lines.findIndex((line) => new RegExp(`^${field}:\\s*`, "u").test(line));
    const rendered = `${field}: ${value}`;
    if (start < 0) {
      lines.unshift(rendered);
      return;
    }
    let end = start + 1;
    while (end < lines.length && !/^[A-Za-z0-9_-]+:\s*/u.test(lines[end]!)) end += 1;
    lines.splice(start, end - start, rendered);
  };
  replaceField("name", name);
  replaceField("description", JSON.stringify(compactDescription(description)));
  return content.replace(match[0], `---\n${lines.join("\n")}\n---`);
}

/**
 * Keeps projected skills out of Git without touching a repository's own ignore
 * rules: the file ignores this plugin's directories and itself, so a skill the
 * developer writes by hand in the same root still shows up in git status.
 */
const ignoreFile = "catalog-*\n.gitignore\n";

interface Manifest { schemaVersion: 1; digest: string; paths: string[] }

/**
 * A machine's link to bb drops for a few seconds whenever its tunnel
 * reconnects, and every file RPC in flight then fails with "host is not
 * connected". Projecting a full skill set is thousands of calls spread over
 * minutes, so one blip must not throw the whole projection away: wait for the
 * machine to come back and repeat the call that lost. Every call here is a
 * mkdir, an overwrite, or a compare-and-swap that reconciles a conflict, so
 * repeating one that already landed is harmless.
 */
const hostRetryDefaults = { budgetMs: 2 * 60_000, delayMs: 2_000 };

function hostUnavailable(error: unknown): boolean {
  return /host (?:is )?(?:not connected|unavailable)|host_unavailable|host disconnected/iu.test(
    error instanceof Error ? error.message : String(error),
  );
}

function retryWhileHostReconnects(
  options: { budgetMs: number; delayMs: number },
) {
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const deadline = Date.now() + options.budgetMs;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (!hostUnavailable(error) || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  };
}

async function mapConcurrently<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
) {
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        await visit(values[index]!);
      }
    },
  ));
}

export async function materializeSkills(args: {
  bb: BbPluginApi;
  hostId: string;
  /** Absolute skill roots and their trusted enclosing confinement roots. */
  roots: Array<{ path: string; rootPath: string; publish?: boolean }>;
  /** Write a self-ignoring .gitignore into each root; use inside a workspace. */
  keepOutOfGit?: boolean;
  /** Absolute confinement root containing the manifest. */
  manifestRoot: string;
  manifestPath: string;
  skills: ApprovedSkill[];
  /** How long to keep repeating a call while the machine is offline. */
  hostRetry?: { budgetMs?: number; delayMs?: number };
}): Promise<{ ready: boolean; digest: string; skillCount: number; roots: string[]; detail: string }> {
  const { bb, hostId, roots: configuredRoots, manifestRoot, manifestPath, skills, keepOutOfGit = false } = args;
  const reconnecting = retryWhileHostReconnects({ ...hostRetryDefaults, ...args.hostRetry });
  const files = {
    mkdir: (input: Parameters<typeof bb.sdk.files.mkdir>[0]) => reconnecting(() => bb.sdk.files.mkdir(input)),
    read: (input: Parameters<typeof bb.sdk.files.read>[0]) => reconnecting(() => bb.sdk.files.read(input)),
    remove: (input: Parameters<typeof bb.sdk.files.remove>[0]) => reconnecting(() => bb.sdk.files.remove(input)),
    write: (input: Parameters<typeof bb.sdk.files.write>[0]) => reconnecting(() => bb.sdk.files.write(input)),
  };
  const publicationRoots = configuredRoots.filter(({ publish = true }) => publish);
  const roots = publicationRoots.map(({ path }) => path);
  const digest = createHash("sha256").update(JSON.stringify([projectionFormatVersion, configuredRoots, keepOutOfGit ? ignoreFile : "", skills.map((skill) => [skill.id, skill.revision, skill.digest])])).digest("hex");
  let previous: Manifest | null = null;
  let previousSha256: string | null = null;
  try {
    const file = await files.read({ hostId, rootPath: manifestRoot, path: manifestPath });
    previous = JSON.parse(file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content) as Manifest;
    previousSha256 = file.sha256;
  } catch { /* first materialization */ }
  if (skills.length === 0 && previous === null) return { ready: true, digest, skillCount: 0, roots, detail: "Nothing is assigned here, so no skill root was touched." };
  if (previous?.digest === digest) return { ready: true, digest, skillCount: skills.length, roots, detail: `${skills.length} assigned skill${skills.length === 1 ? "" : "s"} already projected.` };

  // Every directory is created once, however many files land in it. A large
  // skill set is otherwise one redundant mkdir per file, and on a sandbox each
  // of those is a round trip across the machine's link.
  const directories = new Map<string, Promise<unknown>>();
  const ensureDirectory = (rootPath: string, path: string): Promise<unknown> => {
    const key = `${rootPath}\u0000${path}`;
    const existing = directories.get(key);
    if (existing !== undefined) return existing;
    const created = files.mkdir({ hostId, rootPath, path, recursive: true });
    directories.set(key, created);
    return created;
  };

  await Promise.all(publicationRoots.map(async ({ path, rootPath }) => {
    await ensureDirectory(rootPath, path);
    if (keepOutOfGit) await files.write({ hostId, rootPath, path: `${path}/.gitignore`, content: ignoreFile });
  }));
  const projections = publicationRoots.flatMap((root) => skills.map((skill) => ({
    directory: `${root.path}/${projectedName(skill)}`,
    rootPath: root.rootPath,
    skill,
  })));
  const nextPaths = projections.map(({ directory }) => directory);
  // Remote file RPC latency dominates sandbox preparation, and a machine
  // reached over a tunnel answers far more of these in parallel than in
  // sequence. Keep a bounded number of independent skill projections in flight
  // while preserving each skill's own file order.
  await mapConcurrently(projections, 16, async ({ directory, rootPath, skill }) => {
    await ensureDirectory(rootPath, directory);
    for (const file of skill.files) {
      const content = file.path === "SKILL.md" ? projectFrontmatter(file.content, projectedName(skill), skill.description) : file.content;
      const contentEncoding = file.path === "SKILL.md" ? "utf8" : file.contentEncoding;
      const path = `${directory}/${file.path}`;
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent !== directory) await ensureDirectory(rootPath, parent);
      await files.write({ hostId, rootPath, path, content, contentEncoding });
    }
  });
  for (const stale of previous?.paths ?? []) {
    const root = configuredRoots.find((candidate) => stale.startsWith(`${candidate.path}/catalog-`));
    if (!nextPaths.includes(stale) && root) {
      await files.remove({ hostId, rootPath: root.rootPath, path: stale, recursive: true }).catch(() => undefined);
    }
  }
  await files.mkdir({ hostId, rootPath: manifestRoot, path: manifestPath.slice(0, manifestPath.lastIndexOf("/")), recursive: true });
  const manifest = await files.write({
    hostId,
    rootPath: manifestRoot,
    path: manifestPath,
    content: `${JSON.stringify({ schemaVersion: 1, digest, paths: nextPaths }, null, 2)}\n`,
    expectedSha256: previousSha256,
    mode: 0o600,
  });
  if (manifest.outcome === "conflict") {
    const current = await files.read({ hostId, rootPath: manifestRoot, path: manifestPath }).catch(() => null);
    const content = current
      ? current.contentEncoding === "base64" ? Buffer.from(current.content, "base64").toString("utf8") : current.content
      : "";
    const currentManifest = content ? JSON.parse(content) as Manifest : null;
    if (currentManifest?.digest !== digest) {
      throw new Error("Executor skill materialization changed concurrently; retry to reconcile the skill projections.");
    }
  }
  return { ready: true, digest, skillCount: skills.length, roots, detail: `Projected ${skills.length} assigned skill${skills.length === 1 ? "" : "s"} into ${roots.length} skill root${roots.length === 1 ? "" : "s"}.` };
}
