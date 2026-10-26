// Project: this project's changes, commits, pull requests, and threads.
import { useState, type ReactNode } from "react";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import { useHost } from "../host.js";
import { Chevron, Reveal, focusRing, type Group } from "../kit.js";
import { jsonChildren, jsonPreview, jsonScalar, relativeTime } from "./project-logic.js";
import { TestsView } from "../reports/ResultsView.js";

/** Rows that have their main field yet: while a reply streams, the last one may be half written. */
const ready = <T,>(items: unknown, key: keyof T): T[] => Array.isArray(items) ? items.filter((item) => item && typeof item === "object" && typeof item[key] === "string" && item[key] !== "") : [];
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const words = (value: unknown) => typeof value === "string" ? value.replace(/_/gu, " ").toLowerCase() : "";
const toggle = `flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-sm text-left ${focusRing}`;
const row = "border-b border-border-hairline py-1.5 last:border-b-0";
const list = "m-0 flex list-none flex-col p-0";

// One tone per state word BB and git hosts use. Unknown words stay muted.
const TONES: Record<string, string> = {
  passing: "text-success", passed: "text-success", approved: "text-success", mergeable: "text-success", ready_to_merge: "text-success", ready: "text-success", open: "text-success", added: "text-success",
  failing: "text-destructive", failed: "text-destructive", changes_requested: "text-destructive", conflicts: "text-destructive", checks_failed: "text-destructive", error: "text-destructive", deleted: "text-destructive",
  pending: "text-warning", checks_pending: "text-warning", review_requested: "text-warning", review_required: "text-warning", blocked: "text-warning", creating: "text-warning", provisioning: "text-warning", starting: "text-warning", stopping: "text-warning", modified: "text-warning",
  merged: "text-primary", active: "text-primary", queued: "text-primary", renamed: "text-primary", copied: "text-primary",
};
const tone = (word: unknown) => (typeof word === "string" && TONES[word]) || "text-muted-foreground";

function Title({ text, children }: { text?: string; children?: ReactNode }) {
  return text || children ? <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">{text ? <h3 className="m-0 font-semibold text-foreground">{text}</h3> : null}{children}</div> : null;
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="shrink-0 tabular-nums"><span className="text-success">+{additions}</span> <span className="text-destructive">−{deletions}</span></span>;
}

function Empty({ text }: { text: string }) {
  return <p className="m-0 text-muted-foreground">{text}</p>;
}

const file = z.object({ path: z.string(), status: z.string().optional(), additions: z.number().optional(), deletions: z.number().optional(), patch: z.string().optional(), previousPath: z.string().nullable().optional() });
type ChangedFile = z.infer<typeof file>;
const LETTER: Record<string, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", type_changed: "T" };

function ChangedRow({ item, open: initial }: { item: ChangedFile; open: boolean }) {
  const host = useHost();
  const [open, setOpen] = useState(initial);
  const patch = typeof item.patch === "string" ? item.patch : "";
  const status = item.status ?? "modified";
  const name = <><span aria-label={words(status)} title={words(status)} className={`w-3 shrink-0 font-mono ${tone(status)}`}>{LETTER[status] ?? "M"}</span>
    <span className="min-w-0 flex-1 truncate font-mono text-[0.92em] text-foreground">{item.previousPath ? `${item.previousPath} → ` : ""}{item.path}</span>
    <Counts additions={num(item.additions)} deletions={num(item.deletions)} /></>;
  return <li className={row}>
    {patch ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={toggle}><Chevron open={open} />{name}</button>
      : <div className="flex min-w-0 items-baseline gap-2"><span className="w-[1em] shrink-0" />{name}</div>}
    {patch ? <Reveal open={open} className="pt-1.5"><host.Diff patch={patch} path={item.path} /></Reveal> : null}
  </li>;
}

