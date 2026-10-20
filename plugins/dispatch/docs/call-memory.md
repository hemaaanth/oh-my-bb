# Call memory

The agent remembers past calls. It can answer "what did we talk about
yesterday?" It also knows which device you call from and your local time.

## What is stored

Everything is stored in Dispatch's plugin database on the BB server. Nothing
goes to another plugin unless that plugin asks for it (see `read.calls` below).

| What | Where | When |
| --- | --- | --- |
| Transcript | `call_trace` rows of kind `speech.user` and `speech.agent`, with payload `{ text }`. One row per utterance. | During every call, app and phone. |
| Tool trace | `call_trace` rows of kind `tool.call` and `tool.result`. | During every call. |
| Summary | One `call_summaries` row per call: title (up to 80 characters), summary (up to 600), topics, thread ids, the local day, and the time zone. | A few seconds after a call ends. |
| Device | The call's device profile, with its time zone and a short name such as "Mac" or "iPhone". | When the call starts. |

GPT-Live sends the transcript in small fragments. Dispatch joins them into one
utterance per speaker turn. A new utterance starts when the speaker changes or
after a pause of more than 2 seconds. The open utterance is written after
4 seconds of quiet, and when the call ends.

## How summaries are written

When a call ends, Dispatch waits 5 seconds, then sends the transcript and the
tool trace to the OpenAI Responses API. It uses **your OpenAI key** and **your
reasoning model** from Advanced settings, with low reasoning effort and JSON
output. The request sets `store: false`. These tokens are billed by OpenAI and
are not in Dispatch's cost estimate.

- A long call keeps its start and its end. The middle is left out of the input.
- If the model fails, Dispatch stores a `fallback` summary. It lists the tools
  the call used and the threads it touched. It uses no model.
- A call with nothing said and no tools gets a `skipped` row and no model call.
- When Dispatch loads, it summarises up to 10 ended calls that have no summary,
  newest first. A restart during the 5-second wait leaves such calls.

## What the agent sees

- **Runtime context.** One line: "Last call: yesterday at 3:05 PM from Mac."
  The time line uses your local time zone.
- **Recent calls.** A `# Recent calls` section with up to 5 summaries, at most
  1,500 characters. The prompt preview in Agent settings shows it.
- **The `recall_calls` tool.** It looks up older calls by local day
  (`YYYY-MM-DD`), by words in the title, summary, or topics, or both. It returns
  up to 20 calls.

## Time zones

- In-app calls send the browser's time zone.
- Phone calls use **Home time zone** in Calls settings. When it is empty,
  Dispatch uses the BB server's zone.

The local day of each summary is in the caller's zone. So "yesterday" means
yesterday where you were.

## How to turn it off

All of these are in Dispatch settings, **Calls**, on the desktop settings page.

- **Call memory** (on by default). When it is off:
  - no new summaries are written,
  - the prompt has no Recent calls and no Last call line,
  - the agent has no `recall_calls` tool,
  - `read.calls` returns `memory: false`, with every title and summary null.

  Summaries already written are hidden, not deleted. Transcripts are still kept
  for the console, and retention still deletes them.
- **Remember calls for**: 30 days, 90 days (the default), 1 year, or forever.
  Dispatch deletes older summaries and transcripts when it loads and once a
  day. The call row, its tool trace, and its billed time stay, so usage and
  cost reports stay correct. 90 days covers a quarter of work, which is long
  enough for "what did we decide last month?" and short enough not to keep
  speech for ever.
- **Forget one call.** In the console, open a call and press **Forget this
  call**, during or after the call. Or run `bb dispatch forget [call-id]`. With
  no id, it forgets the latest call. Forgetting deletes the call's transcript
  and summary, and Dispatch never summarises it again. Words that arrive later
  in a live call are dropped. The tool trace stays.

## `read.calls` (optional integration)

`read.calls` is a read-only, discoverable RPC. Another plugin, such as Journal,
may call it to show your calls next to its own data:

```ts
const result = await bb.sdk.plugins.callRpc({
  pluginId: "dispatch",
  method: "read.calls",
  input: { since: "2026-10-01T00:00:00Z", until: "2026-10-20T00:00:00Z" },
  // The caller's own zod schema for the output below. Do not import Dispatch.
  outputSchema: readCallsOutput,
});
```

If Dispatch is not installed, or is an older version without `read.calls`, the
call fails. Treat that as "no calls".

- Input: `since` and `until`, ISO date-times with an offset. `until` must be
  after `since`. The window spans at most 62 days.
- Output: `{ memory, calls }`. Each call has `id`, `startedAt`, `endedAt` (null
  while live), `channel`, `device` (a short label, or null), `title` (up to 80
  characters, or null), `summary` (up to 600, or null), and `threadIds`.
- A call is included when it started before `until` and ended after `since`,
  or is still live. Calls are listed oldest first, so the newest is last.
- A forgotten call is still listed, with a null title and summary and no thread
  ids. So is every call while Call memory is off.
- It never calls a model and never writes.

Dispatch does not look for Journal or any other caller. Nothing changes in
Dispatch when no plugin calls `read.calls`.

## Journal

When the Journal plugin is installed and the agent may run its commands
(**Tools** settings), the agent may also use Journal through
`run_plugin_command`. Dispatch does not check for Journal.
