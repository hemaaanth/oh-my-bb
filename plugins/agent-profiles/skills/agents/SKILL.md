---
name: agents
description: Work with persistent BB agents and shared channels. Inspect agents, create channels, invite members, send requests, collect attributed replies, read history, react, and publish files through native tools and bb agents commands.
---

# Agents and channels

Use `bb agents --help` for installed profile commands. Use `--json` for automation.
Resolve agent identities before changing profiles:

```sh
bb agents list --json
bb agents show @researcher --json
bb agents runs-in @researcher <project-id|caller> [--checkout] [--machine <id-or-name>] --json
```

Agent selectors accept a UUID, `@slug`, or unique name. For full agents, use
`bb agents mission`, `bb agents memory`, and `bb agents history` to inspect or
update standing documents. Pass the current document version when saving edited
text.

When the owner changes execution, use `bb agents level <agent> <level>` for
the Codex-only Pi model tier. Use `bb agents pin` only when the owner asks
for an exact available `openai-codex/*` or `model-gateway/*` model and
reasoning effort. Invalid or unavailable pins and unsupported efforts fail closed;
correct the saved pin before running that agent. A compatible exact Gateway route
is separate from choosing another native harness.
Use `bb agents runs-in <agent> <project-id|caller>` only when the owner asks
to change saved launch defaults, and before a permanent DM is reserved. Add
`--checkout` to use the project's checkout. Add `--machine <id-or-name>` with
`--checkout` to default to that machine. An unavailable saved default fails closed.
After reservation the saved default is locked; existing DMs do not move.
Explicit task project/environment overrides these defaults for that task only.
Without an explicit task context, saved resolution is unchanged. Caller mode uses
the caller's selected environment for tasks and the Agents home for DM, channel,
or mission work. Profiles store project and optional machine IDs, not secrets.

Saved profiles are portable. Do not pair them to projects or sandbox selections.
Native project/runtime access and independent capability consent still apply.
Old membership metadata is retained history; membership mutation RPCs are retired.

All agents use one `agents` provider and stable `agent/<UUID>` model IDs.
Pi resolves the real model on the execution host. Only the agent's DM
binds its frozen OptChat memory key, even after a slug rename, and disables
native auto-compaction. Delegated children, sequence steps, and channel
turns do not take the memory lock, so many run in parallel. A full agent's
finished task and channel answers reach its DM's next turn as reports it
remembers as its own; thin agents stay stateless. Full agents also use
MISSION.md and PERSONA.md; thin agents do not have document tools. Agent
turns always use full permission. Keep the native provider `agents` and the
profile's `agent/<UUID>` model identity. Do not replace that binding with another
native provider or plain Hempi. Plain Hempi threads retain their own
**Long memory: on/off** action, effective on the next turn.

Both full and thin execution require Pi with the supported settlement protocol
and configured Model Gateway on the execution host. Missing Gateway URL/token
fails before model dispatch; native Pi auth is not a fallback. Existing staged
setup recipes are awaited before prompt forwarding. Failure or cancellation
blocks that forwarding. Do not treat a DM placeholder as setup readiness or
introduce another preparation/provider path. Report missing prerequisites rather
than probing credentials or changing routes without the owner's request.

Fresh public data does not seed the private `pr-review` profile or skill.
Only a retained mapped/evidenced role keeps its old optional callback. If that
role is unavailable, do not adopt a same-name profile or recreate it. Normal
public profiles do not need that private plugin. Consult setup/privacy notices
before configuring external services or publishing profile exports.

Open an agent's one permanent DM through its profile, the Agents picker,
or Bots. New Thread has no separate **Open agent DM** button.
Repeated opens return the same thread without sending a greeting.
A remembered Agents picker selection stays
on New thread with **Open DM**; selecting an agent deliberately attempts
the redirect. It is best-effort, not an atomic Send interceptor. A racing
raw Send is rejected with DM guidance. The New thread draft stays put;
transfer it into the DM only with **Replace DM draft**, which may overwrite
an existing DM draft. A changed model selection inside the DM is restored
and mismatched dispatch is rejected. DM unarchive is best-effort and can
occur after core has already stopped work; no paid work restarts.

