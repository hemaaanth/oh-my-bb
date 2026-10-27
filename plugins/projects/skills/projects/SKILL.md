---
name: projects
description: Organize BB projects and inspect assignment readiness. Use for Projects groups, routing profiles, explicit legacy import and controlled assignment handoff.
---

# Projects

Use More in native Projects settings for bounded group, icon and routing-profile management. These work without assignment readiness or sibling plugins. More and its management/maintenance disclosures start collapsed and keep unsent drafts when closed.

Authentication stays in host-owned Configuration. Behavior has a separate native Preferences section. Oh My BB has real opt-in switches: Executor uses catalog, Tasks uses task-workspaces, and Credentials retains its legacy name. Keys and IDs do not change. Sources stay off without saved consent. Enable a source, then explicitly load choices under More → Assignments and migration. Missing definitions must not clear stored IDs.

## Readiness

`assignmentStatusV1({kind})` reports typed readiness for `bundles`, `applicationBindings` or `agentPreferences`. Missing `suite-v1` blocks authoritative assignment reads with `not-migrated`. Never catch this failure and synthesize empty skills or a null credential binding.

Import only on an explicit operator request. `importLegacyFromSourcesV1(null)` requires the named legacy sources and resumes a durable local import after interruption. `initializeFreshV1` requires a verified no-legacy installation; an unavailable source is not evidence of absence. Neither import nor export runs setup, regenerates profiles or requests a model.

## Handoff

Read the package's `ASSIGNMENT_HANDOFF.md` before changing authority. Freeze one assignment kind, export its exact generation, validate a staged receipt from its fixed authenticated destination, then commit source authority. The destination stays read-only until Projects reports matching `destination-owned`. No receipt uploaded by an arbitrary caller can activate ownership.

Existing setters forward one way only after commit. Reject destination bounce-back and stop on unavailable owners. Never restore source authority by downgrading code. Freeze and reverse-export every destination edit, reconcile its digest and only then resume source writes.

Do not run a real transfer, reload or source switch without the operator's cutover prerequisites and authorization. SDK isolated fixtures do not certify native provider lifecycle.

## Routing commands

`bb project-routing status`, `backfill`, `regenerate --project <id>`, `history`, and `learn` inspect or operate the existing routing feature. Generation and learning may use configured paid services; they are not harmless migration checks.

Profile generation and learning run only through explicit actions. Startup, reload, project changes, key/model changes, periodic time and trace collection preserve stored profiles and learned guidance. “Refresh stale generated profiles” and `backfill` create missing profiles and replace stale generated profiles; manual profiles stay unchanged. `regenerate` may replace the selected manual profile. These actions use the saved model, may incur cost and do not restore earlier values.

Generation RPCs require an SDK client caller; plugin-origin calls are denied. SDK client access includes UI, CLI and agents, not proof of human approval. No plugin initiating contract is approved. Learning is available only through the explicit `learn` command.
