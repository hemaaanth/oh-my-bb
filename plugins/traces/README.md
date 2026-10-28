# Traces

Traces reads BB's own thread events as a debugging waterfall. It uses only `bb.sdk.threads.get/list/events.list` in phase 1. It creates no database, file cache, or stored projection. The backend keeps at most five derived trees in memory and invalidates them when BB announces new thread events.

## Use

Open **Traces** in the BB navigation rail and enter a thread ID. Or select **Trace this thread** in any thread menu. The thread's side panel also offers a **Trace this thread** action tab. The latest turn opens by default; select All turns or enable Children to expand the trace. Use the span detail drawer to inspect timing, tool input/output, model, provider, permission, and environment. Hatched bars are waits. A stacked bar shows exclusive wall time, so parallel items and nested turns do not inflate the total.

```sh
bb traces thread <thread-id>
bb traces thread --self
bb traces thread <thread-id> --children
bb traces thread <thread-id> --json
bb traces thread <thread-id> --json --reveal
```

Text mode puts errors and the slowest spans ahead of the waterfall. `--json` returns the tree and summary. The CLI has a 1 MB output limit; the UI is the fallback for a large tree. CLI output and RPC responses hide inputs, outputs, and unstructured errors by default. Arbitrary tool output can contain secrets without recognizable prefixes, so regex masking is not enough. **Reveal sensitive data** in the UI or `--reveal` in the CLI is an explicit request; do not share a revealed trace.

## What the timeline means

A thread contains turns. Turns contain item spans (tools, commands, file reads and changes, reasoning, messages, search, delegation, compaction) and generic events for unknown types. Each `item/completed` pairs with the nearest unmatched `item/started` in the same thread and turn by item ID. Background task completion events are thread-scoped, so their start is found by item ID in the same thread. A completed-only item gets zero observed duration unless the provider supplied `durationMs`. The summary measures disjoint wall time rather than summing overlapping spans.

Queue, provisioning, first output, approval/input, user question, retry, and fallback waits are separate hatched spans. Idle time between turns is not agent work. `model / uninstrumented` is residual time inside a turn; it is not a measured API call. Open spans have `end: null` and `durationMs: null`; the UI draws them through the last stored event, not the current clock. A turn without a stored usage snapshot reports `usage: null` ("not stored"), never zero. BB prunes historical usage updates. Phase 2 will fill gaps from provider transcripts.

Child BB threads are loaded through `parent_thread_id` with `--children` or the UI toggle. In-provider delegation turns are nested through `parentToolCallId` in the same thread. A `childRef` that names a BB child thread can link its subtree to the delegation. Provider-specific child references are not resolvable through this phase's SDK alone.

## Layout

The Waterfall navigation page uses a **1440px** maximum canvas instead of BB Settings' standard **760px**. A timing track, labels, durations, and a detail drawer must be visible together to compare spans. The separate thread action tab stacks the detail drawer below the timing rows in a narrow side panel. Other plugin pages should use BB's standard width.

## Development

```sh
cd plugins/traces
npm ci
npm run typecheck
npm test
npm run build
```

`npm run fixtures` regenerates small redacted fixtures from `~/.bb/bb.db` in read-only mode. Every event query filters by thread ID. Fixtures cover claude-code, codex, acp-omp, and pi. Structural IDs and numeric timing/usage remain, while arbitrary text, paths, tool arguments, outputs, and environment values are replaced. The pure builder in `spans.ts` accepts plain events and thread metadata; future read-only fleet scans can reuse it without a new storage dependency.

Phase 2 (provider transcripts + Context Inspector), phase 3 (read-only fleet scans + Log Explorer), and phase 4 (Fleet Metrics) are not included. No suite-wide plugin source switch is needed. Install or reload this plugin alone from its worktree after checking `bb plugin source traces --json`.
