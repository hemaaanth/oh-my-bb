A searchable journal of BB thread lifecycle and work history.

## A journal that writes itself

Journal records thread creation, archival, restoration, and deletion without treating archive time as work time. Idle turns index provisional work days. Closed days from the last seven days can get one transcript-aware AI pass when enabled; a configurable $0.50/day automatic spend budget and 500-call backstop persist across reloads. An explicit, resumable all-time backfill can index older days after a read-only cost estimate without deleting earlier work-day rows.

## Catch up on any thread

A Catch up button in each thread header opens a saved briefing: the original goal, what is done, what remains, where it stopped, and which decisions are made or still open, with live status and freshness. Opening it never calls a model. With the optional subscription backend, Journal refreshes briefings in the background after a thread goes idle, through the Model Gateway's ChatGPT subscription accounts with no paid fallback.

## Designed for a real archive

The Journal page offers daily, weekly, and all-time replay with per-day outcomes, work-category filters, project breakdowns, and a separate lifecycle context. Visible child-agent and side-chat work rolls into the parent day with links, so it does not inflate counts. Hidden workers remain omitted. Test-category activity stays visible.

Calendar shows agent turns as time blocks. Time sheet groups agent hours by thread or project and copies them as CSV. Traces shows raw turns, failures, and input requests. Calendar and Time sheet deliberately use a wider day-column canvas; text views align with BB Settings.

Categories cover bug fixes, features, improvements, research, analysis, operations, content, planning, reviews, projects, and tests. Local title rules work without an API key; manual corrections win over model results. The work-day timezone defaults to America/New_York and is configurable for new indexing and explicit backfill.

## Dispatch calls, if you want them

An optional Dispatch integration shows voice-agent calls as a thin rail beside the agent blocks in the Calendar, with their own rows in Traces. It is off by default; the Calls toggle turns it on. Journal reads calls from Dispatch on demand and stores nothing. Calls never count toward agent hours.

## Settings with clear ownership

Native Configuration holds only the OpenRouter API key. Preferences holds summaries, models, budget, and timezone. More links to setup. Oh My BB holds the optional Model Gateway backend selector and Dispatch switch. Neither integration is required or probed at startup.

Existing non-secret settings import without resetting saved values. One finishing Journal reload removes their legacy native editors. `bb journal preferences` reads or changes these values; the API key keeps its native command and secret storage.

## CLI included

Use `bb journal list` for paginated work days, `bb journal list --lifecycle` for events, and `bb journal summary` for dated highlights. `bb journal brief <id>` reads a saved briefing; `--refresh` explicitly requests a model pass. `bb journal ai-status` reads backend readiness without a model request. `bb journal backfill --dry-run` estimates all-time coverage and cost before any AI calls. `bb journal backfill --limit 5` saves a cursor and resumes in bounded batches, with at most 100 daily AI attempts per invocation. `bb journal backfill --status` shows failed days, provider blocks, and today's automatic budget without sending work to a provider. `bb journal cost` reports token and spend totals. JSON output is available.

All data stays in the plugin's BB-managed SQLite database. API keys remain host-local; transcripts go to the configured AI backend (OpenRouter, or ChatGPT subscription through Model Gateway) only when intelligence is enabled.
