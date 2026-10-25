# Scripts migration: decisions and lessons

Scripts is the first command-runner migration in this sequence. Its public package is `plugins/workspace-scripts`; the display name is **Scripts**. Stored IDs do not change with display names.

The owner accepted removal of the agent/workspace pairing editor from Scripts settings. Settings now contain native Configuration and More → Setup guide. Existing approved startup preparation and CLI management remain supported. This migration does not add an Agents settings screen.

## Ownership before controls

1. Decide which package owns a behavior before designing a settings form. Scripts owns repository command declarations, execution and run state. An agent owns its startup policy and existing execution location. Do not build a second agent/workspace pairing editor in Scripts.
2. Prefer native environment setup when it covers the need. BB owns automatic environment setup and teardown. A plugin may expose manual reruns or documented manifest fallbacks; it must not duplicate the native lifecycle.
3. Use `bb.json` as the primary declaration. Compatibility files are an absent-file fallback, not a competing source or a merge layer. Invalid primary configuration must fail rather than silently execute legacy commands.
4. A declaration is not execution approval. Keep automatic preparation opt-in. Recheck the approved command, environment, host and working directory before execution. Preserve narrow legacy approvals as narrow recipe snapshots; never promote them into permission to run arbitrary workspace commands.

## Independent packages and optional integrations

- Each package installs, typechecks, tests and builds from its own directory, with its own lockfile. No root runtime dependency and no sibling runtime import.
- An optional integration must remain optional at startup and during ordinary operation. Do not install, enable or probe another package on startup. Check an explicitly enabled integration when it executes; fail clearly if a required capability is unavailable.
- Sharing a native BB registry is not a dependency on another plugin. Scripts contributes to BB's thread-actions menu directly. It does not need Sandboxes to expose commands.
- Remove only the duplicate contribution you own. Keep other plugins' entries and the original host menu intact. Model Gateway and Sandboxes controls must not disappear with a Scripts shortcut.

## Settings and interaction design

- Keep plugin-wide settings and secrets in native Configuration where it fits. Populate only useful sections, in the accepted order. Do not add empty headings, passive prerequisite cards, duplicate toggles or a generic Oh My BB section without a concrete integration control.
- A list of real resources should have clear per-resource Edit actions and a distinct New action. A global Configure button must not unexpectedly rename or change the meaning of unrelated rows. First question whether the resource list needs to exist at all.
- Use the accepted themed picker components, not unstyled operating-system selects. Preserve keyboard behavior, scoped portals and focus return. Ignore empty or invalid selection emissions. Async option loading must not overwrite saved values.
- Make destructive operations explicit. Default confirmation focus to Cancel. Cancel, Escape and outside dismissal must preserve state. Prefer a reversible disable that retains configuration when disabling is the actual intent.
- Removing a control must not remove its data or silently disable an opted-in workflow. Verify the complete saved authorization, not just its visible row count. Never delete settings as a UI migration shortcut.

## Visual consistency

- Match the whole accepted pattern, not just colors: outlined recessed cards, quiet dividers, native headings, 6px corners and 12px card padding.
- Standard text surfaces use a 760px outer frame, 16px horizontal padding and 728px content at full width. Compare actual bounding rectangles and scrollbar behavior, not just CSS class names.
- Verify 320, 360, 390, 480, 640 and 760px widths with long labels. Lack of horizontal overflow does not prove that controls do not wrap. Keep compact actions together and let search fields shrink.
- Use one canonical SVG for static branding. Preserve functional avatars, animated state and native footer context menus.
- Keep status quiet. Show only useful operational state; put secondary detail on hover or behind disclosure. A menu footer should be short and aligned with the actual menu content. Scope any host-menu CSS to the owned contribution rather than changing other plugins' menus.
- Use the host-compatible desktop dialog and narrow-screen drawer pattern. Verify nested picker dismissal, Escape, outside click, focus return and visible mobile completion controls.

## Verification and publication

- Run the actual changed surface. Unit tests alone cannot prove host slot rendering, portals, layout or shared-menu behavior.
- For command runners, use disposable harmless fixtures. Do not run user scripts, real installers, scans, services, model requests or paid operations as a smoke test.
- Background capture can stall animations. Inspect computed styles, open state and ARIA before treating a capture artifact as a product bug. A scoped reduced-motion override may be used in the owned verification window; do not change product behavior just to make capture pass.
- Compare the public draft with the current private source before cutover. Keep authorized functionality. Do not copy private history, databases, credentials, environment files, machine-specific paths or setup assumptions.
- Add a package to the collection, package check list and marketplace only after its own checks pass. Keep its description and overview aligned. A main-tracking marketplace entry must use `ref: main`, not a semver range without a published matching tag.
- Owner acceptance, a public `origin/main` commit, a verified public live source and private package removal are separate completion conditions. A feature worktree and a private live copy are not a finished public migration.
- Switch only the selected plugin. Never use a suite-wide source switch. Preserve saved settings and approvals, inspect active operations, and keep dependencies in the installed source. Delete the old private package only after the public source is committed and verified live.
- Shared checkouts may contain unrelated work. Publish from a clean integration checkout and stage only owned paths. Do not merge an older migration draft wholesale or import other packages just because they share its branch.

## Deferred setup-guide reconciliation: do not start now

The owner reported two differences in Scripts' setup guide:

1. Its native HTML disclosure triangle differs from the collapse/expand icon used by accepted plugin guides.
2. Its inline disclosure and guide structure differ from the accepted setup-guide pattern in other plugins.

This is a deliberately deferred cross-plugin design reconciliation, not a request to fix Scripts now. The parent should record it and continue the migration sequence. Revisit the guide pattern in a separately scoped reconciliation after the relevant accepted implementations can be compared. Do not change the icon, introduce a shared UI framework or move the guide as part of this handoff.

## Sandboxes integration record

Sandboxes is not part of this Scripts publication. Its existing live review copy already had only the duplicate Scripts Machine-menu shortcut removed; Sandboxes and Model Gateway controls were retained. The small source patch is preserved in `scripts-sandboxes-shortcut.patch` for the separately owned Sandboxes migration. Do not add or migrate the whole Sandboxes package to publish Scripts. Carry this narrow removal when Sandboxes is migrated; do not start additional Sandboxes work from this note.

The archived patch uses zero context so blank diff-context lines do not trip repository whitespace checks. Inspect it against the eventual Sandboxes source; if applying it with Git, use `git apply --unidiff-zero`. Do not apply it to public main while the Sandboxes package is absent.

## Evidence boundary

The accepted package passed its own fresh installation, typecheck, 45 tests and build. Review included real native-menu and CLI fixture behavior, saved-approval preservation, and rendered settings from 320px through the standard frame. Security-tool downloads and real model execution were intentionally not exercised. The final operator handoff identifies the publication commit, private-removal commit and selected public runtime source.
