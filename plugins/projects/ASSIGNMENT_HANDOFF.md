# C1 assignment handoff, schema version 1

This contract is local to Projects. Destinations copy wire types; they do not import a shared runtime. No transfer runs at startup. No transfer has been run by this implementation.

## Readiness and authority

`suite-v1` absent means `not-migrated`. Assignment reads and setters throw `AssignmentError` with a typed `reasonCode`. The SDK serializes handler failures as `handler_error`; the stable reason code prefixes the message. `assignmentStatusV1({kind})` provides typed readiness without relying on error text. Old callers must stop on an error. They must not translate it to empty assignments or a credential detach.

`organizationSnapshot`, groups, icons and routing profiles do not depend on readiness. Ordinary reads never import legacy data or probe definitions. `snapshot` retains its public shape and assignment semantics; definition labels are unresolved IDs until choices are explicitly loaded with `assignmentOptionsV1`. Selected IDs are never removed because a definition is unavailable.

Explicit import entrypoints:

- `importLegacyFromSourcesV1(null)`: native client only. Reads the four named legacy sources: Status Sidebar groups, Credentials bindings, Catalog assignments, Agents profile IDs. Collections must be present; a missing collection is not an empty source. All reads finish before one local transaction applies data and saves a durable import receipt. Sidebar remapping is retried from that receipt. Only successful remapping writes `suite-v1`. Reload or crash does not regenerate group/profile IDs or repeat the import. No model/profile generation runs during import.
- `importLegacy(existingInput)`: existing payload and result shapes, native client only. Transactional one-generation payload staging. Identical input retries return the saved result, including after full source import. Different input fails. This partial payload cannot certify omitted kinds or Agents preferences as empty and never writes `suite-v1`; complete readiness through the explicit all-source import. Empty payload does not certify absence; use the separate fresh-install action.
- `initializeFreshV1({confirmation:"no-legacy-assignments"})`: explicit client attestation that no legacy assignments exist in any source. Missing/unavailable sources do not establish absence. Existing local non-null assignments or a pending import block initialization. Native group/icon rows with null credential selection do not block it. This never clears local or destination rows.

The public SDK authenticates `experimental_caller` as a plugin ID or the supported `client` channel. The client channel includes the app, CLI and agents; it is not a proof of human identity. Migration endpoints reject all plugin callers. No caller-supplied label or receipt can authorize a transition. Deployment operators must control access to their native client/CLI.

### Destination-first setup policy

Before `initializeFreshV1` or an incomplete `importLegacyFromSourcesV1` can write readiness or partial import state, Projects checks native installed-plugin metadata and every installed fixed destination's authoritative `assignmentStatus(null)`. No startup, native view or ordinary read performs these checks. Optional source consent does not bypass this authority check during an explicit setup action.

True absence in native metadata permits the existing standalone action and its local-data/explicit-declaration checks. An installed destination must be enabled and running and return strict `{state:"uninitialized",transfer:null,destinationRevision:null,conflicts:0}`. Native metadata failure is not absence. Disabled, offline, old, unsupported, active, staged, reverse-frozen or ambiguous state blocks before setup writes. An empty legacy export is never proof that no destination owns assignments.

The complete local status wire shape is `{state:"uninitialized"|"staged"|"active"|"reverse-frozen",transfer:TransferIdentity|null,destinationRevision:string|null,conflicts:number}`. Each destination implements this method for its fixed kind. Credentials and Agents must expose this same authoritative local contract when their adapters land; an installed old version without it blocks setup rather than being guessed empty. Fields and identity use the existing C1 bounds. Only the pristine uninitialized combination is accepted.

Completed readiness/setup retries remain local no-ops, including after ownership transfer. Incomplete import receipts are retained if a newly active/unavailable destination blocks resume. Payload-only `importLegacy` remains non-authoritative staging and cannot certify readiness.

Destination-first adoption is unsupported in this transitional version. Projects does not copy active destination rows back or initialize an empty competing owner. Native organization and routing remain available. Operators must run cross-plugin setup actions serially. This preflight is not a distributed lock; simultaneous cross-plugin initialization is unsupported and no distributed atomicity is claimed.


## Kind and destination

| kind | fixed destination | source data |
| --- | --- | --- |
| `bundles` | `catalog` | `project_bundles`, `global_bundles`, preserved raw legacy bundle assignments |
| `applicationBindings` | `project-environments` | every stored project credential binding, including explicit null, plus preserved legacy bindings/conflicts |
| `agentPreferences` | `agent-profiles` | `project_agents`, `global_agents` |