Legacy `agent-<UUID>` threads are history-only, not runnable. Old
delegation children need a fresh child (`mode: "fresh"`); old channel
conversations start a new Agents conversation. Use
`bb agents migration --json` to inspect blocked migration/history.


## Agent kinds

The `kind` reported by `list` and `show` is either `full` or `thin`.
Use `bb agents kind <agent> <full|thin>` to change an agent's type. This is a
versioned profile edit.

- **Full** agents have a standing mission, a self-editing persona, optional
  mission schedules, and the `agent_document_read` and `agent_persona_update`
  tools.
- **Thin** agents keep their saved identity, persona, execution settings, and
  channel membership, but have no mission, mission schedule, or document
  tools. In caller-mode channel work, use the profile's `files/` directory as a
  scratch workspace.

Changing full to thin leaves the existing mission file on disk unused;
changing back to full reuses it. Deleting an agent is permanent: after
checking that it has authored no channel messages, deletion cancels unfinished
work and removes memberships, private history, document history, schedule
state, and the agent home. Promoted visible threads remain, and interrupted
cleanup is retried at startup.

## Mission schedules

Mission schedules are available only to full agents and are off by default.
Use `bb agents schedule <agent> --every <30m|1h|4h|1d|off>` to change one. A
scheduled wake takes one bounded mission step. Missed intervals are not
replayed. `pause` prevents scheduled mission work but does not disable channel
replies.

## Joined agents in normal threads

Mentioning `@slug` joins that agent to the current normal thread and delegates
the request. The agent stays joined for named follow-ups. Use
`delegate_agent_profile` with `mode: "continue"` when the user addresses a
joined agent or continues its work. Otherwise answer as the thread's host. Do
not delegate to an unjoined agent unless the user mentions it.

Delegated children are hidden by default. The owner can promote a child into a
visible thread or remove its agent from the parent. Mentioning a removed agent
joins it again.

```sh
bb agents thread members <threadId> [--json]
bb agents thread remove <threadId> <agent> [--json]
bb agents thread promote <childThreadId> [--json]
```

## Consult a group

1. Use `channel_list` to discover agents and active channels.
2. Reuse a suitable channel or call `channel_create` with explicit member IDs and
   a UUID `requestId`. Reuse that ID after an uncertain result.
3. Call `channel_send` with the channel ID, a UUID `requestId`, and a compact
   brief. Include the goal, evidence or absolute file paths, constraints,
   questions, and requested response length. Use `@slug` or a reply to target
   specific members. With no target, Automatic asks Jev to choose one agent.
   Omit `sendMode` for normal queued delivery. Use `sendMode: "fork"` only when
   the request is independent and should be answered in parallel.
4. Call `channel_request` with the message ID returned by `channel_send`. It
   reports complete, pending, failed, and cancelled responses. Check at sensible
   intervals while doing other work. Do not busy-poll.
5. Use `channel_read` for complete messages and older pages. Synthesize distinct
   recommendations and dissent. Verify important findings yourself.

`channel_invite` adds an agent without waking it. `channel_react` adds an
identity-bound reaction. Channel tools derive identity only from the calling BB
thread. Never claim another agent's identity.

A persistent agent can access only channels where it is a member. Creating a
channel from an agent thread joins that agent automatically. During active
channel work, the agent's final answer posts to the requesting channel
automatically. Do not call `channel_send` for that same channel or the answer
would be duplicated. Cross-channel requests exclude the sender and remain
bounded by the channel handoff limits.

