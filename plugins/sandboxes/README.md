# Sandboxes plugin

This built-in, opt-in plugin contributes native BB machine and environment
providers backed by Daytona, Modal, E2B, Box by ASCII, and Freestyle.
BB core owns current thread creation, host enrollment, checkout, and machine
retirement; the plugin owns vendor allocation/removal and retains compatibility
cleanup data for sandboxes created before the BB 0.43 migration.

Sandbox providers are available with **No project** selected too. These threads
use BB's personal workspace on a new sandbox. Selecting a project uses its
checkout on the sandbox instead.

Source/state migration, optional integration gates, native cleanup limits and image provenance are documented in [CONTRACTS.md](CONTRACTS.md). File-level source decisions are in [RECONCILIATION.md](RECONCILIATION.md). Synthetic tests do not certify paid provider lifecycle.

## Local editors over Tailscale

This optional integration is for a desktop that runs both BB's server and the
editor, such as Hemarchy. It shares one implementation across all six providers'
Linux sandboxes, with no public SSH ports or BB core changes. Built-in file
editing and preview continue to use BB's existing host connection.

In Settings → Sandboxes:

1. Set **Sandbox SSH Tailscale enrollment key** to a dedicated reusable, tagged,
   **non-ephemeral** auth key. Pre-approve it if device approval is enabled.
2. Set **Sandbox SSH Tailscale cleanup API key** to an API access token that can
   delete those devices. An enrollment key cannot delete devices.
3. Allow your desktop to reach the sandbox tag on TCP 22 and use Tailscale SSH
   as the sandbox's login user (`root` on stock images).
4. Turn on **Open sandbox files in local editors**. The desktop must already be
   signed in to Tailscale, with `tailscale` and `bb-app` on PATH.

Active connected sandboxes are configured on settings changes, create, and
resume. To configure a particular existing machine now:

```sh
bb sandbox ssh-setup <host-id>
bb sandbox ssh-status --json
```

Use **Open in → Zed** as usual. A plugin-managed SSH alias asks BB to resume a
sleeping machine before carrying SSH over Tailscale. Aliases and the proxy
helper live in plugin storage, included by one line in `~/.ssh/config`.
Existing manual BB SSH mappings are preserved. SSH host-key verification stays
enabled; Zed may ask you to confirm a host key on first connection.
When editing in Zed independently of a running thread, use the machine's
**Always on** switch to prevent BB's normal idle policy from suspending it.

Sandboxes owns one host-network lifecycle implementation for SSH and Browser.
Each consumer keeps separate identity state, socket, key and routing policy;
Browser cannot reroute SSH. Browser's persisted per-thread references keep its
daemon alive until the last release. Worker reload preserves referenced daemons.
Missing Tailscale binaries are downloaded with a SHA-256 check (currently 1.102.3).
Sandbox workers must run as root on Linux; custom images also need Node and tar.

The enrollment key travels only to the host worker, is used through a temporary
mode-0600 file, and is removed after enrollment. The API key stays on the BB
server. Rotate expired enrollment/API keys; enrolled devices have their own
node identity. The plugin does not change your tailnet access rules.

Machine deletion removes its Tailscale device, BB mapping, and SSH alias.
Disabling the setting stops connected daemons and revokes tracked devices.
Failed cleanup is retained and retried every five minutes, including after
restart; it never blocks provider deletion. An empty SSH `Include` can remain
after the last alias is removed.

