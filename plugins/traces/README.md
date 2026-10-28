# Traces

Traces reads BB's own thread events, the existing read-only `bb.db`, and provider transcripts. Waterfall uses `bb.sdk.threads.get/list/events.list`. Context Inspector resolves the execution host through the SDK and reads Claude Code or Codex JSONL through this plugin's `bb.host` entry. Log Explorer and Fleet Metrics use bounded, thread-first SQLite reads. Traces creates no plugin database, disk cache, or durable mirror. Derived event trees and fleet jobs stay in bounded memory only.

## Use

Open **Traces** in the BB navigation rail to start in Log Explorer. Four sibling views share the page: Log Explorer, Waterfall, Context Inspector, and Fleet Metrics. Explicit thread links from Explorer or **Trace this thread** in a thread menu still open that thread's Waterfall or Context Inspector. The thread side panel offers separate Waterfall and Context Inspector action tabs. Waterfall shows a focused turn summary, previous/next turn controls, and foldable nested tool/delegation lanes; the selected turn has a shareable thread/turn URL. The timeline supports j/k or arrow up/down to select spans and arrow left/right to fold or expand. It keeps only visible rows mounted. `bb traces thread --children` remains available for deep child-thread CLI debugging. Hatched bars are waits. The breakdown counts exclusive wall time.

The Traces sidebar uses BB's own live thread list. It groups threads by project, searches titles and `thr_` IDs, and opens Waterfall using the exact BB thread ID. Hidden and archived threads are opt-in; a missing selection is labeled unavailable rather than assigned to another thread. On narrow screens, open BB's sidebar drawer to use the search. This sidebar and per-thread interaction design draw on [Agent Traces](https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-traces) by Nicolas Charpentier (MIT); the original copyright notice is retained in `LICENSE`.

Waterfall refreshes after BB event signals settle, folds only new SDK event pages into a bounded in-memory cache (up to five single-thread traces, 20,000 events and roughly 8 MB of event JSON per entry), and rebuilds the tree from those events. Child-inclusive CLI reads are not retained in the cache. Gaps or BB history rewrites trigger a full source read. Running-turn bars use a one-second local clock; elapsed time is not provider network timing. After realtime reconnection the view refetches because missed signals are not replayed. Larger histories remain readable but are not retained in that cache, so repeated refreshes can be slower. No local database, durable mirror, or export is created.

```sh
bb traces thread <thread-id>
bb traces thread --self
bb traces thread <thread-id> --children
bb traces thread <thread-id> --json
bb traces thread <thread-id> --json --reveal
bb traces prompt <thread-id> [--call N] [--json] [--reveal]
bb traces prompt --self [--call N] [--json] [--reveal]
bb traces query 'kind:toolCall status:failed' --since 24h [--mode events|spans] [--json]
bb traces slow --since 24h --by tool|provider --p 50|95 [--filter 'provider:codex'] [--json]
bb traces errors --since 6h --group category|provider|tool [--filter 'status:failed'] [--json]
bb traces job <scan_id> [--cancel] [--json]
```

Text mode puts errors and slow spans ahead of the waterfall, or prints prompt sections and a nearby per-call ledger. Fleet commands return bounded rows, groups, and explicit scan progress. `--json` returns structured data. The CLI has a 1 MB output limit. CLI output and RPC responses hide event inputs/outputs, system prompt text, tool definitions, injected content, and unstructured errors unless `--reveal` or `reveal: true` is requested. Arbitrary prompt or tool text can contain secrets without recognizable prefixes, so regex masking is not enough. Per-thread UI views now request Reveal sensitive data **on by default**; turn it off before sharing a screen. Turning Reveal off clears displayed content. CLI reveal remains opt-in; do not share revealed output.

## Context Inspector

Pick an API call by number, use Previous/Next, or select a row in the token ledger. The page shows provider/model, system prompt sections, tool definitions, injected AGENTS/skills blocks when present, a context-window composition estimate, exact stored per-call token and cache usage, and a structured diff from the previous call. Section token sizes are character-based estimates, not billed tokens. The capacity bar reports "not stored" when the provider did not record it. Claude Code exposes cache writes split by 5m and 1h; Codex does not. Codex also does not record an API request-start time, so its call duration is "not stored."

