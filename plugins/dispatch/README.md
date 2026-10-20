# Dispatch

Dispatch lets you drive BB by voice. You talk to a named agent, Juno by
default, in the BB app or over a phone call. The agent reads your threads,
starts new ones, sends them messages, and brings them on screen.

## Features

- **In-app voice.** Tap the pet in the sidebar footer, or press Mod+Shift+H, to
  start a call. Audio goes straight from the browser to OpenAI GPT-Live over
  WebRTC. Press the same key or tap the pet again to stop.
- **Tools that act on BB.** The agent can list and search threads, read what a
  thread did, start, stop, rename, and archive threads, send a message, change
  a thread's model, open a diff, and run commands from plugins you allow. It
  asks for a clear yes before it stops or archives a thread.
- **Thread notices.** While a call is live, the agent says when a thread
  finishes or fails.
- **One call everywhere.** A call started on one device stops the call on any
  other device. `bb dispatch stop` ends it everywhere.
- **Phone calls.** Dispatch can call your phone through Twilio. You get the
  same agent and the same tools. See [docs/phone-calls.md](docs/phone-calls.md).
- **The pet.** A small robot face in the sidebar footer. It sleeps with no call
  and shows when the agent listens, talks, reads, or works. Long-press or
  right-click it for a menu.
- **A Dispatch console.** A nav panel with every call, its transcript, summary,
  and tool trace, and voice minutes with an estimated cost.
- **Call memory.** After each call, your reasoning model writes a short title
  and summary. The agent sees the last few calls, knows your local time and
  your last call, and can look up older calls with `recall_calls`. Turn it off,
  set how long it is kept, or forget one call. See
  [docs/call-memory.md](docs/call-memory.md).
- **A `bb dispatch` CLI and an agent skill.** Check setup, list live threads,
  stop or mute the call, and report usage.
- **Your instructions.** Add standing instructions for the agent. Every saved
  version is kept, and you can restore one.

## Two modes

| Mode | Needs |
| --- | --- |
| In-app voice | An OpenAI API key with GPT-Live access. Nothing else. |
| Phone calls | The OpenAI key, a Twilio account and number, your phone number, an OpenAI project id for SIP, and the Webhooks plugin. |

BB shows **Needs configuration** for Dispatch only when the OpenAI key is
missing. Missing phone fields never cause it. In-app voice works without them.

## Install

Add the `oh-my-bb` marketplace once:

```sh
bb marketplace add git:github.com/hemaaanth/oh-my-bb@main
```

Then install only Dispatch:

```sh
bb plugin install dispatch@oh-my-bb
```

Or install it directly from Git:

```sh
bb plugin install git:https://github.com/hemaaanth/oh-my-bb.git@^0.2.0 \
  --plugin dispatch \
  --tag-prefix dispatch/
```

## Set up in-app voice

1. Create an OpenAI API key in a project that has GPT-Live access. A ChatGPT
   or Codex subscription token does not work.
2. Open Dispatch's page in BB's plugin settings. Paste the key into the first
   field, **In-app voice — OpenAI API key**, and save. Or run:

   ```sh
   bb plugin config dispatch set openaiKey <key>
   ```

3. Dispatch reloads itself a moment later, and the **Needs configuration**
   banner clears. If a call is live, or the reload fails, the **Readiness**
   section shows **Reload to apply** instead. Press it, or run
   `bb plugin reload dispatch`.
4. Tap the pet in the sidebar footer, or press Mod+Shift+H. Allow the
   microphone when the browser asks.
5. Say "Juno, what is running?" The agent answers to its name. You can change
   the name in **Agent**.

`bb dispatch status` shows what is set up. It never prints a value.

## Settings

The six setup fields are BB plugin settings. All six are secret: BB stores each
one as a secret file, and no value reaches the browser. Set them in the form at
the top of the Dispatch settings page or with
`bb plugin config dispatch set <id> <value>`. Save an empty value to clear one.

| Id | Label | Format |
| --- | --- | --- |
| `openaiKey` | In-app voice — OpenAI API key | No spaces. Needed for every call. |
| `twilioSid` | Phone calls — Twilio Account SID | `AC` and 32 hex characters. |
| `twilioToken` | Phone calls — Twilio Auth Token | No spaces. |
| `twilioCallerNumber` | Phone calls — Twilio caller number | E.164, like `+14155550100`. |
| `yourPhoneNumber` | Phone calls — your phone number | E.164. |
| `openaiSipProject` | Phone calls — OpenAI project id for SIP | `proj_` and letters or digits. |

Below the form, Dispatch adds its own sections. They are the same on every
device, except where a row says it is saved for this device.

