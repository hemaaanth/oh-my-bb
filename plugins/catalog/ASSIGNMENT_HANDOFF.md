# Executor assignments — C1 destination adapter 1

Executor retains skill sources, releases, skills, capability sets, remote Executor auth, toolkit maps, approvals and audit rows. Its plugin identity stays `catalog`; no tool, RPC, storage, secret or assignment identity changes with the display name. Only bundle assignment authority moves through the existing C1 transition. No transfer, source probe or skill materialization runs at plugin startup. Opening settings must not initialize, stage, activate or materialize anything.

## Before ownership

An uninitialized Executor reads and writes assignments through reviewed Projects C1. It first checks `assignmentStatusV1({kind:"bundles"})`. A missing or older source, `not-migrated` source, committed destination without local activation, or reverse barrier is an error. It is not an empty projection. Unresolved bundle references remain stored; skill materialization fails before writing when a required definition is unavailable. The plugin never prunes unknown source references.

A new standalone installation requires explicit native-client `initializeAssignmentsV1({confirmation:"no-legacy-assignments"})`. It first checks Projects. Any answered source status, including `not-migrated`, requires explicit source import/handoff instead. If that call fails, native `bb.sdk.plugins.list()` must confirm Projects is not installed; an old, disabled or unreachable installed source cannot be bypassed. Unavailable native metadata also refuses initialization. The declaration attests no legacy data outside the installed source; metadata absence alone is not proof of that. Existing local legacy assignments, any staged transfer or an existing transferred authority still block the action. The durable initialization audit records the declaration and native metadata evidence. It never clears rows or runs setup/projection. SDK client includes app, CLI and agents; the migration channel does not attest a human decision.

## Forward transition

All source identities are strict schema 1, `kind:"bundles"`, `destination:"catalog"`, adapter 1. IDs are opaque, bounded strings. Canonical record/digest/page rules are copied from Projects C1. Runtime imports never cross package boundaries.

1. The operator freezes bundles in Projects at the exact running Executor plugin release.
2. Native-client `stageAssignmentsV1(identity)` checks fresh source identity, downloads all bounded frozen pages, validates counts/cursors/digest, and rechecks fresh source status before one local transaction stages data and provenance. There are no live destination assignment writes. Identical retries retain the revision and conflict receipt.
3. Authenticated Projects alone reads `assignmentReceiptV1(identity)`. It first records source `destination-staged`, then pulls the identical receipt and commits source `destination-owned`.
4. Native-client `activateAssignmentsV1(identity)` checks exact running release and freshly observes exact source `destination-owned`. Only then does a local transaction install assignments and commit a durable local activation receipt. Finding copied rows or a committed source is not activation. A crash rolls back the entire local activation.

Source records that reference missing definitions remain opaque references. Raw source legacy rows and all preexisting local legacy rows are retained as provenance. Legacy global, environment and profile scope is not silently promoted into effective native project/global references. Staging audit records source identity, digest, count, destination revision, conflicts, local provenance and time. Historical source/local snapshots are retained after later edits.

`assignmentAbortV1(identity)` accepts only verified Projects. It durably abandons that exact generation and discards only its staged authority. The tombstone also blocks a delayed in-flight import. An old notice cannot discard another generation or revoke active/reverse-frozen authority. A mismatched identity fails. Notice delivery is advisory; activation always requires a fresh exact source status even when no notice arrived.

## Ordinary operation and compatible releases

After local activation, Executor reads and writes locally, including after restart with Projects absent. There is no permanent Projects-required boot cycle. Verified Projects compatibility calls validate exact historical identity and local authority, then run locally. They never call Projects back. Read projections cover project/global contexts, bounded unique batched contexts, bundle assignments and full assignment snapshot. Mutations cover project/global toggles and removing a bundle's live references. Legacy provenance is not deleted by removal.

`destinationVersion` pins staging and first activation only. After a durable local activation receipt, it is immutable historical transfer identity. A compatible later release supports schema 1, adapter 1 and persisted assignment/provenance format 1 explicitly. It does not rewrite the receipt or compare historical release to current semver as an authorization rule. Every read/write/export rejects unsupported persisted format versions, older or newer. An incompatible downgrade is not an authority recovery method.

One-time dependencies: reviewed Projects source for staging, fresh source commit check for first activation, and verified source reverse barrier for reverse export. Ordinary active local reads/writes need none of them. Staged release A cannot first activate under B merely because B supports the format.

## Reverse transition and rollback

Projects records exact source `reverse-frozen` before requesting `assignmentReverseExportV1`. Only verified Projects can request it. Executor freshly verifies that barrier, then atomically freezes local writes and snapshots all current references plus retained source/local legacy provenance. Reverse pages are bounded to 200, share one durable generation/digest and include all destination edits. Null-generation retries resume the same snapshot.

A compatible B that never committed local activation may reverse-export A's preserved staged copy only after the exact source reverse barrier. It never activates or becomes writable. Reinstalling reviewed A to finish activation is the other recovery path. Unknown staged formats fail closed.

Projects validates all pages and commits reconciled source authority. The plugin's local rows remain frozen and audit-only. Only a fresh source `source-owned` status matching the complete stored transfer identity and durable local reverse generation permits read-through and write-through to Projects. Normal skill reads and materialization use that source projection; the destination tables never thaw or receive these edits. Missing source, mismatched identity/generation, a downgrade or a delayed advisory notice remains an error. A further forward handoff after completed reverse is unsupported. A different stage cannot replace the preserved transfer/reverse binding, and its delayed abort cannot discard it. An old Executor plugin release can only be restored after full reverse reconciliation. Keep the source/destination database backups and reviewed package lineage until reconciliation is verified.

## Validation

`assignments.test.ts` covers registered handlers, initialization, missing/not-migrated sources, read-only staging, opaque/unresolved/legacy retention, exact activation, compatible upgrades, unsupported persisted formats, crash rollback, advisory abort races and caller identity. Historical migration SQL hashes are pinned. The integration smoke uses the actual reviewed Projects C1 server and actual Executor plugin factory (`catalog` identity) in isolated public SDK fake hosts. No model, provider or production transfer is part of those checks.