The server joins `thread/identity.providerThreadId` to a transcript on the **thread's execution host**. The host entry searches `~/.claude/projects/*/<sessionId>.jsonl` for Claude Code or `~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl` for Codex. It does not assume the BB server's filesystem is the execution host. `acp-omp`, Pi, and other providers return an honest unsupported state. A missing transcript returns unavailable. No prompt or usage is fabricated.

Reads stream through at most 192 MiB, 60,000 lines, and 2 MiB per line. Up to 5,000 API calls are indexed in memory for one request. The RPC returns only the selected call, a 71-row ledger window, up to 100 tools and 32 injected blocks, and at most 160,000 revealed content characters. Malformed or oversized JSONL lines are skipped with counts; a partial result is labeled truncated. No unredacted prompt is logged or persisted by the plugin.

## Log Explorer and Fleet Metrics

Log Explorer scans event metadata or derived spans. It offers a bounded time histogram (without a duplicate time-bin table), facets for project, thread, provider, model, environment/worktree, child relation, kind, tool, status, and category, and a row table. Click a row to open its detail pane, or focus the results and use j/k (or arrow keys) to move between rows; only the visible row window renders, and keyboard selection reads event detail after movement stops. Close restores focus to the selected row, and a new scan clears the selection. The thread ID opens Waterfall without selecting the row. The detail pane also links to the BB thread and Context Inspector. Fleet rows hold only structural IDs and safe labels; raw event payloads are not indexed. The pane reads one event through `bb.sdk.threads.events.list`. Its Reveal toggle starts on and can hide the payload again. Query syntax opens from the info icon beside Window. Incomplete scans retain a visible Partial results indicator; detailed limits remain in CLI/JSON output.

The query grammar is AND-only `field:value`. Fields: `project`, `thread`, `provider`, `model`, `environment`, `worktree`, `child`, `kind`, `type`, `status`, `tool`, `category`, `duration`, and `metric`. Use quoted spaces, for example `project:"Oh My BB"`. Use `duration:>5s` or `@duration:<=100ms`. Metric drilldowns use `metric:turn-start`, `tool-completed`, `tool-measured`, `tool-failed`, `provider-retry`, or `recorded-failure` to show the exact counted event set while preserving the current filter. Aggregated “other” buckets cannot be filtered exactly and are not links. There is no free text, OR, or raw SQL. `--since` accepts 1h–99h or 1d–7d; the UI offers 1h, 6h, 24h, and 7d. Values are parsed at the boundary and parameterized where used in SQLite.

Fleet Metrics shows measured tool p50/p95, recorded failure rates and categories, a per-provider/UTC-hour median time to first recorded reasoning/message delta, and BB parent-thread spawn trees. The first-output measure is not network TTFT. The failure-rate tile links to its failed-tool numerator; the denominator remains in the tile. BB prunes historical token usage; surviving per-thread totals may include work outside the selected window. Fleet-window token/cache totals therefore remain **unknown**, not zero. Context Inspector has exact stored per-call usage for supported transcripts; fleet scanning does not fetch thousands of remote transcripts.

## Read-only fleet lifecycle

The SQLite connection opens `bb.db` in read-only, `query_only` mode at `bb.server.experimental_dataDir`. Fleet scans require the reviewed BB migration hash and expected columns/indexes. If they change, Explorer/Metrics report **schema-mismatch** and stop; SDK-backed Waterfall/Context still work. Candidate threads come from `threads.updated_at` **or an active status**: BB can append events to an active thread without advancing its thread row's `updated_at`. Optional project/provider filters narrow the cohort. Events are then sought by `thread_id` using BB's existing index. There is no time-only event index, so 7d scans can take minutes.

