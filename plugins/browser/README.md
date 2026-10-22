# Browser plugin

See [the plugin overview](PLUGIN_OVERVIEW.md) for installation, capabilities and integration requirements.

Browser owns `bb-browser`, pairing, authentication seeds, regular-profile relay, thread windows and groups, handoff, observations, guarded actions, diagnostics and runtime cleanup. It works without Sandboxes. Sandboxes keeps machine lifecycle and delivers Browser’s global settings. No BB core changes are required.

## Build and distribution

Run `npm install`, `npm test`, `npm run typecheck`, then `npm run build` here. The build emits server/app/host bundles and deterministic `dist/runtime.tar`. Sandboxes images consume that single runtime artifact through `docker/browser-runtime.tar`; there is no second CLI implementation. Build Browser before building Sandboxes images. Install the runtime archive under `/opt/bb-browser`, with `bb-browser` pointing to `docker/trusted-browser.mjs`. Local command installation is an explicit maintainer action, not a plugin startup side effect.

The image needs Node, Brave, agent-browser, TigerVNC (Xtigervnc), xauth, Openbox, D-Bus, ImageMagick, xdotool and x11vnc. Browser workers resolve a verified standalone Node interpreter, not the embedding host's executable. Isolated sessions use one mode-0700 profile, authenticated X display and private session bus per thread. `BB_BROWSER_HEADLESS=1` is for scratch fixtures; production handoffs start headed. At most four sessions start concurrently per host. A watchdog checks aggregate browser RSS (1.5 GiB), CPU (15 CPU minutes) and idle retention (30 minutes) every two seconds. These are process watchdog limits, not a security boundary against host code. Sandbox provider machine limits remain the hard host boundary.

## Migration

The extension manifest retains its exact public key and extension identity. Old `/api/v1/plugins/sandboxes/http/cookie-sync/*` paths forward privately to Browser. A versioned plugin-only RPC copies legacy settings, token hashes, pending pairing and private cookie state once. It does not delete the old store, change profile paths, relaunch an existing browser or change grants. Token values never pass through the frontend. A disconnect after migration stays disconnected.

Legacy project allowlists remain effective. Per-project Enable browser access switches can override them. Every project on a shared machine must be eligible before authentication is delivered. If Browser is missing, Sandboxes still creates machines and clears old browser provisioning without sending credentials. SSH and Browser retain separate Tailscale directories and sockets; disabling either does not stop the other's daemon.

**Deployment gate:** drain pending handoffs before unloading the old Sandboxes owner or switching its host artifact. Do not reload it while a person is using a waiting card. Browser does not claim to transfer an in-flight SDK promise between plugins. Existing profile, thread ownership and hold files remain at their original runtime paths. The maintainer owns integration and live deployment; this branch does not change live registrations.

## Connections and private handoff

The extension popup shows relay connectivity, cookie-export status and the last successful sync. It includes Sync now and Settings controls. Its settings and popup use the Pages palette, local Inter font and BB mark.

Managed native windows, including startup windows, open silently on the configured workspace (8 by default). `bb-browser layout tile` also moves legacy `special:bb-browser` windows there without changing desktop focus. Windows moved elsewhere by the user are preserved.

Pair in Settings → Browser. The extension supports the regular-profile relay and optional cookie export. New pairings leave cookie export off. Existing paired installations retain legacy export and project permissions. New isolated sessions never subscribe to later source changes. Explicit refresh requires a paused session and named seed domains. Saving a seed is explicit and private.

The relay authenticates its extension and pins installation/run identity. Downstream commands use BB's authenticated CLI transport and thread context, not a public unauthenticated CDP socket. Only explicitly owned or borrowed tabs are actionable. Borrowed tabs are released, never closed. New tabs open in an unfocused thread window. Late opens are closed. Pinned tabs, existing personal groups and drag-out opt-outs are preserved. Native Brave groups label owned tabs without altering page titles. An outdated extension reports an error rather than falling back to title mutation.

