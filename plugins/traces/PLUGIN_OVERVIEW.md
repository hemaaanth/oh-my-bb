Read BB's own thread storage as a debugging trace: a per-thread waterfall of turns, tool calls, waits, and child threads.

## Find where time went

Open a thread from Traces in BB's navigation rail, a thread menu, or the thread side panel. Bars show the timeline. Hatched bars mark queue, provisioning, first-output, approval, retry, and fallback waits. The breakdown counts exclusive wall time, including idle time between turns. Select a span to inspect provider, model, worktree, duration, status, and its input and output.

## Debug from the CLI

`bb traces thread <id|--self> [--json] [--children] [--reveal]` puts errors and slow spans first. JSON returns the full span tree for agents. Inputs, outputs, and unstructured error details are hidden by default; reveal is explicit and can expose secrets.

## No extra storage

Phase 1 reads only BB's thread SDK. It builds spans in memory, keeps a small invalidated LRU, and writes no plugin database or cache. Real redacted event fixtures cover claude-code, codex, acp-omp, and pi. Historical token usage is shown as "not stored" when BB pruned it. Provider transcripts, the Context Inspector, Log Explorer, and Fleet Metrics belong to later phases.

The Waterfall page uses a wider canvas than standard Settings pages so the timing track and detail drawer remain legible together. The thread side-panel tab adapts to its available width.