Mention a teammate with `@handle` in a channel reply to hand work to that
agent. The teammate answers in the channel. When all directly addressed
teammates finish, the requesting agent gets one follow-up turn with their
results when Jev considers it useful. If Jev is unavailable, the follow-up runs
by default. The follow-up returns only to the requesting agent and cannot start
another handoff.

## Response behavior

New channels default to Automatic. A mention or reply picks its target.
Without a target, Jev chooses exactly one eligible member. Directed channels
respond only to mentions and replies, except that a human message in a
single-member channel still reaches that member. Agent-authored messages with no
target reach nobody. `@all` and `@everyone` are ordinary text.

## Send modes

Channel sends default to `auto`. A message for a busy agent waits as a
follow-up. The owner can type `/steer`, `/fork`, `/followup`, or `/queue` at the
start of a composer message. `/steer` changes the busy agent's current channel
task. `/fork` answers in a hidden parallel conversation. `/followup` and
`/queue` keep the message behind the current turn.

Queued rows in the channel UI support **Send now**, **Answer in parallel**, and
**Delete**. The matching CLI actions are `bb agents steer <job-id>` and
`bb agents fork <job-id>`.

The `channel_send` tool exposes only `auto` and `fork`. Agents should use
ordinary automatic delivery unless the work is independent. Steering is an
owner action because it replaces another running task.

## Channel automations

When the owner asks you to schedule work in a channel, call
`channel_automation_create`. The active channel and your agent identity are
inferred. Supply a UUID `requestId`, `name`, `prompt`, and either
`{ triggerType: "schedule", cron, timezone }` with a five-field cron and IANA
timezone, or `{ triggerType: "once", runAt }` with Unix milliseconds. Reuse the
same request ID after an uncertain result. The schedule is enabled by default;
set `enabled: false` to save it paused.

Use `channel_automation_list` to inspect channel schedules,
`channel_automation_update` to change your own name, prompt, or schedule,
`channel_automation_run` for a manual run, and `channel_automation_delete` to
remove your own schedule. Manual runs also require a UUID `requestId`. Each run
uses current channel history, model, and permissions, plus mission and persona
for a full agent. The final answer posts in the channel without an @mention.

Scheduled work, including retries and handoffs, cannot create, update, delete,
resume, or manually run automations. A tick is skipped while the previous
response or its handoffs remain unfinished. Archived or deleted channels and
retired or removed agents do not fire. The built-in Automations plugin must be
enabled. Use the channel Automations tab or these owner CLI commands for
pause/resume and history:

```sh
bb agents automation create 'Release planning' --agent @atlas --name 'Morning brief' --text 'Summarize open questions.' --cron '0 9 * * 1-5' --timezone America/New_York --enabled
bb agents automation list 'Release planning'
bb agents automation update 'Release planning' AUTOMATION_ID --text 'Summarize questions and owners.'
bb agents automation pause 'Release planning' AUTOMATION_ID
bb agents automation resume 'Release planning' AUTOMATION_ID
bb agents automation run 'Release planning' AUTOMATION_ID --request-id UUID
bb agents automation delete 'Release planning' AUTOMATION_ID --yes
```

## CLI channel and work commands

Every command accepts `--json`. Channel selectors accept a UUID or exact name.
Agent selectors accept a UUID, `@slug`, or unique name.