const Changes = defineComponent({
  name: "Changes",
  props: z.object({ files: z.array(file), title: z.string().optional(), open: z.boolean().optional() }),
  description: 'Changed files with line counts. Each file with a patch (unified diff text) opens to show it in BB\'s diff viewer. status is added, modified (default), deleted, renamed, copied, or type_changed; give previousPath for renames. open true starts every file open. Use Query("changes") for this thread\'s uncommitted changes.',
  component: ({ props }) => {
    const files = ready<ChangedFile>(props.files, "path");
    const additions = files.reduce((sum, item) => sum + num(item.additions), 0), deletions = files.reduce((sum, item) => sum + num(item.deletions), 0);
    return <div className="flex min-w-0 flex-col gap-2">
      <Title text={props.title}><span className="text-muted-foreground">{files.length} {files.length === 1 ? "file" : "files"}</span><Counts additions={additions} deletions={deletions} /></Title>
      {files.length ? <ul className={list}>{files.map((item, i) => <ChangedRow key={`${item.path}:${i}`} item={item} open={props.open === true} />)}</ul> : <Empty text="No changes." />}
    </div>;
  },
});

const commit = z.object({ subject: z.string(), sha: z.string().optional(), author: z.string().optional(), date: z.union([z.string(), z.number()]).optional() });

const Commits = defineComponent({
  name: "Commits",
  props: z.object({ commits: z.array(commit), title: z.string().optional() }),
  description: 'A list of commits, newest first: short sha, subject, author, and when. date is ISO text or epoch ms. Use Query("commits") for the commits on this thread\'s branch.',
  component: ({ props }) => {
    const commits = ready<z.infer<typeof commit>>(props.commits, "subject");
    return <div className="flex min-w-0 flex-col gap-2">
      <Title text={props.title} />
      {commits.length ? <ul className={list}>{commits.map((item, i) => <li key={i} className={`flex min-w-0 items-baseline gap-2.5 ${row}`}>
        {item.sha ? <code className="shrink-0 font-mono text-[0.92em] text-muted-foreground">{item.sha.slice(0, 7)}</code> : null}
        <span className="min-w-0 flex-1 truncate text-foreground" title={item.subject}>{item.subject}</span>
        <span className="shrink-0 text-muted-foreground">{[item.author, relativeTime(item.date)].filter(Boolean).join(" · ")}</span>
      </li>)}</ul> : <Empty text="No commits." />}
    </div>;
  },
});

