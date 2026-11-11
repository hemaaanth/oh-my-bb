# Repository rules

- Every plugin and agent package must install, build, and test from its own directory.
- Do not add repository-level runtime dependencies or imports across package directories.
- Integrations between packages must be optional and documented. One package must not
  install, enable, or probe another package during startup.
- List every package in `scripts/packages.txt`. It is the only package list that
  `scripts/check.sh` and CI use.
- Keep one lockfile per package. The repository root is not an npm workspace.
- Add plugins to `.bb/plugins.json` and `marketplace.json` only after their package-local
  checks pass.
- Release plugins independently with `<plugin-id>/vX.Y.Z` tags.
- Keep `bb.description`, marketplace copy, and `PLUGIN_OVERVIEW.md` aligned.
- Match standard plugin pages to BB settings' rendered content box, not an
  inner component's maximum width. The current outer frame is `max-w-[760px]`
  with `px-4` inside it (728px content at full width). Overview, detail, create,
  edit, and setup pages must align without scrollbar-driven shifts. Wider
  layouts need an explicit, documented reason, such as Journal's calendar.
- Keep setup guidance off the main content path. Link a dedicated setup page
  from settings and configuration warnings; use the standard page width and header.
- Keep plugin-wide settings and credentials in BB's native Configuration form.
  Group key-entry fields together and clearly separate them from behavior controls
  by section or field order. A Preferences section may follow a native key-only form.
  Do not replace native secret storage or settings commands just to change headings.
- Settings sections follow this order when populated: Configuration; Preferences
  (when needed); Credentials (only for plugin-owned per-resource controls or links);
  Advanced; More; Oh My BB. Per-resource credentials stay with their resource.
- Standardize static branding with one canonical SVG. Preserve functional animated
  avatars and their status feedback; do not replace them with branding glyphs.

## Concurrent plugin work

- Work in the checkout the user supplied unless they request a different one. Do not
  create a branch or worktree solely because the task changes a plugin.
- Keep current shared-checkout changes in place. Stage only task-owned paths or hunks.
- Give each plugin one writing thread. Read the other thread's handoff before taking over.
- Before any live build, reload, or source change, inspect `bb plugin source <id> --json`.
- Preserve the installed source path. Several plugins intentionally run from dedicated live worktrees.
- A single-plugin task must not run the suite-wide `use:local` source switch.
- Install locked dependencies in the plugin directory before builds. Cleanup must exclude installed local plugin roots and their node_modules.
- Report commit, changed paths, installed source, validation, remaining uncommitted work, and the branch if one was already in use.
- Do not remove existing unfinished branches or worktrees until their work is backed up and integration is verified.

## UI icons

- Use `experimental_Icon` from the Plugin SDK for app UI icons. Typed local wrappers must delegate to that renderer so app-wide overrides apply. Do not bundle a separate UI icon library.
- Declare missing artwork as SVG assets in `bb.branding.experimental_icons`, then use the namespaced name through the shared renderer. Keep artwork attribution with the assets.
- Standalone guest pages may use a local icon adapter because they run outside BB. Keep it separate from the BB app bundle.
