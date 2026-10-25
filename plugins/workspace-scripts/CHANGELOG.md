# Changelog

## Unreleased

- Prepare Scripts as an independently installable Oh My BB package.
- Use one terminal SVG across static branding and thread actions.
- Keep setup help inline under More; remove the redundant operational panel,
  rail page, command-palette launcher and Sandboxes Machine-menu shortcut.
- Prefer bb.json as a whole, with paseo.json only as an absent-file fallback.
- Use native thread-action choices for commands, services and manual hooks.
- Show the latest command exit result and tracked terminal state; retain
  disconnected state and single-flight concurrent environment service starts.
- Support explicit BB service ports and BB_PORT allocation, retaining legacy
  port aliases. Check known loopback listeners without inferring server health.
- Copy native terminal-output commands instead of offering unsupported
  cross-scope terminal navigation or adding a separate logs panel.
- Bound and wrap long labels only inside Scripts' native desktop and compact menus.
- Shorten menu hints and align footers with the menu content.
- Remove agent setup controls and their UI-only RPCs from Scripts settings while
  preserving stored approvals, CLI management and the optional Agents startup path.
- Share explicit cwd/environment and blocking, cancellable setup between manual
  commands and the optional Agents startup handshake.
- Preserve old selections as pinned recipe snapshots with their original scope;
  remove obsolete security CLI/RPC paths and keep the installer standalone.
- Keep native autostart Configuration, service defaults and hook precedence.
- Replace the bundled icon map with the public host icon renderer.
