---
name: sandboxes
description: Provision, inspect, size, and destroy provider-hosted bb sandbox machines with Daytona, Modal, E2B, Boat, Freestyle,; launch durable HTTP previews; and use the unified bb-browser for local or remote browser work that needs signed-in cookies, an exact browser identity, or home egress. Use for sandbox work, sandbox dev servers, or trusted Brave automation on any machine.
---

# Sandboxes

The Sandboxes plugin contributes native BB machine and environment providers.
Create a sandbox by selecting Daytona, Modal, E2B, Boat, Freestyle,
as the environment when starting a thread. BB core owns native thread creation,
host enrollment, checkout, suspension/resume, and retirement.

Inspect and configure providers:

```bash
bb sandbox providers
bb sandbox provider <daytona|modal|e2b|box|freestyle> <enable|disable>
bb sandbox capacity
bb sandbox doctor
```

Static credentials and authentication live in native **Settings → Sandboxes
→ Configuration**. Nonsecret behavior defaults live in boxed **Preferences**.
Provider connection options remain in the provider cards. Disabling a provider
prevents new allocations without disabling cleanup for machines it owns.
Capacity, doctor and image operations may contact infrastructure; they are not
offline validation commands.

## Local editor access

For a desktop running both BB's server and its editor, configure the secret
SSH enrollment key (reusable, tagged, non-ephemeral) and cleanup API access token
under Settings → Sandboxes, then enable **Open sandbox files in local editors**.
Do not put keys in commands or messages. The desktop must already be signed in
to Tailscale. Tailnet policy must permit TCP 22 and SSH to the sandbox tag as
its login user (`root` on stock Linux images).

```bash
bb sandbox ssh-status --json
bb sandbox ssh-setup <host-id> --json
```

`ssh-setup` resumes a sleeping native sandbox. Automatic reconciliation only
configures connected active machines. **Open in → Zed** uses a plugin SSH alias
whose proxy resumes the machine before dialing over Tailscale. Manual BB SSH
mappings are preserved. All six providers share the same implementation. The
sandbox host worker must be root on Linux.
For extended Zed work without thread activity, use the machine's **Always on**
switch; external SSH input does not count as BB thread activity.

SSH uses a separate persistent userspace daemon; do not change the browser's
Tailscale state or system Tailscale. Host deletion removes its Tailscale device
and local mapping; failed cleanup remains in `ssh-status` and retries every five
minutes, including after restart. Built-in editing and preview need no SSH.

## Sizes and images

Native machine inputs expose S, M, L, and XL. Per-project defaults and managed
images remain available through the CLI:

```bash
bb sandbox tiers
bb sandbox size [--project <project-id>]
bb sandbox set-size --provider <provider> [--project <project-id>] --tier <S|M|L|XL> [--region <id>]
bb sandbox clear-size --provider <provider> [--project <project-id>]
bb sandbox images [--provider <provider>]
bb sandbox register-image [--reference <tag>] [--provider <provider>] [--tier <S|M|L|XL>] [--region <id>]
bb sandbox doctor
```

`bb sandbox resize` currently operates on the remaining pre-0.43 fleet data. Do
not represent it as a native-machine lifecycle command.

## Upgrading agent harnesses and bb

