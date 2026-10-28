# Executor

Executor gives BB agents remote Executor services and approved versioned skills. Run assigned toolkits, subscribe to Git skill sources, review updates and choose enabled skills. Build custom capability sets and assign them globally or to native projects. The remote Executor server keeps integration credentials and tool rules. This BB plugin keeps its Executor API key server-side, stores mappings and routes thread calls.

The rename changes only the display name. The plugin ID remains `catalog`; the package remains `bb-plugin-catalog`. Existing `bb catalog` commands, skill and Executor tool IDs, RPCs, storage/secret identities, assignments and `catalog-*` skill folders remain unchanged. Skills stay fully supported in this plugin and their existing provider roots.

## Configuration

Set Executor URL and API key in BB's native Configuration fields. The key stays on the server. No custom auth form duplicates those fields.

Executor settings → Oh My BB contains optional integrations. Agents profile toolkit scopes are off on a fresh install. Saved false stays false. An existing agent toolkit map retains its previous consent until explicitly changed. No optional source is probed merely by opening settings.

Sources, custom sets and toolkit mappings use scoped native dialogs. More is collapsed help, including explicit assignment readiness. Connection diagnostics contact Executor only when Check Executor is chosen; opening settings reads local configuration and cached alerts.

Editors keep saved configuration/membership baselines. Stale saves fail without restoring revoked choices or dropping the open draft. Explicit toolkit clears remain available. Preferences and toolkit-map saves serialize independently; failed durable map writes do not install grants in memory.

## Assignment authority

Use the explicit source-first Projects C1 handoff for existing assignments. A new standalone install needs native confirmation that Projects is not installed and an explicit declaration that no legacy assignments exist. Unknown/unavailable authority never becomes an empty projection. After local activation, ordinary Executor assignment reads/writes work without Projects at startup. Reverse reconciliation restores source use without thawing destination rows. See ASSIGNMENT_HANDOFF.md.

## Approval

Plugin toolkit RPCs bind the supplied caller to the SDK-authenticated plugin ID. A plugin can decline its own paused work. Generic RPC acceptance is unsupported for all callers, including SDK clients. Native thread approval cards retain once/thread/all decisions and in-memory grants; stale revoked access cannot accept.

## Distribution

The runtime archive includes built artifacts, source maps, the canonical SVG, skills and public docs/licenses. It excludes tests, development fixtures, node_modules, local settings and user data. A source checkout has its own lockfile and all declared development dependencies. No sibling package import or root-only dependency is required. BB supplies the public Plugin SDK runtime.
