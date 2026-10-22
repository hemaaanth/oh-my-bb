Run repository commands and services from the thread’s machine menu.

Scripts reads `paseo.json` from the thread's checkout. It lists named commands,
long-running services and workspace setup/teardown hooks. Run a command, start
or stop a service, and open its BB terminal from Machine → Scripts. The same
actions are available through `bb workspace-scripts`.

## Setup

Install Scripts and add a `paseo.json` with a `scripts` object to a repository.
Each entry has a command and optional description; use `type: "service"` for a
long-running process. README.md includes a complete example.

Worktree terminals can start automatically when a workspace becomes active.
Control that in Settings → Scripts. Repository commands run with the current
host user's permissions and can read that environment's credentials. Only run
hooks and services from repositories you trust. BB's own environment hooks are
not duplicated by this plugin; fallback setup and teardown remain manual.

## Standalone

Scripts requires BB, not Browser or Sandboxes. It uses BB's thread-action
registry to appear beside other machine actions. It works with local workspaces
and connected remote environments. Services remain scoped to their environment.
No account, hosted service or API key is needed.
