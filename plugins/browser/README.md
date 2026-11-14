# Browser plugin

Browser owns `bb-browser`, pairing, authentication seeds, regular-profile relay, thread windows and groups, handoff, observations, guarded actions, diagnostics and runtime cleanup. It works without Sandboxes. Sandboxes keeps machine lifecycle and delivers Browser’s global settings. No BB core changes are required.

See [the plugin overview](PLUGIN_OVERVIEW.md) for supported hosts and optional integrations.

## Build and distribution

Run `npm ci`, `npm run typecheck`, `npm test`, then `npm run build` in this directory. No repository-level dependencies or sibling imports are required. `bb plugin types --check` validates the public SDK pin against your BB version. The build emits server/app/host bundles and deterministic `dist/runtime.tar`. An installed BB CLI supplies the build tool and runtime-shimmed UI packages, including production-only cold builds. The public SDK stays a type-only development dependency.

Install the plugin with BB's plugin installer after package validation. This does not install a browser or replace the local `bb-browser` command. For the CLI, unpack `dist/runtime.tar` under a dedicated runtime directory such as `/opt/bb-browser` and explicitly link its `docker/trusted-browser.mjs` as `bb-browser`. Keep runtime assets together. `bb-browser --version` reports the package version without starting a browser or importing login state. Replacing an existing runtime is a separate maintainer cutover, not a startup side effect.

Sandboxes can consume the archive in its image build. That is an optional integration; Browser does not build, install or enable that package.

The image needs Node, Brave, agent-browser, TigerVNC (Xtigervnc), xauth, Openbox, D-Bus, ImageMagick and xdotool. Sandboxes supplies voxl for the handoff viewer. Browser workers resolve a verified standalone Node interpreter, not the embedding host's executable. Isolated sessions use one mode-0700 profile, authenticated X display and private session bus per thread. `BB_BROWSER_HEADLESS=1` is for scratch fixtures; production handoffs start headed. At most four sessions start concurrently per host. A watchdog checks process ownership and idle retention (30 minutes) every two seconds. Manual handoffs retain their session while the hold is active. Browser memory and JavaScript heaps use Chromium defaults; there is no cumulative CPU quota or summed-RSS kill threshold. Sandbox provider machine limits remain the hard host boundary. Numeric isolated waits use a local timer after normal ownership and egress checks, without connecting the general engine. They retain its existing 30-second command bound; selector and load-state waits still use the general engine.

## Migration

The extension manifest retains its exact public key and extension identity. With Sandboxes integration enabled, a versioned plugin-only RPC can copy legacy settings, token hashes, pending pairing and private cookie state once when the integration is used. It does not run at startup, delete the old store, change profile paths or relaunch an existing browser. Token values never pass through the frontend. A disconnect after migration stays disconnected. Legacy HTTP forwarding belongs to the installed Sandboxes version.

Browser checks the calling plugin and asks Sandboxes to validate a sandbox host before delivering authentication. Sandboxes owns its project and machine eligibility policy. Global Browser opt-in does not replace that host check. SSH and Browser retain separate Tailscale directories and sockets; disabling either does not stop the other's daemon.

**Deployment gate:** drain pending handoffs before unloading the old Sandboxes owner or switching its host artifact. Do not reload it while a person is using a waiting card. Browser does not claim to transfer an in-flight SDK promise between plugins. Existing profile, thread ownership and hold files remain at their original runtime paths. The maintainer owns integration and live deployment; this branch does not change live registrations.

## Connections and private handoff

The extension popup shows relay connectivity, cookie-export status and the last successful sync. It includes Sync now and Settings controls. Its settings and popup use the Pages palette, local Inter font and BB mark.

Native BB threads each get a persistent private profile, Brave process and authenticated X display. The configured native profile name is a namespace, not a shared live profile. Their desktops stay at 1920×1080 and normal windows maximize there; dialogs keep their natural size. They never draw on the user's desktop. No-thread native and explicit existing/relay behavior remain unchanged.

Closing the last native thread session cleanly stops its owned Brave, Openbox and Xvnc. A partial session close leaves the other sessions running. Active command leases and manual holds prevent teardown. Automatic idle cleanup leaves live views and pending handoffs alone. Archive/delete and closing an idle view also retire its native processes. Profiles and first-use seed markers remain. Persistent cookies survive a clean restart; browser-session cookies may not. Normal thread shutdown does not force-kill Brave. If clean shutdown cannot be confirmed, the command fails and preserves the runtime record for cleanup.

