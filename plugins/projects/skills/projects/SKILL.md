---
name: projects
description: Organize BB projects and inspect assignment readiness. Use for Projects groups, routing profiles, explicit legacy import and controlled assignment handoff.
---

# Projects

Use native Projects settings for groups, icons and routing profiles. These work without assignment readiness or sibling plugins.

Authentication stays in native Configuration. Behavior lives in Preferences. Oh My BB sources are optional and off without saved consent. Enable a source, then explicitly load assignment choices. Missing definitions must not clear stored IDs.

## Readiness

`assignmentStatusV1({kind})` reports typed readiness for `bundles`, `applicationBindings` or `agentPreferences`. Missing `suite-v1` blocks authoritative assignment reads with `not-migrated`. Never catch this failure and synthesize empty skills or a null credential binding.

Import only on an explicit operator request. `importLegacyFromSourcesV1(null)` requires the named legacy sources and resumes a durable local import after interruption. `initializeFreshV1` requires a verified no-legacy installation; an unavailable source is not evidence of absence. Neither import nor export runs setup, regenerates profiles or requests a model.

## Handoff

Read the package's `ASSIGNMENT_HANDOFF.md` before changing authority. Freeze one assignment kind, export its exact generation, validate a staged receipt from its fixed authenticated destination, then commit source authority. The destination stays read-only until Projects reports matching `destination-owned`. No receipt uploaded by an arbitrary caller can activate ownership.

Existing setters forward one way only after commit. Reject destination bounce-back and stop on unavailable owners. Never restore source authority by downgrading code. Freeze and reverse-export every destination edit, reconcile its digest and only then resume source writes.

Do not run a real transfer, reload or source switch without the operator's cutover prerequisites and authorization. SDK isolated fixtures do not certify native provider lifecycle.

## Routing commands

`bb project-routing status`, `backfill`, `regenerate --project <id>`, `history`, and `learn` inspect or operate the existing routing feature. Generation and learning may use configured paid services; they are not harmless migration checks.
