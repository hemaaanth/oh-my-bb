# Portable identity: membership is retained history

This checkpoint supersedes the unpublished C1 Agents destination. The reviewed
recovery code is retained on `foundations/agents-c1-reviewed-471502f` at
`471502f15927a123e41d231a8995c86dfbc97b94`. Do not activate a membership transfer.
No live generation was read or changed by this work.

## Status and recovery

`assignmentStatus(null)` returns exactly:

```json
{"schemaVersion":1,"kind":"agentPreferences","state":"retained-only"}
```

This is not empty membership, an uninitialized destination, an access grant, or an
active owner. There are no stage, activation, receipt, write-through, or reverse
destination RPCs in the portable release. Projects owns its retirement/setup guard.
Bundle transfer and application bindings are not changed here.

All migration SQL stays exact, including the unused C1 table migration. Physical
tables, legacy rows, sandbox preferences, profile IDs, revisions, defaults, and
memory keys are not deleted or reinterpreted. If a C1 authority row or live C1
assignment record exists, factory startup and status fail with
`membership-recovery-required`. Preserve its database. Use the retained reviewed
recovery branch to reconcile the generation. The portable release still blocks an
applied authority/audit row after reverse; that unexpected database needs a separate
reviewed cutover. Do not delete rows to bypass the guard. This checkpoint requires
no applied C1 owner and never guesses activation or abandons a transfer.

## Portable task context

A valid saved profile can be discovered and selected in any native project and
runtime permitted by native access and independent capability consent. Project
membership and sandbox saved-profile selections no longer gate task launch,
delegation, mention discovery, or default-profile configuration.

`spawnProfile` and `spawnBuiltInProfile` accept optional `projectId` and
`environment`. A supplied project is explicit task context. It overrides saved
launch defaults for that task only. Its omitted environment uses native
`project-default`. An explicit environment requires an explicit project. With no
task context, the saved project/checkouts/machine resolution is unchanged; a task
with neither explicit nor saved project must choose one. Delegation uses its
parent's explicit project/environment. `bb agents ask --project` is explicit;
without it, the saved default resolution is used.

Native thread APIs still enforce target validity and access. Profile validation,
actual runtime support, toolkit/application consent, provider guards, and channel
membership are unchanged. No new preparation/provider/network operation is added.
Existing DMs stay on their reserved ID and current bound environment. Task context
never rewrites defaults or moves homes, memory, or resumed threads. Channel and
mission defaults are unchanged.

## Historical compatibility reads

`listProfiles` remains the profile-definition discovery API.
`profilesForProject({projectId})` returns the same portable profiles; the project
is not a membership filter. Neither method queries Projects.

`getSandboxAgents({hostId})` lazily reads the actual old saved selection, including
null and opaque unresolved IDs. It adds schemaVersion, kind, and retained-only
state. It never authorizes or blocks a profile. Malformed saved data throws.

`agentAvailability({agentId})` is historical only. It lazily reads actual Projects
`agentAssignments` and native project labels. Existing global/projects fields are
retained. `projectIds` also preserves unresolved source references, and the result
adds the retained-only marker. Unavailable/malformed source fails; it never means
empty history. This read is not used by portable launch, discovery, or the editor.

`setAgentAvailability`, `setSandboxAgents`, and `refreshAvailability` throw the
explicit `membership-retired` error. They are not successful no-ops. Profile
save/import/seed/default promotion/deletion makes no membership writes. No new
pairing editor replaces the removed availability controls. The profile editor's
native Default project choice is only a launch default, not a permission surface.

## Deployment and checkpoint limits

New public consumers must recognize retained-only before live activation. Paired
mixed-version fixtures show that old Projects rejects portable Agents setup/import,
and old Agents' automatic grant calls fail against retirement-aware Projects.
Therefore use a serialized maintenance cutover, not a zero-downtime claim:

1. Pause setup/import and old membership callers. Verify that no applied C1 owner
   or pending source transfer exists; use retained recovery if one does.
2. Deploy portable Agents first, preserving its data and defaults.
3. Deploy retirement-aware Projects before resuming setup/import or old callers.
4. Verify the exact retained-only pair and explicit mutation refusal, then resume.

This order is a deployment gate, not authorization to perform it here. Absence,
old readers, and source errors are not empty-history evidence. Fresh native setup
may acknowledge retained history only after the fixed exact Agents status check;
it neither deletes those references nor turns profile definitions into grants.
No actual transfer, install, live source switch, reload, model call, or publication
is authorized by this checkpoint.

Public release still requires the full Agents standalone, UI, privacy, legal,
Gateway/private integration, and actual runtime acceptance. Independent consent is
not broadened by portable identity.

## Unreleased changes

- Retired project/sandbox profile membership gates and public availability controls.
- Removed automatic global grants and the unpublished C1 destination state machine.
- Retained exact SQL history, physical rows, native access, and stable profile/DM data.
- Made explicit task context override saved launch defaults without persisting it.