Pair in Settings → Browser → More → Browser connection. The extension supports the regular-profile relay and optional cookie export. New pairings leave cookie export off. Existing paired installations retain legacy export and project permissions. New isolated sessions never subscribe to later source changes. Explicit refresh requires a paused session and named seed domains. Saving a seed is explicit and private.

The relay authenticates its extension and pins installation/run identity. Downstream commands use BB's authenticated CLI transport and thread context, not a public unauthenticated CDP socket. Only explicitly owned or borrowed tabs are actionable. Borrowed tabs are released, never closed. New tabs open in an unfocused thread window. Late opens are closed. Pinned tabs, existing personal groups and drag-out opt-outs are preserved. Native Brave groups label owned tabs without altering page titles. An outdated extension reports an error rather than falling back to title mutation.

Native tab grouping requires the BB Browser extension in the managed native
profile, not only in the paired regular profile. If its service worker is absent,
commands fail with `NATIVE_GROUP_EXTENSION_REQUIRED`; install or enable the current
extension in that managed profile. The native doctor's live check verifies the
browser identity and state through its diagnostic session; it does not prove this
thread-group extension prerequisite. Thread cleanup does not require grouping.

Headed isolated and native handoffs use the optional Sandboxes voxl service for the existing private display. The authenticated viewer streams H.264 and accepts mouse, keyboard and paste. Browser chrome, popups and native dialogs stay in the same session. File-chooser interception is released before handoff. Raw VNC has an owner-only Unix socket and no TCP listener. Geometry stays 1920×1080 in watch and control modes. The whole desktop scales up or down with contain fitting and letterboxing; it is never cropped or resized to the card.

Each desktop grant has one server-enforced viewer lease, including direct links. A second page cannot automatically take over. The wrapper prepares one single-use transfer ticket per ownership generation, valid no longer than the grant. Open session calls BB's public navigation API synchronously with that prepared HTTPS URL. It respects the client's browser preference and does not require a popup window handle. Standalone viewers use a prepared `noopener` link. Issuing or opening the link does not revoke inline viewing; destination ticket consumption does. The inline viewer then becomes a non-streaming **Viewing elsewhere** placeholder. Use **View here** to return explicitly, including after closing the pop-out. A failed launch leaves ownership unchanged. Fullscreen keeps the same frame and connection. Revoked workers are removed rather than left reconnecting. Done, Reply, Cancel and expiry close the viewer before resume/discard. Lost unload or polling requests never imply completion or automatic return.

Without desktop integration, handoff offers page-only controls and explains that browser chrome and OS dialogs are unavailable. Native private windows are not on the user's workspace. Regular-profile/relay and scratch headless viewers stay page-only; they never expose a personal desktop. Browser does not install, probe or enable Sandboxes at startup.

Viewer origin policy includes this server's loopback URL, configured `BB_APP_URL`
and its own connected public URL from the supported `bb connect status --json`
command. This is read only when issuing a viewer, not at startup. It does not
probe optional plugins or trust the sandbox's port-tunnel origin. Embedded
viewers declare their actual parent in the fragment; the host allowlist and
exact parent window/origin checks must both match. Page-only links are
app-relative, so local and Connect clients keep their current BB origin.

Browser records desktop cleanup ownership before calling Sandboxes. An
uncertain open is an error, not permission to offer page-only fallback.
Unconfirmed revocation keeps cleanup ownership and blocks resume; the existing
discard path stops the browser task. Explicit close and disposal retry retained
cleanup. A later successful acknowledgement releases the hold.

New native thread profiles may import the configured default state once. A durable initialized marker prevents later source revisions, missing seeds or process recovery from replacing thread sign-ins. No seed means manual login; successful login stays private to that thread. Existing legacy profile files remain untouched. No cookies, SQLite databases, Local State or keyring data are copied from the live legacy profile. `state save` and the richer explicit `identity seed` workflow remain isolated-session features, not a native export promise. Portable cookies can help, but passkeys, device-bound state and every old login cannot be transferred. Imported state is not account verification.

Migration requires draining legacy native thread records and pending handoffs with their original runtime. New commands reject live legacy records instead of attaching, killing or resizing them. Old nonconforming private/shared desktops require an explicit drained restart. Preserve old profiles and runtime artifacts for rollback. Regenerate Sandboxes' Browser runtime only from the reviewed, committed Browser source.

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

Native desktop isolation and terminal cleanup have a separate disposable Linux fixture:

