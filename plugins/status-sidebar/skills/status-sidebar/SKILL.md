---
name: status-sidebar
description: Understand Status Sidebar grouping, saved layout state, and explicitly enabled Agents, Projects, and Tasks integrations. Use for the Status Sidebar plugin, not BB's bundled Thread list preferences.
---

# Status Sidebar

Status Sidebar replaces only BB's thread-list slot. BB owns the rail, footer, new-thread button, navigation, split panes, and thread action registry. It requires no sibling plugin, API key, or model call.

## Layout

Select the provider in Settings → Appearance → Sidebar. Right-click or long-press a section heading for Group by, Subgroup by, and Sort by. Manual sort enables drag ordering. The sidebar is intentionally narrow. Expand More → Setup guide in Status Sidebar's plugin settings. The guide starts collapsed and has no rail page.

Never change the user's selected provider, grouping, collapse state, ordering, or BB Thread list preferences merely to validate the plugin. Use disposable fixture state. Never archive, move, delete, or create real threads or projects for validation.

Status summaries distinguish needs input, active work, drafting, unread, idle, and archived. Pinned and Later are organizational buckets. A parent includes its neediest child. Drafts are client-local. Thread menus use native BB actions plus the plugin's Later marker.

## Integrations

Oh My BB in plugin settings exposes `agentsIntegration`, `projectsIntegration`, and `tasksIntegration`. All default to false. Read their values only when needed; do not enable them merely because an owner is installed. Existing native flags import once with the same IDs and values. The custom switches stay hidden during that import generation. One explicitly authorized reload finishes removing the native editors. Do not retain duplicate controls or add an API credentials section.

- Agents (`agent-profiles`): Bots and Channels snapshots. DM creation/opening happens only on an explicit user action. Only exact owner-supplied thread IDs are excluded from Code while enabled. Do not infer ownership from titles, providers, or project IDs.
- Projects (`projects`): use the owner's groups and project order. When off, local sidebar groups remain available. Toggling never copies or deletes either source's data. Enabled-owner errors are surfaced; they do not authorize local fallback writes.
- Tasks (`task-workspaces`): expose Attach to task. Query-driven discovery and explicit attachment only. The owner stores credentials.

No startup installation, enabling, sibling probe, or source switch. Native BB host data is not a dependency on Sandboxes. Keep other owners' settings, IDs, and secrets untouched.

## Maintenance

Install, typecheck, test, and build from this package directory. Check SDK pins with `bb plugin types --check .`. Inspect generated distributables and source maps for private paths, not just source files. A local build is not a live reload or publication approval.