Project, bundle and profile IDs are opaque strings. Export contains assignment identifiers only. No definitions, auth settings, credentials, tokens, instructions, routing history or model data are exported. Unknown/deleted project and target IDs remain in the export. Raw legacy rows are provenance, not a second live assignment writer. Destinations must retain or quarantine them, not discard them.

## Frozen records and digest

Record union, strict objects:

```ts
type AssignmentRecord =
  | {type:"reference"; projectId:string|null; targetId:string}
  | {type:"binding"; projectId:string; credentialId:string|null}
  | {type:"legacyBundle"; bundleId:string;
     kind:"global"|"project"|"project-environment"|"agent-profile"; targetId:string}
  | {type:"legacyBinding"; projectId:string; credentialId:string|null};
```

`reference` is valid only for bundles/agentPreferences. `projectId:null` means global. `binding` and `legacyBinding` are valid only for applicationBindings. `legacyBundle` is valid only for bundles. Duplicate reference keys and duplicate live binding project IDs are invalid. Conflicting legacy binding values remain separate provenance records.

Canonicalization uses schema property order shown above. Sort records by their `JSON.stringify(record)` strings using JavaScript code-unit comparison, not locale comparison. Digest is lowercase SHA-256 of UTF-8 `JSON.stringify(sortedRecords)`. No whitespace or trailing newline. Both source and destination recompute this digest. Maximum 100,000 records per kind; exceeding it fails without changing authority. A page contains at most 200 records. Identifiers are bounded to 1,024 characters.

## Source endpoints

```ts
type TransferIdentity = {
  schemaVersion:1; kind:"bundles"|"applicationBindings"|"agentPreferences";
  generation:string; semanticDigest:string; destination:string;
  destinationVersion:string; // exact stable x.y.z pin for staging/first activation
  adapterVersion:1;
};

type Status = {
  kind:TransferIdentity["kind"];
  state:"not-migrated"|"source-owned"|"frozen/exported"|
        "destination-staged"|"destination-owned"|"reverse-frozen";
  transfer:TransferIdentity|null;
  reverseGeneration:string|null;
};

assignmentStatusV1({kind}): Status;
assignmentHandoffV1({phase:"freeze",kind,destination,destinationVersion}): Status;
assignmentExportV1({kind,generation,cursor?:number}): TransferIdentity & {
  frozen:true; records:AssignmentRecord[]; recordCount:number; nextCursor:number|null;
};
assignmentHandoffV1({...identity,phase:"stage"|"commit"|"abort"|
                    "reverse-freeze"|"reverse-commit"}): Status;
```

Freeze is a local atomic snapshot and write barrier. It generates a new opaque generation. Repeating freeze for the same in-flight destination/version returns the same transfer. A different destination/version fails. Export requires the exact generation and allows only the client or authenticated named destination. Cursor starts at zero and is an ordinal into the durable snapshot. Each page repeats identity, digest and total count. Original export pages remain frozen after activation; they are not current destination projections.

Stage and commit are native-client operations. Each pulls a fresh receipt from the fixed destination through `bb.sdk.plugins.callRpc`. Projects never accepts a caller-uploaded receipt as authority. The destination must support adapter version 1. Staging, an unactivated staged receipt and first activation require the actual running release to equal `destinationVersion`. After durable local activation, that value is immutable historical identity, not today's release authorization rule. Identity and total count must match the frozen source snapshot. The staged destination revision and conflict count are pinned at stage and must be identical at commit. An old source without these endpoints cannot transfer ownership; a new destination must stay read-only.

### Precommit abort

`abort` is native-client only and requires the exact transfer identity. It is allowed only from `frozen/exported` or `destination-staged`. One local transaction stores the abandoned identity, previous state, prior staged receipt and abort timestamp in `assignment_aborts`, then returns the kind to `source-owned` without changing assignments. A crash cannot persist only half of this transition. A repeated exact abort is a no-op, including after another generation starts; it cannot abort that newer generation. Mismatched identity fails. Abandoned generations cannot export, stage or commit. Abort is rejected after ownership commit, including during reverse reconciliation.

Projects durably aborts **before** sending a best-effort `assignmentAbortV1(identity)` notice for an abandoned staged transfer. It does not wait for delivery; a missing, old or stuck destination cannot strand the source writer. Retrying the abort may retry this notice. Delivery or failure is never authority. Stage and commit recheck exact identity and expected state after every awaited destination receipt, so a late receipt cannot resurrect an aborted transfer.


## Destination adapters required before activation

Each destination must implement and verify these methods before activation. Availability is a per-package prerequisite, not a new shared runtime. Installing Projects never transfers ownership.