```sh
BB_TEST_REAL_NATIVE=1 npm test -- test/native-desktop-live.test.ts
```

It requires this package's `bb-browser` CLI, the actual Brave engine, Xvnc,
Openbox, xauth, Python/libX11, FFmpeg and `prlimit`. Its default engine is
`/opt/brave-origin-bin/brave`; set `BB_TEST_BRAVE_EXECUTABLE` for another engine
and `BB_TEST_CHROME_WRAPPER` for its launcher environment. Do not supply a
wrapper that masks the engine's exit status.

The fixture uses temporary profiles and synthetic loopback cookies. It proves
normal engine exit, old Brave/Xvnc/Openbox PIDs gone, new PIDs on reopen, and
immediately added/changed persistent cookies retained. It also checks partial
sessions, active command leases, manual holds, lifecycle watch/archive/delete
cleanup, first-use/missing seed behavior, fresh extension grouping and physical
1920×1080 X geometry. A detached four-second FFmpeg root-pixel guard rejects
1 Hz presentation and missing fixture content before any screenshot is taken.
SDK host fixtures drive the actual CLI for lifecycle
checks; they are not rendered BB viewer proof. DOM `screen` and `outerWidth`
metrics are not physical-display proof. With `BB_THREAD_STORAGE`, it writes a
JSON receipt and page screenshot there. Successful proof uses no emergency
process cleanup.

The optional consumer-composition regression runs actual Browser and Sandboxes
implementations in separate package-local processes, connected by their RPC
contracts. Neither package imports the other or adds a dependency:

```sh
BB_TEST_SANDBOXES_SOURCE=/path/to/plugins/sandboxes npm test -- test/desktop-composition.test.ts
```

It uses only SDK/host fixtures, not provider allocation or real credentials.
Open/close acknowledgement loss must not offer fallback or resume, and cleanup
ownership must survive until a confirmed close. The default standalone suite
skips this explicitly opted-in cross-package check.

Real voxl fixtures cover 320×180 through 3840×2160 viewers and a narrow 360×640
container, with a fixed 1920×1080 stream and full corner visibility. The narrow
container letterboxes. Tiny standalone wrapper tools can overlap its upper-right
corner; embedded wrappers hide those tools. Arbitrary one-pixel containers are
not a supported scaling promise. These fixtures do not prove the deployed BB
card/panel or a real-site login.

Before deployment, run a real provider image with two simultaneous headed sessions and different fixture accounts. Verify manual OAuth/bot-check handoff through the remote BB URL, viewer expiry/reconnect/cancel, sandbox hold/release, process crash recovery and resource cleanup. Verify home public IP, DNS and WebRTC behavior on the approved Tailscale exit node, then stop its route and prove Brave fails closed. These require provider allocation, tailnet policy and approved credentials. Local fixture success is not evidence for those external gates.

## Changelog

### 0.3.2

- Prepare grant-bounded pop-out links before the click. Use the public BB navigation API without `about:blank` reservations or `WindowProxy` assumptions. Keep the old stream until consumption and clear cached links on ownership loss, expiry and session replacement.
- Avoid the bogus 1 Hz GLX refresh clock on owned native/isolated Xvnc displays with a private-only GPU VSync flag. Leave desktop-native, existing, relay and scratch headless launches unchanged. Measure animation after command detachment; focus emulation during eval is not passive motion evidence.

### 0.3.1

- Give native threads separate persistent profiles/processes/displays and seed default authentication only once. Preserve legacy profiles and reject live legacy thread attachment.
- Use one exclusive viewer lease, explicit pop-out/return and fixed 1920×1080 contain scaling. Remove overlapping mode-replacement streams. Keep desktop integration optional with an honest page-only handoff fallback.
- Accept this server's exact local/configured/Connect origins without trusting unrelated Connect users. Keep page-only links app-relative. Retain Browser cleanup ownership before desktop opens and reject fallback/resume after uncertain cleanup.
- Cleanly retire fully closed thread-native Brave, Openbox and Xvnc processes under their existing locks and leases. Preserve profiles, first-use seed markers and persistent cookies. Keep active commands, manual holds and live-view idle protection. Leave no-thread legacy/existing/relay lifecycle unchanged.

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

Headed sandbox handoffs now request Sandboxes' shared VNC service for the same paused private display. The viewer streams through voxl and supports direct mouse, keyboard, paste and reconnection. There is no screenshot-polling input transport for this path. Done, Cancel and expiry revoke the viewer before automation resumes or the browser closes. Native/paired regular-profile and scratch headless viewers remain page-scoped; they never expose a personal desktop through VNC.