function JsonNode({ name, value, depth, open: initial }: { name?: string; value: unknown; depth: number; open: number }) {
  const [open, setOpen] = useState(depth < initial);
  const [shown, setShown] = useState(100);
  const children = jsonChildren(value);
  const key = name !== undefined ? <span className="text-muted-foreground">{name}: </span> : null;
  if (!value || typeof value !== "object") {
    const color = typeof value === "string" ? "text-success" : typeof value === "number" ? "text-primary" : "text-warning";
    return <li className="pl-5"><span className="break-all">{key}<span className={color}>{jsonScalar(value)}</span></span></li>;
  }
  return <li>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${toggle} items-baseline`}>
      <Chevron open={open} />
      <span className="min-w-0 truncate">{key}<span className="text-muted-foreground">{open ? (Array.isArray(value) ? "[" : "{") : jsonPreview(value)}</span></span>
    </button>
    <Reveal open={open}>
      <ul className={`${list} ml-1.5 border-l border-border-hairline pl-2`}>
        {children.slice(0, shown).map(([childKey, child]) => <JsonNode key={childKey} name={childKey} value={child} depth={depth + 1} open={initial} />)}
        {children.length > shown ? <li className="pl-5"><button type="button" onClick={() => setShown(shown + 100)} className={`cursor-pointer rounded-sm text-primary ${focusRing}`}>Show {Math.min(100, children.length - shown)} more of {children.length - shown}</button></li> : null}
      </ul>
      <span className="pl-5 text-muted-foreground">{Array.isArray(value) ? "]" : "}"}</span>
    </Reveal>
  </li>;
}

const Json = defineComponent({
  name: "Json",
  props: z.object({ data: z.any(), title: z.string().optional(), open: z.number().optional() }),
  description: 'A collapsible JSON viewer for any value: objects and lists open and close; closed ones show their size. open is how many levels start open (default 1). Good for Query("file") data and API responses.',
  component: ({ props }) => <div className="flex min-w-0 flex-col gap-2">
    <Title text={props.title} />
    <ul className={`${list} overflow-x-auto font-mono text-[0.92em] leading-relaxed`}><JsonNode value={props.data ?? null} depth={0} open={typeof props.open === "number" ? props.open : 1} /></ul>
  </div>,
});

const PR_STATE: Record<string, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const CHECKS: Record<string, string> = { passing: "Checks pass", failing: "Checks fail", pending: "Checks running", no_checks: "No checks" };
const REVIEW: Record<string, string> = { approved: "Approved", changes_requested: "Changes requested", review_requested: "Review requested", review_required: "Review required" };
const MERGE: Record<string, string> = { mergeable: "Can merge", conflicts: "Has conflicts", blocked: "Merge blocked" };

const pr = z.object({
  number: z.number().optional(), title: z.string(), url: z.string().optional(), state: z.string().optional(), base: z.string().optional(), head: z.string().optional(), updatedAt: z.string().optional(),
  checks: z.object({ state: z.string().nullable().optional(), passed: z.number().optional(), failed: z.number().optional(), pending: z.number().optional(), total: z.number().optional() }).optional(),
  review: z.string().nullable().optional(), mergeable: z.string().nullable().optional(),
});

const PullRequest = defineComponent({
  name: "PullRequest",
  props: z.object({ pullRequest: pr.nullable().optional(), message: z.string().optional() }),
  description: 'One pull request: number, title, state, branches, checks, review, and whether it can merge. state is open, draft, merged, or closed. checks.state is passing, failing, pending, or no_checks; review is approved, changes_requested, review_requested, or review_required; mergeable is mergeable, conflicts, or blocked. A null pullRequest shows message. Use Query("pull_request") for this thread\'s branch.',
  component: ({ props }) => {
    const host = useHost();
    const item = props.pullRequest && typeof props.pullRequest === "object" && typeof props.pullRequest.title === "string" ? props.pullRequest : null;
    if (!item) return <Empty text={props.message || "No pull request."} />;
    const checks = item.checks ?? {};
    const state = item.state ?? "open";
    const facts: [string, string][] = [
      ...(checks.state && CHECKS[checks.state] ? [[checks.state === "no_checks" ? CHECKS.no_checks : `${CHECKS[checks.state]}${num(checks.total) ? ` (${[num(checks.passed) && `${num(checks.passed)} passed`, num(checks.failed) && `${num(checks.failed)} failed`, num(checks.pending) && `${num(checks.pending)} running`].filter(Boolean).join(", ")})` : ""}`, tone(checks.state)] as [string, string]] : []),
      ...(item.review && REVIEW[item.review] ? [[REVIEW[item.review], tone(item.review)] as [string, string]] : []),
      ...(state === "open" && item.mergeable && MERGE[item.mergeable] ? [[MERGE[item.mergeable], tone(item.mergeable)] as [string, string]] : []),
    ];
    const title = <>{item.number ? <span className="text-muted-foreground">#{item.number} </span> : null}{item.title}</>;
    return <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2">
        {/^https?:\/\//iu.test(item.url ?? "") ? <button type="button" onClick={() => host.openUrl(item.url!)} className={`min-w-0 cursor-pointer rounded-sm text-left font-semibold text-foreground hover:underline ${focusRing}`}>{title}</button> : <span className="min-w-0 font-semibold text-foreground">{title}</span>}
        <span className={`shrink-0 ${state === "open" ? "text-success" : state === "merged" ? "text-primary" : "text-muted-foreground"}`}>{PR_STATE[state] ?? words(state)}</span>
      </div>
      {item.head || item.base ? <p className="m-0 min-w-0 truncate font-mono text-[0.92em] text-muted-foreground">{item.head ?? "?"} → {item.base ?? "?"}{item.updatedAt ? <span className="font-sans"> · {relativeTime(item.updatedAt)}</span> : null}</p> : null}
      {facts.length ? <p className="m-0 flex flex-wrap gap-x-3">{facts.map(([label, color]) => <span key={label} className={color}>{label}</span>)}</p> : null}
    </div>;
  },
});


const Tests = defineComponent({
  name: "Tests",
  props: z.object({ results: z.union([z.array(z.any()), z.string(), z.record(z.string(), z.any())]), title: z.string().optional() }),
  description: 'Test results from existing case lists, vitest/Jest JSON, or JUnit XML. Failures sort first, with source locations, messages, and captured output behind disclosures. Search by name, suite, or file. Skips, pending tests, and expected failures stay distinct from passing tests. Load a report with Query("file").',
  component: ({ props }) => <TestsView results={props.results} title={props.title} />,
});

const thread = z.object({ title: z.string(), status: z.string().optional(), updatedAt: z.union([z.string(), z.number()]).optional(), branch: z.string().nullable().optional(), waiting: z.boolean().optional(), current: z.boolean().optional() });

const Threads = defineComponent({
  name: "Threads",
  props: z.object({ threads: z.array(thread), title: z.string().optional() }),
  description: 'Threads with their status, branch, and last update. status is active, idle, error, pending, starting, or stopping. waiting true marks a thread that needs an answer; current marks this one. Use Query("threads") for this project.',
  component: ({ props }) => {
    const threads = ready<z.infer<typeof thread>>(props.threads, "title");
    return <div className="flex min-w-0 flex-col gap-2">
      <Title text={props.title} />
      {threads.length ? <ul className={list}>{threads.map((item, i) => <li key={i} className={`flex min-w-0 items-baseline gap-2.5 ${row}`}>
        <span className={`w-14 shrink-0 ${tone(item.status)}`}>{words(item.status) || "idle"}</span>
        <span className="min-w-0 flex-1 truncate text-foreground" title={item.title}>{item.title}{item.current ? <span className="text-muted-foreground"> (this thread)</span> : null}</span>
        {item.waiting ? <span className="shrink-0 text-warning">Needs answer</span> : null}
        {item.branch ? <code className="hidden max-w-[12rem] shrink truncate font-mono text-[0.92em] text-muted-foreground sm:inline">{item.branch}</code> : null}
        <span className="shrink-0 text-muted-foreground">{relativeTime(item.updatedAt)}</span>
      </li>)}</ul> : <Empty text="No threads." />}
    </div>;
  },
});

const environment = z.object({ name: z.string(), branch: z.string().nullable().optional(), base: z.string().nullable().optional(), status: z.string().optional(), worktree: z.boolean().optional(), path: z.string().nullable().optional(), updatedAt: z.union([z.string(), z.number()]).optional(), current: z.boolean().optional() });

const Environments = defineComponent({
  name: "Environments",
  props: z.object({ environments: z.array(environment), title: z.string().optional() }),
  description: 'Environments (checkouts and worktrees) with branch, base, and status. status is ready, creating, provisioning, or error. current marks this thread\'s. Use Query("environments") for this project.',
  component: ({ props }) => {
    const environments = ready<z.infer<typeof environment>>(props.environments, "name");
    return <div className="flex min-w-0 flex-col gap-2">
      <Title text={props.title} />
      {environments.length ? <ul className={list}>{environments.map((item, i) => <li key={i} className={`flex min-w-0 flex-col gap-0.5 ${row}`}>
        <span className="flex min-w-0 items-baseline gap-2.5">
          <span className="min-w-0 flex-1 truncate text-foreground">{item.name}{item.current ? <span className="text-muted-foreground"> (this thread)</span> : null}</span>
          <span className={`shrink-0 ${tone(item.status)}`}>{words(item.status) || "ready"}</span>
          <span className="shrink-0 text-muted-foreground">{relativeTime(item.updatedAt)}</span>
        </span>
        {item.branch ? <span className="min-w-0 truncate font-mono text-[0.92em] text-muted-foreground">{item.branch}{item.base ? ` → ${item.base}` : ""}{item.worktree ? <span className="font-sans"> · worktree</span> : null}</span> : null}
      </li>)}</ul> : <Empty text="No environments." />}
    </div>;
  },
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const patch = "@@ -1,4 +1,5 @@\n export function total(items) {\n-  return items.reduce((a, b) => a + b);\n+  if (!items.length) return 0;\n+  return items.reduce((a, b) => a + b, 0);\n }";
const changesFixture = { files: [
  { path: "src/total.ts", status: "modified", additions: 2, deletions: 1, patch },
  { path: "src/total.test.ts", status: "added", additions: 14, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+import { total } from \"./total\";\n+\n+test(\"empty\", () => expect(total([])).toBe(0));" },
  { path: "docs/old.md", status: "deleted", additions: 0, deletions: 22, patch: "" },
], additions: 16, deletions: 23 };
const commitsFixture = { branch: "fix/total", base: "main", ahead: 3, behind: 0, commits: [
  { sha: "a1b2c3d4e5", subject: "Return 0 for an empty list", author: "Ana", date: ago(12) },
  { sha: "f6e7d8c9b0", subject: "Add a test for total()", author: "Ana", date: ago(90) },
  { sha: "0a9b8c7d6e", subject: "Start fix/total", author: "Raj", date: ago(60 * 30) },
] };
const prFixture = { pullRequest: { number: 128, title: "Return 0 for an empty list", url: "https://github.com/acme/shop/pull/128", state: "open", base: "main", head: "fix/total", updatedAt: ago(5), checks: { state: "failing", passed: 6, failed: 1, pending: 0, total: 7 }, review: "review_requested", mergeable: "mergeable", attention: "checks_failed" }, message: "" };
const threadsFixture = { threads: [
  { id: "t1", title: "Fix the empty-cart total", status: "active", updatedAt: ago(1), branch: "fix/total", waiting: false, current: true },
  { id: "t2", title: "Pick a chart library", status: "idle", updatedAt: ago(70), branch: null, waiting: true },
  { id: "t3", title: "Upgrade to React 20", status: "error", updatedAt: ago(60 * 26), branch: "chore/react-20", waiting: false },
] };
const environmentsFixture = { environments: [
  { id: "e1", name: "shop", branch: "main", base: "main", status: "ready", worktree: false, updatedAt: ago(3) },
  { id: "e2", name: "shop · fix-total", branch: "fix/total", base: "main", status: "ready", worktree: true, updatedAt: ago(1), current: true },
  { id: "e3", name: "shop · react-20", branch: "chore/react-20", base: "main", status: "provisioning", worktree: true, updatedAt: ago(0) },
] };
const junit = `<testsuites><testsuite name="cart"><testcase classname="cart" name="adds items" time="0.004"/><testcase classname="cart" name="totals an empty cart" time="0.002"><failure message="expected 0">AssertionError: expected NaN to be 0\\n    at cart.test.ts:14:31</failure></testcase><testcase classname="cart" name="applies coupons"><skipped/></testcase></testsuite><testsuite name="checkout"><testcase classname="checkout" name="charges the card" time="0.120"/></testsuite></testsuites>`;

export const group: Group = {
  id: "project",
  name: "Project",
  notes: ['Query tools give this thread\'s real data: changes, commits, pull_request, threads, environments, and file for reports in the workspace (Query("file", {path: "coverage/coverage-summary.json"}, {data: null})).'],
  entries: [
    { component: Changes, summary: "changed files with diffs", examples: [
      { name: "From the thread", code: 'data = Query("changes", {}, {files: []})\nroot = Changes(data.files, "Uncommitted changes")', tools: { changes: changesFixture } },
      { name: "Inline, one file open", code: `root = Changes([{path: "src/total.ts", status: "modified", additions: 2, deletions: 1, patch: ${JSON.stringify(patch)}}, {path: "src/sum.ts", previousPath: "src/add.ts", status: "renamed", additions: 0, deletions: 0}], null, true)` },
    ] },
    { component: Commits, summary: "commit list", examples: [
      { name: "From the thread", code: 'data = Query("commits", {limit: 5}, {commits: []})\nroot = Commits(data.commits, "On " + data.branch)', tools: { commits: commitsFixture } },
      { name: "Inline", code: `root = Commits([{sha: "a1b2c3d", subject: "Ship the new checkout", author: "Ana", date: "2026-03-02T10:00:00Z"}, {subject: "Draft release notes"}])` },
    ] },
    { component: Json, summary: "collapsible JSON", examples: [
      { name: "Nested", code: 'root = Json({name: "shop", version: "2.4.0", private: true, scripts: {build: "vite build", test: "vitest"}, workspaces: ["web", "api"], licence: null}, "package.json")' },
      { name: "From a file", code: 'data = Query("file", {path: "package.json"}, {data: null})\nroot = Json(data.data, data.path, 2)', tools: { file: { path: "package.json", kind: "json", rows: [], text: "", data: { name: "shop", version: "2.4.0", dependencies: { react: "^19.1.0", zod: "^4.0.0" } } } } },
    ] },
    { component: PullRequest, summary: "one pull request", examples: [
      { name: "From the thread", code: 'data = Query("pull_request", {}, {pullRequest: null, message: ""})\nroot = PullRequest(data.pullRequest, data.message)', tools: { pull_request: prFixture } },
      { name: "Merged", code: 'root = PullRequest({number: 97, title: "Move cart totals to the server", state: "merged", base: "main", head: "cart-server", checks: {state: "passing", passed: 9, total: 9}, review: "approved"})' },
      { name: "None", code: 'root = PullRequest(null, "This branch has no pull request.")' },
    ] },
    { component: Tests, summary: "test results", examples: [
      { name: "Cases", code: 'root = Tests([{name: "adds items", status: "passed", suite: "cart", ms: 4}, {name: "totals an empty cart", status: "failed", suite: "cart", ms: 2, message: "AssertionError: expected NaN to be 0"}, {name: "charges the card", status: "passed", suite: "checkout", ms: 120}, {name: "refunds", status: "todo", suite: "checkout"}], "Unit tests")' },
      { name: "JUnit report", code: 'data = Query("file", {path: "reports/junit.xml"}, {text: ""})\nroot = Tests(data.text)', tools: { file: { path: "reports/junit.xml", kind: "text", rows: [], data: null, text: junit.replace(/\\n/gu, "\n") } } },
      { name: "vitest JSON", code: 'root = Tests({testResults: [{name: "src/math.test.ts", assertionResults: [{title: "adds", ancestorTitles: ["math"], status: "passed", duration: 1}, {title: "divides by zero", ancestorTitles: ["math"], status: "failed", duration: 3, failureMessages: ["Error: expected Infinity to throw"]}]}]})' },
    ] },
    { component: Threads, summary: "project threads", examples: [
      { name: "From the project", code: 'data = Query("threads", {limit: 10}, {threads: []})\nroot = Threads(data.threads)', tools: { threads: threadsFixture } },
    ] },
    { component: Environments, summary: "project environments", examples: [
      { name: "From the project", code: 'data = Query("environments", {}, {environments: []})\nroot = Environments(data.environments)', tools: { environments: environmentsFixture } },
    ] },
  ],
};
