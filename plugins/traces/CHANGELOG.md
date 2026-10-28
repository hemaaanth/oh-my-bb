# Changelog

## 0.4.0 — 2026-10-28

- Add read-only, thread-first SQLite fleet scans with schema fingerprint checks, bounded windows, progressive realtime progress, cancellation, busy retries, connected-session live rescans, and active-thread inclusion when `updated_at` is stale.
- Add Log Explorer with parsed filters, time histogram, facets, event/span rows, SDK-backed detail, and thread drilldowns.
- Add Fleet Metrics with measured tool p50/p95, errors, first recorded output timing, spawn trees, and explicit unknown fleet-window token totals.
- Add `bb traces query`, `slow`, `errors`, and `job` agent CLI commands with bounded JSON and partial-result status.
- Fix background-task completion pairing when another turn reuses the same item ID; add synthetic SQLite and regression tests.
- Refine the Explorer row/keyboard workflow and compact scan status, remove manual per-thread ID forms, adopt the BB-styled turn picker, and default per-thread UI Reveal on while keeping CLI output hidden without `--reveal`.
- Remove the redundant Explorer time-bin table and Waterfall Children toggle, harmonize the four open view shells, and window Explorer rows with local keyboard scrolling and deferred detail reads.
- Open the navigation-rail Traces root in Log Explorer while keeping explicit thread, Context Inspector, and Metrics deep links intact.
- Add an SDK-backed, project-grouped Traces sidebar with search and exact BB thread deep links, excluding archived and BB-hidden helper threads from rows and counts; inspired by Agent Traces (Nicolas Charpentier, MIT).
- Add turn summaries, stable turn links, collapsible nested lanes and keyboard selection; coalesce live signals, append from the last SDK event page, refetch rewritten/gapped history, and catch up on reconnect without adding storage or export paths.
- Add expandable safe command/tool groups, previous-turn comparison of time and error counts with honest usage snapshots, and bounded timeline zoom/pan/minimap with slow-call focus. Keep original nested spans and read-only behavior.
- Consolidate view navigation in the BB sidebar with host-matched surfaces, use the same BB-styled Radix Window picker across fleet views, persist submitted fleet filters and windows in deep links, label each breakdown color, and separate scanned-match display caps from sampled metrics and actual source limits.
- Use viewport height for Explorer rows, Waterfall spans/detail, and Metrics cards without widening the page. Give Waterfall one readable detail scroll surface and compact grouped toolbar controls; shorten Metrics copy while retaining visible source/sample limits and an expandable token-coverage explanation.

## 0.2.0 — 2026-10-28

- Add the Context Inspector view and thread tab with per-call prompt sections, tool definitions, injected context, token/cache ledger, and adjacent-call diff.
- Read Claude Code and Codex JSONL on the execution host through a bounded, read-only `bb.host` entry; show unsupported/unavailable states for other providers or missing transcripts.
- Add `bb traces prompt <id|--self> [--call N] [--json] [--reveal]` with secret-bearing fields hidden by default.
- Add sanitized provider-transcript fixtures and host/CLI redaction tests.

## 0.1.0 — 2026-10-28

- Add a per-thread event waterfall with turn and item pairing, nested delegations, child threads, waits, errors, and exclusive wall-time accounting.
- Add the `bb traces thread` agent CLI and Traces skill.
- Add the navigation page, thread side-panel tab, and thread-menu action.
- Hide event payloads by default; add explicit reveal controls.
- Cover claude-code, codex, acp-omp, and pi event shapes with redacted read-only database fixtures.
