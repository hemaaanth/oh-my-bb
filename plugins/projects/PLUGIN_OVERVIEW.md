# Projects

Organize native BB projects into groups. Keep project icons, ordering, routing profiles and 1Password application environments in one place.

## Native first

Projects and groups work without sibling plugins and before assignment migration. Existing assignment state is not treated as empty while an import is pending.

## Optional sources

Enable Executor (`catalog`), Agents, Status Sidebar or Tasks (`task-workspaces`) only when needed. Native-aligned switches retain existing keys, IDs and saved consent. Integrations are off without consent. Load assignment choices explicitly in More; unavailable definitions retain their saved IDs.

## Controlled assignment ownership

Explicit legacy import preserves existing selections. Bounded frozen exports and version-bound receipts support a single-writer handoff to each assignment owner. Forwarding starts only after activation. Rollback requires reverse reconciliation of destination edits. Destination adapters must be ready before a real handoff.

## Routing

Authentication stays in host-owned Configuration. Preferences contains behavior, and collapsed More contains bounded group/project/profile management, migration, maintenance and setup. Profile generation and learning remain explicit, potentially paid actions. Existing native composer controls, menus and agent avatars remain host-owned.

## Project environments

Manage application environments from Settings → Projects → Projects, then edit a project. Each project gets its own configuration. Existing shared links are retained and clearly marked. Metadata saves check the saved project and environment revision. They do not run setup.

Projects owns environment definitions, service-account token files, preparation records and the guarded ClickHouse tool. Agent service credentials remain in remote Executor. Configuration is resolved through the existing on-host `bb-project-env-run` wrapper.

The old `project-environments` ID is a small compatibility adapter. It forwards existing RPCs and `bb project-env` commands to Projects and owns no second editor, data writer or preparation queue. A live merge requires a verified backup and a maintenance copy; it never imports secrets on startup. Project-specific setup sources belong in each project's `.bb/setup/` directory and are not bundled publicly.

## Scripts are part of Projects

Project commands and services remain declared in each checkout's bb.json (or legacy paseo.json). The native thread Scripts action, environment-scoped terminal tracking, service autostart preference and approved pre-prompt agent setup now run in Projects. Use `bb projects scripts …`. The separate Scripts package is retired and must be uninstalled after its saved state is migrated.

Projects has no navigation rail page. Settings contains Preferences with autosave, compact Projects rows with environment/routing editors, Groups with swatch controls, a single standard More setup-guide row, and explained integration switches. Groups stay owned by Projects; Status Sidebar can consume them.