Native tab grouping requires the BB Browser extension in the managed native
profile, not only in the paired regular profile. If its service worker is absent,
commands fail with `NATIVE_GROUP_EXTENSION_REQUIRED`; install or enable the current
extension in that managed profile. The native doctor's live check verifies the
browser identity and state through its diagnostic session; it does not prove this
thread-group extension prerequisite. Thread cleanup does not require grouping.

Headed sandbox handoffs use Sandboxes' shared x11vnc/noVNC service for the existing private display. The authenticated, expiring viewer streams desktop updates and accepts direct mouse and keyboard input, explicit paste, and full screen. Browser chrome, popup windows and native file dialogs remain in the same session. A private session bus keeps activated dialogs off the user's desktop; file-chooser interception is released before handoff. Raw VNC uses an owner-only Unix socket with TCP disabled. The private desktop follows the viewer size and Brave starts maximized. Existing Xvfb sessions must be closed and reopened to gain resizing. Done, Cancel and expiry revoke access before resume/discard. An unconfirmed revocation discards the browser instead of resuming it. Viewer disconnect does not complete a handoff.

Regular-profile/native and scratch headless sessions retain page-only viewing; they never expose a personal desktop. ImageMagick/xdotool private-display commands remain diagnostic plumbing, rather than the streaming sandbox handoff transport.

## Routing and no-focus behavior

Sandboxes owns one host-network lifecycle implementation for SSH and Browser. Browser acquires persisted per-thread references through a private versioned API. Only the last Browser release logs out and stops its daemon. SSH retains its own consumer and device cleanup. Identity directories and sockets remain separate because SSH and Browser can have different tailnet policies. Enrollment reuses the Sandboxes key by default, with an optional Browser override; this is a shared lifecycle owner, not one merged tailnet node. Worker reload preserves referenced daemons. Changing the Browser exit node requires all its consumers to close. New provisioning removes the auth key from the browser runtime; a managed runtime cannot start an independent fallback daemon. Old standalone Browser routing remains available without Sandboxes.

Required home egress checks exit-node health and public IP. Chromium receives only the SOCKS proxy, no direct fallback; DNS bypass, QUIC, implicit loopback bypass and non-proxied WebRTC UDP are disabled. A browser-originated request verifies the actual egress. Its result must match the configured public IP or the verified proxy probe. A required tunnel failure is an error, never a switch to direct.

Owned pages use focus emulation, not desktop focus. CDP screenshots start a 1×1 low-quality JPEG screencast while capturing the actual PNG, then stop it in `finally`. Relay viewport capture uses the browser's visible-tab API only when the target remains selected inside its owned unfocused window; it never activates or moves a tab and discards a raced capture. Other relay captures use CDP. Normal agent-browser frame/shadow-DOM behavior remains available in isolated sessions.

See [the Browser skill](skills/browser/SKILL.md) for commands, guards, explicit dialogs and the optional fast runner. The runner is disabled by default and needs per-task `--allow-model`. No paid model call is part of the regression suite.

## Verification and real external gates

Local scratch Brave fixtures exercise two different accounts on one origin, scoped handles, stale decisions, single consumption, overlays, same-node replacement, password omission, compact deltas, pause/viewer/resume and stale viewer denial. HTTP/RPC tests exercise pairing migration, private endpoint forwarding, grants, revocation and missing-plugin behavior. Builds do not install or reload live plugins.

Before deployment, run a real provider image with two simultaneous headed sessions and different fixture accounts. Verify manual OAuth/bot-check handoff through the remote BB URL, viewer expiry/reconnect/cancel, sandbox hold/release, process crash recovery and resource cleanup. Verify home public IP, DNS and WebRTC behavior on the approved Tailscale exit node, then stop its route and prove Brave fails closed. These require provider allocation, tailnet policy and approved credentials. Local fixture success is not evidence for those external gates.

## Changelog

- Extract Browser from Sandboxes with private idempotent migration and old endpoint forwarding.
- Add isolated per-thread profiles/displays and a private remote manual viewer.
- Add paired-profile relay, native groups, owned/borrowed targets and run identity.
- Add drawing-session captures, explicit JavaScript dialogs and bounded diagnostics.
- Add compact/delta observations, one-use guarded actions and an opt-in bounded fast runner.
- Add full private-display handoff, serialized manual input, and verified Node worker execution.
- Share host-network lifecycle code with persisted Browser consumers while preserving separate SSH routing identities.