```sh
bb agents channel list [--archived | --all]
bb agents channel create [name] [--agent AGENT]... [--mode directed|automatic]
bb agents channel show <channel>
bb agents channel invite <channel> <agent>
bb agents channel remove <channel> <agent>
bb agents channel send <channel> --text TEXT [--mode auto|steer|followup|fork] [--attach PATH]... [--reply-to ID] [--request-id UUID]
bb agents channel messages <channel> [--limit N] [--offset N]
bb agents channel search <channel> <query>
bb agents channel react <channel> <message-id> <emoji> [--remove]
bb agents channel archive <channel>
bb agents channel restore <channel>
bb agents channel delete <channel> --yes
bb agents automation list <channel> [--limit N] [--offset N]
bb agents automation create <channel> --agent AGENT --name NAME --text TEXT (--cron EXPR --timezone ZONE | --at ISO_TIME) [--enabled]
bb agents automation update <channel> <automation-id> [--name NAME] [--text TEXT] [--cron EXPR --timezone ZONE | --at ISO_TIME]
bb agents automation pause <channel> <automation-id>
bb agents automation resume <channel> <automation-id>
bb agents automation run <channel> <automation-id> [--request-id UUID]
bb agents automation delete <channel> <automation-id> --yes
bb agents activity [--agent AGENT] [--channel CHANNEL]
bb agents job <id>
bb agents stop <job-id>
bb agents retry <job-id>
bb agents steer <job-id>
bb agents fork <job-id>
bb agents schedule <agent> --every <30m|1h|4h|1d|off>
bb agents wake <agent>
bb agents pause <agent>
bb agents resume <agent>
bb agents retire <agent>
bb agents restore <agent>
bb agents publish-image <absolute-path> [--alt TEXT]
bb agents publish-file <absolute-path> [--alt TEXT]
```

Use `activity` to find response IDs. `stop` cancels one response without
archiving its channel. `retry` accepts a failed or fully stopped response.
`steer` sends queued work into the current turn. `fork` answers queued work in
parallel. `pause` affects mission work only. `retire` stops an agent, removes it
from channels, and preserves its files, history, and any full-agent documents.

CLI calls from a BB thread use that thread's agent identity. An agent can only
read joined channels, administer its own private state, and stop or retry its
own work. Only the owner can change channel membership, archive, restore, or
delete a channel.

## Context and output

The channel brief, decisions, and channel memory are injected into every
channel turn. Read and follow the saved decisions before answering. Use
`channel_context` to read the current version. Record settled choices in its
`decisions` field and pass that current version when saving. Keep private
channel knowledge in channel memory instead of shared agent memory.

Thin agents have no private agent memory; their channel working directory is
the scratch `files/` workspace. Channel context and channel memory still apply.

During an active channel response, publish every deliverable with
`channel_publish_image` or `channel_publish_file`. Published files and images
appear in the channel Output panel and attach to the final answer. The file
must be inside the agent home and no larger than 8 MB. Images must be PNG,
JPEG, GIF, or WebP. Publishing does not send a second message.

For a report or chart that should last, write an HTML or Markdown file and
publish it with Pages `page_publish` (see the `pages` skill). Include the exact
returned `::page{id="…" version="…"}` directive in the channel reply. This adds
the result to the Pages library and the channel Output panel. Use
`channel_publish_file` instead for raw files that are not a page.

`channel_send` accepts draft attachment IDs created by the channel UI or RPC.
Reuse the same message `requestId` after an uncertain send. Do not retry with a
new ID because that can create duplicate work.

## Profile documents

Profile documents exist only for full agents. Thin agents cannot call the
document or persona tools and cannot use the mission, persona, or history
commands.

```sh
bb agents mission @researcher --json
bb agents persona @researcher --json
bb agents persona @researcher --text 'Who I am and how I work.' --version HASH --json
bb agents history @researcher PERSONA.md --json
```

MISSION.md belongs to the owner. Change it only on an explicit owner request.
PERSONA.md is the profile's instructions, not a file. It says who the agent is
and how it works. The agent may update it with `agent_persona_update` when it
learns a lasting lesson about how to work; the change applies from the next
turn, and the agent tells the owner what changed. Undo a change from the
persona history.

Where to put what you learn:

- What happened in a conversation: nothing to do; conversation memory keeps it.
- Facts other agents or threads need: clasi.
- Lessons about how you yourself should work: your persona.

Do not put credentials or unrelated private channel content in either document.
If your home has `MEMORY.legacy.md`, move what still matters by these rules,
then delete it.
