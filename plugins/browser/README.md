# Browser plugin

Browser owns `bb-browser`, pairing, authentication seeds, regular-profile relay, thread windows and groups, handoff, observations, guarded actions, diagnostics and runtime cleanup. It works without Sandboxes. Sandboxes keeps machine lifecycle and delivers Browser’s global settings. No BB core changes are required.

See [the plugin overview](PLUGIN_OVERVIEW.md) for supported hosts and optional integrations.

## Build and distribution

Run `npm ci`, `npm run typecheck`, `npm test`, then `npm run build` in this directory. No repository-level dependencies or sibling imports are required. `bb plugin types --check` validates the public SDK pin against your BB version. The build emits server/app/host bundles and deterministic `dist/runtime.tar`. An installed BB CLI supplies the build tool and runtime-shimmed UI packages, including production-only cold builds. The public SDK stays a type-only development dependency.

Install the plugin with BB's plugin installer after package validation. This does not install a browser or replace the local `bb-browser` command. For the CLI, unpack `dist/runtime.tar` under a dedicated runtime directory such as `/opt/bb-browser` and explicitly link its `docker/trusted-browser.mjs` as `bb-browser`. Keep runtime assets together. `bb-browser --version` reports the package version without starting a browser or importing login state. Replacing an existing runtime is a separate maintainer cutover, not a startup side effect.

Sandboxes can consume the archive in its image build. That is an optional integration; Browser does not build, install or enable that package.

The image needs Node, Brave, agent-browser, TigerVNC (Xtigervnc), xauth, Openbox, D-Bus, ImageMagick, xdotool and x11vnc. Browser workers resolve a verified standalone Node interpreter, not the embedding host's executable. Isolated sessions use one mode-0700 profile, authenticated X display and private session bus per thread. `BB_BROWSER_HEADLESS=1` is for scratch fixtures; production handoffs start headed. At most four sessions start concurrently per host. A watchdog checks process ownership and idle retention (30 minutes) every two seconds. Manual handoffs retain their session while the hold is active. Browser memory and JavaScript heaps use Chromium defaults; there is no cumulative CPU quota or summed-RSS kill threshold. Sandbox provider machine limits remain the hard host boundary. Numeric isolated waits use a local timer after normal ownership and egress checks, without connecting the general engine. They retain its existing 30-second command bound; selector and load-state waits still use the general engine.

## Migration

The extension manifest retains its exact public key and extension identity. With Sandboxes integration enabled, a versioned plugin-only RPC can copy legacy settings, token hashes, pending pairing and private cookie state once when the integration is used. It does not run at startup, delete the old store, change profile paths or relaunch an existing browser. Token values never pass through the frontend. A disconnect after migration stays disconnected. Legacy HTTP forwarding belongs to the installed Sandboxes version.

Browser checks the calling plugin and asks Sandboxes to validate a sandbox host before delivering authentication. Sandboxes owns its project and machine eligibility policy. Global Browser opt-in does not replace that host check. SSH and Browser retain separate Tailscale directories and sockets; disabling either does not stop the other's daemon.

**Deployment gate:** drain pending handoffs before unloading the old Sandboxes owner or switching its host artifact. Do not reload it while a person is using a waiting card. Browser does not claim to transfer an in-flight SDK promise between plugins. Existing profile, thread ownership and hold files remain at their original runtime paths. The maintainer owns integration and live deployment; this branch does not change live registrations.

## Connections and private handoff

The extension popup shows relay connectivity, cookie-export status and the last successful sync. It includes Sync now and Settings controls. Its settings and popup use the Pages palette, local Inter font and BB mark.

Managed native windows, including startup windows, open silently on the configured workspace (8 by default). `bb-browser layout tile` also moves legacy `special:bb-browser` windows there without changing desktop focus. Windows moved elsewhere by the user are preserved.

Pair in Settings → Browser → More → Browser connection. The extension supports the regular-profile relay and optional cookie export. New pairings leave cookie export off. Existing paired installations retain legacy export and project permissions. New isolated sessions never subscribe to later source changes. Explicit refresh requires a paused session and named seed domains. Saving a seed is explicit and private.

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

