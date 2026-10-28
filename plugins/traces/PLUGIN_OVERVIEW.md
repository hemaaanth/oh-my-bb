Inspect BB thread events and provider transcripts as a timing waterfall and prompt context ledger.

## Find where time went

Open a thread from Traces in BB's navigation rail, a thread menu, or the side panel. Waterfall bars show turns, tools, child threads, and hatched queue, approval, retry and fallback waits. The breakdown counts exclusive wall time. Select a span for its metadata and hidden-by-default input and output.

## Inspect what the model saw

Context Inspector reads existing Claude Code and Codex transcripts on the thread's execution host. Select an API call to see system prompt sections, tool definitions, injected AGENTS/skills blocks, exact stored token and cache usage, and a diff from the previous call. Section sizes are estimates. Codex has no 5m/1h cache-write split or API request-start time; missing values say “not stored.” Other providers show an honest unsupported state.

## Debug from the CLI

`bb traces thread <id|--self> [--json] [--children] [--reveal]` puts errors and slow spans first. `bb traces prompt <id|--self> [--call N] [--json] [--reveal]` prints prompt sections and a per-call token ledger. JSON is bounded and agent-readable. Inputs, outputs, system prompts, tool definitions, and injected content are hidden by default. Reveal is explicit and may expose secrets.

## No extra storage

Waterfall reads BB's thread SDK. Context Inspector reads provider JSONL through this plugin's host entry. Traces writes no plugin database or disk cache. A small invalidated in-memory LRU holds only derived event trees, not transcripts. Redacted fixtures cover claude-code, codex, acp-omp, and pi events, plus Claude Code and Codex prompt records. The Log Explorer and Fleet Metrics belong to later phases.

Both navigation views use a wider canvas than standard Settings pages so timing rows and the token ledger stay legible. Thread side-panel tabs stack their detail areas in narrow space.
