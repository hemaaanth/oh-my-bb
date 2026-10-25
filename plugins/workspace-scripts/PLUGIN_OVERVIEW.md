Run bb.json commands and track services from thread actions.

Scripts reads `bb.json` from the thread's checkout. Open the thread header's
… → Scripts submenu to run commands, start or stop services, and inspect their
terminal state, last exit results and known ports. Output stays in BB terminals.
The same operations are available through `bb workspace-scripts`.

## Setup

Install Scripts and add a `bb.json` with a `scripts` object to a repository.
Entries have a command and optional description. Use `type: "service"` for a
foreground service and optional `port` or `BB_PORT` for a known port. README.md
includes a complete example. `paseo.json` remains a fallback only when `bb.json`
is absent; invalid BB JSON never falls back or merges legacy commands.

Worktree terminals can start automatically when a workspace becomes active.
Control that in Settings → Scripts. Repository commands run with the current
host user's permissions and can read that environment's credentials. Only run
hooks and services from repositories you trust. BB's own environment hooks are
not duplicated by this plugin; fallback setup and teardown remain manual.

## Standalone

Scripts requires only BB, not Browser, Sandboxes or Model Gateway. Its submenu
uses BB's native thread-action registry. There is no separate Scripts panel or
Machine-menu shortcut. Local and connected remote environments work alike.
Services stay environment-scoped and reuse tracked terminals across threads.
Known-port checks confirm a listener, not process ownership or application health.
Unknown ports are not discovered. No account, hosted service or API key is needed.

## Optional integration

Optional Agents startup preparation uses explicit stored approvals. Existing
approvals stay active without an agent/workspace editor in Scripts settings.
Inspect them with `bb workspace-scripts agent-setup list`. A POSIX host with
Python 3 and an Agents plugin with setup-script support are required.
Failure blocks the selected turn; stopping it cancels setup. Ordinary preparation
and manual commands work without Agents. No plugin is installed, enabled or
probed at startup.

Previous security-tool choices retain only their pinned recipe and original
sandbox restriction. The standalone recipe, downloads and migration are
documented in README.md. General workspace setup does not require Sandboxes.
