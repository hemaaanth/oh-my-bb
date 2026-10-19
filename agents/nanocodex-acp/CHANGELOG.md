# Changelog

## Unreleased

- Pins `@modelcontextprotocol/sdk` to 1.31 or later with an `overrides` entry. nanocodex 0.6.5
  pins 1.30.0, which has a high-severity OAuth advisory (GHSA-6qxp-vccf-f47h). The two high
  `npm audit` findings are gone. The moderate `sprintf-js` finding remains: no patched
  release exists, and the code path in use does not reach it.
- Stays on nanocodex 0.6.5. 0.6.7 renames `gpt-6-sol` to `gpt-6.1-sol` and pulls in a
  vulnerable `undici`.
- `initialize` reports the version from `package.json` instead of a hard-coded `0.1.0`.
- Toolchain moves to TypeScript 5.9 and `@types/node` 22.20. Adds a `build` script
  (`node --check`). Tests stay on `node:test`, run in a network namespace.
- README: drops references to internal plan and spike notes, documents `test:ci`, and
  explains the pins and the remaining audit finding.
