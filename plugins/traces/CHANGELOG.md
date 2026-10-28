# Changelog

## 0.4.0 — 2026-10-28

- Add read-only, thread-first SQLite fleet scans with schema fingerprint checks, bounded windows, progressive realtime progress, cancellation, busy retries, connected-session live rescans, and active-thread inclusion when `updated_at` is stale.
- Add Log Explorer with parsed filters, time histogram, facets, event/span rows, SDK-backed detail, and thread drilldowns.
- Add Fleet Metrics with measured tool p50/p95, errors, first recorded output timing, spawn trees, and explicit unknown fleet-window token totals.
- Add `bb traces query`, `slow`, `errors`, and `job` agent CLI commands with bounded JSON and partial-result status.
- Fix background-task completion pairing when another turn reuses the same item ID; add synthetic SQLite and regression tests.

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
