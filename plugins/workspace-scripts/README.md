# Scripts

Run bb.json commands and track services from thread actions.

See [the plugin overview](PLUGIN_OVERVIEW.md) for installation and optional integrations.

## Declare commands in bb.json

Add `bb.json` at the checkout root. It uses the same `scripts` and `worktree`
shape as Paseo, with optional service ports:

```json
{
  "worktree": {
    "terminals": [
      {
        "name": "Web",
        "command": "npm run dev -- --port \"$BB_PORT\""
      }
    ]
  },
  "scripts": {
    "verify": {
      "command": "npm test",
      "description": "Run the focused test suite"
    },
    "api": {
      "type": "service",
      "command": "npm run api -- --port \"$BB_PORT\"",
      "port": 4000
    }
  }
}
```

`scripts` default to one-shot commands in thread-scoped BB terminals. Services
use environment-scoped terminals and are shared by threads in that environment.
Keep services in the foreground. Scripts tracks their BB terminal, not arbitrary
detached processes.

Service wrappers and manual hooks use POSIX shell syntax. Native `.sh` hook
reruns also require Bash. One-shot commands use the machine's native shell.

`worktree.terminals` are services that start when a thread's workspace becomes
active. Autostart remains on by default. Disable it in **Settings → Scripts →
Configuration** before activating an untrusted repository. Inspecting scripts
or opening a menu does not execute them.

Services receive `HOST=127.0.0.1`. Set `port` to a number from 1 through 65535,
or reference `BB_PORT` to allocate an ephemeral loopback port. The command must
honor that value. An allocated port is released before launch; it is not reserved.
`port` is valid only on services and `worktree.terminals`, not one-shot commands.

## Native thread-actions menu

Open the thread header's **… → Scripts** submenu. It offers Run for commands,
Start or Stop for services, output commands, manual hooks and Refresh status.
There is no separate Scripts panel, rail entry, command-palette launcher or
Machine-menu shortcut. Sandboxes keeps its own Machine controls and optional
Model Gateway route display.

The submenu shows the latest terminal state, each thread's last command exit
result, and known service ports. While tracked runs are active or disconnected,
visible native action consumers refresh status about every three seconds after
the previous poll finishes. Threads in the same environment share service state.
Concurrent service starts reuse one terminal. Unknown or disconnected service
state is retained and blocks duplicate starts until the workspace reconnects.

Known ports are checked on the checkout machine's IPv4 loopback interface:
listening, not listening, or unchecked. A listener is not application health or
proof that the tracked terminal owns it. Scripts does not scan ports, infer a
server from arbitrary command output, expose a port, or depend on a preview
supervisor. Commands without a declared or allocated service port keep it unknown.

Output stays in native BB terminal sessions. Active one-shot commands can open
in the thread's Terminal panel. BB cannot open environment-scoped service
sessions from a thread surface, so Scripts offers **Copy output command** for
every tracked run instead of a dead-end Open control or another panel. Run the
copied `bb terminal output <terminal-id>` command to read its output, including
finished sessions while BB retains their scrollback. This does not restart a run.

The same operations are available from a thread terminal:

```sh
bb workspace-scripts list
bb workspace-scripts run <name>
bb workspace-scripts stop <name>
bb workspace-scripts setup
bb workspace-scripts teardown
```

Setup help is inline under **Settings → Scripts → More → Setup guide**.
Commands use the checkout machine user's permissions and can access its
credentials. Only run hooks and services from repositories you trust.

## Native lifecycle hooks

BB owns automatic `.bb-env-setup.sh` and `.bb-env-teardown.sh` execution for
provider-owned environments, including managed local worktrees and provider
sandboxes. Scripts does not duplicate that lifecycle. Attaching an existing
directory or using an agent's home is not a provider setup event.

Manual setup and teardown prefer those native files. Without a native file,
they use `worktree.setup` or `worktree.teardown` from the selected manifest.
Hook arrays run in order with fail-fast shell behavior. Manual teardown stops
tracked services in the workspace first and fails if stopping a service fails.

<details>
<summary>Paseo compatibility</summary>

`bb.json` takes precedence as a whole. `paseo.json` is read only when `bb.json`
is absent. Files are never merged. An empty `bb.json` intentionally masks the
legacy manifest. Invalid BB JSON fails instead of falling back to legacy commands.

Legacy manifests retain their existing command, service, terminal and manual
hook behavior. Service action IDs and saved service records do not change when
renaming a manifest. The BB-only `port` field is not interpreted in legacy files.