### Inline viewing

Sandbox handoffs embed the authenticated desktop directly in their compact action card. Done and Cancel still control pause/resume and revoke access. External viewing remains available. Agent instructions show a `browser_live` view-only card by default when browser work starts. The agent emits `::browser-live{}` immediately in a progress message before further browser actions, then reuses that card throughout the session. Closing the card or asking for hidden browsing suppresses automatic reopening. Unavailable streaming does not enable integrations or trigger repeated viewer retries. Automation continues; server-side view-only VNC blocks keyboard, pointer and clipboard input. A handoff replaces the watch grant with interactive access. Closing a view stops streaming without closing an active browser. Watching and interactive handoffs preserve the fixed desktop resolution and fit it into the available viewer space. Watching retains an idle session until the view expires (fifteen minutes); archive/deletion revokes it. Local handoffs use BB attention notifications and never change the user's workspace. Historical directives do not open new streams automatically.

### Remote viewing on a local host

The native Brave profile can move to a private display when the user works on the local machine from another computer. `BB_BROWSER_DISPLAY` (or `<bb-browser home>/display`) chooses the placement: `auto` (the default), `desktop` or `private`. In `auto`, a bb Connect client that is connected or was active in the last five minutes selects `private`. A placement change restarts Brave only when no thread holds it or waits on a handoff. Brave restores its session after the restart, but tabs and their target IDs are not guaranteed to survive.

The private display is TigerVNC (`Xvnc` or `Xtigervnc`) with Openbox on an owner-only Unix socket. TCP is off and access needs an X authority cookie. Brave draws only on that display. It keeps the login session bus, because its cookie key is in that session's unlocked keyring. `bb-browser thread desktop [--watch]` gives Sandboxes the display. Sandboxes streams it through voxl (`~/.cargo/bin` is searched). The server's own machine has no machine credential, so its viewer port is shared with `bb connect expose` and removed with `bb connect unexpose`. Handoffs and `browser_live` embed this view the same way as a sandbox desktop. When Brave stays on the local desktop, handoffs use BB attention and never change the user's workspace.

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

### Page readiness and form filling

Use `bb-browser settle [timeout-ms]` after navigation or an action, then inspect
with `bb-browser observe`. It waits for `document.readyState === "complete"` and
200 ms without DOM mutations. The default deadline is 3,000 ms; accepted values
are 0–10,000 ms. It returns `{ready, readyState, ms, url}`. A deadline returns
`ready: false`, so callers can inspect partial state without repeating input.
Navigation that destroys the execution context can fail the command; inspect
the new page before continuing. This checks DOM readiness, not network idle or
business success. Background requests and delayed updates can continue.
It works through the existing isolated, native, attached and relay paths.

Relay `fill` uses native input setters and input/change events for controlled
inputs. It replaces textarea and contenteditable contents and supports value
controls such as dates. Disabled, readonly and non-text controls are rejected;
invalid values are checked before clearing the existing field. Guarded `act`
filling also rejects readonly and non-text controls before consuming a decision.

These improvements were informed by [dev-browser](https://github.com/SawyerHood/dev-browser)'s
explicit look → act → verify workflow, bounded load helper and form handling.
They use Browser's existing transports and add no runtime dependency.

### One local source

For local development, install Browser from this checkout's `plugins/browser`
and keep `bb-browser` linked to `docker/trusted-browser.mjs` in that package.
Load the unpacked extension from `browser-extension` in the same package.
A legacy download directory may be a symlink to that directory; avoid maintaining
another copied extension tree. After changing extension JavaScript, reload BB
Browser in the regular browser's extensions page. Browser profiles, cookies,
pairing and plugin settings remain outside Git.

Sandboxes accepts committed Browser runtime artifacts explicitly using its
package-local updater. Git push publishes source; plugin and extension reloads
activate code already on the local machine. Neither operation synchronizes
private browser data.

A paired relay can reload its own extension with
`BB_BROWSER_BACKEND=relay bb-browser extension reload`. This refuses to reload
while a handoff is paused. Its idle heartbeat keeps the MV3 worker connected.

Native thread display placement also follows `BB_BROWSER_DISPLAY=auto|desktop|private` (or the display setting file). Explicit `desktop` overrides remote presence while preserving the separate thread profile. Desktop windows stay on the configured workspace without focus changes. Only private displays support full desktop streaming; desktop placement uses page-only controls.
