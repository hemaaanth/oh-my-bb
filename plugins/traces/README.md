# Traces

Traces reads BB's own thread events as a debugging waterfall and existing provider transcripts as a Context Inspector. Waterfall uses `bb.sdk.threads.get/list/events.list`. Context Inspector resolves the execution host through the SDK and reads Claude Code or Codex JSONL there through this plugin's `bb.host` entry. Traces creates no database, file cache, or stored projection. The backend keeps at most five derived event trees in memory and invalidates them when BB announces new thread events; it does not cache transcript contents.

## Use

Open **Traces** in the BB navigation rail and enter a thread ID. Waterfall and Context Inspector are sibling views. Or select **Trace this thread** in any thread menu. The thread side panel offers separate **Trace this thread** and **Context Inspector** action tabs. Waterfall opens the latest turn by default; select All turns or enable Children to expand the trace. Hatched bars are waits. A stacked bar shows exclusive wall time, so parallel items and nested turns do not inflate the total.

```sh
bb traces thread <thread-id>
bb traces thread --self
bb traces thread <thread-id> --children
bb traces thread <thread-id> --json
bb traces thread <thread-id> --json --reveal
bb traces prompt <thread-id> [--call N] [--json] [--reveal]
bb traces prompt --self [--call N] [--json] [--reveal]
```

Text mode puts errors and slow spans ahead of the waterfall, or prints prompt sections and a nearby per-call ledger. `--json` returns bounded structured data. The CLI has a 1 MB output limit. CLI output and RPC responses hide event inputs/outputs, system prompt text, tool definitions, injected content, and unstructured errors by default. Arbitrary prompt or tool text can contain secrets without recognizable prefixes, so regex masking is not enough. **Reveal sensitive data** in the UI or `--reveal` in the CLI is an explicit request; do not share a revealed trace. Turning Reveal off clears the displayed content.

## Context Inspector

Pick an API call by number, use Previous/Next, or select a row in the token ledger. The page shows provider/model, system prompt sections, tool definitions, injected AGENTS/skills blocks when present, a context-window composition estimate, exact stored per-call token and cache usage, and a structured diff from the previous call. Section token sizes are character-based estimates, not billed tokens. The capacity bar reports "not stored" when the provider did not record it. Claude Code exposes cache writes split by 5m and 1h; Codex does not. Codex also does not record an API request-start time, so its call duration is "not stored."

The server joins `thread/identity.providerThreadId` to a transcript on the **thread's execution host**. The host entry searches `~/.claude/projects/*/<sessionId>.jsonl` for Claude Code or `~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl` for Codex. It does not assume the BB server's filesystem is the execution host. `acp-omp`, Pi, and other providers return an honest unsupported state. A missing transcript returns unavailable. No prompt or usage is fabricated.

Reads stream through at most 192 MiB, 60,000 lines, and 2 MiB per line. Up to 5,000 API calls are indexed in memory for one request. The RPC returns only the selected call, a 71-row ledger window, up to 100 tools and 32 injected blocks, and at most 160,000 revealed content characters. Malformed or oversized JSONL lines are skipped with counts; a partial result is labeled truncated. No unredacted prompt is logged or persisted by the plugin.

## What the timeline means

A thread contains turns. Turns contain item spans (tools, commands, file reads and changes, reasoning, messages, search, delegation, compaction) and generic events for unknown types. Each `item/completed` pairs with the nearest unmatched `item/started` in the same thread and turn by item ID. Background task completion events are thread-scoped, so their start is found by item ID in the same thread. A completed-only item gets zero observed duration unless the provider supplied `durationMs`. The summary measures disjoint wall time rather than summing overlapping spans.

Queue, provisioning, first output, approval/input, user question, retry, and fallback waits are separate hatched spans. Idle time between turns is not agent work. `model / uninstrumented` is residual time inside a turn; it is not a measured API call. Open spans have `end: null` and `durationMs: null`; the UI draws them through the last stored event, not the current clock. A turn without a stored usage snapshot reports `usage: null` ("not stored"), never zero. BB prunes historical usage updates; Context Inspector reads exact per-call provider usage where a transcript exists.

Child BB threads are loaded through `parent_thread_id` with `--children` or the UI toggle. In-provider delegation turns are nested through `parentToolCallId` in the same thread. A `childRef` that names a BB child thread can link its subtree to the delegation. Provider-specific child references are not resolvable through this phase's SDK alone.

## Layout

The Waterfall and Context Inspector navigation views use a **1440px** maximum canvas instead of BB Settings' standard **760px**. Timing rows need a track and detail drawer side by side. Context needs prompt sections beside a multi-column token ledger. The thread action tabs stack their detail areas below the primary view in a narrow side panel. Other plugin pages should use BB's standard width.

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

Phase 3 (read-only fleet scans + Log Explorer) and phase 4 (Fleet Metrics) are not included. No suite-wide plugin source switch is needed. Install or reload this plugin alone from its worktree after checking `bb plugin source traces --json`.
