# Changelog

## Unreleased

- `--version` reads the version from `package.json` instead of a hard-coded `0.1.0`.
- Toolchain moves to vitest 4.1, TypeScript 5.9 and `@types/node` 22.20. The tsconfig now
  matches the other agent packages and type-checks the tests.
- README: install uses the same tag, pack and install steps as the other agent packages,
  adds a Develop section, drops references to the old `pa-acp.sh` shim, and labels the
  real-binary results as a manual check that `npm test` does not run.
