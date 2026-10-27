## 0.4.2

- Remove the persistent autosave note.
- Use compact environment label/input rows without dividers.
- Replace the free-text icon field with a square emoji picker and clear default/reset states.

## 0.4.1

- Put Groups first and use freeform colour controls with full swatch buttons.
- Show compact native-style project metadata, a bounded initial list and square edit actions.
- Use stable-size dialogs and keyboard-accessible Environment, Suggestions and Skills tabs.
- Place masked token editing with environment metadata. Use pills for description tags.
- Remove confusing global assignment/refresh controls and the integration switchboard.
- Retire agent-membership writes and Tasks enrichment; preserve historical rows and saved skills.
- Refresh installed Executor and Status Sidebar automatically after relevant edits.

# Changelog

## Unreleased

- Use separate native Preferences and Oh My BB sections after host-owned Configuration. Remove the outer Projects heading, faux preference legend, duplicate gutters and empty status band. Keep group/project/profile management and costly refresh bounded and collapsed in boxed More. Preserve drafts, keys, IDs, caller guards and saved opt-ins; display Executor and Tasks over the existing catalog/task-workspaces IDs.
- Require explicit routing generation and learning actions. Remove reload/periodic generation and learning services, project/key/model refresh queues and trace-triggered learning. Preserve stored generated/manual profiles and learned guidance when optional evidence changes.
- Deny plugin-origin generation RPCs before any project/evidence reads or model calls using the existing SDK client guard. Clarify stale generated-profile replacement and cost in the refresh action and backfill help. Keep explicit-only learning.
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