| Section | What it holds |
| --- | --- |
| Readiness | Whether in-app voice and phone calls are ready, what is missing, the webhook route, and **Reload to apply** when needed. |
| Agent | Name (up to 24 characters), voice, your instructions (up to 4,000 characters) with history, and a read-only view of the full prompt. |
| Appearance | The pet's style, colour, head shape, pointer follow, antenna flash, and a live preview. The pointer ghost switch is per device. |
| Calls | Microphone and speaker (per device), announcements, mobile drawer behaviour, the two keyboard shortcuts, **Call memory**, **Remember calls for** (30 days, 90 days, 1 year, or forever), and **Home time zone** for phone calls. The three memory controls are on the desktop page only. |
| Tools | Which plugins' commands the agent may run: all, none, or the ones you pick. |
| Advanced | Voice model, reasoning model, and **Reset preferences**. Reset keeps setup values and instructions. |

On a phone, BB's mobile settings page has a short **Dispatch** section.

## Start and stop

| Where | What |
| --- | --- |
| Pet tap | Start or stop a call. A second stop within 4 seconds ends calls on every device. |
| Pet menu | Wake or sleep, **Call my phone**, and **Dispatch settings**. **Call my phone** is disabled and says "Needs: …" until phone setup is ready. |
| Mod+Shift+H | Start or stop a call. Works anywhere in BB. |
| Mod+Shift+U | Mute or unmute. Works while a call is live. |
| Command palette | **Dispatch: start or stop voice**, **Dispatch: mute or unmute** (only during a call), **Dispatch: call my phone**. |

"Mod" is ⌘ on macOS and Ctrl elsewhere. Change the shortcuts in **Calls**. A
shortcut must include Mod or Alt. The two shortcuts cannot share a key, and
keys that BB already uses are refused. The palette commands have no shortcut of
their own.

## Commands

| Command | What it does |
| --- | --- |
| `bb dispatch status [--json]` | Show what is set up and whether a call is live. |
| `bb dispatch live [--json]` | List threads that are working now. |
| `bb dispatch read <thread-id>` | Print what a thread did last. |
| `bb dispatch usage [--json] [--days <1-365>]` | Voice minutes and estimated cost per day. Default 30 days. |
| `bb dispatch stop` | End the live call on every device. Exits 0 when no call is live. |
| `bb dispatch mute` | Mute the microphone on the live call. Exits non-zero when no call is live. |
| `bb dispatch unmute` | Unmute the microphone on the live call. Exits non-zero when no call is live. |
| `bb dispatch forget [call-id]` | Delete a call's transcript and summary, and never summarise it again. Default: the latest call. Exits non-zero when the id is unknown or there are no calls. |
| `bb dispatch call` | Call your phone and talk to the agent. Exits 1 and lists what is missing when phone setup is not ready. |

`bb dispatch --help` lists them all, and `bb dispatch <command> --help` shows
one.

## Cost

GPT-Live is billed by session time. Dispatch counts it at $0.05 per minute
(checked 2026-10-19): cost = billed seconds / 60 × $0.05. The console and
`bb dispatch usage` show minutes and cost per day for app and phone calls
together.

The reasoning model runs the agent's tools and writes one summary per call.
Its tokens are billed on top and are not counted here, because the plugin
cannot see them. Check OpenAI's usage
page for the full bill. Phone calls also cost Twilio minutes.

## Security

- Setup values stay on the BB server. The browser gets only booleans and field
  labels. Logs, the console, and `bb dispatch status` never show a value.
- The OpenAI key goes only into the `Authorization` header of requests to
  `api.openai.com`.
- In-app calls go from your browser to OpenAI. Dispatch's server creates the
  session and never carries audio.
- Transcripts, tool traces, and call summaries are stored in Dispatch's plugin
  database on the BB server. Transcripts and summaries are deleted after
  90 days by default. Change this, or turn call memory off, in **Calls**.
- Call summaries are written by your reasoning model with your OpenAI key. The
  request sends the call's transcript and tool trace, with `store: false`.
- The agent runs plugin commands only from plugins you allow in **Tools**.
- Text that tools return is data for the agent, not instructions.

## Optional integration

In-app voice needs no other plugin. Phone calls need the
[Webhooks plugin](../webhooks/README.md) to receive OpenAI's incoming-call
webhook. Install it yourself. Dispatch never installs, enables, or calls it.
When Readiness is read, Dispatch looks in BB's plugin list to see whether
Webhooks is enabled, and reports a missing **webhook route** when it is not.

Other plugins may read your calls with the discoverable, read-only
`read.calls` RPC: titles, summaries, and thread ids for a window of up to
62 days. Dispatch never looks for a caller. With call memory off, titles and
summaries are null. See [docs/call-memory.md](docs/call-memory.md).

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## License

MIT. See [LICENSE](LICENSE). Third-party parts are listed in
[THIRD_PARTY.md](THIRD_PARTY.md).