1. `assignmentReceiptV1(identity)` returns strict `{...identity,phase:"staged",recordCount,destinationRevision,conflicts}`. `destinationRevision` is the opaque frozen staged-assignment revision; `conflicts` is the nonnegative count of retained/quarantined source records, at most recordCount. Authenticate Projects as caller. Return this only after an atomic, idempotent staged import has recomputed the complete source digest, preserved null/unresolved/conflicting rows, and durably saved provenance. Same generation/digest is a no-op. Different identity, unsupported format or a running release mismatch before first activation fails without clearing stage/data. No destination assignment writes are allowed while staged.
2. Projects stores the full validated receipt with `destination-staged`, then pulls and verifies an identical receipt again during commit. The local audit wrapper records schemaVersion, sourcePluginId, sourceGeneration, sourceSemanticDigest, destinationRevision, countByKind, conflicts, phase and completedAt. Projects atomically stores `destination-owned` **before** the destination may enable writes. Immediately before first activation, the destination must freshly observe `assignmentStatusV1({kind})` with exactly its identity and `destination-owned`; cached/staged status is insufficient. Durable activation requires an activation receipt committed in the destination's own database. Observing source ownership or finding copied rows is not activation. A crash before that local receipt remains pre-activation. No separate destination-first writable commit is permitted.
3. `assignmentReadV1({...identity,method,input})` returns the existing method's DTO or the kind-specific projection described below. `assignmentWriteV1({...identity,method,input})` returns `{ok:true}`. Authenticate Projects and validate the full immutable active identity, supported schema/adapter/persisted format and local authority/freeze state on every operation. After durable activation, a compatible running release need not equal the historical `destinationVersion`. Perform operations locally; never call Projects' compatibility setters/readers back. Do not weaken existing native caller/access checks merely because Projects forwarded an operation.
4. On rollback, `assignmentReverseExportV1({...identity,cursor:number,reverseGeneration:string|null})` atomically freezes destination writes and creates/reuses one durable reverse snapshot. Return strict `{...identity,reverseGeneration,reverseDigest,recordCount,frozen:true,records,nextCursor}`. Every page must refer to that same snapshot. A null reverseGeneration on retry must resume it, not make a new generation. Recompute reverseDigest over all current destination assignment records, including every new write and preserved provenance. Return at most 200 records per page. Stay frozen until source authority has durably resumed. Never resume destination writes merely because Projects is unavailable.
5. `assignmentAbortV1(identity)` returns strict `{ok:true}`. Authenticate Projects. Durably abandon and discard only that identity's staged copy, idempotently; never discard another generation or use the notice to change active ownership. A receiving destination must never activate an abandoned identity, including on a delayed receipt retry. Receiving no notice does not permit activation: the fresh exact source `destination-owned` check is always required. This notice is advisory; Projects has already revoked the precommit transfer locally.

### Compatible releases and recovery (U1–U3)

- **U1 — durable activation and immutable history.** Release A is pinned for staging and first activation. After a committed local activation receipt, compatible B may serve the same identity only with explicit support for schema 1, adapter 1 and the persisted assignment/provenance format. Preserve all receipts and provenance. Never rewrite the original receipt to pretend B accepted the transfer; any diagnostic running version is a separate value. Semver alone is not compatibility proof. Projects forwards the original identity, and exact stage/commit retries after `destination-owned` are local no-ops without requesting A's old binary or a new receipt.
- **U2 — unactivated staged recovery.** If the source commits A's stage, then A becomes B before the destination commits its local activation receipt, B remains pre-activation. It cannot infer activation from source status or copied rows. A different release fails first activation and the unactivated staged receipt check. A format-compatible B may provide authenticated read-only reverse export of the preserved staged copy only behind the exact source `reverse-frozen` identity; it never activates or accepts writes. Projects then reverse-reconciles the complete records and provenance. Reinstalling the exact reviewed A with support for the unchanged persisted format is the other recovery. Never fabricate an activation receipt or blindly restore an old database.
- **U3 — persisted-format and downgrade gates.** Persist an explicit assignment/provenance format version. Every release checks supported formats before reading, writing or exporting; both higher and lower unsupported versions fail closed without mutation. A downgrade is not evidence of compatibility. Separately reviewed migrations preserve historical receipts and all edits. Compatible B's new edits and retained provenance must return in complete reverse export with the original transfer identity and a fresh reverse digest. Exact-identity reverse exports and advisory abort notices also require supported formats; a release mismatch never permits guessing activation or abandonment. Abort never changes active ownership.


