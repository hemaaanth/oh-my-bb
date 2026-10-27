# Executor

Executor gives BB agents remote Executor services and approved versioned skills.
It does not replace BB's built-in skill loader.

The display name is Executor. The plugin ID stays `catalog` and the package stays
`bb-plugin-catalog`. Existing `bb catalog` commands, `catalog_search`,
`catalog_read`, `executor_*` tools, RPC routes, storage and secret identities,
assignment IDs and `catalog-*` skill folders stay unchanged. Skills remain in
this plugin and their existing provider roots. This naming change does not move
data or introduce an identity migration.

For skills, Executor:

- subscribes to one or more HTTPS Git repositories;
- records immutable revisions and optionally holds updates for approval;
- gives every source an automatic skill set containing the skills you leave
  switched on, and lets you build custom sets that mix sources;
- owns global/project skill-set assignments after an explicit fresh
  initialization or a source-first Projects C1 handoff;
- exposes assigned skills through native `catalog_search` and `catalog_read` tools;
- projects assigned skills into the provider roots Claude Code, Codex, OMP,
  Pi, Prime Agent, Exo executors, and fx already read. Inside BB, its skill
  tools expose those skills without publishing a duplicate copy into BB's root.

Projection writes one directory per skill, named `catalog-<source>-<skill>`,
and an assignment's scope decides where those directories land:

| Assignment | Roots written |
| --- | --- |
| Global | `~/.agents/skills`, `~/.claude/skills` |
| Project | `<workspace>/.agents/skills`, `<workspace>/.claude/skills` for every checkout and bb worktree of that project |

A workspace projection is what makes scoping honest: a project-assigned skill
is available to `catalog_search` and `catalog_read` only in that project, and any harness started in
that checkout — including subagents bb never sees — discovers it through the
convention it already follows. Each workspace root also gets a `.gitignore`
holding `catalog-*` and `.gitignore`, so the copies never reach `git status`
while skills the developer writes by hand in the same root still do. Nothing
is written into a workspace that has no assigned skills.

Projected `SKILL.md` files keep their full instruction body. Executor rewrites
only the discovery frontmatter: it gives each copy a collision-safe name and a
concise routing description of at most 160 characters. This keeps provider
skill menus within their metadata budgets without losing the instructions that
are loaded when the skill is used.

The `catalog_search` and `catalog_read` tools resolve the running thread's
project. Every agent in that project sees the same approved skill set.

Projection reruns whenever sources sync, a skill is switched on or off, an
assignment changes, or a thread is created in a fresh worktree; a content
digest makes an unchanged projection a no-op, and unreachable machines are
reported rather than fatal. Project credential preparation reprojects the
machine and the workspace it prepared, so a sandbox receives the same
capability set without copying a developer's home directory.

## Configuration and Preferences

Set the Executor URL and secret API key in BB's native **Configuration**.
Executor does not duplicate those fields. **Preferences** contains optional
sources under **Oh My BB**. Agents profile toolkit scopes are off on a fresh
installation. An explicit saved false remains false. An existing agent-scoped
toolkit mapping retains the earlier opt-in until you change it.

Opening Executor reads local source, set and toolkit metadata. It does not
probe optional plugins, check remote connections, initialize assignments or
write skill folders. **Check Executor** runs connection and policy diagnostics
only when requested. The existing connection alerts remain available.

Sources and custom sets use scoped editors. New sources added through the UI
start with weekly checks off. **More** is collapsed by default and holds
assignment readiness and harness help. Unavailable assignment data is not
shown as an empty assignment list. Use **Load assignments** to request it.
Editing during a pending save keeps the newer draft through refreshes and
late responses. Save errors keep the draft.
Closing an editor returns keyboard focus to its invoking control. If that control
was removed, focus returns to an available settings control.
Edits send the saved source configuration, custom-set membership or toolkit
mapping as their baseline. A stale edit is rejected instead of restoring a
revoked choice. The draft stays open; reopen the editor to review current
values before reapplying it. Clearing a toolkit mapping remains available.
Preferences and toolkit-map writes serialize separately so a delayed earlier
save cannot overtake a later revocation.

## Assignment readiness

Opening Executor does not migrate assignments or materialize skills. A new
standalone installation needs explicit `initializeAssignmentsV1` confirmation
that no legacy assignments exist, plus native metadata confirming Projects is
not installed. A known or unreachable installed source cannot be bypassed.
Required source errors block assignment operations and materialization;
unknown references are never pruned.

After a completed handoff, Executor owns assignment reads and writes without
Projects at startup. Projects compatibility calls forward once to this plugin.
Staging is read-only. Activation requires a fresh exact source ownership
check and a durable local receipt. Reverse export includes new writes and
retained provenance, and freezes the destination until reconciliation.
See [the assignment handoff contract](ASSIGNMENT_HANDOFF.md) for the explicit
steps, compatible-release rules and rollback barriers.

## Remote Executor services

