# Agents

BB plugin for reusable, versioned full and thin agent profiles. A profile stores its identity, model level or exact Codex/Gateway pin, persona, mission settings, and optional launch defaults. Agents use one `agents` provider with a stable `agent/<profile UUID>` model per profile; Pi selects the real model for each turn.

The owner authorizes MIT publication of owned Agents and Hempi code. Separate upstream/helper licenses remain in force. Current core prompt wording is original; its [local provenance](provider/vendor/hempi/LOCAL_PATCH.md) is explicit. Publish only the reviewed current-tree snapshot, never retained private history or excluded upstream expression. Offline checks are not a native runtime or live activation receipt.

Read [setup](SETUP.md), [runtime contracts](RUNTIME_CONTRACT.md), [privacy](PRIVACY.md), [third-party notices](THIRD_PARTY.md), [package overview](PLUGIN_OVERVIEW.md), and [unreleased changes](CHANGELOG.md).

## Install from source

```sh
npm ci
npm run build
bb plugin install .
```

Open **Agents** in BB, create a profile, and optionally make it the default.

## Agent kinds

**Full** agents have a standing mission, a self-editing persona, and optional
mission schedules. Their mission and persona are injected into work. They can
read both with `agent_document_read` and update their own persona with
`agent_persona_update`.

The persona is the profile's instructions, shown as `PERSONA.md` in the
**Persona** tab. It never lives in a working folder. An agent change applies
from the next turn and appears in the thread as an **Updated persona** row.
The persona history lists every version with who made it (`You`, `@slug`, or
`Profile settings`); **Use this version** undoes a change.

OptChat conversation memory keeps what happened across turns. The persona
holds lasting lessons about how the agent works. When installed, optional
Clasi holds facts shared with other agents and threads; it is not required
to save or launch a profile. The old `MEMORY.md`
is retired: on reload it is renamed to `MEMORY.legacy.md`, and the agent is
asked to move what still matters and delete it.

**Thin** agents keep the saved identity, persona, execution settings, channel
membership, and activity tracking without mission overhead. They do not
support mission schedules, and the agent document and persona tools are
disabled; edit a thin agent's instructions in its profile. For caller-mode channel work, a thin agent uses its `files/`
directory as a scratch workspace instead of the full agent home.

Changing a full agent to thin leaves its mission file on disk but stops using
it. Changing it back to full reuses that file. A thin agent changed to full
receives a mission document if it does not already have one.

Deleting an agent is permanent and is refused after it has authored a channel
message or reserved a permanent DM. For eligible agents, deletion cancels
unfinished work, removes channel memberships, private conversations, bindings,
document history, schedule state, and the agent home; promoted visible threads
remain. Interrupted orphan cleanup is retried at startup.

## Model levels

Agents use one job-based level: **Extra high**, **High**, **Medium**, **Low**, or
**Extra low**. The execution host resolves the level and supported reasoning
effort against Hempi's unbound Pi catalog of `openai-codex/*` models on each
turn. It does not inherit the caller's model family or harness. Use **Pin
exact model** for an available `openai-codex/*` or `model-gateway/*` model and
reasoning effort. Unavailable pins and unsupported reasoning efforts fail
closed; correct an invalid saved pin in the profile editor rather than
silently running another model. Every managed turn, including an
`openai-codex/*` selection, requires the Gateway Pi extension and BB-supplied
URL/token on the execution host. Compatible registered API models can use an
exact Gateway route. Gateway owns credential and API approval policy; a route
name is not independent access consent. Native Pi auth is not a fallback.

Pi runs agent turns with full permission. The BB provider/model stay `agents`
and `agent/<UUID>` even when the profile's real model or level changes.
Agents register one catalog of profiles; create, rename, and retire refresh
that catalog without a reload. Plain **Hempi** remains a separate provider.
Its **Long memory: off/on** thread action applies on the next turn; disabling
it restores Pi native auto-compaction without deleting memory. Agent memory
is always on in the agent's DM, with native auto-compaction disabled. Manual
compaction is not exposed.

