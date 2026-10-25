# BB Journal

A searchable journal of BB thread lifecycle and work history.

Journal keeps lifecycle events and a separate dated history of work in BB threads. It works without another plugin or an AI account.

## Install

Requires BB 0.46.1 or later. Install from this package directory:

```sh
npm ci
npm run build
bb plugin install .
```

The package has its own lockfile. The repository root is not an npm workspace. No sibling checkout, symlink, or suite installation is needed. Do not install over an active personal instance merely to validate changes.
After the first load, run `bb plugin reload journal` once to finish the settings import described below.
Open **More → Setup guide** for optional AI setup and costs.

## Settings

- **Configuration** contains only the OpenRouter API key. Its secret ID, storage, and `bb plugin config journal openRouterApiKey` command are unchanged.
- **Preferences** contains intelligent summaries, the OpenRouter and subscription models, the automatic dollar budget, and the work-day timezone. Save applies only edited fields.
- **More** links to the setup guide.
- **Oh My BB** contains the AI backend selector and the optional Dispatch switch. Selecting **Model Gateway subscription** explicitly opts Journal into that integration. Both integrations are optional; neither is installed, enabled, or probed at startup.

Use `bb journal preferences [--json]` to read non-secret values, or `bb journal preferences set <key> <value> [--json]` to change one. Keys are `aiBackend`, `gatewayModel`, `openRouterModel`, `intelligenceEnabled`, `automaticDailyBudgetUsd`, `workTimeZone`, and `showDispatchCalls`. Booleans accept only `true` or `false`; the daily dollar budget accepts 0 through 100; timezones must be valid IANA names. These commands never return the API key.

### Existing installations

The first load imports all saved non-secret fields into Journal-owned preferences, including `aiBackend` and `gatewayModel`. It keeps legacy native fields registered during that import generation because the public SDK cannot read undeclared saved fields. Run `bb plugin reload journal` once afterward. `bb journal preferences --json` then reports `migrationPending: false`, and native Configuration contains only the key.

Until that finishing reload, the custom controls show an import notice rather than duplicate editors. Native edits made during the import generation are preserved too. Afterward, use the new controls or `bb journal preferences set`, not the old non-secret `bb plugin config journal` commands. Old native records remain stored but are not imported again. No history, summary, category, budget, backfill cursor, or opt-in is reset. Importing does not reindex, backfill, call a model, or reload another plugin.

## What it records

- Thread creation, archival, restoration, and deletion
- Daily work activity inside long-running threads, even when they stay open for days or weeks
- Project, provider, parent thread, and originating plugin
- Provisional work days on idle, then one transcript-aware AI summary and dated outcome after the day closes
- A manual category correction that wins over later model passes
- Daily work summaries with lifecycle counts shown separately

Initial sync only backfills lifecycle events. An explicit, resumable all-time backfill indexes historical work days. Visible child and side-chat work is grouped under the parent by day, with child links; hidden threads are omitted.

## Categories

`bug-fix`, `feature`, `improvement`, `research`, `analysis`, `operations`, `content`, `planning`, `review`, `project`, and `test`.

Without an AI provider, the journal uses a local title summary and deterministic keyword category. Enable intelligent summaries and configure OpenRouter or the optional Model Gateway subscription backend to finalize closed days. The default OpenRouter model is `google/gemini-3.1-flash-lite-preview` (catalog price checked October 2026: $0.25/M input, $1.50/M output tokens); the model remains configurable. Model calls, token counts, and charged or estimated USD cost appear in `bb journal cost`, `stats`, and the panel. Unpriced calls are counted separately.

The `workTimeZone` preference defaults to `America/New_York`. It controls new indexing and explicit all-time backfill. Changing it does not alter stored rows. New indexing uses a timezone-keyed table; the earlier work-day table stays intact. Replay includes earlier rows until each thread finishes backfill in the configured timezone. The day boundary follows local calendar dates and daylight-saving changes. Idle turns index metadata without AI; today remains provisional. Closed days from the preceding seven days can be finalized automatically. The `automaticDailyBudgetUsd` preference defaults to **$0.50 per local day**, shared by automatic closed-day summaries, period prose, and sidebar catch-up. Each OpenRouter call reserves an estimated cost before sending, then charges OpenRouter's reported cost (or the default-model token estimate); failed or unpriced calls keep their reservation as a conservative charge. A persisted 500-call daily backstop protects against bad pricing. Unknown model prices reserve the whole daily budget until OpenRouter reports cost. Backfill, explicit `enrich`/`activity-sync`, and manual catch-up Refresh remain outside the automatic budget. Each daily model input uses up to 12,000 transcript characters. Visible children are included; hidden threads are not. API keys are host-local BB secrets. When intelligence is enabled, the selected backend receives closed-day transcripts for finalization and explicit backfill, recent excerpts for the catch-up, or thread history for explicit enrichment.

