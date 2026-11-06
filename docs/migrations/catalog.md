# Executor migration

Executor is the display name of the `catalog` plugin. The package stays
`bb-plugin-catalog`. Plugin IDs, `bb catalog` commands, tool IDs, RPC routes,
configuration keys and `catalog-*` skill folders keep their names.

## Catalog 0.2 to 0.3 (Executor 1 to Executor 2)

Executor 2 moves most of the old plugin logic onto the Executor server.

| Concern | Catalog 0.2 with Executor 1 | Catalog 0.3 with Executor 2 |
| --- | --- | --- |
| Services | Executor integrations | Executor apps (TypeScript code with tools, skills and accounts) |
| Which tools an agent sees | Plugin maps a scope to a toolkit | Plugin maps a scope to a connection; Executor enforces it |
| Ask first | Toolkit policies, per toolkit | App code, per tool, the same for every caller |
| BB credential | One server-side API key | One OAuth (PKCE) grant per connection, kept in the plugin database |
| Skills | Git sources, skill sets and assignments in this plugin | Apps ship skills; `githubSkills` loads a repository's skills |

### Steps

1. Run Executor 2 next to Executor 1. Executor 2 cannot upgrade an Executor 1
   database in place.
2. Rebuild each Executor 1 integration as an Executor 2 app, then sign in to its
   accounts. Executor 1 credentials are encrypted for that server and cannot move.
3. Create one Executor 2 connection per Executor 1 toolkit, with the same ID.
   The plugin's scope map then carries over unchanged.
4. Back up `~/.bb/plugins/catalog/data.db`, install Catalog 0.3, configure the
   Executor URL, and run `bb catalog executor connect <id>` for each connection.
   Migrations drop the old source, set, release and assignment tables. Native
   capabilities from other plugins stay available through Projects.
5. Choose sandbox skills again. Skill IDs are now `<app>/<skill>`.
6. Stop Executor 1. Keep its volume and backups until nothing more needs to be
   recovered from it.

### What changes for callers

- `executor_execute`, `executor_docs` and `executor_resume` keep their names.
  The `toolkit` argument now names a connection.
- Plugin backends keep `executorCall` and `executorDecide`. Tool paths follow
  the app slugs, for example `tools.slack` instead of `tools.slack.user.<account>`.
- An approval rule belongs to the tool. It can no longer differ by toolkit.
- An Executor restart loses paused approvals. The caller runs the call again.

## Approval boundary

Executor decides which calls pause. The plugin shows each pause as a native
approval card. Generic RPC acceptance is unsupported, including for SDK clients;
an SDK client call is not evidence of a human decision. A plugin backend may
decline its own paused work, never accept it.

## Publication and runtime cutover

Each package builds and tests with its own manifest and lockfile. Keep the
marketplace overview equal to `plugins/catalog/PLUGIN_OVERVIEW.md`. For a local
installation, check `bb plugin source catalog --json`, build in the plugin
directory, then reload. A build alone is not live proof; check settings, a
connection sign-in and one `executor_execute` call in a thread.
