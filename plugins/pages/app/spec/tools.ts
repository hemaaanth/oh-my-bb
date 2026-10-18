// Query tools agents may call from a fence: `data = Query("file", {path: "out/report.json"}, {rows: []})`.
// server/spec/data.ts answers them. Keep both in step: a tool listed here must be handled there.
import type { ToolSpec } from "@openuidev/react-lang";

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties) });
const list = (items: Record<string, unknown>) => ({ type: "array", items });
const limit = { type: "object", properties: { limit: { type: "number", description: "How many to return. Default 20, at most 100." } } };

export const specTools: ToolSpec[] = [
  {
    name: "file",
    description: "Reads a file from this thread's workspace, its thread storage, or /tmp. A relative path is in the workspace. .json gives data (and rows if it is a list); .csv, .tsv, .jsonl give rows of objects; anything else gives text. At most 2 MB and 5000 rows.",
    inputSchema: { type: "object", properties: { path: str }, required: ["path"] },
    outputSchema: obj({ path: str, kind: str, rows: list({ type: "object" }), data: {}, text: str }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "changes",
    description: "The uncommitted changes in this thread's environment: one row per file with its unified diff (patch is empty when too large). status is added, modified, deleted, renamed, copied, or type_changed.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: obj({ files: list(obj({ path: str, status: str, additions: num, deletions: num, patch: str })), additions: num, deletions: num }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "commits",
    description: "The commits on this thread's branch that are not on its base branch, newest first.",
    inputSchema: limit,
    outputSchema: obj({ branch: str, base: str, ahead: num, behind: num, commits: list(obj({ sha: str, subject: str, author: str, date: str })) }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "pull_request",
    description: "The pull request of this thread's branch, or pullRequest null with a message. Fields: number, title, url, state, base, head, updatedAt, checks {state, passed, failed, pending, total}, review, mergeable, attention. state is open, draft, merged, or closed; checks.state is passing, failing, pending, or no_checks; review is approved, changes_requested, review_requested, review_required, or none; mergeable is mergeable, conflicts, blocked, or draft.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: obj({ pullRequest: { type: ["object", "null"], properties: { number: num, title: str, url: str, state: str, base: str, head: str, checks: obj({ passed: num, failed: num, pending: num, total: num }), review: str, mergeable: str, attention: str } }, message: str }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "threads",
    description: "Recent threads of this project, newest first. status is active, idle, error, pending, starting, or stopping; waiting means it needs an answer.",
    inputSchema: limit,
    outputSchema: obj({ threads: list(obj({ id: str, title: str, status: str, updatedAt: str, branch: str, waiting: bool })) }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "environments",
    description: "The environments (checkouts and worktrees) of this project. status is ready, creating, provisioning, or error.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: obj({ environments: list(obj({ id: str, name: str, branch: str, base: str, status: str, updatedAt: str })) }),
    annotations: { readOnlyHint: true },
  },
];