### AI backend

**Oh My BB → AI backend** chooses where every Journal model request goes. `openrouter` is the default, so existing installs change nothing. It uses the OpenRouter key and dollar budget above. `subscription` sends every request (closed-day and thread summaries, period prose, workspace catch-up, backfill, enrichment, and thread briefings) through the Model Gateway plugin's `inference.complete` RPC. That backend uses only ChatGPT subscription accounts (`gpt-6-luna` by default, `gpt-5.6-luna` selectable in Preferences). It needs no OpenRouter key and never falls back to a paid key. When the gateway is unavailable, saved results stay; automatic work can retry later. Subscription calls are recorded at $0 (calls without reported tokens count as `unmeasuredCalls`); they still count toward the 500-call daily backstop. Journal sends one gateway request at a time. It trims model facts to valid JSON within the gateway's 64,000-character input and 128 KiB UTF-8 request limits, dropping the oldest items first with an explicit omitted count. The backend and model are part of the narrative cache identity, so switching either cannot make old prose look fresh.

Settings keeps descriptions short. Setup and data-sharing details live under **More → Setup guide**. Use `bb journal ai-status` to inspect backend readiness without making a model request. Settings does not run a connection test.

### Thread briefings

The thread header's **Catch up** button opens a saved six-section briefing: original goal, done so far, remaining work, where it stopped, accepted decisions, and open decisions. It also shows live state (an agent running now, or idle, which is not the same as done) and whether newer activity is not yet covered. Opening or reloading it reads stored rows only: no model call and no transcript read. A child thread opens its root's briefing, which also covers visible child threads; hidden threads with their subtrees, and deleted children, are excluded.

With intelligence enabled on the subscription backend, the background worker writes a briefing after the root or a visible child has been idle for 2 minutes, at most once per thread per 30 minutes, one request at a time, and only when the source (turns or new conversation in the root or its visible children) changed. Each pass reads the newest timeline page of the root and of up to 3 children, the earliest and the 29 most recent daily summaries, and the previous briefing, which carries the original goal and older decisions forward without re-reading old history. Newer transcript text outranks older summaries; proposals stay open decisions until accepted. The briefing records its coverage: whether older pages were not read, whether long or middle messages were shortened, and whether the opening request was ever read. Failures keep the saved briefing and back off. The OpenRouter backend runs no automatic briefings; `bb journal brief <id> --refresh` makes one explicit call on either backend. Saved briefings also feed the workspace catch-up, which skips the transcript read for threads whose briefing is current. Nothing backfills briefings automatically.

## Use

Open **Journal** in the BB sidebar, or use the CLI:

Thread links in Calendar, Time sheet, Activity, and Traces open the chat in a pop-up. Close it with the close button, Escape, or a click outside to keep your date range, filters, and scroll position. Use **Open full thread** in the pop-up header to navigate to the full BB thread.

```sh
bb journal list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit <n>] [--offset <n>] [--all] [--json]
bb journal list --lifecycle [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit <n>] [--offset <n>] [--all] [--json]
bb journal show <threadId> [--limit <1-100>] [--offset <n>] [--json]
bb journal summary [--json]
bb journal stats [--json]
bb journal cost [--json]
bb journal backfill --dry-run [--json]
bb journal backfill --status [--limit <1-500>] [--offset <n>] [--json]
bb journal backfill [--limit <1-25>] [--restart] [--json]
bb journal sync [--json]
bb journal enrich [--limit <n>] [--thread <id>] [--force] [--json]
bb journal activity-sync [--limit <n>] [--thread <id>] [--force] [--json]
bb journal brief <threadId> [--refresh] [--json]
bb journal ai-status [--json]
bb journal preferences [--json]
bb journal preferences set <key> <value> [--json]
bb journal timesheet [--week this|last|YYYY-MM-DD] [--gap 15|30|60|120] [--json]
bb journal log [--day today|yesterday|YYYY-MM-DD | --week this|last|YYYY-MM-DD] [--gap 15|30|60|120] [--json]
```

