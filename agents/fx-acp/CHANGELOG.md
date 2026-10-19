# Changelog

## Unreleased

- Toolchain moves to vitest 4.1, TypeScript 5.9 and `@types/node` 22.20. Adds a `build`
  script (`node --check`).
- When the gateway URLs are incomplete or invalid, `fx-acp` now prints the reason on
  stderr instead of a generic message. It never prints the URLs, which carry the hub token.
- The README install command clones the `fx-acp/v0.1.0` tag, like the other agent packages.
