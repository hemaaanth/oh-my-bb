# Changelog

## Unreleased

- Native projects, groups, icons and routing work before assignment import and without sibling plugins.
- Remove automatic legacy import and startup retry probes. Assignment APIs fail explicitly on missing readiness; explicit owner import is transactional and resumable.
- Add identifier-only frozen assignment export, version-bound staged receipts, one-way forwarding and reverse reconciliation. Preserve null, unresolved and conflicting records. No live transfer is automatic.
- Move the saved profile model into Preferences with one-generation preservation. Keep authentication in native Configuration.
- Add explicit optional source controls and explicit choice loading. New integrations stay off without saved consent. Missing definitions retain selected IDs.
- Bound settings width and picker overlays. Preserve unsent group, icon, model and routing drafts across asynchronous updates.
- Keep native batch reads batched. Owner projections preserve order and repeated IDs; incomplete projections fail closed.
- Hold group actions until native data is ready while retaining loading-time drafts. Reverse reconciliation rejects missing legacy provenance before changing source authority.
- Preserve native group membership, order and default during explicit legacy import. Do not promote bundle assignments from a conflicting legacy credential binding.
- Keep partial payload imports not-migrated until explicit complete source import. Reject missing legacy collections instead of treating them as authoritative empty state.
- Add exact-identity owner-client abort before ownership commit. Retain abandoned identity/receipt audit, restore source writes without waiting for destination discard, and reject late stage/commit receipts.
- Include the authorized repository MIT license and verified dependency/component provenance notices in the package.
- Block explicit setup beside an installed active, staged, frozen, old or unreachable assignment destination. Distinguish native-metadata-confirmed absence from unknown availability before readiness/import writes.
- Preserve completed setup retries and standalone adoption. Document serial setup, unsupported destination-first adoption, durable activation, compatible upgrades and format-gated staged recovery (U1–U3).
- Reject repeated forward freeze after completed reverse before any mutation. Preserve the prior transfer/reverse binding and destination read/write-through across restart.
