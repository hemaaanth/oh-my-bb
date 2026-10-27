---
name: projects
description: Organize BB projects and inspect assignment readiness. Use for Projects groups, routing profiles, explicit legacy import and controlled assignment handoff.
---

# Projects

Manage groups in **Settings → Projects → Groups** and edit projects from **Settings → Projects → Projects**. Groups precede Projects. Project rows show repository, group, machine count and description source. Environment, Suggestions and Skills are tabs in a fixed-size settings dialog. More contains only the setup guide. Projects adds no rail page.

Preferences autosave. Configuration stores the OpenRouter and Jev keys. There is no integration switchboard. Projects never loads agent choices, manages agent availability or fetches task titles. Old agent membership is inert history; membership writes and new handoffs fail with `membership-retired`. Do not use those APIs to configure agents.

Projects works without Executor. Opening a project's Skills tab loads skill sets from Executor. If unavailable, preserve saved assignments and report that the chooser is unavailable. After a skill change, installed Executor receives only a project-ID refresh hint. Installed Status Sidebar receives automatic group-refresh hints. Sidebar owns its group-source preference.

## Project suggestions

When the user types a new-thread prompt, the composer can suggest a project by comparing the prompt with saved project descriptions through Jev. Exact repository references can match locally. This does not assign tasks or run an agent.

**Generate description** in the Suggestions tab explicitly asks the saved OpenRouter model to write a description and tags from repository README/package metadata. It may incur cost and replaces that project's description and tags. No Tasks data is read. The user can write and save descriptions directly. Never generate as a configuration check.

## Readiness

`assignmentStatusV1({kind})` reports typed readiness for `bundles`, `applicationBindings` or `agentPreferences`. Missing `suite-v1` blocks authoritative assignment reads with `not-migrated`. Never catch this failure and synthesize empty skills or a null credential binding.

Import only on an explicit operator request. `importLegacyFromSourcesV1(null)` requires the named legacy sources and resumes a durable local import after interruption. `initializeFreshV1` requires a verified no-legacy installation; an unavailable source is not evidence of absence. Neither import nor export runs setup, regenerates profiles or requests a model.

## Handoff

Read the package's `ASSIGNMENT_HANDOFF.md` before changing authority. Only skill bundles and application bindings have active ownership handoffs. Do not start an agent-membership handoff. Freeze one active assignment kind, export its exact generation, validate a staged receipt from its fixed authenticated destination, then commit source authority. The destination stays read-only until Projects reports matching `destination-owned`. No receipt uploaded by an arbitrary caller can activate ownership.

Existing setters forward one way only after commit. Reject destination bounce-back and stop on unavailable owners. Never restore source authority by downgrading code. Freeze and reverse-export every destination edit, reconcile its digest and only then resume source writes.

Do not run a real transfer, reload or source switch without the operator's cutover prerequisites and authorization. SDK isolated fixtures do not certify native provider lifecycle.

## Routing commands

`bb projects routing status`, `backfill`, `regenerate --project <id>`, `history`, and `learn` inspect or operate the existing routing feature. Generation and learning may use configured paid services; they are not harmless migration checks.

Profile generation and learning run only through explicit actions. Startup, reload, project changes, key/model changes, periodic time and trace collection preserve stored profiles and learned guidance. The explicit CLI `backfill` create missing profiles and replace stale generated profiles; manual profiles stay unchanged. `regenerate` may replace the selected manual profile. These actions use the saved model, may incur cost and do not restore earlier values.

Generation RPCs require an SDK client caller; plugin-origin calls are denied. SDK client access includes UI, CLI and agents, not proof of human approval. No plugin initiating contract is approved. Learning is available only through the explicit `learn` command.

## Project application environments

Projects owns each project's 1Password application environment, private service-account token, preparation records and guarded `query_clickhouse` tool. Remote Executor credentials are separate.

Use **Settings → Projects → Projects → Edit → Environment** to edit a project's configuration. Metadata and token saves in this editor do not run setup. Existing shared configurations are marked and require confirmation before edits.

`bb project-env list` and the existing `prepare`, `run`, `import-credential`, `bind`, `unbind` and `cleanup` commands remain available through the stateless `project-environments` adapter. They execute in Projects. Preparation and run can execute project setup; do not use them just to inspect configuration. Run application commands through `bb-project-env-run`. Never print injected secrets or replay preparation after an unknown outcome.

Private machine and workspace setup source belongs in the project's `.bb/setup/machine.sh` and `.bb/setup/workspace.sh`. Existing project manifests are separate and must be preserved.

## Project commands

Scripts is part of Projects. Use `bb projects scripts list`, `run <name>`, `stop <name>`, `setup`, `teardown`, `prepare` and `agent-setup <list|enable|disable>`. Declarations remain in project bb.json/paseo.json. Existing service terminals and agent setup approvals survive migration. These actions can run code; do not invoke them as read-only configuration checks. Routing commands are now `bb projects routing …`. The old Scripts plugin is retired. All project management is in Settings, not a rail page.
