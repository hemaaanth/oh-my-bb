# Status Sidebar

Group BB threads by working status with nested thread summaries and saved ordering.

## What it adds

Status Sidebar is an alternative thread list. Its distinctive features are attention-based status groups, a parent's neediest-child summary, and a private Later marker. BB already owns thread navigation, projects, native sections, split panes, thread actions, the navigation rail, and the footer. This plugin uses those host contracts instead of recreating their menus or changing BB core.

The list is intentionally narrow. Expand **More → Setup guide** in Status Sidebar's plugin settings for setup and usage. The guide starts collapsed and adds no navigation rail page.

Choose the list under **Settings → Appearance → Sidebar**. This per-client provider choice is not rewritten by the package. Saved grouping, subgrouping, sort, collapse keys, Later markers, and order IDs keep their existing names.

Right-click or long-press a group heading for Group by, Subgroup by, and Sort by. Manual sort enables drag ordering. Needs input and active work take precedence over an unsent draft. Draft state comes from the current BB client. A parent rolls up its children's neediest status. Expand children with the chevron. Keyboard shortcut targets follow visible top-level rows; child links retain normal focus and split behavior.

Thread context menus use BB's native action registry. Status Sidebar contributes Move to later and, when authorized, Attach to task. A real `thread.href` is retained for native link operations. Ctrl-click and Command-click use BB split navigation. Navigation calls the host callback to close the mobile sidebar. Opening a menu performs no thread operation.

## Independent operation

No sibling plugin is required. The base sidebar reads native BB thread, project, draft, host, and navigation data. It keeps local groups and orders in its own database. Those groups are the existing Status Sidebar workspace data, not a second copy of BB's native thread sections. They remain supported to preserve saved layouts. Native Thread list preferences remain untouched.

New installs start with a neutral General group. Existing group IDs and saved names are not renamed or removed.

Machine markers read BB's native host registry. Sandboxes is not called, installed, enabled, or required. Known sandbox providers retain lifecycle tones. Unknown lifecycle values render neutrally. An unavailable native host listing does not hide threads.

## Optional integrations

**Oh My BB** in plugin settings contains three real opt-ins. All default to off. The plugin never discovers, probes, installs, or enables a sibling during startup. Install and configure each owner separately. Changes take effect without a live source switch.

| Setting | Owner | Authorized behavior |
| --- | --- | --- |
| `agentsIntegration` | `agent-profiles` (Agents) | Load Agents/Channels snapshots, show Bots, exclude the exact Agents-owned thread IDs from Code, and open a canonical DM only on an explicit agent-row action. |
| `projectsIntegration` | `projects` (Projects) | Read and edit that owner's groups and project order instead of the local sidebar groups. |
| `tasksIntegration` | `task-workspaces` (Tasks) | Show Attach to task; search only after a query and attach only after a task selection. |

With Agents disabled, there is no Bots tab and no Agents-based thread exclusion. If enabled Agents is unavailable, Code remains usable and Bots reports unavailable. Inbound Agents updates are ignored while disabled; late results from an older authorization generation are discarded. Delegated agent children remain ordinary Code threads.

With Projects disabled, local saved groups work without any sibling RPC. Toggling Projects does not copy, merge, rename, or delete either source's groups. Saved Projects IDs and local IDs remain stored. If enabled Projects fails, the frontend reports the error and retains its current client snapshot. A fresh client can still show the native thread list in a fallback group. It does not silently write edits to the local source on a Projects failure.

Previously saved native flags import once with their existing IDs and values. The import generation retains only the legacy native editors; the Oh My BB switches stay hidden to prevent duplicate controls. One explicit plugin reload finishes the cutover. Later loads use private plugin preferences only and remove these keys from native Configuration. This plugin has no API credentials or permanent Configuration fields.

Tasks owns its credentials and provider configuration. The sidebar shows task search and attachment errors instead of silently treating them as an empty result. Disabling Tasks removes its menu action and rejects direct attachment RPC calls before any owner call.

Older private versions accessed integrations implicitly. Public migration does not treat their presence as consent. During an authorized cutover, explicitly enable the integrations the owner wants to retain, especially Projects when its groups supply the current layout. Do not infer opt-in from package installation or copy settings from another package.

## State and privacy

The plugin ID stays `status-sidebar`. Database migrations are append-only; existing IDs, orders, assignments, and local browser preference keys are preserved. No startup action moves, archives, deletes, or creates a user's threads or projects. Deleting a plugin-owned group requires confirmation with Cancel first and never deletes its projects or threads.

Private storage stays on the BB server. The package contains no conversation history, runtime database, credentials, personal project paths, or machine configuration. API keys are not required for the base sidebar. Optional owners keep their own settings and secrets.

## Development

Run these commands from this directory:

```sh
npm ci
npm run typecheck
npm test
bb plugin types --check .
npm run build
npm pack --dry-run
```

The package has its own dependency manifest and lockfile. It has no sibling imports, symlinks, or repository runtime dependencies. React, SDK, and host overlay libraries use the installed BB pins. Build artifacts are generated under `dist/`; inspect both assets and source maps before distribution. `npm pack` includes built files, branding, documentation, and the skill, not test fixtures or private source history.

The package build normalizes absolute paths in generated source maps, including BB's virtual dependency source names. Use `npm run build` rather than calling the raw builder for distributable assets. `npm pack` runs that build again through `prepack`.

A package-local build does not select or reload the live source. Owner review, public publication, source cutover, and private-source retirement are separate gates.

Projects group colours accept both the original named palette and six-digit hex values. Saved groups and group-source preferences are unchanged.
