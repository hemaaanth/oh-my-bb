---
name: journal
description: Browse or reconcile the user's BB thread journal and work history, and answer "what did my agents work on, when, and for how long" with the agent time sheet and activity log.
---

# BB Journal

Use `bb journal` to inspect dated work and separate lifecycle history.

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

## Agent hours

`timesheet` and `log` read the turn index: when each thread had an agent turn running. `timesheet` shows hours per thread and day for one Monday-to-Sunday week, grouped by project. `log` lists work blocks in time order for one day (default today) or one week, with the day summary and outcome under each thread's first block of that work day. `--gap` sets the idle time that still counts as one block (default 30 minutes). `--json` prints thread IDs, project IDs, and epoch-millisecond times; `log --json` lists at most 500 blocks and reports the rest as `truncatedBlocks`.

- Times use the bb server's local time zone; the header names it. Day summaries stay keyed by the configured work timezone.
- Blocks are rounded out to quarter hours. Do not report them as exact minutes.
- Hours add up per thread. Parallel agents can log more than 24 hours in a day. Say "agent hours" when you sum them.
- "Agent turns" is the unrounded time turns were running.
- Visible child threads and side chats count toward their root thread. Hidden threads are not included.

To see what happened in a thread, use `bb journal show <id>` or `bb thread show <id>`.

Dispatch voice calls are not agent hours. The CLI never shows them. When **Oh My BB → Show Dispatch calls** is on (off by default), the Journal Calendar and Traces show calls read from Dispatch on demand; Journal stores nothing about them.

## Work history

`list` and `summary` use one work entry per parent thread per configured local day (default `America/New_York`). Visible child and side-chat entries are linked under their parent and do not inflate counts. `--all` expands child details for work or includes child lifecycle rows with `--lifecycle`. Lifecycle rows never show current outcomes. Archived, created, and restored counts are separate context. Test-category work remains in replay. Every list page reports its total and next offset. Work entries and `show` days include agent time from the turn index: `activeMs`, `turnCount`, and `blockCount` (null when the thread has no recorded turns; a list entry sums its children).

`--from` and `--to` are inclusive calendar dates in the configured work timezone; work rows use their `dayStart`, lifecycle rows use event time. `show` reads the thread's stored summary and paged per-thread work days; no model request or narrative generation occurs. Hidden threads are not shown. The discoverable read-only RPC methods are `read.list` (same filters and pagination) and `read.show` (`threadId`, `limit`, `offset`). Inspect schemas with `bb plugin rpc inspect journal read.list --json`.

Idle turns index provisional work without AI. Automatic finalization considers closed days from the previous seven days and shares the `automaticDailyBudgetUsd` setting (default $0.50 per local day) with period prose and sidebar catch-up. Cost is reserved before each call and reconciled to reported cost afterward; failed or unpriced calls retain an estimated charge. A persisted 500-call backstop also applies. `bb journal backfill --status` shows today's automatic spend, reservations, remaining budget, and call count. When budget is exhausted, catch-up returns the last cached narrative with a note; its manual Refresh remains outside the budget. Explicit backfill, `enrich`, and `activity-sync` are also outside it. The read-only `backfill --dry-run` estimates all-time thread/day coverage and OpenRouter tokens and cost before processing. It counts days from the turn index, so its token figure is an upper bound (`estimateBasis`); only threads without turns are read in full. Real backfill runs at most 25 threads and 100 daily AI attempts per invocation, saves progress per summarized day, and resumes at the last completed thread. Invalid successful responses get at most three attempts per day; failed days are listed by `backfill --status`, with `--limit` and `--offset` for paging. HTTP/network errors stop the batch without skipping days; if the OpenRouter key reaches its monthly limit, raise it or wait for reset before resuming. `--restart` clears failed-day attempts and reindexes days in the configured timezone without deleting earlier work-day rows or forcing duplicate same-zone finalized AI calls. Changing timezone alone does not re-bucket old rows. `cost` shows usage reported by OpenRouter; failed attempts without reported usage are not priced. The Journal page offers Day, 3-day, and Week time grids with replay, a Time sheet, All-time replay, and a 24-hour Activity feed.

## Thread briefings and AI backend

`bb journal brief <id>` prints the saved six-section briefing (goal, done, remaining, where it stopped, decisions, open decisions) for the thread's visible root, with staleness, live running state, and coverage. It reads stored rows only. `--refresh` makes exactly one model call on the configured backend; use it only when the user asks. Report coverage honestly: if `startRead` is false, the goal came from saved summaries, not the opening request. An idle thread is not finished.

`bb journal ai-status` shows the AI backend (`openrouter` default, or `subscription` through the Model Gateway plugin's ChatGPT subscription accounts), readiness, and today's automatic call count. Subscription calls cost $0 and never fall back to a paid key; automatic briefings run only on the subscription backend. `bb journal cost` counts calls with no reported tokens as `unmeasuredCalls`.

## Preferences

Native Configuration holds only the OpenRouter API key. Preferences holds models, intelligent summaries, budget, and timezone. Oh My BB holds the backend selector and Dispatch opt-in. Journal does not install or probe either optional plugin at startup.

`bb journal preferences --json` reads non-secret values and whether a finishing settings-import reload is pending. `bb journal preferences set <key> <value>` changes one validated value. Keys are `aiBackend`, `gatewayModel`, `openRouterModel`, `intelligenceEnabled`, `automaticDailyBudgetUsd`, `workTimeZone`, and `showDispatchCalls`. Booleans accept `true` or `false`; the budget accepts 0 through 100; timezone names must be valid IANA names. Use these controls or commands instead of the old non-secret native config commands. The API-key command is unchanged.

Do not change preferences, test a model, or request refresh/backfill/enrichment merely to answer a history question. A backend change can enable automatic work when intelligence is already on. Existing settings import preserves defaults, opt-ins, stored history, budgets, and saved briefings without a model request.