Sandboxes owns one host-network lifecycle implementation for SSH and Browser. Browser acquires persisted per-thread references through a private versioned API. Each isolated browser incarnation has a generation token. Delayed cleanup can release only its own generation, so a dead browser cannot disconnect its replacement. Only the last Browser release logs out and stops its daemon. SSH retains its own consumer and device cleanup. Identity directories and sockets remain separate because SSH and Browser can have different tailnet policies. Enrollment reuses the Sandboxes key by default, with an optional Browser override; this is a shared lifecycle owner, not one merged tailnet node. Worker reload preserves referenced daemons. Changing the Browser exit node requires all its consumers to close. New provisioning removes the auth key from the browser runtime; a managed runtime cannot start an independent fallback daemon. Old standalone Browser routing remains available without Sandboxes.

Required home egress checks exit-node health and public IP. Chromium receives only the SOCKS proxy, no direct fallback; DNS bypass, QUIC, implicit loopback bypass and non-proxied WebRTC UDP are disabled. A browser-originated request verifies the actual egress. Its result must match the configured public IP or the verified proxy probe. A required tunnel failure is an error, never a switch to direct.

Owned pages use focus emulation, not desktop focus. CDP screenshots start a 1×1 low-quality JPEG screencast while capturing the actual PNG, then stop it in `finally`. Relay viewport capture uses the browser's visible-tab API only when the target remains selected inside its owned unfocused window; it never activates or moves a tab and discards a raced capture. Other relay captures use CDP. Normal agent-browser frame/shadow-DOM behavior remains available in isolated sessions.

See [the Browser skill](skills/browser/SKILL.md) for commands, guards, explicit dialogs and the optional fast runner. The runner is disabled by default and needs per-task `--allow-model`. No paid model call is part of the regression suite.

## Verification and real external gates

Local scratch Brave fixtures exercise two different accounts on one origin, scoped handles, stale decisions, single consumption, overlays, same-node replacement, password omission, compact deltas, pause/viewer/resume and stale viewer denial. HTTP/RPC tests exercise pairing migration, private endpoint forwarding, grants, revocation and missing-plugin behavior. Builds do not install or reload live plugins.

The default suite does not start a real browser. To run only disposable headless
account and storage fixtures:

```sh
BB_TEST_REAL_BROWSER=1 BB_TEST_AUTH_BROWSER=1 npm test -- test/browser-thread-live.test.ts test/auth-state-live.test.ts
```

The Linux default executable is `/opt/brave.com/brave/brave`. For another install,
set `BB_TEST_BRAVE_EXECUTABLE` and `BB_TEST_BRAVE` to the actual Brave engine.
Do not use a daily-browser wrapper. These fixtures use private temporary profiles
and synthetic loopback sites, not your regular profile, login state or tailnet.
Native/paired-extension and production BB shell checks are separate acceptance
steps; a headless pass does not cover them.

Before deployment, run a real provider image with two simultaneous headed sessions and different fixture accounts. Verify manual OAuth/bot-check handoff through the remote BB URL, viewer expiry/reconnect/cancel, sandbox hold/release, process crash recovery and resource cleanup. Verify home public IP, DNS and WebRTC behavior on the approved Tailscale exit node, then stop its route and prove Brave fails closed. These require provider allocation, tailnet policy and approved credentials. Local fixture success is not evidence for those external gates.

## Changelog

### Public package 0.3.0

- Preserve the selected Browser implementation, including bounded native-group readiness probes, one-shot grouping and generation-scoped network cleanup.
- Disable home routing and Sandboxes integration on fresh installations. Preserve saved routing, login-sharing and migrated integration choices; explicit integration opt-outs survive reload.
- Gate sandbox preparation, settings delivery, cookie sync, private desktop opening and network acquisition on integration consent. Keep release and revocation available for cleanup.
- Use only the public SDK and package-local dependencies. Keep frontend renderer identity separate from backend RPC construction so production-only builds do not need development packages.
- Add public licensing, overview and an explicit release file list. Runtime archives include the license.
- Normalize generated virtual-source identifiers so source maps do not publish the build machine's absolute path.
- Preserve an existing session when a handoff is denied before pause; uncertain pause attempts still take the discard cleanup path.
- Keep credentials in native Configuration. Move behavior to boxed Preferences, integration consent to Oh My BB, and connection/setup disclosures to More. Import saved behavior once and remove its old native controls on the next planned reload.

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

