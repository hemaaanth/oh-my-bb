# Executor

Executor connects BB agents to a self-hosted Executor 2 server. Executor owns the apps, accounts, tools, approval rules and skills. This plugin signs BB in to Executor connections, records which connections each project, Agents profile or plugin uses, runs agent calls from the BB server, and projects the skills that the connections' apps ship.

The plugin ID stays `catalog` and the package stays `bb-plugin-catalog`. The `bb catalog` commands, `catalog_search`, `catalog_read` and `executor_*` tools, RPC routes and storage keys keep their names.

## Configuration

Set the Executor URL in BB's native Configuration. An optional personal access token reads account health for connection alerts; it never runs code. Executor settings → Oh My BB holds the optional Agents profile integration, which is off on a fresh install. Opening settings reads local data only.

## Connections

BB signs in to each Executor connection with OAuth (PKCE) and keeps one refreshed grant per connection. A thread's connections are its agent's, then its project's, then the global ones. The first is the default. Calls run on the BB server, so no token reaches a sandbox.

## Approval

Executor decides which calls need approval. The plugin shows each paused call as a native card in the thread, with once, thread and all choices. An agent cannot approve its own call. A plugin backend can decline its own paused work, never accept it.

## Skills

Executor apps ship skills, with IDs `<app>/<skill>`. `catalog_search` and `catalog_read` expose the skills of a thread's connections. The plugin writes them into `~/.agents/skills`, `~/.claude/skills` and each project workspace's roots. Native capabilities from other plugins stay available through Projects.

Catalog 0.2's Git sources, skill sets and assignments are removed. Executor apps publish skills instead.

## Distribution

The runtime archive includes built artifacts, source maps, the canonical SVG, skills and public docs/licenses. It excludes tests, development fixtures, node_modules, local settings and user data. A source checkout has its own lockfile and all declared development dependencies. No sibling package import or root-only dependency is required. BB supplies the public Plugin SDK runtime.