This plugin connects projects to remote MCP servers and APIs through a self-hosted
[Executor server](https://executor.sh). The remote server owns the tools.
Its connections hold OAuth tokens and API keys. Its toolkits decide which
connections and policies go together. Build and edit toolkits in the remote
Executor console. The BB plugin records which toolkits each project uses,
which toolkits each Agents profile carries into a project, and optional
toolkits for every project.

Threads with toolkits get `executor_execute`, `executor_docs`, and
`executor_resume`, with instructions naming each toolkit and its integrations.
A thread's toolkits are its agent's, then its project's, then the global ones;
the first is the default, and a `toolkit` argument picks another. Agent-scoped
toolkits apply only with the Agents source enabled in Preferences. When it is
enabled, each call asks Agents which profile the thread runs as; the check
does not rely on a cached answer. When it is off, the plugin makes no Agents call.
One call runs in one toolkit. The tools run on the BB server and call the
toolkit's MCP endpoint there, so local worktrees and sandboxes behave the same
and no Executor credential reaches the agent's machine. The same toolkits can
serve clients outside BB.

An Executor API key reaches every toolkit, so choosing the endpoint is the
scope. The plugin opens sessions with `elicitation_mode=browser`, so a call that
needs approval pauses until a person decides. It shows the pending call in
the thread with Approve and Decline, records the answer through Executor's
approval API, and resumes the call; the agent sees only the final result. If
nobody answers within an hour, or Executor cannot describe the call, the agent
gets Executor's approval link instead, and `executor_resume` waits for that
decision. Neither path lets the agent approve its own call. Executor's
`native` mode cannot replace this on a self-hosted Executor, which answers MCP
requests as plain JSON and so has no stream to ask on mid-call.

The card names the integration and account, gives the tool's own description,
lists the arguments, and says why Executor asks: a toolkit rule, or the
integration marking the tool as one that changes data. A burst of calls in one
thread shows one card at a time with the others listed under it. A queued call
opens its own card after 30 seconds, because some harnesses give up on a slow
tool after about a minute. **Approve for this thread** also approves later
calls to the same tool in that thread until the plugin restarts. **Approve
all** answers every call waiting in the thread. Bb's question shortcuts pick
Approve, Approve for this thread, Decline and Approve all, in that order.

Executor applies the most restrictive matching rule within one toolkit only. A
thread can call any of its toolkits, so when two of them treat a tool
differently the looser one decides. **Connection and policy checks** in the
plugin's settings and `bb catalog executor status` warn about such pairs,
toolkits nothing uses, and assignments whose toolkit, project or agent is gone.
The CLI also lists toolkit scopes. Edit rules in the remote Executor console.

Executor gives up on an OAuth connection after one refused refresh and says
nothing; every call through it then fails. The plugin checks every connection
every ten minutes. A connection is broken when Executor's health check says it
cannot serve calls, for example "expired" after a refused refresh. Two states
do not count. A degraded connection only failed to load its tool list, and its
calls still work. An old access token is normal, because Executor refreshes
tokens only when a call needs one. Broken connections appear in the same warnings. BB
also shows a pop-up for each one, with a link to Executor. The pop-up stays
until you dismiss it and comes back when BB opens while the connection is
still broken. A second pop-up says when it works again.

```sh
bb catalog executor configure --url https://executor.example.ts.net:8446 --key-file /path/to/handoff.env  # reads EXECUTOR_API_KEY
bb catalog executor use team --project example-project  # first toolkit is default
bb catalog executor use team --agent @example-agent     # requires Agents opt-in
bb catalog executor use shared --global          # toolkits every project gets
bb catalog executor use worker --plugin example-worker  # another plugin's backend
bb catalog executor status
bb catalog executor calls --plugin example-worker       # that plugin's call audit
```

Another plugin's backend can run remote Executor code through this plugin's
`executorCall` RPC, in a toolkit mapped to it with `--plugin <id>`. Plugin
scopes are separate: the global toolkits do not apply to them, and plugin
toolkits never reach threads. `executorCall` and `executorToolkits` require a
verified SDK plugin caller whose `pluginId` matches the supplied `caller`.
Missing or mismatched identity is rejected before toolkit lookup, queueing,
rate limits, audit, or external work. A client has no plugin toolkit identity.
Each call states `read` or `write`. A `read` call that pauses for approval is
declined at once and fails, so a background sync never waits on a person. A
`write` call returns the paused call with the tool address and arguments.
`executorDecide` allows that same verified plugin to decline, never accept.
The SDK client path (app, CLI, agents and BB) may decline with the original
caller and execution ID, but cannot accept. Generic `executorDecide` acceptance
fails before reading or consuming the pause. A background plugin's approval
URL remains available for the owner to use in the remote Executor console; this plugin cannot infer
a human decision from RPC input or client identity.

Native thread tools keep their actual `bb.ui.requestInput` approval cards.
Only a submitted native interaction can create a once/thread/all decision.
Approve-for-thread stays in memory and is lost on reload. Toolkit revocation,
Executor reconfiguration or a cancelled tool prevents a stale card or grant
from accepting. Timeout and unknown executions remain unapproved.
Calls run one at a time per plugin, at most 30 a minute, and
the plugin records caller, toolkit, mode, purpose, size, and outcome, never
content.

The key is a secret setting, kept in a mode-0600 file in the plugin's data
directory.

## Standalone development and distribution

Run these commands inside this package. No repository-root install or sibling
plugin is required:

```sh
npm ci --workspaces=false --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

The build uses the public BB CLI. It does not register, install or reload the
plugin. The exact SDK development pin remains in the lockfile. BB may report a
different bundled SDK build version; a successful build is not a live-host
certification.

`npm pack` builds first. The runtime archive contains `dist`, the SVG, this
package's skills and public documentation and grants. It excludes tests,
fixtures, local dependencies and source worktrees. The build strips absolute
build-machine paths from generated map source names and retains source content.
Inspect the archive before publishing. See [third-party provenance](THIRD_PARTY.md)
and [the package overview](PLUGIN_OVERVIEW.md). Build and pack do not authorize
an assignment handoff or a live reload.

Subscribe to a repository without assigning any of its skills:

```sh
bb catalog add upstream https://github.com/example/skills --subdirectory skills
```

The source remains enabled for update checks. Its skills arrive switched on in
the source's automatic set, but nothing reaches an agent until that set (or a
custom set containing those skills) is made available to a project. Turn individual skills off with
the switches on the source, or from the CLI:

```sh
bb catalog skills --source upstream
bb catalog disable <skill-id>
bb catalog project
```