Each agent has a frozen OptChat memory key. Only its permanent DM binds it,
so the DM never compacts. Renaming its slug does not change that key.
Delegated children, sequence steps, and channel turns run without the memory
lock. They get the persona and use Pi native auto-compaction, so any number
of them run at once. A DM turn whose memory is held by another process fails
at once and names the holder.

A full agent's finished task and channel turns each leave one report in
`agent_inbox`: where it happened, what it was asked, and its final answer
(no transcript). The DM's next turn receives the unread reports before the
message, so the agent remembers that work as its own. The newest 20 are
shown and older unread ones are counted. Reports are marked read when that
DM turn goes idle; a failed turn keeps them for the next one. Thin agents
write no reports and stay stateless.

The provider starts Pi per turn and resumes the thread's native session.
A remote DM turn copies only the agent's memory profile from the primary
host, then verifies copy-back while the primary profile remains locked. Full
agents additionally use MISSION.md and the PERSONA.md document; thin agents
have no document tools. Plain Hempi thread memory stays host-local.

### Permanent DM and legacy history

Open an agent from its profile, the Agents model picker, or the Bots sidebar.
New Thread no longer includes a separate **Open agent DM** button.
`ensureAgentDm` reserves one canonical, empty
DM per profile and returns the same thread on later opens; opening does not
send a greeting or a draft. A caller-mode DM lives in the Agents home;
a fixed-project DM uses that project's default environment. **Runs in**
cannot change after a DM reservation exists; moving a permanent thread
would change its identity. A missing or deleted DM is an error, not a reason
to create a replacement.

Selecting an agent in New thread attempts to open that DM. This is
best-effort, not an atomic picker interception. A restored Agents default
leaves New thread in place with **Open DM**; leave Agents and deliberately
reselect an agent to open it. A fast keyboard Send can race the redirect,
but the server rejects an unbound Agents thread and points to the DM.
The New thread draft stays there. An offer in the DM can explicitly
**Replace DM draft** with its text, mentions, and attachment references;
the existing DM draft is never overwritten automatically.
Inside a DM the composer restores a changed agent selection. The dispatch
and provider guards reject mismatched identity even if Send races the UI.
Core provider handoff can create another thread; it cannot rebind the DM.

Old `agent-<UUID>` direct threads remain history-only, with predecessor
links recorded where available. They cannot continue through the removed
per-agent providers. `bb agents migration --json` previews the legacy
history classification and blocks unsafe migration while active work or
memory recovery is pending. An `auto` or `continue` delegation whose prior
child used a legacy provider must start a fresh child; old channel
conversations start a fresh Agents conversation rather than continuing
the removed provider. Existing browser preferences for old providers
cannot be rewritten by the plugin: select Agents instead.

Bots offers no archive action for DMs. If a DM is archived elsewhere,
Agents attempts to unarchive it on the event and on startup/open. This
is best-effort: core may already have stopped work, closed terminals,
or retired an environment. Restore failures remain visible on open or
in logs; interrupted paid work never restarts automatically.

### Avatars

Mention menus and pills render known single-codepoint emoji avatars.
FE0F presentation selectors are ignored for icon identity. Unknown text,
flags, skin-tone and ZWJ sequences use Bot. The app registers a generated
compact list at setup; it does not load the full emoji dataset. Providers
use manifest-declared SVGs for the current avatar set because the public
backend icon contract does not resolve app registrations. Run
`node scripts/generate-avatar-icons.mjs` after updating the declared subset
in that script and the manifest. Other avatars use Bot until their SVG
is declared and built. BB tints provider logos; luminance masks preserve
the emoji's interior detail. Mention icons remain full color.

### Host requirements and shared-memory recovery

- Each execution host must expose `pi` 1.2.0 or later on its worker's `PATH`.
  Use the binary directly so BB's tool-channel file descriptors survive.
- Hempi is embedded in `dist/host.js`, retaining upstream base
  `2db99a3ab1175723d022a4a348350be74fbe9824` with the local original-prompt patch.
  `HEMPI_SOURCE_SHA256` identifies exact local bytes. The worker materializes
  them under `dataDir` using both identities. An offline `--help` probe checks
  for `--role` and `--optchat-profile` to avoid duplicate loading. An auto-loaded
  Hempi must include the settlement, Gateway lookup, recovery guard and local
  patch requirements. Those flags alone do not certify version or provenance.
  No remote source checkout is needed for the bundled extension.
