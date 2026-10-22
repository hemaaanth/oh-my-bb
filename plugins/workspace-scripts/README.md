# Scripts

See [the plugin overview](PLUGIN_OVERVIEW.md) for installation, capabilities and integration requirements.

Runs repository-declared workspace hooks, commands, and long-running services
inside BB.

## Configuration

The plugin reads `paseo.json` from the active checkout:

```json
{
  "worktree": {
    "setup": "pnpm install",
    "teardown": "docker compose down",
    "terminals": [
      {
        "name": "Web",
        "command": "pnpm dev --port \"$PASEO_PORT\""
      }
    ]
  },
  "scripts": {
    "verify": {
      "command": "pnpm test",
      "description": "Run the focused test suite"
    },
    "api": {
      "type": "service",
      "command": "pnpm dev:api --port \"$PASEO_WORKTREE_PORT\""
    }
  }
}
```

`scripts` default to one-shot `command` actions. Set `type` to `service` for a
long-running environment-scoped terminal. `worktree.terminals` are services
that start automatically after a sandbox thread is attached.

Services receive `HOST=127.0.0.1`. When a command references `PASEO_PORT` or
`PASEO_WORKTREE_PORT`, BB allocates one free local port and exports the same
value under both names. A running service is reused rather than duplicated.

## Lifecycle hooks

BB 0.43 core runs `.bb-env-setup.sh` and `.bb-env-teardown.sh` automatically on
the environment lifecycle for every provider-owned environment (managed local
worktrees and provider/cloud sandboxes alike), so this plugin no longer runs
those hooks automatically.

What remains is a **manual** setup/teardown affordance for workspaces whose
hooks BB core does not run for you — primarily `paseo.json` fallbacks. The
Scripts panel and CLI still let you re-run a hook on demand:

1. `.bb-env-setup.sh`; otherwise `paseo.json` `worktree.setup`
2. `.bb-env-teardown.sh`; otherwise `paseo.json` `worktree.teardown`

Paseo fallback hooks receive `PASEO_SOURCE_CHECKOUT_PATH`,
`PASEO_WORKTREE_PATH`, and `PASEO_BRANCH_NAME`. A manual teardown stops tracked
workspace services before running the repository hook.

## UI and CLI

Open **Machine → Scripts** to inspect hooks, run commands, start or stop
services, and open their BB terminal tabs. The Scripts panel is also available
from the thread actions menu and **Open workspace scripts** in the command palette.
The optional Sandboxes integration consumes the shared thread-action registry;
it does not require or install Sandboxes. There is no separate Scripts header icon.

Open **Settings → Scripts** to control whether declared `worktree.terminals`
services start automatically when a thread's workspace becomes active. Manual
script and service controls remain available from the Scripts panel.

The same operations are available from a thread terminal:

```bash
bb workspace-scripts list
bb workspace-scripts run <name>
bb workspace-scripts stop <name>
bb workspace-scripts setup
bb workspace-scripts teardown
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
bb plugin reload workspace-scripts
```
