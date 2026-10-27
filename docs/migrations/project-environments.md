# Credentials into Projects

This is a maintenance migration, not a rename of a plugin ID. Projects owns the environment runtime, editor, definitions, tokens, prepared-checkout records and ClickHouse tool. Existing Projects bindings remain authoritative. `project-environments` stays as a stateless compatibility transport.

## Preserve first

1. Back up both plugin databases consistently, both plugins' native KV/settings, and private token files. Keep the original source directories and dependencies.
2. Rehearse on copies. Apply the exact append-only Projects migration list. Copy every raw column from `runtime_profiles`, `project_bindings` and `machine_preparations`; do not round-trip DTOs. Verify old Projects tables and migration hashes remain unchanged. Existing shared or unresolved references must not be discarded.
3. Copy source KV to the `environments:` prefix in Projects. Preserve null, empty opt-outs and raw values. Retain the old namespace.
4. Copy tokens byte-for-byte to Projects' private `secrets/onepassword` directory, with private directory/file modes. Refuse symlinks, unsafe IDs, orphan temporary files or conflicting destination bytes. Never print tokens or put them in the repository.
5. Copy private setup sources to their owning projects' `.bb/setup/` files without changing existing manifests. Do not run them as part of migration.

## Switch one owner

Stop new preparation and use a bounded maintenance window. Disable only the two affected plugins. Confirm source rows and files are stable. Perform the rehearsed copy, verify it, then write Projects' private `environments:migration:v1` receipt. Startup refuses an existing unmigrated Credentials database.

Publish reviewed code to `origin/main` first. Build the exact public files in each canonical plugin directory. Enable Projects with the migrated state, then replace the old `project-environments` registration with the canonical compatibility package, preserving its ID and install identity. Never uninstall it to move its source. There is only one writer after the switch.

Verify raw rows, all current project links, token bytes/modes, original settings/KV and sources. Read the new editor and old list/snapshot interfaces. Do not invoke preparation or application setup as a migration smoke test.

## Recovery

Keep both original backups and old sources. Before any rollback after new writes, export and reconcile those writes; do not blindly restore a pre-migration database. A lost remote preparation response is unknown, not permission to replay setup. Existing prepared checkouts and their metadata are retained.
