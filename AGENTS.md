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
