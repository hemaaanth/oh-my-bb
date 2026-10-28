---
name: traces
description: Debug BB thread timing and inspect Claude Code or Codex API prompts, tools, and token usage with `bb traces`.
---

# Traces: waterfall and prompt context

Use `bb traces thread` to see why a thread was slow or failed. Use `bb traces prompt` to inspect what Claude Code or Codex sent to the model.

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
- `usage: null` means "not stored." BB prunes most historical per-turn token snapshots; do not report null as zero. `bb traces prompt` reads provider usage per API call.

Events are read through `bb.sdk.threads.get/list/events.list` in pages of 100. The plugin stores no trace data on disk. Its small in-memory LRU is invalidated by BB thread events.

## Inspect the model context

```sh
bb traces prompt --self
bb traces prompt thr_kxvdvw5nsh --call 1
bb traces prompt thr_kxvdvw5nsh --call 14 --json
bb traces prompt thr_kxvdvw5nsh --call 14 --reveal
```

`--call` is 1-based across the provider session. Without it, the latest stored API call is selected. The CLI prints the system prompt sections, tool inventory, injected AGENTS/skills blocks when present, a nearby per-call token ledger, and a structured diff from the previous call. The default hides prompt text, tool definitions and injected content. `--reveal` is explicit and **may include credentials or personal data**; keep its output local. The UI has a Reveal control that clears the content again when switched off.

Claude Code reports exact API input, cache reads, cache writes (including 5m/1h), output, and thinking tokens when present. Codex reports input, cached input, cache writes, output, and reasoning; its 5m/1h split and API request-start timing are not stored. `null`/“not stored” is not zero. Prompt section token sizes are rough character-based estimates, not provider billing. The Context Inspector bar uses provider usage where stored.

The server resolves the thread's execution host through BB's SDK and asks this plugin's host entry to read that host's existing transcript. It never reads a server-local path for a remote thread. Claude Code transcripts live under `~/.claude/projects/*/<sessionId>.jsonl`. Codex transcripts live under `~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl`. Other providers return `unsupported`. Missing sessions return `unavailable`. Reads are capped at 192 MiB, 60,000 lines, 2 MiB per line, and 5,000 calls. A truncated result says what was skipped. No new database or disk cache is written.
