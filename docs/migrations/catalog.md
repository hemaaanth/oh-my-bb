# Executor migration

Executor is the display name of the `catalog` plugin. The package remains
`bb-plugin-catalog`. Skills remain part of Executor. This release does not rename
plugin IDs, commands, tool IDs, configuration keys, database identities, skill
IDs or `catalog-*` materialized skill folders.

## Keep the two access paths separate

The remote Executor server owns service credentials and service tool rules.
This BB plugin owns its server-side Executor API key, toolkit mappings, native
approval flow and skill sources/sets. Application runtime configuration is not
moved into Executor. No service credentials are copied into a sandbox by this
migration.

Skills work without a configured remote Executor. A new install has optional
Agents profile scopes off. Saved opt-outs remain off; existing explicitly saved
profile toolkit mappings retain their supported behavior. Installed, enabled,
configured and approved are different states. Opening settings reads local
configuration and cached information; a connection check is an explicit action.

## Preserve an existing installation

Do not uninstall `catalog` or create another plugin ID to obtain the new name.
Preserve the existing database, native configuration identity, server-side key,
source/release/skill/set IDs, toolkit mappings, approval audit and provider roots.
Keep the old selected source and dependencies until the new runtime is accepted.

Before a reload, arrange a fresh known-idle checkpoint for Executor calls and
paused approvals. An empty audit view is not a drain. Approve-for-this-thread
grants live in memory and clear on reload. Later calls need genuine reapproval;
never reconstruct a human decision from an audit record or a client label.

Use proportional backups for a source-path or caller-only change. An actual
assignment transfer requires consistent source/destination backups and a verified
disposable restore, scoped semantic comparisons, complete migration receipts and
an explicit allowed-difference list. Do not log keys or personal configuration.

## Existing assignment handoff

Follow [ASSIGNMENT_HANDOFF.md](../../plugins/catalog/ASSIGNMENT_HANDOFF.md) with the
matching Projects source contract. An old, offline or uninitialized source is not
an empty set of skills. Do not clear a migration marker to make setup succeed.

The source remains the only writer until its receipt-checked ownership commit.
The destination remains staged until its own activation receipt is durable.
Calls in that gap fail closed; they do not reopen source writes. A newer release
may use an activated generation only when its declared storage format supports
it. An unactivated staged generation has separate recovery rules.

Before ownership commit, an exact abort restores the source writer. After
activation and new edits, rollback requires reverse export and reconciliation.
Never restore an old database over new work. After a completed reverse, normal
reads and writes use the exact accepted source identity; the destination copy
stays frozen. Starting another forward transfer after that reverse is explicitly
unsupported. Both source and destination reject it without replacing the retained
identity or provenance.

A genuinely fresh standalone installation needs native confirmation that
Projects is absent and an explicit no-legacy-assignment declaration. An installed
but unreachable Projects is not absence. Initialize one side at a time. Installing
Projects after Executor already owns assignments must not create another writer;
that adoption transition is not supported by this release.

## Approval and editing

Plugin toolkit calls bind their claimed caller to the host-verified plugin
identity. A plugin may decline its own paused work. Generic RPC acceptance is
unsupported, including for SDK clients. SDK client includes app, CLI and agents;
it is not evidence of a human decision. Acceptance comes from a submitted native
approval card, with current toolkit, client and cancellation state checked again.

Editors preserve saved baselines. A stale source, set or toolkit edit cannot
silently restore a revoked choice. A clear remains possible when optional
connection metadata is unavailable. Durable assignment authority and advisory
connection descriptions are separate; a metadata refresh must not make a
persisted permission change look like a failed save.

## Publication and runtime cutover

Each package builds and tests with its own manifest and lockfile. Validate the
exact published source, built archive, maps, licenses and privacy boundary. Keep
marketplace overview bytes equal to the package overview and the `catalog`
registry entry unique.

For a maintained local installation, prepare the exact published source with its
own dependencies in the canonical checkout. Use the supported per-plugin
path-to-path activation. Do not select a feature worktree or switch the suite.
Verify requested source, resolved source, runtime root, version and install
identity. A finishing reload and native settings/approval/skill checks are still
required; a successful build or isolated component fixture is not live proof.

No remote service operation, model request or paid provider allocation is needed
to validate migration fixtures. Actual external access remains a separately
scoped acceptance step, never a side effect of opening settings.
