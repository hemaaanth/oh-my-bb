---
name: workspace-scripts
description: Inspect and run bb.json commands, hooks and services with Scripts. Prepare workspaces and configure optional approved agent setup.
---

# Scripts

Run from a BB thread terminal. Commands act on that thread's checkout and machine.

```sh
bb workspace-scripts list
bb workspace-scripts run <name>
bb workspace-scripts stop <name>
bb workspace-scripts setup
bb workspace-scripts teardown
```

Read the checkout's `bb.json` and native hook files before running them.
`paseo.json` is a compatibility fallback only when `bb.json` is absent. Files
are not merged; invalid BB JSON fails closed. Listing and opening the native
thread header's … → Scripts submenu do not run commands. Commands use the
machine user's permissions and credentials. Task authorization is required.

- `scripts` entries default to one-shot commands in thread terminals.
- `type: "service"` uses an environment terminal; running services are reused.
- Service wrappers and manual hooks use POSIX shell syntax. Native `.sh` hook
  reruns require Bash.
- `worktree.terminals` autostart on `thread.active` unless disabled in Scripts
  Configuration. Do not activate a thread just to inspect untrusted services.
- Native `.bb-env-setup.sh` / `.bb-env-teardown.sh` take precedence over
  selected manifest's hooks. BB owns their automatic lifecycle execution.
  Scripts offers manual reruns. Manual teardown stops tracked services first.
- Services receive `HOST=127.0.0.1`. Set `port` in bb.json or reference `BB_PORT`
  to allocate one. The same value is exported under the legacy `PASEO_PORT` and
  `PASEO_WORKTREE_PORT` names; references to those names still allocate a port.
  Allocation releases the port before launch; it does not reserve it.
- Keep services in the foreground. Status follows BB terminals, not arbitrary
  daemonized processes. Known-port checks report IPv4 loopback listeners, not
  application health or ownership. Unknown ports are never guessed or exposed.
- Latest command results are thread-scoped. Services are environment-scoped,
  concurrent starts are deduplicated, and disconnected records are retained.
  Reconnect and refresh unknown service state instead of starting duplicates.

## Shared preparation and optional Agents integration

Declare `agentSetup: { "script": "<one-shot-name>", "env": { ... } }` in bb.json.
It references an existing named script; no setup is authorized by the file alone.
The environment applies to that named command and the approved agent process.
Values support `${HOME}`, `${PATH}`, `${BB_WORKSPACE_DIR}` and `${BB_SETUP_DIR}`.
Do not put secrets in the manifest. Setup uses the actual thread workspace and
requires a POSIX host with Python 3.

```sh
bb workspace-scripts prepare
bb workspace-scripts agent-setup list
bb workspace-scripts agent-setup enable <agent-uuid-or-unique-slug>
bb workspace-scripts agent-setup disable <agent-uuid-or-unique-slug>
```

`prepare` waits and propagates the command's exit code. It works without Agents.
Menu Run uses the same prepared command in a native terminal.
There is no agent/workspace editor in Scripts settings. Existing approvals remain
active. CLI enable explicitly approves the current definition. Approval is bound
to the host, workspace path and recipe digest. Changes require review.
Referenced files remain trusted workspace code; their content is not frozen.

The optional Agents startup handshake runs the staged command before forwarding
the prompt. Failures block that turn; stopping cancels its process group.
Keep preparation idempotent and concurrency-safe. A native lifecycle hook may
invoke the same preparation file directly; do not call `workspace-scripts setup`
from `.bb-env-setup.sh`, which would select itself again.

Old security selections migrate only to their saved pinned recipe and original
sandbox restrictions. They do not authorize workspace scripts. The standalone
Linux security recipe is in recipes/security-tools. Do not execute installers
or change agent approvals for validation without authorization.

Removal by saved UUID works without optional Agents discovery. No package
installs, enables or probes another at startup. See README.md for the full schema.
