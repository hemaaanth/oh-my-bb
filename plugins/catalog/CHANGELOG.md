# Changelog

## 0.3.1

- Remove the one-time `scripts/executor-skill-apps.mjs` migration script. The move to Executor 2 is complete.
- `executor_docs` no longer maps the Executor 1 doc name `execute` to `code-mode`.

## 0.3.0

- Move to Executor 2. Connections replace toolkits; connection IDs keep the old toolkit slugs, so existing mappings carry over.
- Sign in to each connection with OAuth (PKCE) from settings or `bb catalog executor connect`. Keep one refreshed grant per connection in the plugin database. The personal access token is now optional and only reads account health.
- Read skills from the apps in each thread's connections. Skill IDs are `<app>/<skill>`. Executor's own docs stay in `executor_docs`.
- Remove Git skill sources, skill sets, release approval, assignments and the Projects handoff. Migrations drop their tables and keep native capabilities.
- Add `scripts/executor-skill-apps.mjs`, which moves Catalog 0.2 sources into Executor apps that use `githubSkills`.
- Open settings without calling Projects, Agents or Executor's health API. The scheduled account check records its own error.

## 0.2.x

- Display the plugin as Executor. Keep `catalog` package/plugin/tool/RPC, storage, secret and assignment identities and existing skill roots unchanged.
- Bind Executor plugin RPCs to verified SDK caller identity. Reject plugin toolkit-map spoofing before lookup, queues, rate limits, audits or external work.
- Reject every generic RPC acceptance. Keep actual native interaction approvals and memory-only thread grants. Recheck access after a native approval waits.
- Add explicit standalone assignment readiness and source-first Projects C1 handoff, durable local activation, compatible-release identity, exact abort protection and reverse reconciliation with preserved provenance.
- Block standalone initialization over a known source. Require native metadata absence plus an explicit no-legacy declaration. Keep frozen destination records audit-only after reverse acceptance; normal operations use the exact reconciled source.
- Reject a different forward stage after reverse reconciliation. Preserve the frozen transfer/reverse binding and provenance, including after a delayed abort of the rejected generation.
- Keep Executor keys, toolkit maps, audit rows and sandbox projections in this plugin. Preserve every historical migration literal and stable source/release/skill/bundle ID.
- Use native Configuration, outlined Preferences, opt-in Agents source, scoped source/set/toolkit editors and collapsed More help. Preserve edits across asynchronous saves and data refreshes; restore native editor focus after close on desktop and mobile.
- Reject stale source, custom-set and toolkit edits before they can restore revoked choices. Serialize Preferences and toolkit-map saves; keep explicit toolkit clears available and failed durable grants out of memory. Preserve reads and offline revocation of existing larger toolkit mappings.
- Report durable toolkit saves as successful when advisory integration descriptions cannot refresh. Warn without rolling back grants or offline revocations.
- Ship package-local build/check commands, canonical SVG, authorized MIT grant and dependency notices. Exclude private configuration and test fixtures from runtime archives.