Historical provider results belong to the private implementation, not this public-package review. They are not proof of a public cutover. This review uses disposable local Brave sessions and synthetic accounts. Provider allocation, approved home routing, production BB cards and migration activation require separate owner-authorized acceptance.

### Streaming sandbox handoff

Headed sandbox handoffs now request Sandboxes' shared VNC service for the same paused private display. The viewer uses noVNC for direct mouse, keyboard, explicit paste, full screen, and reconnection. There is no screenshot-polling input transport for this path. Done, Cancel and expiry revoke the viewer before automation resumes or the browser closes. Native/paired regular-profile and scratch headless viewers remain page-scoped; they never expose a personal desktop through VNC.


### Inline viewing

Sandbox handoffs embed the authenticated desktop directly in their compact action card. Done and Cancel still control pause/resume and revoke access. External viewing remains available. When the user asks to watch, `browser_live` opens a read-only stream and returns `::browser-live{}` for the agent to place in chat. Automation continues; server-side view-only VNC blocks keyboard, pointer and clipboard input. A handoff replaces the watch grant with interactive access. Closing a view stops streaming without closing an active browser. Watching preserves the automation viewport; interactive handoffs resize the desktop to the available viewer space. Watching retains an idle session until the view expires (fifteen minutes); archive/deletion revokes it. Local handoffs use BB attention notifications and never change the user's workspace or expose a personal desktop. Historical directives do not open new streams automatically.

### Global sandbox settings

Enable **Enable Sandboxes integration** under **Oh My BB** before managed sandbox
provisioning, streaming handoff or routing. New installs keep it, home routing and
personal-login sharing off. Upgrades preserve saved choices. An explicit
integration opt-out is retained on later reloads.

**Configuration** contains only keys and authentication-file inputs.
**Preferences** contains routing and login-sharing behavior, with collapsed Fast
tasks and Advanced groups. **More** contains boxed Browser connection and Setup
guide disclosures. Section headings have no subtitles.

Saved native behavior settings are imported into Browser preferences once.
Like Journal, the import generation retains the old controls to preserve edits.
The next planned plugin reload removes them from Configuration. Secrets and
authentication-file settings remain in their original native storage. Perform
that finishing reload only during the authorized cutover, after draining handoffs.

After opt-in, **Route sandbox browsers through home** and **Share personal logins
with sandbox browsers** apply across eligible sandbox hosts. Home routing uses the
Tailscale exit node and fails closed. Login sharing supplies a one-time seed; later
agent changes remain private. Turning sharing off removes future seeds, not cookies
already received. Connected sandbox hosts receive settings changes immediately,
with a minute retry; preparation handles new or resumed hosts.

Close owned sessions before disabling the integration. Disabling it stops new
preparation, provisioning, sync and viewer/network acquisition. It does not
silently rewrite an existing runtime to direct egress, erase logins or revoke an
in-flight browser action. Cleanup can still release old network references and
revoke a viewer. Missing Sandboxes leaves local native and paired relay use intact.

### Preferences and credential readiness

Browser user-agent and fast-task controls are ordinary Preferences rows. An empty user-agent override shows **Automatic — browser default**: its exact value depends on the browser version and execution machine. It does not set a synthetic user agent.

Fast-task options are disabled until the private API key is set in Configuration. Only a configured/not-configured boolean reaches the app. A credential change refreshes the controls. The backend also refuses enabling fast tasks or configuring a model/endpoint without a key. No paid model request runs to display settings.

The retired continuous-cookie-sync toggle, scheduled fan-out, host sync handler and local active-session import have been removed. Pairing and authentication snapshots for new sessions remain supported. Existing paired records and private snapshots are preserved; old compatibility routes are only transport for the retained pairing, not continuous sync into active sessions.

### Browser handoff replies

Handoff cards use icon actions for Done, Reply and Cancel. Details is a separate disclosure note. Reply sends bounded user context back to the waiting agent without asserting that the browser action succeeded. The browser resumes for the agent to follow that direction; its viewer grant is still revoked first. Failed viewer cleanup still prevents resumption. Done retains its explicit completion-and-verify behavior. Cancel still discards the waiting session.