- Every managed turn needs the Model Gateway Pi extension and its BB-supplied
  URL and token on the execution host. Missing settings stop the turn even if
  native credentials exist. Main models and Hempi memory helpers resolve through
  the `model-gateway` provider. GPT and explicit Claude gateway pins are supported;
  the Gateway owns subscription selection, translation and API approval.
  Use `bb gateway setup host` to reconcile the execution host.
- The primary BB host must be reachable through BB's public host RPC. Its
  `OPTCHAT_HOME` (default `~/.optchat`) is authoritative for agent profiles.
  Remote agent turns override their own `OPTCHAT_HOME` with
  `dataDir/memory-transfers/<operation>/home`. They do not copy other profiles,
  the primary Pi login, or `last-profile`.
- The provider worker needs writable, persistent `HOME`, Pi agent directory,
  `dataDir` and `tempDir`. Persona files and import markers live under `dataDir`.
  Native sessions use `~/.bb/pi-bridge-sessions`, or
  `BB_PI_BRIDGE_SESSION_DIR` when set. Keep a failed turn's remote data directory:
  it may hold the only new memory.
- Remote transfers use per-turn HMAC capabilities, bounded chunks and verified
  file/manifest hashes. Only the selected profile is transferred, including hidden
  files, binary files and Git checkpoints. Symlinks and special files are rejected;
  sockets are not transferred. Logs record byte counts, not memory contents.
- Copy-back failure fails the BB turn and retains the remote copy. The next local
  or remote agent turn must recover it before running. If the host is offline,
  Pi exit is unconfirmed, or primary files changed, the turn refuses to use stale
  memory. Restore connectivity and keep both copies; do not delete the pending
  journal under primary `dataDir/agent-memory` to bypass recovery.
- Before remote launch, the primary worker atomically writes that journal and
  `remote-pending.json` inside the profile while holding the native lock. The
  marker and interrupted atomic-write files are excluded from snapshots,
  transfers and base hashes. The marker stays in place
  through installation. Even plain Pi refuses to bind it with exit 73 and names
  the retained copy and BB recovery path.
- Recovery removes the marker under the lock after verified commit, or after a
  proven pre-start cancellation. If a worker died after installation but before
  clearing the journal, a matching installed digest or durable receipt completes
  recovery without overwriting memory or requiring the remote host to be online.
- Project workspaces, CLI credentials, skills, browser tools and mounts remain
  execution-host prerequisites. BB plugin API credentials stay with their owning
  server tools; they do not need to be copied into Pi's agent directory.

After reviewing a local source change, regenerate only the retained local tree:

```sh
node scripts/refresh-hempi.mjs --local
node scripts/refresh-hempi.mjs --check
```

The explicit local mode accepts no checkout/revision argument and has no network
fallback. `REVISION` remains the upstream base, not a byte-exact upstream claim.
The build checks exact generated bytes. Do not use upstream archive refresh for
the local wording patch. Preserve its licenses, credits and patch record.


## Where agents run and what they can access