Jobs process five threads per batch and yield between 256-event chunks inside a busy thread. They publish partial progress through `bb.realtime`; the UI coalesces terminal status reads and refreshes active snapshots each minute. At most two scans run together. Cancel stops after the current chunk or thread and also releases a completed job's live tail. `SQLITE_BUSY` is retried twice. Scans cap at 7 days, 2,000 threads, 3 million events, and 50,000 events per thread; results report source-specific limit counts and skipped relevant payloads. Four job snapshots are retained in memory for up to ten minutes since their last access; an open viewer refreshes its snapshot and rebuilds it from source if evicted. Each response has the newest 250 rows globally, with at most 250 retained per thread. Latency samples are bounded and flagged partial if capped.

The CLI waits up to 25 seconds. A longer scan returns a **running**, partial result and a `scan_` ID; use `bb traces job <id>` to read it later or `--cancel` to stop it. Once a scan completes, BB event announcements rescan changed threads and add a separate Live histogram bin. The live tail covers the connected session only. Events are not replayed after a disconnect or reload; the UI starts a fresh source scan on reconnect. A snapshot or live-since label never claims lossless CDC.

## What the timeline means

A thread contains turns. Turns contain item spans (tools, commands, file reads and changes, reasoning, messages, search, delegation, compaction) and generic events for unknown types. Each `item/completed` pairs with the nearest unmatched `item/started` in the same thread and turn by item ID. Background task completions use the background-task start map, not a same-ID foreground item in another turn. A completed-only item has zero observed duration unless the provider supplied `durationMs`. The summary measures disjoint wall time rather than summing overlapping spans.

Queue, provisioning, first output, approval/input, user question, retry, and fallback waits are separate hatched spans. Idle time between turns is not agent work. `model / uninstrumented` is residual time inside a turn; it is not a measured API call. Open spans have `end: null` and `durationMs: null`; the focused running turn is drawn to a one-second local clock, while stored completed spans use their recorded end. A turn without a stored usage snapshot reports `usage: null` ("not stored"), never zero. BB prunes historical usage updates; Context Inspector reads exact per-call provider usage where a transcript exists.

Child BB threads are loaded through `parent_thread_id` with `--children`; Waterfall's nested lanes show in-thread delegations and tool hierarchy using `parentToolCallId`. A `childRef` that names a BB child thread can link its subtree to the delegation when CLI child traversal is requested. Provider-specific child references are not resolvable through the SDK alone.

## Layout

All four Traces navigation views use the same open **1440px** maximum canvas instead of BB Settings' standard **760px**. Their outer views have no enclosing card; headings or controls align below the tabs, while detail panes, stat tiles, and charts retain useful separators. Waterfall needs timing rows beside details. Context needs prompt sections beside a token ledger. Explorer needs facets, rows, and details. Metrics needs stat tiles and charts. Narrow containers stack these regions; tables scroll inside their own panels. The thread action tabs stack their detail areas in narrow side panels. Other plugin pages should use BB's standard width.

## Development

```sh
cd plugins/traces
npm ci
npm run typecheck
npm test
npm run build
```

`npm run fixtures` regenerates small redacted fixtures from `~/.bb/bb.db` in read-only mode. Every event query filters by thread ID. Fixtures cover claude-code, codex, acp-omp, and pi. Structural IDs and numeric timing/usage remain, while arbitrary text, paths, tool arguments, outputs, and environment values are replaced. The pure builder in `spans.ts` accepts plain events and thread metadata; future read-only fleet scans can reuse it without a new storage dependency.
`npm run prompt-fixtures` regenerates small Claude Code and Codex JSONL fixtures from real local transcripts. It replaces every prompt, tool description/schema and path with structural markers; it retains only record types, IDs, timestamps and numeric usage. These fixtures do not require provider files to run the test suite.

The synthetic SQLite fixture tests read-only schema gating, thread-first query selection, progress, cancellation, live replacement, latency, pruned usage, and redaction. Phase 3/4 adds no on-disk projection. A durable mirror would require a transactional BB-core change feed; rowid-only synchronization can miss deletes and rewrites. No suite-wide plugin source switch is needed. Install or reload this plugin alone from its worktree after checking `bb plugin source traces --json`.
