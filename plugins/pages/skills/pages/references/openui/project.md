# Project

Query tools give this thread's real data: changes, commits, pull_request, threads, environments, and file for reports in the workspace (Query("file", {path: "coverage/coverage-summary.json"}, {data: null})).

## Changes

`Changes(files: {path: string, status?: string, additions?: number, deletions?: number, patch?: string, previousPath?: string}[], title?: string, open?: boolean)`

Changed files with line counts. Each file with a patch (unified diff text) opens to show it in BB's diff viewer. status is added, modified (default), deleted, renamed, copied, or type_changed; give previousPath for renames. open true starts every file open. Use Query("changes") for this thread's uncommitted changes.

From the thread:

```openui-lang
data = Query("changes", {}, {files: []})
root = Changes(data.files, "Uncommitted changes")
```

Inline, one file open:

```openui-lang
root = Changes([{path: "src/total.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,4 +1,5 @@\n export function total(items) {\n-  return items.reduce((a, b) => a + b);\n+  if (!items.length) return 0;\n+  return items.reduce((a, b) => a + b, 0);\n }"}, {path: "src/sum.ts", previousPath: "src/add.ts", status: "renamed", additions: 0, deletions: 0}], null, true)
```

## Commits

`Commits(commits: {subject: string, sha?: string, author?: string, date?: string | number}[], title?: string)`

A list of commits, newest first: short sha, subject, author, and when. date is ISO text or epoch ms. Use Query("commits") for the commits on this thread's branch.

From the thread:

```openui-lang
data = Query("commits", {limit: 5}, {commits: []})
root = Commits(data.commits, "On " + data.branch)
```

Inline:

```openui-lang
root = Commits([{sha: "a1b2c3d", subject: "Ship the new checkout", author: "Ana", date: "2026-03-02T10:00:00Z"}, {subject: "Draft release notes"}])
```

## Json

`Json(data: any, title?: string, open?: number)`

A collapsible JSON viewer for any value: objects and lists open and close; closed ones show their size. open is how many levels start open (default 1). Good for Query("file") data and API responses.

Nested:

```openui-lang
root = Json({name: "shop", version: "2.4.0", private: true, scripts: {build: "vite build", test: "vitest"}, workspaces: ["web", "api"], licence: null}, "package.json")
```

From a file:

```openui-lang
data = Query("file", {path: "package.json"}, {data: null})
root = Json(data.data, data.path, 2)
```

## PullRequest

`PullRequest(pullRequest?: {number?: number, title: string, url?: string, state?: string, base?: string, head?: string, updatedAt?: string, checks?: {state?: string, passed?: number, failed?: number, pending?: number, total?: number}, review?: string, mergeable?: string}, message?: string)`

One pull request: number, title, state, branches, checks, review, and whether it can merge. state is open, draft, merged, or closed. checks.state is passing, failing, pending, or no_checks; review is approved, changes_requested, review_requested, or review_required; mergeable is mergeable, conflicts, or blocked. A null pullRequest shows message. Use Query("pull_request") for this thread's branch.

From the thread:

```openui-lang
data = Query("pull_request", {}, {pullRequest: null, message: ""})
root = PullRequest(data.pullRequest, data.message)
```

Merged:

```openui-lang
root = PullRequest({number: 97, title: "Move cart totals to the server", state: "merged", base: "main", head: "cart-server", checks: {state: "passing", passed: 9, total: 9}, review: "approved"})
```

None:

```openui-lang
root = PullRequest(null, "This branch has no pull request.")
```

## Tests

`Tests(results: any[] | string | Record<string, any>, title?: string)`

Test results from existing case lists, vitest/Jest JSON, or JUnit XML. Failures sort first, with source locations, messages, and captured output behind disclosures. Search by name, suite, or file. Skips, pending tests, and expected failures stay distinct from passing tests. Load a report with Query("file").

Cases:

```openui-lang
root = Tests([{name: "adds items", status: "passed", suite: "cart", ms: 4}, {name: "totals an empty cart", status: "failed", suite: "cart", ms: 2, message: "AssertionError: expected NaN to be 0"}, {name: "charges the card", status: "passed", suite: "checkout", ms: 120}, {name: "refunds", status: "todo", suite: "checkout"}], "Unit tests")
```

JUnit report:

```openui-lang
data = Query("file", {path: "reports/junit.xml"}, {text: ""})
root = Tests(data.text)
```

vitest JSON:

```openui-lang
root = Tests({testResults: [{name: "src/math.test.ts", assertionResults: [{title: "adds", ancestorTitles: ["math"], status: "passed", duration: 1}, {title: "divides by zero", ancestorTitles: ["math"], status: "failed", duration: 3, failureMessages: ["Error: expected Infinity to throw"]}]}]})
```

## Threads

`Threads(threads: {title: string, status?: string, updatedAt?: string | number, branch?: string, waiting?: boolean, current?: boolean}[], title?: string)`

Threads with their status, branch, and last update. status is active, idle, error, pending, starting, or stopping. waiting true marks a thread that needs an answer; current marks this one. Use Query("threads") for this project.

From the project:

```openui-lang
data = Query("threads", {limit: 10}, {threads: []})
root = Threads(data.threads)
```

## Environments

`Environments(environments: {name: string, branch?: string, base?: string, status?: string, worktree?: boolean, path?: string, updatedAt?: string | number, current?: boolean}[], title?: string)`

Environments (checkouts and worktrees) with branch, base, and status. status is ready, creating, provisioning, or error. current marks this thread's. Use Query("environments") for this project.

From the project:

```openui-lang
data = Query("environments", {}, {environments: []})
root = Environments(data.environments)
```