Agents default to **caller** mode. A task or delegation uses the selected
caller's project and environment. Channel and mission conversations have no
caller environment, so caller-mode agents use their Agents home (the full
agent home or a thin agent's `files/` scratch workspace). The permanent
DM also uses the agent home.

An agent can save a default project. A task with an explicit project/environment
uses that context instead; it does not rewrite the profile. Without explicit task
context, new tasks, channel replies, mission runs, and DMs use the saved project
resolution. Add `--checkout` to reuse a ready project checkout. Add
`--machine <id-or-name>` with `--checkout` to default to that machine's checkout.
An offline or unavailable saved default fails rather than silently falling back.
Once a DM is reserved, the saved **Default project** remains locked. Explicit task
context can still override it without moving the DM. Change defaults before
opening the permanent DM:

```sh
bb agents runs-in <agent> <project-id|caller> [--checkout] [--machine <id-or-name>]
```

The execution environment may be local, remote, or sandboxed. Its checkout,
environment variables, skills, credentialed tools, and credentials determine
what the agent can access. The profile and its exports store project and
optional machine IDs, but never environment variables, credentials, or
secrets. BB server APIs carry agent and channel communication across
machines, so the caller and the execution environment do not need to share a
filesystem.
Paths still belong to the machine where they are read: channel-send attachments
are uploaded from the caller's machine, while an agent publishes output from
its active Agents home or fixed-project workspace.

## CLI

```sh
bb agents list [--json]
bb agents show <agent> [--json]
bb agents kind <agent> <full|thin> [--json]
bb agents level <agent> <xhigh|high|medium|low|xlow> [--json]
bb agents runs-in <agent> <project-id|caller> [--checkout] [--machine <id-or-name>] [--json]
bb agents migration [--json]
bb agents pin <agent> --provider PROVIDER --model MODEL --reasoning LEVEL [--json]
bb agents mission <agent> [--text TEXT | --file PATH] [--version HASH] [--json]
bb agents persona <agent> [--text TEXT | --file PATH] [--version HASH] [--json]
bb agents history <agent> <MISSION.md|PERSONA.md> [--before ID] [--json]
bb agents thread members <threadId> [--json]
bb agents thread remove <threadId> <agent> [--json]
bb agents thread promote <childThreadId> [--json]
bb agents export [--json] > agents.json
bb agents import agents.json [--json]

bb agents channel list [--archived | --all] [--limit N] [--offset N] [--json]
bb agents channel create [name] [--agent AGENT]... [--mode directed|automatic] [--json]
bb agents channel show <channel> [--json]
bb agents channel invite <channel> <agent> [--json]
bb agents channel remove <channel> <agent> [--json]
bb agents channel send <channel> --text TEXT [--mode auto|steer|followup|fork] [--attach PATH]... [--reply-to ID] [--request-id UUID] [--json]
bb agents channel messages <channel> [--limit N] [--offset N] [--json]
bb agents channel search <channel> <query> [--json]
bb agents channel react <channel> <message-id> <emoji> [--remove] [--json]
bb agents channel archive <channel> [--json]
bb agents channel restore <channel> [--json]
bb agents channel delete <channel> --yes [--json]

bb agents automation list <channel> [--limit N] [--offset N] [--json]
bb agents automation create <channel> --agent AGENT --name NAME --text TEXT (--cron EXPR --timezone ZONE | --at ISO_TIME) [--enabled] [--request-id UUID] [--json]
bb agents automation update <channel> <automation-id> [--name NAME] [--text TEXT] [--cron EXPR --timezone ZONE | --at ISO_TIME] [--json]
bb agents automation pause <channel> <automation-id> [--json]
bb agents automation resume <channel> <automation-id> [--json]
bb agents automation run <channel> <automation-id> [--request-id UUID] [--json]
bb agents automation delete <channel> <automation-id> --yes [--json]

bb agents activity [--agent AGENT] [--channel CHANNEL] [--limit N] [--offset N] [--json]
bb agents job <id> [--json]
bb agents stop <job-id> [--json]
bb agents retry <job-id> [--json]
bb agents steer <job-id> [--json]
bb agents fork <job-id> [--json]
bb agents schedule <agent> --every <30m|1h|4h|1d|off> [--json]
bb agents wake <agent> [--json]
bb agents pause <agent> [--json]
bb agents resume <agent> [--json]
bb agents retire <agent> [--json]
bb agents restore <agent> [--json]
bb agents publish-image <absolute-path> [--alt TEXT] [--json]
bb agents publish-file <absolute-path> [--alt TEXT] [--json]
```

Agent selectors accept a UUID, `@slug`, or unique name. Channel selectors
accept a UUID or exact name. Every command accepts `--json`.

Channel sends default to `auto`. A busy agent queues the message as a follow-up.
Use `steer` to replace that agent's current channel task, `followup` to keep the
message queued, or `fork` to answer in a hidden parallel conversation. The
channel composer also accepts leading `/steer`, `/followup`, `/queue`, and
`/fork` commands. Queued rows offer **Send now**, **Answer in parallel**, and
**Delete**. `bb agents steer` and `bb agents fork` apply those actions to a
queued work item.

The `channel_send` agent tool accepts only `auto` and `fork`. Normal agent
requests should preserve queued delivery. A fork is allowed for an independent
parallel answer. Steering is reserved for the owner because it replaces another
running task.

Full-agent mission and persona reads return the current text. JSON output
includes the SHA-256 version. Pass that version when saving an edited copy.
Exports contain no credentials, MCP endpoints, thread history, or machine
paths. Skill and MCP server IDs are portable references; the destination BB
host or sandbox must provision them separately.

## Channel automations

Ask an agent in a channel to schedule recurring work or a one-time reminder.
The active agent and channel are inferred. Each run reads the current channel
history, model, and permissions, plus mission and persona for a full agent, then
posts the answer back to that channel with a **Scheduled** marker.

Channel schedules are real BB Automations in the Agents project. The built-in
`automations` plugin must be enabled. Their names use
`#<channel> · @<agent> · <title>`, so they remain readable in BB's Automations
page. The channel **Automations** tab supports weekday, daily, hourly, one-time,
and custom schedules, plus pause/resume, Run now, history, editing, and deletion.
Schedules created in the editor start paused unless **Start enabled** is set.

An agent can create and manage only its own schedules in channels where it is a
member. The owner can manage every channel schedule. A scheduled response and
its handoffs cannot create, update, delete, resume, or manually run automations.
A tick is skipped while that automation's previous response or handoffs remain
unfinished. Archived or deleted channels and retired or removed agents do not
fire. Pausing or deleting affects future runs; stop current work from Activity.
There are no push notifications.

## Mission schedules

Mission schedules are available only to full agents and are off by default. Set
one with `bb agents schedule @agent --every 4h`, or choose an interval on the
agent’s Mission tab. A due wake queues the same bounded mission step as **Wake
now**. Enabling or changing an interval starts its next wake from that time.
Downtime does not replay missed intervals. Paused and retired agents do not wake
on schedule. Channel replies stay available while mission work is paused.

Channel calls made from a BB thread use that thread's agent identity. Agents
can read joined channels, administer their own private state, and manage only
their own work. Only the owner can change channel membership, archive, restore,
or delete channels. `channel delete` always requires `--yes`. Attached files
are read and uploaded from the invoking machine. Publish commands work only
during an active agent channel response and only for files inside that agent's
active Agents home or fixed-project workspace.

During a channel reply, an agent can hand work to a teammate by mentioning
`@handle`. The mentioned agent answers in the channel. When every directly
addressed teammate settles, Jev decides whether the requesting agent should post
one follow-up that uses those results. If Jev is unavailable, the requesting
agent posts the follow-up by default. Returns go only to that requesting agent
and keep the existing handoff depth limits.

Jev calls use the **Jev API key** plugin setting. It drives Automatic channel
routing and these follow-up decisions. Without it, Automatic channels fall back
to the member who replied most recently, and every follow-up runs.

## Integration RPC

Other plugins call `spawnProfile` on the stable internal plugin ID
`agent-profiles` for tasks, not direct DMs. Pass an agent UUID or omit it to
use the default, plus title and prompt. A supplied project/environment is explicit
task context and overrides saved launch defaults for that task only. Omit task
context to use the saved project/checkouts/machine resolution. A task without
either context must choose a project. Delegation uses its parent's context.
`ensureAgentDm` is the sole canonical DM allocator; existing DMs do not move.
`agentsSidebar` supplies profile, DM, legacy history, and channel-owned thread IDs.

The `listProfiles` RPC discovers agents. The default profile contributes
its persona and capability policy to ordinary threads, but their chosen
provider/model remain authoritative. Agent task and channel turns use the
single Agents provider and resolve their Pi model from the profile's current
level or pin. Agent identity and OptChat memory key stay stable across
profile edits. Agent turns use full permission.

Profiles also appear in BB's mention picker. In a normal thread, `@<profile>`
joins the agent and delegates through `delegate_agent_profile` into a child,
not its DM. The parent stays the result destination; children keep their
parent link and caller environment unless Runs in pins a project. No child
result is copied to a DM. Joined agents stay available for follow-ups;
the delegation card and composer pills provide child open/promotion/removal.
On New thread, selecting an agent model opens its permanent DM.
Profile mentions retain delegation.

`channelSummaries` and `agentsSidebar` give Status Sidebar its channel and
agent rows. Agents pushes changed summaries where possible; Status Sidebar
refreshes them on reconnect. The integration is best-effort, so Agents keeps
working when Status Sidebar is absent.

Fresh installs do not seed the private `pr-review` preset or require its plugin/skill. The stable `pr-review` role RPC remains only for an already retained mapped profile or the existing evidenced legacy reconciliation. Renamed profiles keep their mapping and stored contents. Missing/deleted private roles are unavailable; Agents does not adopt a same-name user profile without legacy evidence or create a replacement. A retained mapped role keeps its optional `registerReviewThread({threadId})` callback. Other profiles make no private-plugin calls.

## Portable identity checkpoint (unreleased)

Saved profiles no longer need project membership or sandbox selection. Any valid
profile can be chosen in native project/runtime contexts allowed by native access
and independent capability consent. Creating, importing, seeding, deleting, or
promoting a profile makes no automatic global assignment writes and does not
require Projects. Channel membership and capability consent are unchanged.

The Project availability editor is removed. Default project uses native project
choices and is only a fallback for task launch. Explicit context overrides it
without rewriting saved defaults or moving DMs, homes, memory, or resumed threads.

`assignmentStatus(null)` reports the exact retained-only envelope, not empty
membership or active ownership. Old reference rows and saved sandbox selections
remain historical. Legacy mutation RPCs return `membership-retired`. See
[the retirement contract](ASSIGNMENT_HANDOFF.md) for read compatibility, unexpected
C1 recovery, deployment gates, and preserved SQL history.

The reviewed C1 recovery branch is retained, but its new destination state machine
is not shipped or activated. No new preparation/provider operations are included.
Standalone packaging, privacy and offline protocol evidence are recorded in the package documents. The owner MIT grant is recorded separately from upstream rights. Native full-shell/runtime and later preparation/consumer acceptance remain separate gates.

## Background runtime

Agents runs channel and mission work in hidden threads. Caller-mode agents use
their Agents home: new full-agent conversations use an unmanaged workspace at
the profile home and receive the current persona and `MISSION.md` before
the job prompt, while thin-agent conversations use the profile's scratch
`files/` workspace with only their saved identity and persona. Fixed-project
agents use that project's default environment for channel and mission work.

The runtime validates every managed dispatch against its registered job,
queues work while an agent is busy, follows up on the existing conversation,
and settles jobs from thread lifecycle events. Its background service retries
recoverable dispatches, wakes due missions, and removes expired draft uploads.

## Current boundary

BB's public plugin API cannot atomically intercept the core model picker,
make a thread strictly unarchivable, or migrate a historical thread's
provider. Canonical DMs are new threads; old provider threads remain
history-only. Project and sandbox profile membership is retired; retained rows
are history, not an access decision.
Execution hosts provide their own skills, credentials, and tools; profiles do not store
environment secrets or maintain a second preferred-skill/MCP list.

Existing setup integrations can contribute `AGENT_SETUP_ERROR` and an absolute `AGENT_SETUP_SCRIPT` path. An unresolved setup error fails before dispatch. With a staged script, Agents can acknowledge and retain the turn while it awaits the Python recipe before forwarding the model prompt. Recipe failure or cancellation prevents forwarding. The DM placeholder is not setup readiness. This checkpoint adds no preparation service or native-thin execution path.

### Agent settings

Define agents in **Settings → Agents**. Preferences contains the default-agent choice. The Agents section has a searchable compact list and **New agent**. Select a row or its edit icon to open the profile, mission, persona, activity and usage in a settings dialog. Saved revision checks and local unsaved drafts are retained. There is no Agents rail page. Channel invitations link to Settings for agent management; channel conversations remain on their existing surface.
