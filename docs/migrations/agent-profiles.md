# Agents: portable identity and source migration

The package is `bb-plugin-agent-profiles`; its installed ID remains
`agent-profiles`. The display name is Agents. This release removes saved-profile
project/sandbox membership requirements, not native project access or application,
Executor, tool, model, or provider authorization.

A supplied task project/environment overrides saved launch defaults for that task.
It does not rewrite those defaults or move an existing DM. Preserve profile IDs,
revisions, default selection, DM reservations, homes, memory keys/files, channel
membership, current environments and provider sessions. Never uninstall to move
an existing installation.

## Runtime requirements

The package owns its source, lockfile, build and runtime dependencies. It does not
require Projects or a suite boot cycle to manage profiles. Managed turns require
separately configured Model Gateway, its host-side Pi extension and BB-supplied
URL/token, plus the supported Pi executable. Native Pi authentication is not a
fallback. See [setup](../../plugins/agent-profiles/SETUP.md) and
[runtime contracts](../../plugins/agent-profiles/RUNTIME_CONTRACT.md).

Tasks uses native BB threads; this release does not restore a saved-Agent shortcut
in Tasks. Optional integrations keep their own authority. Existing explicitly
mapped private-role compatibility is retained, but fresh installs do not create
private presets or probe private receivers at startup.

## Existing assignment history

Agents exposes the exact retained-only `agentPreferences` status. Historical
references are evidence, not current grants. Retired mutation methods fail
explicitly; profile creation does not synthesize global membership. Opaque
historical references remain stored rather than being inferred from current
profile definitions.

An older Projects release can reject this retained-only status during explicit
assignment initialization/import. That is fail-closed compatibility, not proof
that history is empty. Do not bypass the check, force a new import marker, or
initialize both sides concurrently. Existing installations that need the
retirement transition require the reviewed retirement-aware Projects counterpart
and a serialized maintenance cutover: pause old membership/setup callers, activate
portable Agents first, then retirement-aware Projects, verify the pair, and only
then resume callers. Publication of Agents alone is not that live cutover.

Any applied or pending C1 agent-membership authority must be reconciled using its
retained reviewed implementation before this portable release can load. The new
release preserves the historical migration SQL and rows but refuses unexpected
applied authority/records. A completed reverse can still leave an audit authority
row; do not delete it to pass readiness. Recovery requires a separately reviewed
transition, not a fabricated acknowledgement.

## No-loss activation checklist

1. Record the selected source, version, installed identity and current operation
   state. Stop new affected work and safely drain active jobs/memory recovery;
   metadata absence is not proof that work is idle.
2. Take restricted consistent package-data backups and preserve native settings,
   secret identities and host memory/home files. Verify a disposable restore for
   an actual data transfer. A source-only move needs proportional checks, not an
   unrelated whole-core dump.
3. Compare semantic state and immutable migration history. Whitelist only the
   intended change. Preserve unresolved IDs, old rows, opt-outs and unknown job
   outcomes. A source move must not execute setup, replay jobs or move a DM.
4. Build the reviewed public package with its own locked dependencies. Activate
   one canonical PATH source through supported BB controls, keeping the same ID.
   Verify requested/resolved/rootDir, running artifacts and preserved state.
5. Exercise the actual native UI/runtime without paid model/provider work merely
   for validation. Keep the old source/dependencies and private recovery evidence
   until acceptance. After new writes, use forward repair or tested reverse
   reconciliation; never restore an old database over new user work.

Existing awaited setup behavior remains; publication does not certify a new
native reservation or before-first-prompt preparation barrier. Do not retire the
old preparation path until its replacement and callers pass their own checks.

## Distribution and evidence limits

Public source contains only the reviewed current tree, not private branch history
or private proof archives. The owner grants MIT rights to owned Agents/Hempi code;
upstream/helper notices remain separate. Original replacement prompt wording and
local provenance are retained without a vendor refresh or blanket relicense.

The manifest retains its existing SDK floor. Builds and disposable runtime
fixtures used SDK 0.6.49; a lower native loader is not certified by those checks.
Component and fake-Pi tests do not certify paid model quality, every installed
extension or a completed native live migration. See the package's
[privacy](../../plugins/agent-profiles/PRIVACY.md),
[assignment history](../../plugins/agent-profiles/ASSIGNMENT_HANDOFF.md) and
[third-party notices](../../plugins/agent-profiles/THIRD_PARTY.md).
