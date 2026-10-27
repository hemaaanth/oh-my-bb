# Scripts merged into Projects

The `workspace-scripts` plugin and its package are retired. Install Projects 0.4.0 or later. Project commands remain in `bb.json` or legacy `paseo.json`; no repository commands move into plugin data.

## Existing installations

1. Back up the Scripts source, native KV and settings. Back up Projects and verify no active setup operation will be interrupted.
2. Disable Scripts and Projects during the state handoff. Copy every raw Scripts KV row into Projects under `scripts:`. Preserve terminal IDs, environment keys, approvals, recipe digests, nulls and timestamps. Preserve the effective `autoStartServices` setting as Projects `scripts:autostart` (default true only when not explicitly configured). Refuse conflicting destination values.
3. Publish and build Projects from main in its canonical local folder. Enable Projects and verify raw state, preferences, native menus, CLI and host contracts. Never invoke real setup or stop a service merely to test the migration.
4. Uninstall `workspace-scripts` only after verifying the copied state. Remove its registration, source directories and marketplace/package-list entries. Keep private backups outside both repositories.

The command is now `bb projects scripts <list|run|prepare|setup|teardown|stop|agent-setup>`. Routing commands are under `bb projects routing …`; their direct subcommand form also remains supported. The existing project-env compatibility command remains unchanged.

Approvals still bind the same agent, workspace and recipe digest. Provider setup stages the existing script; Agents still waits for it before the first prompt. Services reuse their original terminal records. Migration runs no application commands and creates no new approvals.

Projects settings owns Preferences, Projects, Groups, More and Oh My BB. The setup guide uses the standard Journal-style row. Groups organise projects and remain in Projects; Status Sidebar reads them only through its opted-in integration. Existing source/data backups are recovery material, not another installed plugin.
