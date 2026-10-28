Explore BB thread events and provider transcripts with waterfalls, prompt context, fleet search, and metrics.

## Four views, one source of truth

Traces opens Log Explorer by default. Its BB-native sidebar groups and searches the host's own threads by project and `thr_` ID, with opt-in hidden and archived results. Log Explorer searches bounded windows of BB's existing event metadata. It offers a time histogram, provider/tool/status/project facets, event or span rows, and an on-demand detail drawer. Waterfall adds turn summaries, stable thread/turn links, collapsible nested spans, keyboard navigation, and coalesced live catch-up backed by bounded incremental SDK event reads. Context Inspector reads Claude Code and Codex transcripts on the execution host to show system prompt sections, tools, injected AGENTS/skills blocks, per-call token/cache usage, and adjacent-call changes. Fleet Metrics shows measured p50/p95 tool latency, recorded failures, first-output timing where measured, and parent-thread trees. Drilldowns open the matching Explorer filter or per-thread view.

## Debug from the CLI

`bb traces thread`, `bb traces prompt`, `bb traces query`, `bb traces slow`, and `bb traces errors` return compact text or bounded JSON. Long fleet scans report progress and a `scan_` ID. Use `bb traces job <id>` to read or cancel one. Query terms are parsed AND-only field filters; no raw SQL or unbounded free text.

## Read-only and honest about missing data

Traces writes no plugin database, disk cache, or durable mirror. Fleet jobs read `bb.db` read-only, select threads first, then seek each thread's indexed events. They stream partial results, cap memory and time windows, and can be cancelled. A BB schema change disables only fleet views; SDK-backed thread views remain. The live tail covers the connected session, not missed events after a restart. Fleet-window token/cache totals remain **unknown** because BB prunes historical usage; a first recorded output is not network TTFT. Per-thread UI views show available payloads with Reveal on by default and clear them when it is turned off. CLI output remains hidden unless `--reveal` is requested.

All four navigation views use a wider canvas than Settings so timing tracks, prompt ledgers, facet tables, and metrics charts stay legible. Side-panel views stack for narrow space.