See [auth keys](https://tailscale.com/kb/1085/auth-keys),
[Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh), and
[the device API](https://tailscale.com/api).

## Providers

Add keys in **Settings → Sandboxes → Configuration**, then enable providers in **Providers**. Open a provider’s options for region, capacity or runtime settings.
Credentials are write-only, stored as mode-`0600` files in the plugin's private
secrets directory, and never returned to the browser. Each provider owns its
provider endpoint/app options plus the provider's own image controls; the image
registry and its credentials are shared settings on the same page. The Modal
card also exposes the **Modal VM runtime** toggle. A provider’s toggle controls
whether the provider is offered for new cloud threads. Disabling a provider
never removes its backend while existing sandboxes may still need wake,
teardown, or cleanup.

`idleSleepAfter` controls automatic idle sleep for providers with durable
pause/stop support: 5, 15, or
30 minutes, 1 hour, or Never. It updates live when saved. Daytona, Box, and
Freestyle stop while preserving provider-supported disk state; E2B
pauses and can resume. Modal does not use this setting because its idle timeout
terminates the sandbox rather than pausing it. The machine popover in a thread
provides an **Always on** switch for a single suspendable sandbox machine.
It skips BB idle suspension while any threads remain on that machine. Provider
usage charges continue. Archiving the last thread still retires the machine.

The machine popover also shows the thread's model route when the Model Gateway
plugin routes the thread: the model, the upstream and account, the chain with
the current step, and the fallback cause. It reads Gateway's `thread.route`
RPC through `threadModelRoute` and hides the section when Gateway is missing or
has no route. A fallback puts an amber dot on the header icon. On a local
thread, the laptop icon opens this popover only when there is a route;
otherwise it stays a muted, inert icon.

Environment fallbacks are supported for existing installs:
`DAYTONA_API_KEY`, `BB_SANDBOX_DAYTONA_SNAPSHOT`, `MODAL_TOKEN_ID`,
`MODAL_TOKEN_SECRET`, `BB_SANDBOX_MODAL_IMAGE_NAME`,
`BB_SANDBOX_MODAL_VM_RUNTIME`, `E2B_API_KEY`, and
`BB_SANDBOX_E2B_TEMPLATE`, `BOX_API_KEY`, and `FREESTYLE_API_KEY`.


Freestyle uses the [v5 VM API](https://api.freestyle.sh/openapi.json) through
the `freestyle` 0.2 SDK. The existing `sticky` choice now uses the plan's
default stopped/paused retention policy. It is not a promise to retain disks
until archive. `persistent` requests no idle-deletion cap and no deletion
deadline. If the create response reports either limit, creation fails and the
plugin attempts to delete only that newly created VM. Both modes reject an
ephemeral VM that would be deleted on pause. Existing VM policies are not changed.
See [Freestyle lifecycle policy](https://www.freestyle.sh/docs/vms/lifecycle).

BB idleness now pauses Freestyle VMs and resumes them with `start`, preserving
memory as well as disk. New VMs allow outbound public traffic for bootstrap and
agent tools; no public inbound rule is added. Saving an API key updates subsequent
requests, including executors already returned by the backend, without a reload.
Set a provider-native bootstrap snapshot in the provider card for faster startup.
The legacy standalone snapshot publisher is not included in the supported public
release. Native Freestyle runtime and configured provider snapshot selection
remain supported; no bootstrap or snapshot-building helper is supplied.

The runtime image is built once from `docker/Dockerfile` and pushed to the
registry configured in settings. Every provider with a custom-image API pulls
that same pinned reference instead of running its own build.

## Image pipeline

`bb sandbox build-image` builds `docker/Dockerfile` locally with Docker, pushes
the tagged result to the configured registry, and registers that one pinned
reference with each provider that can consume it:

| Provider | How the reference is used |
| --- | --- |
| Daytona | snapshot created from the registry reference |
| Modal | image created from the registry reference, then published |
| E2B | template built `fromImage` on the reference |

Box and Freestyle have no custom-image API. They install the same pinned
toolchain through the portable runtime bootstrap on first boot.

The selected image pins the sandbox's bb version. When the host is upgraded,
build and activate a new sandbox image with that same version. Box and
Freestyle install the same pinned version through the portable bootstrap on
first boot.

Registry configuration is shared rather than provider-scoped:

- `imageRegistry` — repository reference without a tag, for example
  `ghcr.io/acme/bb-sandbox`
- `imageRegistryUsername` and `imageRegistryToken` — write-only registry
  credentials
- `imagePlatform` — build platform, `linux/amd64` by default

A private repository is the expected setup, and every image-capable provider
reaches one without publishing anything:

- **E2B** receives the credentials in its `fromImage` call.
- **Modal** receives them as a Modal secret attached to `fromRegistry`.
- **Daytona** authenticates per organization rather than per snapshot, so the
  plugin keeps an organization registry entry in sync through Daytona's
  `/docker-registry` API: it lists entries, creates `bb-sandbox-<host>` when
  absent, and `PATCH`es it when the stored credentials differ. Rotating the
  token in settings and rebuilding is enough; nothing needs doing in Daytona's
  dashboard.

GHCR needs a token with `write:packages` (and `read:packages` to pull) —
`gh auth refresh -h github.com -s write:packages,read:packages`, or a classic
PAT. The repository-scoped token that drives `gh` and git in a sandbox does not
carry package scopes.

The settings cards show the active reference, the toolchain inventory, build
history, and optional additional Debian packages. **Generate image** publishes
the first reference. **Refresh image** builds a new immutable tag and activates
it only after the push and provider registration succeed. Manual selection of older images and project-specific image pins have been retired. Existing machines, active provider defaults, and historical image records are retained.

The same operations are available to agents and scripts:

```bash
bb sandbox provider daytona disable
bb sandbox provider daytona enable
bb sandbox images [--provider daytona]
bb sandbox build-image [--provider daytona] [--name bb-sandbox-version]
```

`build-image` without `--provider` registers the pushed reference with every
configured image-capable provider. The build record retains its provider
registrations and image contents, so project-to-image profiles can be added
without changing provider backends.

### Sizes

Sandboxes come in four provider-agnostic sizes. A project picks one; every
backend maps it onto what its API accepts:

| Size | CPU | Memory | Disk |
| --- | --- | --- | --- |
| S | 2 | 4 GiB | 10 GiB |
| M (default) | 4 | 12 GiB | 20 GiB |
| L | 8 | 16 GiB | 40 GiB |
| XL | 16 | 32 GiB | 100 GiB |

Modal takes the size on the create call; Box rounds it
to the nearest machine class; E2B sizes by template and ignores it. Freestyle
starts at its base image or snapshot size, then grows dimensions to at least the
requested tier. Its v5 resize API uses MiB and cannot shrink any dimension, so
small tiers can receive larger resources and billing follows the actual VM size.
Plan limits can reject growth. Daytona
will not accept a size when creating from a snapshot, and some organizations
cannot resize afterwards, so a Daytona size exists only as a snapshot
registered at that size. One image push therefore registers one snapshot per
size (`bb-sandbox-<version>-s`, `-m`, `-l`, `-xl`), skipping sizes whose
per-sandbox limits the selected pool cannot meet. Every size stays on the same
image; only the registered resources differ. A copy registered into another
region with `--region` carries the region in its name.

The plugin-wide default size is a setting; a project overrides it with
`bb sandbox set-size --tier`, or from the cloud launcher's **Size** picker with
*Make … the default size for this project* ticked. A project may also pin a
Daytona region (`--region`); otherwise the configured pool is tried first and
any other pool of the same class after it, so a size the default region cannot
host still lands where it can. Launching a size with no registered snapshot
fails before any provider call and names the `register-image` command that
adds it. `bb sandbox tiers` shows every size with the images and pools that can
serve it. Goldsky Baton is intentionally not embedded
in the image: Baton coordinates repositories, local infrastructure, and
readiness after a machine starts rather than building machine images. It can be
added later as an optional image component and startup recipe for
Goldsky-specific profiles.

### Docker in a sandbox

The image installs Docker CE with compose and buildx, and installs
`bb-sandbox-docker`, which starts a daemon idempotently:

```bash
bb-sandbox-docker --wait
bb-sandbox-docker --status
```

This is best-effort: the command exits nonzero and harmlessly where the
provider forbids a daemon, and the entrypoint calls it fire-and-forget. Modal
needs the **Modal VM runtime** setting for Docker to work at all — its default
gVisor sandbox runtime cannot host a Docker daemon, and Modal's VM runtime is
the supported way to run one. The plugin passes Modal's
`experimentalOptions: { vm_runtime: true }` on sandbox creation when that
setting is enabled.

### Screenshots, recordings, and computer use

A sandbox has no screen, so anything an agent wants to show a human has to be
captured deliberately. `bb-sandbox-capture` is the one entry point, and it
prints only the artifact path so its output composes straight into a PR body:

```bash
bb-sandbox-capture url http://localhost:3000 --full-page   # rendered page
bb-sandbox-capture cmd -- pnpm test                        # a command's output
bb-sandbox-capture tape demo.tape                          # a terminal session
bb-sandbox-capture screen                                  # the whole desktop
bb-sandbox-capture window "Preferences"                    # one GUI window
bb-sandbox-capture video 10                                # an MP4 recording
```

Behind those: `agent-browser` (Vercel Labs' automation CLI, which also has
`open`, `click`, `fill`, `snapshot`, and `pdf`, and ships its own agent
instructions through `agent-browser skills get core`) drives Brave, the image's
only browser. It is internal plumbing; agents use `bb-browser` for interactive
browser work. `freeze` renders ANSI output; `vhs` plus `ttyd` records
scripted terminal sessions; and ImageMagick plus ffmpeg grab a virtual display.

`bb-sandbox-display` owns that display — Xvfb plus openbox, optionally x11vnc
so a human can watch a GUI session live:

```bash
eval "$(bb-sandbox-display start --size 1600x1000 --vnc)"
bb-sandbox-display status
```

`bb-sandbox-computer` starts cua's `computer-server` against the display, which
is full computer use: keyboard, mouse, screen, and PTY control over HTTP and
MCP.

```bash
bb-sandbox-computer start
curl -X POST http://127.0.0.1:8765/cmd \
  -H 'Content-Type: application/json' \
  -d '{"command":"screenshot","params":{}}'
```

It also serves `/mcp`, so an MCP-speaking agent can drive the desktop without
writing HTTP calls, and `/pty` endpoints for driving a terminal. cua's
telemetry and update check are disabled in the image.

Only one browser exists in the image: Brave, from Brave's own apt repository.
`AGENT_BROWSER_EXECUTABLE_PATH`, `PUPPETEER_EXECUTABLE_PATH`, and the
`chromium`, `chromium-browser`, and `google-chrome` aliases all point at it, so
agent-browser, omp's browser tool, VHS's internal headless browser, and any
Puppeteer script reuse it. Playwright and its browser downloads are no longer
installed. Use `bb-browser` for new interactive browser work. A project that
still pins Playwright should point it at Brave with
`executablePath: "/usr/bin/brave-browser"` rather than download a second
Chromium.

### Browser access

Browser behavior now belongs to the dedicated [Browser plugin](../browser/README.md).
Use `bb-browser` as the sole public interactive browser command.

Browser is available to every project. In Settings → Browser, use the global home-routing and personal-login-sharing controls.
These settings apply to every project. If Browser is absent, machine creation
still works and browser credentials are withheld.

Browser owns pairing, private authentication state, isolated sessions, native
groups, regular-profile relay, manual handoff, screenshots and home egress.
Sandboxes owns machine creation/resume and image integration.
The image consumes Browser's built `runtime.tar`; it does not contain a second
browser implementation. Build Browser before building the sandbox image.

Do not expose raw VNC for browser handoff. The Browser attention card opens its
authenticated private viewer without switching desktop focus or workspaces.

### Attaching captures


`bb-sandbox-attach` puts a capture into a pull request so it renders inline,
including on a private repository:

```bash
shot=$(bb-sandbox-capture url http://localhost:3000 --full-page)
gh pr comment --body "$(bb-sandbox-attach "$shot" --alt 'home page')"
```

It uploads to `https://uploads.github.com/user-attachments/assets` with the
`gh` token and returns a `github.com/user-attachments/assets/<uuid>` URL — the
same asset form the web UI produces when a human drags a file into a comment.
GitHub's markdown renderer rewrites it per view into a short-lived signed
`private-user-images.githubusercontent.com` URL, so viewers with repository
access see the image and nobody else can fetch it.

Committed raw URLs are not a substitute. Verified against a private repository:
the renderer leaves `raw.githubusercontent.com` and `github.com/<owner>/<repo>/raw/...`
URLs verbatim rather than proxying them, and those origins answer `404` without
the viewer's credentials, so the image is broken for everyone. GitHub's own
documentation on anonymized URLs says its Camo proxy cannot fetch an origin that
requires authentication.

The upload endpoint is undocumented. `bb-sandbox-attach` therefore checks for
HTTP 201 and fails loudly with the fallback named — commit the file to the PR
branch and link it, which any viewer with access can open even though it will
not render inline.

Workspace commands live in BB's native thread-actions menu under **Scripts**.
The Machine menu retains Sandboxes controls and optional Model Gateway routes.
Local machines keep this menu available even when Model Gateway has no observed route.

## Model access

Sandbox logins are not copied by default. Every harness uses Model Gateway
for model access in BB turns. Per-thread gateway tokens arrive in the process
environment. They are not stored in setup files.

Model Gateway is a required managed-model runtime, not an optional fallback.
Create/resume refuses to allocate or wake when that dependency is unavailable.
Gateway setup failure prevents agent-ready. Installing this package without
siblings supports configuration and status, not managed model execution.

Create and resume install missing required binaries, then reconcile the gateway
files as the sandbox user. The gateway RPC uses that host's `BB_SERVER_URL`,
not the server's loopback address. The same manifest reconciles OMP provider
metadata, main/helper roles and enabled providers, plus Pi extensions, defaults
and model scopes. Custom home-relative `PI_CODING_AGENT_DIR` is included. Managed
sessions remove native model registrations. These files keep unrelated user configuration. Conflicting unmanaged files fail
preparation instead of being overwritten.

Sandboxes never copy OMP, Claude Code, or Codex logins. New images have no
restore code for them. Upgrade disables the restore step in old entrypoints,
but it does not delete credentials already copied to an old machine.
`copyGitHubCliAuth` stays separate and remains on by default.

Direct CLI sessions outside BB do not receive gateway tokens. Disabling Model
Gateway does not create a local-login fallback. FX's no-login support and
Prime's gateway adapter must be available in the pinned adapter release before
this image is rolled out.


## GitHub access

`copyGitHubCliAuth` (on by default) signs each sandbox's `gh` in as the bb
server's own GitHub account. The plugin resolves the token with
`gh auth token`, which is the only source when `gh` keeps it in the OS keyring,
reads the account login from `~/.config/gh/hosts.yml`, and the entrypoint writes
the same `hosts.yml` a real `gh auth login` would, mode `0600`. `gh`, git over
HTTPS, and `bb-sandbox-attach` then work with nothing else configured:

```bash
gh repo clone owner/private-repo     # works
git push                             # works, via gh's credential helper
bb-sandbox-attach shot.png           # works, uploads a PR attachment
```

Precedence is explicit rather than accidental: git consults credential helpers
before `GIT_ASKPASS`, so gh's helper is installed only when no `gitToken` is
set. Configure `gitToken` when git should authenticate as a different identity
than `gh` — a deploy token, or a machine user — and the two coexist, with the
token owning git and the gh login owning `gh`.

The copied token carries every scope granted to `gh auth login` on the server,
which is broader than a purpose-scoped PAT. Set `copyGitHubCliAuth` to false to
withhold it, and prefer `gitToken` with a narrow scope when a provider should
not hold account-wide GitHub access. When `gh` is absent or signed out on the
server, the plugin copies nothing and leaves the `gitToken` path untouched.

Both credential paths are keyed off files on the sandbox's durable filesystem
rather than the creation environment, because providers replay neither the
environment nor the entrypoint arguments after a stop/start. A restarted
sandbox keeps working git and `gh` access.

## Image contents

`docker/` holds the single image definition: `Dockerfile` plus the installer
scripts it runs (`install-toolchain.sh`, `install-containers.sh`,
`install-env-managers.sh`, `install-cloud-clis.sh`, `install-agent-clis.sh`,
`install-harnesses.sh`),
`entrypoint.sh`, `preview-supervisor.mjs`, Browser's `browser-runtime.tar`
(installed as `bb-browser`), and `docker-start.sh`. The bb host
daemon is installed from npm at the server's own version through the
`BB_APP_VERSION` build argument.

The image includes bb, OMP, Claude Code, Codex CLI, FX, Pi, Prime Agent,
`fx-acp`, `nanocodex-acp`, `prime-agent-acp`, Node 22, Bun, Deno, Go,
Rust, Java, Python/uv, Git/GitHub CLI, compilers, database clients, common
debugging tools, Docker CE with compose and buildx, nix with devbox, direnv and
process-compose, the aws, kubectl, helm, doppler, and duckdb CLIs, Brave with
agent-browser and `bb-browser`, and Tailscale. It also preinstalls the shared project CLIs for
PostHog, Vercel, Railway, Notion, Slack, Grain, HubSpot, Linear, and
ClickHouse. These binaries contain no project credentials and do not advertise
capabilities to the agent; Credentials injects only the credentials
and instructions declared by the selected project profile at command time.

At startup the entrypoint idempotently enables Astra's experimental Codex
context manager with `[features.context_management] experimental_mode = true`.
It merges that setting into `/root/.codex/config.toml` without replacing other
Codex configuration, so new images and existing sandboxes repaired with
`bb sandbox upgrade` use the same setting as the bb server machine.

Daytona, Modal, E2B, reference this image directly. Box and
Freestyle install the same layers through the portable bootstrap, which embeds
the same installer scripts and skips any layer the provider will not let it
install as root.

## Upgrading harnesses and bb

One command brings the image and every live native sandbox up to the latest
Claude Code, Codex CLI, OMP, FX, Pi, Prime Agent, and the three ACP adapters,
and to the bb version this server runs:

```bash
bb sandbox upgrade --check   # report only
bb sandbox upgrade           # do it; follow with bb sandbox upgrade-status <job-id>
```

It runs on the bb server and survives the CLI returning:

1. **Check.** Latest releases from npm and GitHub, plus the server's bb
   version, against the `bb.app.version` and `bb.harness.*` labels of the
   active image. An image without those labels counts as behind.
   Check mode also probes connected hosts without installing or writing setup
   files. It reports each binary version (adapter executable SHA-256), the
   gateway setup revision, and missing/stale files. Suspended or disconnected
   machines report unknown and are never woken.
2. **Build.** Use Docker with Buildx on this BB server, the saved image contents,
   and the target BB/agent versions. Push to the configured container registry.
   No GitHub workflow, source repository, or repository token is required.
3. **Register.** Verify Browser provenance labels on the immutable pushed digest
   before provider registration and activation. Unknown/stale artifacts fail.
4. **Verify.** The native machine backends must now boot the new image. If one
   does not, the upgrade stops and says to reload the plugin.
5. **Heal.** Each live native machine is woken if asleep. Required binaries are
   installed even when an older image has none. Gateway setup files are
   reconciled and verified, then the machine goes back to sleep.
   bb itself is left alone on existing machines: replacing bb-app under a
   running daemon can strand the machine, and core owns daemon updates.
   A machine that is disconnected while active is skipped with a hint.

`--skip-image` only heals machines, `--force-image` rebuilds a current image,
and `--skip-machines` stops after the image.

Local builds use the shipped harness pins unless an explicit runtime upgrade supplies target versions. Excluded harnesses carry `disabled` labels and are not reinstalled.

Pi and Prime Agent have explicit version pins in `install-gateway-harnesses.sh`.
Prime's release archive is checked against `SHA256SUMS`; the Bookworm image
has glibc 2.36 (Prime requires at least 2.35). All adapters come from one
immutable `ADAPTERS_REF` in the public `hemaaanth/oh-my-bb` repository.
The pinned commit must contain all three adapters. `BB_SANDBOX_ADAPTERS_REF` can supply that commit
to the upgrade resolver; the local build uses the same adapter ref.
Image labels track the adapter executable SHA-256, separately from the
gateway setup revision. The installer rejects a non-commit adapter ref.


The legacy compatibility audit can still inspect pre-0.43 records from the
Settings page.

## Upgrading bb

Sandbox daemons never update themselves: a machine keeps the bb-app its image
carried until it is upgraded in place, and bb refuses a daemon whose protocol
no longer matches. After bb is upgraded on this machine, three things can be
stale at once: the active image and every live sandbox. The plugin tracks the bb-app on each of them and offers one
path through:

1. **Notice.** On load the plugin compares the bb version with the one it last
   ran under. When it changed, it logs every image and machine that is
   behind, with the command that fixes each.
2. **Audit.** `bb sandbox doctor` prints the same findings on demand, and the
   Settings page shows them in the *bb <version>* card with per-row actions.
3. **Image.** *Refresh image* (or `bb sandbox build-image`) builds and activates
   an image on the current bb. Images registered from CI report their bb-app
   from the `bb.app.version` label the Dockerfile stamps. On Daytona one
   registration covers every size, so a bb upgrade never leaves one size
   behind; the audit reports a size that the plugin default or a project
   depends on but that no active image serves, with the
   `bb sandbox register-image --provider daytona --tier <size>` that fixes it.
4. **Machines.** `bb sandbox upgrade` rebuilds the image on this bb and heals
   the agent harnesses on live machines. It does not replace bb on an existing
   machine; a machine whose daemon bb rejects is recreated from the new image
   by starting a new thread.

A sandbox whose daemon bb has already rejected fails to provision or wake within
seconds and names the image and the fix, rather than waiting out the connect
timeout.

`docker/smoke-test.sh` ships in the image as `bb-sandbox-smoke-test`. It asserts
every advertised tool resolves, that Brave renders a headless screenshot, that
`bb-browser` reports the configured user agent exactly in direct mode, and that `bb-sandbox-docker` can start a daemon which then pulls and runs a
container. Run it against a local build before pushing:

```bash
docker build -t bb-sandbox:test --build-arg BB_APP_VERSION="$(bb --version)" docker
docker run --rm --privileged bb-sandbox:test bb-sandbox-smoke-test
```

The image entrypoint consumes Git and OAuth credentials into root-only files,
removes credential values from its process environment, and then starts the
stock `bb-host-daemon`. It also starts the sandbox preview supervisor described
below.

## Durable previews

Provider sleep preserves files but stops application processes. A Connect URL
can remain registered during that time, but it has nothing to forward to until
the application server returns. Inside a sandbox, always launch and share HTTP
dev servers through the image's supervisor so the launch command is registered
on durable provider storage:

```bash
bb-sandbox-preview start \
  --port 3000 \
  --name web \
  --cwd "$PWD" \
  -- pnpm dev --host 0.0.0.0 --port 3000
```

This is the canonical sandbox preview workflow and supersedes the generic
start-a-server-then-share-it procedure. The command creates or reuses its bb
Connect share before launch, exposes its URL to the application as
`BB_PREVIEW_URL`, waits for the port, and prints the same URL. Do not start the
server separately or use bare `bb connect expose` for an HTTP preview; reserve
bare Connect exposure for one-off non-HTTP ports such as VNC. The image
entrypoint starts the supervisor on its first boot. Native machine bootstrap
runs `bb-sandbox-preview ensure` after every daemon connection, including
resume, to restore registered previews even when the provider skips the image
entrypoint. The supervisor restarts a preview after an ordinary crash.
For existing machines whose image predates `ensure`, the resume hook starts
the older supervisor command in a detached process.
This applies to Daytona stop/start and provides the same crash supervision on
E2B and Modal. The URL is necessarily unavailable while provider compute is
actually asleep.

`BB_PREVIEW_URL` is the default environment variable name. Applications can
choose their own environment contract with `--public-url-env NAME`; the
supervisor persists that choice and restores it with the preview.

Some applications deliberately accept only one loopback hostname. Keep that
application boundary intact with the optional canonical-origin adapter. The
share port must differ from the application's own port; the adapter rewrites
the internal Host, Origin, and Referer and proxies both HTTP and WebSockets:

```bash
bb-sandbox-preview start \
  --port 3001 \
  --name strict-web \
  --public-url-env DEV_SERVER_PUBLIC_ORIGIN \
  --canonical-origin http://localhost:3000 \
  -- pnpm dev --host 127.0.0.1 --port 3000
```

```bash
bb-sandbox-preview list
bb-sandbox-preview stop web
```

Specs and logs live under `/root/.bb/sandbox-previews` with root-only
permissions. `stop` removes the durable registration and terminates the full
preview process tree. Existing previews started with a detached command plus
bare `bb connect expose` cannot be inferred retroactively; register their
launch command once or recreate the sandbox using a current provider artifact.

## Commands

```bash
bb sandbox providers
bb sandbox provider <daytona|modal|e2b|box|freestyle> <enable|disable>
bb sandbox images [--provider <daytona|modal|e2b>]
bb sandbox build-image [--provider <daytona|modal|e2b>] [--name <version>] [--tier <S|M|L|XL>] [--region <id>]
bb sandbox register-image [--reference <tag>] [--provider <daytona|modal|e2b>] [--tier <S|M|L|XL>] [--region <id>]
bb sandbox tiers
bb sandbox size [--project <id>]
bb sandbox set-size --provider <provider> [--project <id>] (--tier <S|M|L|XL> | --cpu/--memory/--disk) [--region <id>]
bb sandbox list
bb sandbox show <id>
bb sandbox delete <id> --yes [--force-live-threads]
```

Create current sandboxes by selecting the configured Sandboxes environment in
BB's native New thread composer. BB core owns those machines. `list`, `show`,
and `delete` above are compatibility commands for pre-0.43 legacy records only;
they do not enumerate native BB machines. Legacy deletion refuses to destroy a
host that still has an unarchived thread unless the destructive
`--force-live-threads` override is supplied.

## Resource sizing

New sandboxes start at the project's size, else the plugin default (see
*Sizes* above). For running providers that expose guest commands or metrics, the lifecycle
worker samples CPU utilization, working memory, and available platform signals
such as load, filesystem occupancy, and cgroup OOM events every five minutes.
Configured CPU/RAM/disk is stored separately from observed usage. `bb sandbox
sizing <id>` reports the raw p95/latest values and
one of `collecting`, `underprovisioned`, `balanced`, or `overprovisioned`.
Recommendations require at least 12 samples across 20 active minutes; an
overprovisioned recommendation requires at least an hour of consistently low
pressure. This intentionally avoids interpreting a sleeping machine as an idle
workload or treating a single compilation spike as representative capacity.

## Lifecycle and cleanup

Daytona, E2B, Box, Freestyle, native machines suspend through BB
core after the configured idle interval and resume on the next turn. The plugin
reconstructs idle deadlines at startup, so a reload cannot silently leave an
already-idle machine running. A shared host is suspended only when every
unarchived thread on it is idle. Modal retains its provider-native fixed
lifetime and does not support suspension.

Native sandbox providers are ephemeral. BB core retires the machine after its
last live thread archives and invokes the provider adapter to remove the vendor
allocation. Idle and hidden threads still count as live.

Pre-0.43 records need a separate compatibility path because their provider ids
live in the plugin database rather than BB core. The legacy reaper listens for
archive/delete events, reconciles missed events on startup, and refuses cleanup
while any unarchived thread still uses the host. Once safe, it checkpoints and
retries project-source, provider, BB host, and Connect cleanup. Provider
disappearance alone never authorizes deletion of a sandbox with a live thread.

### Private remote desktops

Sandboxes provides a provider-independent VNC/noVNC service through `desktopOpenV1` and `desktopCloseV1`. An installed plugin requests a viewer for its existing private X display and thread. Browser uses this service for headed sandbox handoffs; other GUI consumers can use the same RPC. The thread's environment selects the machine explicitly. No provider-specific dashboard or shared default display is used.

The host verifies application/display process identities and the private Xauthority file. New Browser sessions use TigerVNC on an owner-only Unix socket with TCP disabled. The viewer resizes the desktop to its available space; Brave stays maximized. Existing Xvfb sessions retain the password-protected loopback x11vnc adapter until reopened. Only the authenticated HTTP/WebSocket gateway is shared through BB Connect. Each grant lasts fifteen minutes; the capability starts in the URL fragment, is exchanged for a secure HttpOnly cookie, and is removed from browser history. WebSocket origin checks and a scoped capability (HttpOnly cookie or WebSocket subprotocol) protect the live RFB stream. The subprotocol path supports embedded viewers without depending on third-party cookies. Frame ancestors include the configured BB app origin. Reconnect creates a new connection without replaying keyboard or mouse input. Consumers can request a view-only grant; x11vnc enforces view-only input restrictions on the server, including for clients that change their own JavaScript. Multiple watchers may share the same grant. Interactive access replaces the previous interactive connection.

Each active desktop grant holds its machine awake independently of browser and maintenance holds. Closing the grant releases that hold, withdraws its shared port and stops only its gateway and any VNC adapter it started. The consumer still owns the app and X display. Expiry or a dead owner also closes access. A reload revokes active viewers; drain pending handoffs before deployment. The image needs tigervnc-standalone-server, x11vnc, Xvfb and Xauthority tooling (included in the managed Linux image). The bundled noVNC source and license information is in THIRD-PARTY-NOTICES and the viewer's `/licenses` endpoint.

Sandbox agent environments receive `HOME` from the execution host user account. This applies to all catalog providers on native Sandboxes hosts, including Agents, Codex, and OMP. It also covers existing sandboxes on their next turn. Local and manually enrolled machines are unchanged. This avoids relative config and cache paths when provider launch APIs omit `HOME`.

## Settings layout

Configuration contains write-only credentials. Preferences save on change. Providers share one compact list. Runtime images opens image configuration and update review on demand. More contains the setup guide. Sandboxes has no navigation-rail page.

Nirvana support has been removed. Historical migration records remain unchanged; no machine or image history is deleted.

## First image and selectable contents

1. Add provider credentials in Configuration and choose its region/runtime in Providers.
2. Install Docker with Buildx on the BB server. Create a container registry repository and add its write credentials in Configuration.
3. Open Runtime images → Build first image. Enter the registry repository (for example `ghcr.io/your-account/bb-sandbox`) and platform.
4. Select optional tools and add extra Debian packages as tags. General defaults exclude Goldsky and HubSpot. Required only deselects every optional tool. Dependencies are visible and required while their dependents are selected.
5. Save, then Build and register image. This builds locally, pushes to your registry and registers its immutable digest for configured Daytona, Modal and E2B providers. It may incur costs. No build starts on save or view. Existing machines are unchanged.
6. Start a thread and choose a Sandboxes machine in the native composer.

The required runtime includes Node.js, BB host daemon, Git/GitHub CLI/SSH, basic OS utilities, and the verified trusted-browser/desktop stack. These underpin the supported image and connection contract. Optional agent CLIs, extra language runtimes, Docker, environment managers, cloud/data CLIs and capture/development tools are individually selectable. Package versions remain pinned in the shipped installers; this UI chooses inclusion, not arbitrary installer commands.

`image-recipe:v1` stores a versioned selection. Stale saves fail before configuration changes. The image records selected tools in `bb.image.tools`; excluded agent binaries carry `disabled` version labels. Upgrades use the same saved contents and do not reinstall excluded agent tools.

The former GitHub build-repository setting, import command and workflow dispatcher are retired. Their historical KV receipt is retained but no longer read. The image registry repository is still needed: it is the container destination, not a source-code repository.

Box and Freestyle bootstrap at launch and do not use the custom-image builder.

### Custom image instructions and Browser settings

The image builder has an inline **Custom Dockerfile instructions** editor. Its instructions extend the shipped BB runtime after the selected tools are installed. Use `RUN` to install custom tools or versions; `ENV`, `ARG`, `LABEL`, `WORKDIR`, `USER` and `SHELL` are also supported. Multiline commands use backslash continuation. `FROM`, `COPY`, `ADD`, Dockerfile heredocs and replacing the runtime entrypoint are not supported by this extension editor. Save stores the draft recipe; **Build and register image** executes it. Never put credentials in image instructions. Additional Debian packages remain available as tags. The included-tools list is collapsed initially. FX and Prime Agent each include their BB ACP adapter when selected.

Tool versions come from the shipped installers unless custom instructions replace them. Some optional installers track `latest`; selections alone do not promise reproducible package versions. The saved tool selection and custom instructions are captured together when a build starts. Custom recipes are not treated as equivalent to the standard image during update reuse checks.

Browser owns sandbox browsing, home routing, public-IP verification and personal login sharing. Sandboxes links to Browser settings and does not display duplicate controls. Retired values and the old native key remain untouched for Browser's verified migration endpoint. Browser is optional: machine creation and coding agents continue without it; managed browser identity provisioning is skipped when Browser is absent or its integration is disabled. The supported managed browser remains Brave.

### Provider credential checks

A provider without credentials has disabled setup controls. After adding credentials in Configuration, choose **Check connection** in Providers. This performs a bounded read-only list request; it creates no sandbox. Only a successful check enables the settings button and enabling that provider. A failed check keeps the controls locked. Changing credentials or Daytona's API URL invalidates the saved check. Existing running machines are not stopped or reconfigured by these UI checks. You can always turn an enabled provider off. Settings reads never contact a vendor.

Freestyle boots its public Ubuntu image when Base snapshot is blank. To use a custom image, enter an existing snapshot ID or public image slug such as `freestyle/ubuntu-sm`. A deleted or inaccessible custom snapshot must be cleared or replaced in settings; Sandboxes does not silently substitute another image.

The shared M tier requests 12 GiB of RAM. Freestyle plans capped at 8 GiB must use S in the thread’s environment options. A rejected resize removes the newly created VM.