`timesheet` and `log` read the turn index. Journal records when each visible thread, archived ones included, had an agent turn running. A background backfill reads bb's turn events without AI, and thread lifecycle hooks keep it current. Turns of a thread separated by at most `--gap` idle minutes (default 30) merge into one block, rounded out to quarter hours. Visible child threads and side chats count toward their root; hidden threads are excluded. `timesheet` shows agent hours per thread and day for one Monday-to-Sunday week, grouped by project. `log` lists blocks for one day or week, with the work-day summary and outcome under each thread's first block of that day. The CLI uses the bb server's local time zone. Work-day summaries stay keyed by `workTimeZone`: a block gets the summary of the work day containing its start. Parallel agents can log more than 24 agent hours in a day. The `journal_calendar` RPC (`from`, `to`, `mergeGapMinutes`, at most 62 days) returns the same blocks with thread, project, color-order, and work-day data.

Work days also carry agent time from the turn index, without AI. Each work-day row stores `activeMs` (agent turn time), `turnCount`, and `blockCount` (30-minute gap) for that work day in `workTimeZone`. When a thread has turns, its first and last activity times come from them; otherwise they come from messages, and the agent fields stay null. Replay entries, `list`, and `show` print agent time, and their JSON includes the three fields; a `list` entry sums its root and children, so parallel agents add up. The sidebar catch-up gives each open thread a "last worked" phrase from the last 14 days, such as "worked 2h 15m this morning". An idle event first syncs the thread's turns and skips the timeline read when no turn started or ended since the last capture.

AI summaries stay one per thread and work day. Possible follow-up: summarize each block on its own, so a day with separate morning and evening sessions gets two entries.

`list` defaults to work days, sorted by last conversation activity. It prints the total and next offset when more rows exist. `--all` expands child details without adding work-day rows. `--lifecycle` shows the original created/archived/restored/deleted events; `--all` there includes child lifecycle events. Lifecycle rows have no outcome: current thread outcomes belong to work dates, not old events. `summary` uses work days for active-thread counts and highlights; creation and archive counts are separate context. Test-category work remains visible in replay.

The date range is inclusive in the configured work timezone. Work rows are filtered on local `dayStart`; lifecycle rows are filtered on occurrence time. `show` returns the visible thread's stored metadata and its own per-day summaries, with `limit`/`offset`. Neither operation generates text or starts a sync. Remote clients can discover equivalent `read.list` and `read.show` RPC schemas using `bb plugin rpc list journal --json` and `bb plugin rpc inspect journal read.show --json`.

`backfill --dry-run` takes thread-days from the turn index and reads full timelines only for threads with no indexed turns. It changes no plugin rows and does not call OpenRouter. Turn-index days are estimated at the 12,000-character transcript cap, so the token count is an upper bound; exact counts need full transcripts. The output says which basis it used (`estimateBasis`, `timelineReads`). It reports visible physical threads, parent-rolled work days, thread-days, closed thread-days needing AI, approximate input tokens, a conservative maximum of 320 output tokens per daily call, and estimated cost for the default model. Custom model cost is unavailable unless the provider returns it after calls. Threads without turns can make it slow. `backfill` processes five threads per invocation by default and at most 25, with at most 100 daily AI attempts per invocation. Saved cursor and finalized days make subsequent invocations resumable, including after a partial thread. An invalid successful model response is retried at most three times per day, across invocations. After three failures, the day appears in `--status` and backfill advances. `--status` lists failed days with `--limit` and `--offset`, the last blocking provider error, and today's automatic AI budget (spent, reserved, remaining, and calls). HTTP failures and network errors stop the batch without marking days failed; a shared OpenRouter key limit must be raised or reset before continuing. `--restart` resets the cursor and failed-day attempts, then reindexes dates in the configured timezone while preserving same-zone finalized summaries; it does not force repeat model calls. Previously stored work-day rows are never deleted by backfill.

