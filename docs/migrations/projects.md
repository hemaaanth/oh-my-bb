# Projects: public package and assignment ownership

Projects organizes native BB projects and groups. It does not own native thread or machine lifecycle. Its native organization and manual routing-profile controls work without another suite plugin.

This release adds explicit assignment readiness and a controlled handoff protocol. Installing it does not transfer assignments, provision a machine, or execute workspace preparation. Destination adapters must be implemented and verified separately before any handoff.

## Install one package

```sh
bb plugin install git:https://github.com/hemaaanth/oh-my-bb.git@main --plugin projects
```

The marketplace entry also tracks `main`. The package owns its dependencies, build, tests, skills and documentation. No repository-root install or suite-wide source switch is needed.

For an existing installation, preserve plugin ID `projects` and use BB's supported source change. Do not uninstall first. Keep the previous source and its dependencies until the new source, runtime and state checks pass.

## Preserve existing state before activation

1. Record the current requested/resolved source, plugin identity and enabled state. Capture consistent private backups of the Projects database and affected native settings/preferences. Keep code, data and registration backups distinct. Protect secret values; reports should contain equality results, not values.
2. Verify a disposable restore and semantic comparison before a schema or authority transfer. Preserve project/group IDs, ordering, routing profiles/history, assignment rows, explicit nulls, unresolved references and migration receipts. Do not treat an unavailable source as empty.
3. Check active routing or assignment operations before changing the running package. A successful build does not prove idle or a successful cutover. Do not run a model or provision a machine to test the migration.
4. Activate only the reviewed published package through a supported single-plugin path change. Compare requested/resolved/runtime root, plugin identity and semantic state. Do not overwrite unrelated checkout edits or change another plugin's source.
5. A one-generation preference import preserves the saved profile model and its old native value. Perform the documented Projects-only finishing reload to remove its duplicate native editor. Keys stay in native Configuration. A retry must preserve explicit destination values.

## Readiness is not an empty selection

An existing `suite-v1` marker retains the old assignment semantics. Without it, assignment APIs return `not-migrated`. They do not return empty skill lists or detached credentials. Native project organization remains available.

For an existing unmarked installation, use the explicit legacy import. The full import reads its named sources, stages a transaction and records a receipt. It resumes Sidebar remapping after interruption without recreating IDs. The partial compatibility import cannot certify omitted kinds as empty.

Use **Initialize without legacy assignments** only after verifying that no legacy assignments exist. Missing or disabled source plugins do not establish this. A client attestation is an operator action, not automatic discovery or proof of human identity. The SDK client channel also includes CLI tools and agents.

Both explicit setup actions must check each destination's authoritative assignment status before writing an import marker or receipt. An installed destination must be uninitialized. Active, staged, frozen, unsupported or unreachable destinations block setup without partial writes. Only native plugin metadata can establish that a destination is not installed; an RPC failure or empty legacy export cannot.

If Catalog was initialized independently before Projects was installed, keep Catalog authoritative. This release does not adopt that existing owner into Projects. Leave Projects assignment setup uninitialized; native project organization remains available. Do not clear Catalog's assignments or initialize a second empty owner to make setup succeed.

Run explicit setup actions one at a time. These checks are not a distributed transaction between plugins. Simultaneous first initialization is unsupported during this rollout. Already-completed valid setup retries remain idempotent.

Before activating new Projects with an older Catalog or Credentials, verify that those readers propagate readiness errors. A reader that converts an error into empty assignments can remove projected skills or detach configuration. Block that combination until its owner supplies a fail-closed reader.

## One writer per assignment kind

The source remains authoritative until the exact destination has staged and verified a frozen export. Each kind moves separately:

- bundles to Catalog;
- application bindings to Credentials;
- agent preferences to Agents.

The export contains assignment identifiers and retained provenance, not secret values or Executor configuration. Catalog keeps all Executor state. An application environment is not a BB machine or workspace.

Before commit, an exact-identity abort restores source writes and records the abandoned transfer. The destination discard notice is advisory. A late receipt cannot revive an aborted transfer. After commit, abort is forbidden.

After a completed handoff, old compatibility calls forward once to the destination. A destination callback to Projects is rejected. If the destination is unavailable, Projects does not start writing its stale copy again.

The initial destination release is pinned for staging and first activation. A durable destination activation receipt, not copied rows or an observed source status, establishes activation. Later releases may use the original immutable identity only when they support the persisted assignment format and adapter contract. They must not rewrite history to claim that the newer release originally accepted the transfer. An unsupported format fails closed on upgrade or downgrade.

## Recovery preserves newer work

Before new writes, use the matching reviewed rollback procedure. After the destination has accepted writes, freeze and reverse-export all of them before restoring source authority. Never restore an older database blindly and discard newer edits.

If the source committed but the destination never activated, a compatible adapter can supply read-only reverse export of the preserved staged copy after verifying the source's reverse-frozen state. Alternatively reinstall the exact reviewed initial destination release. Neither route invents an activation receipt or permits two writers.

Keep old assignment rows, snapshots, source roots and receipts until every consumer and recovery path has been verified. There is no automatic destructive retirement in this release.

See [the package handoff contract](../../plugins/projects/ASSIGNMENT_HANDOFF.md) for exact schemas, version/format checks, abort and reverse-reconciliation rules. Local fake-host and component tests do not certify native provider lifecycle, paid model behavior or live deployment.

## Settings and optional sources

Configuration holds static authentication. Outlined Preferences holds behavior. Oh My BB contains real optional source controls, off when no saved consent exists. More contains setup and migration help. Loading choices is explicit. Missing definitions retain their saved IDs; opening settings does not import state or probe siblings.

Use the native project picker, menus, footer and thread composer. This migration does not add a project/personality membership gate, a second workspace selector, or a required startup bundle.