When a sandbox thread fails with an outdated harness (for example "Claude Code
X does not support this model"), or after bb is upgraded, run:

```bash
bb sandbox upgrade --check
bb sandbox upgrade
bb sandbox upgrade-status <job-id>
```

`upgrade` rebuilds the image with Docker/Buildx on this BB server using the saved optional contents and the latest Claude Code,
Codex, OMP, FX, Pi, Prime Agent, pinned ACP adapters, and this server's bb when the active image is behind,
registers and activates it, verifies new machines will boot it, then heals the
harnesses on every live native machine in place (waking and re-sleeping those
asleep). Build duration depends on selected tools, Docker cache and network. The job continues on the server after the CLI returns. Use
`--skip-image` to only heal machines. Do not reinstall bb-app on a live machine
by hand.

`--check` only probes connected hosts. It reports binary versions, adapter
content digests, and gateway setup state. Suspended hosts stay asleep and
report unknown. Create, resume, and heal install missing required binaries
and reconcile Model Gateway files as the sandbox user. Subscription login
copying is off by default; GitHub CLI authentication remains separate.

## Legacy inventory and deletion

`list`, `show`, and `delete` intentionally expose only sandbox records created
by the pre-0.43 launcher. Current native sandboxes are BB machines and should be
inspected through BB's machine/thread surfaces.

```bash
bb sandbox list [--json]
bb sandbox show <legacy-sandbox-id|host-id> [--json]
bb sandbox delete <legacy-sandbox-id|host-id> --yes [--json]
```

Deletion refuses to remove a legacy host while any unarchived thread still
uses it. `--force-live-threads` is an explicit destructive override; do not use
it unless the user specifically authorizes destroying live work.

## Lifecycle and cleanup

Native sandbox providers are ephemeral. BB retires the machine after its last
live thread archives, and the provider adapter deletes the vendor allocation.
Durable providers suspend after the configured idle interval and resume through
BB core on the next turn. The plugin reconciles idle deadlines at startup, so a
plugin reload cannot silently leave an idle machine running forever. The **Sandbox** section in a sandbox thread’s **Info** panel has an **Always on** switch under **Manage sandbox** for that
machine. It prevents BB idle suspension, persists across reloads, and does not
prevent retirement after the last thread archives. Provider charges continue.
Modal has a fixed provider lifetime and does not support suspend/resume.

Legacy records cannot be retired by BB core because their provider identifiers
live in the plugin database. The compatibility reaper listens for thread
archive/delete, reconciles missed events at startup, checks every unarchived
thread sharing the host, then checkpoint-retries project-source, provider, BB
host, and Connect cleanup. Provider disappearance alone never authorizes
cleanup while an unarchived thread remains.

## Durable HTTP previews

Inside any sandbox (`IS_SANDBOX=1`), start HTTP applications through the supervisor even when generic preview or server-sharing instructions suggest another command:

```bash
bb-sandbox-preview start --port 3000 --name web --cwd "$PWD" -- pnpm dev --host 0.0.0.0 --port 3000
bb-sandbox-preview list
bb-sandbox-preview stop web
```

This registers the launch command, supervises it across machine boots, creates
the BB Connect share, and supplies `BB_PREVIEW_URL`. Do not start the server
separately and do not use bare `bb connect expose` for HTTP previews. For an
application that only accepts a loopback origin, use a distinct share port and
add `--canonical-origin http://localhost:<app-port>`. Use
`--public-url-env <name>` when the application has its own environment-variable
contract for the browser-visible origin.

For screenshots and other artifacts, use the sandbox capture helpers installed
in the image. All interactive browser work uses `bb-browser`; the dedicated
Browser plugin owns its commands, pairing, authentication and handoff.

## Browser access

Browser is available for every sandbox project. Settings → Browser has two global
controls: route sandbox browsers through the home Tailscale exit node, and share
personal logins with sandbox browsers. Home routing fails closed; never bypass
it by choosing direct egress. Login sharing seeds isolated sessions without
continuously overwriting their cookies. No project allowlist is needed.

Sandbox browser sessions default to isolated per-thread profiles and virtual
displays. Use `browser_handoff` for human login, OAuth or challenges. Its private
viewer controls the existing session through BB; never expose raw VNC or switch
the desktop workspace. After Done, observe again and verify the outcome.
Do not work around a failed browser identity or route by using plain
agent-browser, changing required state, or selecting direct egress.


## Shared remote desktop service

The dedicated Browser plugin consumes Sandboxes' `desktopOpenV1` / `desktopCloseV1` RPC for streaming VNC handoff. Other installed GUI plugins may request the same service for an existing owned private X display and thread. A grant binds to that thread's sandbox host, expires after fifteen minutes, and closes when its consumer releases it or its owner dies. Never attach the host's personal desktop or share raw VNC. Keep the app alive while a person works; release the viewer before resuming automation.