`enrich` still processes up to ten recent root threads for thread-wide summaries on explicit request. `activity-sync` indexes a bounded set of full timelines. The Journal UI puts the range (Day, 3 days, Week), grouping (threads or projects), color (project or work type) and filters on top; they apply to every view. Color by project uses the top eight projects of the last 30 days; the rest share a neutral color. The views below only change the presentation. Calendar shows agent blocks on a time grid in the viewer's local time zone; click a block to pin its details, change its work type, or open its children. Time sheet shows agent hours per thread or project and day and copies them as CSV. Activity is the enriched replay: a narrative and one summary per thread and work day. It is the only view that also offers All time. Traces lists raw agent turns as spans, newest first, with failures and input requests; those events are kept for 62 days. The sidebar footer Catch me up button reads bounded recent conversation excerpts and work days to summarize open work with thread links. When the automatic budget is exhausted, it shows the last cached narrative and a note instead of failing. Its explicit Refresh remains outside the automatic budget and can incur a model call. Neither archived threads nor idle agents automatically mean the task is complete.

### Layout

Activity, Traces, and the setup guide use the same 760px outer frame and 16px side padding as BB Settings (728px content at full width). Calendar and Time sheet intentionally use a wider canvas, up to 1280px, so their day columns remain readable. Small screens may scroll the calendar grid or time sheet horizontally inside the view; page controls still fit the container. Dialogs use the host's centered desktop behavior and a bottom drawer below 640px.

## Dispatch calls

Journal can show calls with the Dispatch voice agent. This optional integration is off by default. Turn it on with the **Calls** toggle in the Calendar or Traces toolbar, or with **Oh My BB → Show Dispatch calls**. These controls share one saved preference. Journal does not need Dispatch installed. It never calls Dispatch at startup or while the preference is off.

While the setting is on, `journal_calendar` reads calls for its range from Dispatch's `read.calls` RPC on demand. Journal stores nothing. It keeps each answer in memory for 30 seconds. A read that fails, has the wrong shape, or takes more than 1.5 seconds shows no calls and logs one warning at most once a minute. The `bb journal` CLI never reads calls.

The Calendar shows each call as a thin pill at the left edge of its day, in a fixed violet. Calls that cross midnight split per day. A live call grows to now. On days with calls, agent blocks move right to make room. Hover a pill to see its time, duration, channel, and device; click it to pin the card. When Dispatch remembered the call, the card also shows its title, summary, and the threads it touched. Search matches call titles and summaries; project and category filters do not hide calls. Calls never count toward agent hours. Traces lists calls as their own rows, newest first.

## Develop

```sh
npm ci
npm test
npm run typecheck
npm run build
```

These checks run from this package directory. They use disposable fixtures and do not need a running BB server, OpenRouter key, Dispatch, or another package. Do not use production reindex, backfill, enrichment, or paid summaries for validation. Install and reload only in an explicitly approved live-review slot; reload only `journal`.

Plugin data lives in BB's plugin-owned SQLite database. Migrations only add columns or tables; existing work-day rows and old daily attempt counts are preserved. Automatic dollar accounting starts when this setting ships, because prior usage rows do not identify automatic versus explicit calls. The earlier `journal_work_days` rows remain stored while new work uses `journal_work_days_v2`; manual category corrections still update both tables. The source uses only the public BB Plugin SDK. `bb journal cost` reports usage returned by OpenRouter; failed requests without usage have no token estimate but are charged their reserved estimate against the automatic budget.

### Privacy and state compatibility

The public package contains source, vendored controls, synthetic test fixtures, and the canonical SVG only. Do not copy BB runtime databases, API keys, transcripts, build previews, or personal configuration into it. Existing Journal installations keep the `journal` plugin ID, OpenRouter secret ID and storage, table migrations, local storage keys, category overrides, cached summaries, backfill cursors, and budget records. Non-secret settings migrate as described above. Migration does not require a reindex or model call.

The configurable `America/New_York` work-day default is retained deliberately for stored-date compatibility, not discovered from the developer's machine. All paths and host identities come from BB's public SDK at runtime. Dispatch reads and Model Gateway inference are optional cross-plugin RPCs, explicitly selected in Oh My BB and guarded at execution. There are no cross-package runtime imports.

## Credits

The turn index, block merging, time sheet, and calendar layout are ported from [Agent Calendar](https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-calendar) by charpeni, MIT License. Ported files keep the attribution in their headers.