For compatibility, services export the same assigned port under `BB_PORT`,
`PASEO_PORT` and `PASEO_WORKTREE_PORT`. A reference to either legacy port variable
still allocates a port. Manual hooks retain `PASEO_SOURCE_CHECKOUT_PATH`,
`PASEO_WORKTREE_PATH` and `PASEO_BRANCH_NAME`.

</details>

## Shared preparation and optional Agents integration

Declare one preparation command and reference it from `agentSetup` in `bb.json`:

```json
{
  "scripts": {
    "prepare-tools": { "command": "./scripts/prepare-tools.sh" }
  },
  "agentSetup": {
    "script": "prepare-tools",
    "env": { "PATH": "${BB_WORKSPACE_DIR}/.tools/bin:${PATH}" }
  }
}
```

`agentSetup.script` must name a one-shot command. Its environment applies to that
command and, for an approved Agents binding, the subsequent agent process.
Running the named command from the menu uses the same staged runner in a native
terminal. `bb workspace-scripts prepare` waits for completion, returns the
command's exit code and prints bounded output. It does not require Agents.

Setup runs in the thread's actual workspace, not the provider process directory.
Environment values support `${HOME}`, `${PATH}`, `${BB_WORKSPACE_DIR}` and
`${BB_SETUP_DIR}`. HOME and PATH refer to the host process's original values.
BB_SETUP_DIR is the manifest directory, or the staged directory for a migrated
recipe. Unknown substitutions and reserved setup variables fail closed. Keep
secrets in owner configuration, not repository files. Setup requires a POSIX
host with Python 3; recipes may impose additional requirements.

Scripts settings contain native Configuration and setup help, not an agent or
workspace pairing editor. Existing startup approvals remain active. Inspect
or change them with the CLI commands below; enabling an approval does not run setup.
Only an explicitly bound, selected Agents turn gets the setup script. The optional
Agents plugin must support `AGENT_SETUP_SCRIPT` and `AGENT_SETUP_ERROR`; it waits
outside Core's short environment-hook deadline before forwarding the model prompt.

Approval is tied to the host, workspace path and recipe definition. Moving the
agent or changing the setup command/environment requires review again. It
does not freeze files used by that command: trust the workspace and review its
changes. Setup failures block the selected turn, and stopping the turn cancels
the setup process group. Recipes must be idempotent and concurrency-safe.
Ordinary scripts never install, enable or probe Agents, Browser or Sandboxes.

Preparation and approval commands, run from the intended workspace's thread:

```sh
bb workspace-scripts prepare
bb workspace-scripts agent-setup list
bb workspace-scripts agent-setup enable <agent-uuid-or-unique-slug>
bb workspace-scripts agent-setup disable <agent-uuid-or-unique-slug>
```

CLI enable explicitly approves the current workspace definition. Remove a saved
binding by UUID even if Agents is unavailable. Disabling does not uninstall tools.

Native environment setup and agent startup are different events. A native hook
can invoke the same preparation file directly. Do not make `.bb-env-setup.sh`
call `bb workspace-scripts setup`: that command selects the native hook again.
Existing agent homes do not create another native environment-setup event.

### Migrated security selections

Existing selections migrate to a saved snapshot of the standalone
`recipes/security-tools` recipe, not permission to run workspace commands.
They retain their original six sandbox-provider restrictions. New workspace
bindings have no Sandboxes dependency or provider-ID allowlist.

The recipe contains a normal `bb.json`, `setup.py` and `versions.json`. It
requires Linux x64/ARM64, Python 3 and uv. Versions, download URLs, SHA-256 checks,
the versioned cache and shared installer lock are retained. It prepares pinned
Gitleaks, Nuclei, OSV-Scanner, Semgrep and Nuclei templates; it does not run scans.
An existing selection keeps its saved recipe even if bundled examples change.
See [THIRD_PARTY.md](THIRD_PARTY.md) for upstream licenses.

The old security-only settings, CLI and host RPC are removed. No agent setup
settings UI is added to Scripts or Agents. There are no cross-package runtime
imports or startup installation requirements.

## Development

From this package directory:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Native menu sizing uses a lifecycle-owned content-script scope and Scripts'
namespaced refresh icon. This keeps native sizing, label wrapping and footer
spacing inside Scripts. Native action data alone does not retain imported CSS.
Recheck the scope and long labels when updating the host SDK.

Reload only the intended installed source with `bb plugin reload workspace-scripts`.
Do not point a live registration at a feature worktree for development.