### Compatibility methods

| kind | read methods / outputs | forwarded mutations |
| --- | --- | --- |
| bundles | `projectContext({projectId}) → {bundleIds}`; `globalContext(null) → {bundleIds}`; `bundleAssignmentSnapshot(null)` and `bundleAssignments({bundleId})` retain existing DTOs | `setProjectBundle`, `setGlobalBundle`, `removeBundle` with existing inputs |
| applicationBindings | `projectContext({projectId}) → {credentialId}`; `credentialAssignments({credentialId})` retains existing DTO | `updateProject({projectId,credentialId})`, `removeCredential` |
| agentPreferences | `projectContext({projectId}) → {agentIds}`; `globalContext(null) → {agentIds}`; `agentAssignments({agentId})` retains existing DTO | `setProjectAgent`, `setGlobalAgent`, `removeAgent` |

Compatibility reads are projections of the destination once owned, never the stale source tables. Each kind also supports `projectContexts({projectIds}) → {projects:[{projectId,...kindFields}]}` through `assignmentReadV1`: kindFields is `{bundleIds}`, `{credentialId}` or `{agentIds}` as above. Input contains at most 5,000 unique project IDs. Return exactly one row per requested ID, without unknown or duplicate IDs. Projects rejects missing rows instead of inventing empty/null assignments. The source preserves the original caller's order and repeated IDs in its public full-context DTO. Native-only batches retain their existing batched SQL path; transferred batches make one owner read per kind, not one RPC per project. Projects composes `globalContext` and `snapshot` from the same authoritative projections. The icon part of `updateProject` stays native; credential forwarding must succeed before an accompanying icon edit is applied.

Before handoff, old Catalog/Credentials write-through stays local to Projects. Installing a new destination does not change this. After handoff, an authenticated destination-origin callback fails with `handoff-loop`, including after a destination downgrade. Other existing callers and native UI setters forward once. Missing/old/unavailable destination returns `owner-unavailable`; source authority never resumes as a fallback. Destination-origin reads also fail closed to prevent projection recursion.

**External consumer gate:** any old Catalog reader that catches a Projects assignment error and treats it as `[]` can delete materialized skills. Any Credentials reader that treats it as null can detach a binding. Such operations/cutovers must remain blocked until their owning package supplies a fail-closed reader. Projects cannot safely fix that behavior in another package. Old destination versions must not be rolled back after activation without reverse reconciliation.

## Reverse transition and crashes

`reverse-freeze` first records a durable Projects write/read barrier. The destination may still own writes until it accepts the authenticated reverse-export request and freezes itself; Projects is not a writer during this interval. `reverse-commit` pulls the entire frozen destination snapshot in bounded pages and validates identity, cursors, counts, kind, duplicate keys and digest. It also requires every preserved legacy provenance row to remain present; an incomplete destination export cannot erase unresolved/null/conflicting legacy input. It replaces only that kind's assignments, retains native groups/icons/routing, and records reverse generation/digest and `source-owned` in one transaction. Destination stays frozen. Matching retry is a no-op. Partial download, omitted provenance, invalid page, crash, missing destination or digest mismatch leaves Projects `reverse-frozen` with no source writes. Reverse reconciliation is required even if operators believe no new writes occurred.

Migration SQL is append-only. Existing migration text is unchanged. Original assignment tables and frozen export pages are retained for evidence; destination ownership prevents their use as a second writer. No obsolete assignment rows are deleted during this release's forward handoff.

## Expected data differences

- Appended transfer/export/provenance/import-receipt tables, the append-only abandoned-transfer audit table, and readiness/import receipts.
- One-time preference import of the saved effective routing model; its old native value is retained. One finishing reload hides the legacy model editor. Auth remains native.
- Optional source preferences default off when no saved consent exists. Explicit saved preference values survive reload; views do not probe optional sources.
- Explicit import may add native groups and stable mappings. A name collision gets an explicit imported suffix rather than guessing group identity from a name. Existing groups are not merged by name. Existing native group membership, order and default win conflicts; the original legacy placement/default input remains in the import receipt.
- Legacy null bindings, conflicting bindings, and unmapped bundle assignments are preserved as provenance. Existing non-null local bindings win conflicts. A conflicting legacy profile does not promote its bundle assignments onto the native project's effective binding. Operators reconcile the retained provenance in the destination.
- Forward handoff changes authority/receipts only. Reverse reconciliation intentionally imports destination edits for the affected kind. No profile UUID regeneration, setup, token access, model calls, provisioning, source switch or live transfer is part of import/export.