Upstream mechanism attribution: [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).

### Verified authentication seeds

Isolated sessions import localStorage and optional named IndexedDB databases using an inert, intercepted page. Site code does not run in that import page. Values and cookies are read back before the import succeeds. Existing origin tabs are not frozen; close them before explicitly replacing a seed.

```sh
bb-browser state save work --indexed-db login --account-check '{"url":"https://example.com/account","selector":"#account-email","expected":"alice@example.com"}'
# In the destination session, while paused:
bb-browser identity seed work example.com
```

Account checks load the real account page after import and require exact trimmed text on its origin. Missing checks do not imply verified account identity. Failed imports block automation; after manual recovery, `identity verify` reruns supplied checks. Without checks, retry the seed or discard the session. Database capture is opt-in per name, current-origin only, JSON-only, with no auto-increment stores. Limits: 8 databases, 32 stores/indexes, 1,000 records per store, 2 MiB per seed. This does not clone a browser profile or export device-bound credentials. Cookie-only legacy seeds remain supported. These options apply to isolated sessions.

Browser enrollment uses the existing Sandboxes Tailscale enrollment key by default. Browser's key and private-file settings are optional overrides. A reusable ephemeral key allows automatic enrollment without per-sandbox login and removes offline test identities; pre-approval matters only when tailnet device approval is enabled. The shared lifecycle service still preserves separate SSH and Browser node identities per host to isolate routing policy. Threads reuse the host's Browser identity.

Provider acceptance (2026-10-22): two actual headed Brave sessions on a disposable Daytona machine passed account isolation, desktop input, pause/resume, stale viewer rejection, crash recovery, hold retention and owned-process cleanup. Home routing matched the workstation's IPv4 and IPv6. Packet capture exposed direct WebRTC STUN despite the launch flag; proxied isolated profiles now enforce `webrtc.ip_handling_policy` before launch as well. DNS/STUN capture and tunnel-stop rejection passed after that fix. Fresh-key enrollment, restart-persisted references and last-release logout/stop passed. Full production BB card/migration activation still requires deploying the refactor.

### Streaming sandbox handoff

Headed sandbox handoffs now request Sandboxes' shared VNC service for the same paused private display. The viewer uses noVNC for direct mouse, keyboard, explicit paste, full screen, and reconnection. There is no screenshot-polling input transport for this path. Done, Cancel and expiry revoke the viewer before automation resumes or the browser closes. Native/paired regular-profile and scratch headless viewers remain page-scoped; they never expose a personal desktop through VNC.


### Inline viewing

Sandbox handoffs embed the authenticated desktop directly in their compact action card. Done and Cancel still control pause/resume and revoke access. External viewing remains available. When the user asks to watch, `browser_live` opens a read-only stream and returns `::browser-live{}` for the agent to place in chat. Automation continues; server-side view-only VNC blocks keyboard, pointer and clipboard input. A handoff replaces the watch grant with interactive access. Closing a view stops streaming without closing an active browser. Watching preserves the automation viewport; interactive handoffs resize the desktop to the available viewer space. Watching retains an idle session until the view expires (fifteen minutes); archive/deletion revokes it. Local handoffs use BB attention notifications and never change the user's workspace or expose a personal desktop. Historical directives do not open new streams automatically.

### Global sandbox settings

Browser is available in all sandbox projects. Settings → Browser has two global
controls: **Route sandbox browsers through home** and **Share personal logins
with sandbox browsers**. Home routing uses the Tailscale exit node and fails
closed; disabling it explicitly selects direct egress. Login sharing supplies a
one-time authentication seed to isolated sessions. Turning sharing off removes
future seeds; existing sessions retain their cookies. Connected sandbox hosts
receive changes immediately, with a minute retry for unavailable hosts. New and
resumed machines receive the same settings during preparation. Old project
grants no longer restrict browser access.
