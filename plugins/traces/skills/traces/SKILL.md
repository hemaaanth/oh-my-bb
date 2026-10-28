---
name: traces
description: Debug a BB thread's latency, tool errors, provider waits, and child work with `bb traces thread`.
---

# Traces: thread waterfall

Use `bb traces thread` before guessing why a thread was slow or failed.

```sh
bb traces thread --self
bb traces thread thr_kxvdvw5nsh
bb traces thread thr_kxvdvw5nsh --children
bb traces thread thr_kxvdvw5nsh --json
bb traces thread thr_kxvdvw5nsh --json --reveal
```

`--self` uses the calling BB thread. It cannot be combined with a positional ID. `--children` follows BB child threads via `parent_thread_id`; in-provider delegations nest under their item when their `parentToolCallId` matches. The text view lists errors and the slowest spans first, then a compact waterfall. `--json` includes the full tree and a `summary` with exclusive wall time per kind. JSON is bounded by the CLI's 1 MB limit; use the UI for very large trees.

The default output hides all inputs, outputs, and unstructured error details. Those fields may contain tokens even when they do not look like keys. `--reveal` explicitly requests sensitive data. Never paste a revealed trace into a ticket or send it to another service. The UI has its own Reveal toggle. It resets when the view closes.

## Read the spans

- `wait · Queue` is the time between `client/turn/requested` and `turn/started`.
- `wait · Provisioning`, `wait · Approval / input`, and `wait · User question` are BB-side waits.
- `wait · Provider retry` and `wait · Model fallback` are delays after provider errors or fallbacks until work resumes.
- `wait · First output` runs from `turn/started` to the first recorded text delta or completed item.
- `idle · Idle between turns` is not agent work. The summary counts idle wall time separately.
- `model / uninstrumented` is the remainder inside a turn without a recorded item or wait. It is **not** a measured model API latency.
- `durationMs: null` means the span is still open or its completion was not stored. A completed-only item with no start has zero observed duration, not a fabricated cross-turn match.
- `usage: null` means "not stored." BB prunes most historical per-turn token snapshots; do not report null as zero. Provider transcript usage comes in phase 2.

Events are read through `bb.sdk.threads.get/list/events.list` in pages of 100. The plugin stores no trace data on disk. Its small in-memory LRU is invalidated by BB thread events. The raw event source is BB's own thread storage. Phase 1 does not read provider transcripts or scan the fleet.
