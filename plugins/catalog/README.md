# Executor

Executor connects BB agents to a self-hosted [Executor 2](https://executor.sh)
server. Executor owns the apps, accounts, tools, approval rules and skills.
This plugin does four things:

- It signs BB in to Executor connections, one OAuth grant per connection.
- It records which connections each project, Agents profile or plugin uses.
- It runs agent calls from the BB server, so no token reaches a sandbox.
- It shows the skills that the connections' apps ship, and writes them into
  the skill roots that harnesses read.

The display name is Executor. The plugin ID stays `catalog` and the package
stays `bb-plugin-catalog`. The `bb catalog` commands, `catalog_search`,
`catalog_read` and `executor_*` tools, RPC routes and storage keys keep their
names.

## Configuration

Set these fields in BB's native **Configuration**:

- **Executor URL**, for example `https://executor.example.ts.net`.
- **Executor personal access token** (optional). It reads account health for
  connection alerts. It never runs code.

**Oh My BB** holds one optional integration: Agents profile connections. It is
off on a fresh install.

Opening settings reads local data only. It does not call Projects, Agents or
Executor's health API. Skills come from a 10-minute cache.

## Connections

An Executor connection is a named set of apps and the accounts they run as.
Build connections in the Executor console. Each one has an MCP URL:
`<executor>/mcp?connection=<id>`.

BB signs in to each connection with OAuth (PKCE). The grant holds an access
token and a refresh token. The plugin keeps it in its own database and
refreshes it before it expires. Sign in from settings, or from the CLI:

```sh
bb catalog executor configure --url https://executor.example.ts.net
bb catalog executor connect gtm         # prints the sign-in link
bb catalog executor use gtm --project example-project  # first is the default
bb catalog executor use shared --global                 # every project
bb catalog executor use gtm --agent @example-agent      # needs Agents opt-in
bb catalog executor use worker --plugin example-worker  # another plugin's backend
bb catalog executor disconnect gtm
bb catalog executor status
```

A thread's connections are its agent's, then its project's, then the global
ones. The first is the default. A `toolkit` argument picks another one. (The
argument keeps its v1 name. Connection IDs match the old toolkit slugs.)

Threads with connections get `executor_execute`, `executor_docs` and
`executor_resume`. One call runs in one connection. The tools run on the BB
server, so local worktrees and sandboxes behave the same.

## Approvals

Executor decides which tool calls need approval. When a call pauses, the
plugin shows a card in the thread with Approve and Decline. It sends the
answer to Executor and resumes the call. The agent sees only the result. It
cannot approve its own call.

A burst of calls shows one card at a time. A queued call opens its own card
after 30 seconds, because some harnesses give up on a slow tool after about a
minute. **Approve for this thread** approves later calls to the same tool in
that thread until the plugin restarts. **Approve all** answers every waiting
call in the thread. If nobody answers within an hour, the agent gets
Executor's approval link, and `executor_resume` waits for that decision.

## Account health

With a personal access token, the plugin reads Executor's account inventory
every ten minutes. An account whose credentials stopped working gets a BB
pop-up with a link to Executor. The pop-up stays until you dismiss it. A
second pop-up says when the account works again. Settings show the last
check's result. They do not start a check.

## Skills

Executor apps ship skills. A skill's ID is `<app>/<skill>`. The plugin lists
the skills of every app in the thread's connections. Executor's own docs are
excluded; `executor_docs` reads them.

- `catalog_search` finds skills and native capabilities available in the
  thread. An empty query lists them all.
- `catalog_read` reads `SKILL.md` or another file of one skill.

The plugin also writes skills into the roots harnesses read. Each skill gets a
folder named `catalog-<app>-<skill>`.

| Connection scope | Roots written |
| --- | --- |
| Global | `~/.agents/skills`, `~/.claude/skills` |
| Project | `<workspace>/.agents/skills`, `<workspace>/.claude/skills` for every checkout and worktree of the project |

A workspace root gets a `.gitignore` for `catalog-*`, so the copies stay out
of `git status`. A sandbox can choose its own subset of skills. Projection
reruns when skills change (checked hourly), when a mapping changes, and when a
thread starts in a new worktree.

To publish skills from a Git repository, deploy an Executor app that uses
`githubSkills` from `apps/skills`. A private repository needs a GitHub account
linked to the app.

## Native capabilities

Other BB plugins can register native capabilities: tools and skills that the
plugin itself provides. Projects decides where they are available. Assign one
globally or to a project from settings, or with
`bb catalog assign <capability> [--project <id>]`.

## Plugin calls

Another plugin's backend can run Executor code through the `executorCall` RPC
in a connection mapped to it with `--plugin <id>`. The global connections do
not apply to plugins. Plugin connections never reach threads. The caller must
be a verified SDK plugin whose ID matches the `caller` input.

Each call states `read` or `write`. A `read` call that pauses for approval is
declined at once, so a background sync never waits on a person. A `write` call
returns the paused call. `executorDecide` can decline a pause, never accept
one. Calls run one at a time per plugin, at most 30 a minute. The plugin
records caller, connection, mode, purpose, size and outcome, never content.
See them with `bb catalog executor calls --plugin <id>`.

## Moving from Catalog 0.2

Catalog 0.2 kept Git skill sources, skill sets and assignments in this plugin.
Version 0.3 removes them. Executor apps now publish skills.

`scripts/executor-skill-apps.mjs` moves the old sources. It reads the old
database read-only and prints one Executor execute script:

```sh
node scripts/executor-skill-apps.mjs ~/.bb/plugins/catalog/data.db <organization-id> > skill-apps.js
```

Run the printed script with Executor's `execute` tool. Each source becomes one
app named after it. Skills that were off stay off. Executor rejects a whole
source when one skill breaks its rules or when the source has more than 1,000
files. Then the script loads each skill folder that was on by itself, and a
broken skill drops out alone. The script reports each app's skill count. Run
it again at any time. It updates the apps in place.

Old sandbox skill choices used v1 skill IDs. Choose them again.

## Development

Run these commands inside this package:

```sh
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

The build writes `dist/` and does not reload the plugin. `npm pack` builds
first. The archive holds `dist`, the SVG, skills, docs and licenses. See
[third-party provenance](THIRD_PARTY.md) and [the package overview](PLUGIN_OVERVIEW.md).
