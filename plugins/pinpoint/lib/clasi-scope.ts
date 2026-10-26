// Clasi's repository-scope format, kept local so learning stays optional.
// Node crypto keeps this module server-only.
import { createHash } from "node:crypto";

// Match the public Clasi contract without importing or probing its package.
// Type alias (not interface) on purpose: object-literal aliases get implicit
// index signatures, so this stays assignable to the SDK's JsonValue.
export type ClasiScopeRef = {
  type: "global" | "project" | "environment";
  id: string;
};

/** VERBATIM copy of clasi/server.ts projectScopeRef. */
export function deriveClasiProjectScope(project: {
  id: string;
  gitRemoteUrl: string | null;
}): ClasiScopeRef {
  if (!project.gitRemoteUrl) return { type: "project", id: project.id };
  const canonical = canonicalGitRemote(project.gitRemoteUrl);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return { type: "project", id: `repo_${digest}` };
}

/** VERBATIM copy of clasi/server.ts canonicalGitRemote. */
export function canonicalGitRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git\/?$/i, "");
  const scp = trimmed.includes("://") ? null : /^([^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  const normalized = scp ? `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}` : trimmed;
  try {
    const url = new URL(normalized);
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${path}`;
  } catch {
    return normalized;
  }
}

// Local parity fixtures. Each package installs and runs its tests independently.
export const CLASI_SCOPE_FIXTURES = {
  /**
   * Remote → canonical form pairs. Expected scope ids are computed in each
   * suite as `repo_` + sha256(canonical) hex sliced to 32 — the exact clasi
   * algorithm — and compared against the live derivation on that side.
   */
  scopeRemotes: [
    {
      remote: "https://github.com/acme/example.git",
      canonical: "github.com/acme/example",
    },
    {
      remote: "git@github.com:acme/example.git",
      canonical: "github.com/acme/example",
    },
    {
      remote: "ssh://git@gitlab.com:2222/team/widget.git/",
      canonical: "gitlab.com:2222/team/widget",
    },
  ],
} as const;
