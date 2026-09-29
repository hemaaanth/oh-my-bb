# Repository rules

- Every plugin and agent package must install, build, and test from its own directory.
- Do not add repository-level runtime dependencies or imports across package directories.
- Integrations between packages must be optional and documented. One package must not
  install, enable, or probe another package during startup.
- Keep one lockfile per package. The repository root is not an npm workspace.
- Add plugins to `.bb/plugins.json` and `marketplace.json` only after their package-local
  checks pass.
- Release plugins independently with `<plugin-id>/vX.Y.Z` tags.
- Keep `bb.description`, marketplace copy, and `PLUGIN_OVERVIEW.md` aligned.
