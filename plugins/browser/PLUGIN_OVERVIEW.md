Automate Brave with isolated logins, live viewing and manual handoff.

Browser gives each BB thread its own tabs. Sandbox sessions also have separate
profiles, so two threads can sign in to different accounts on the same site.
An optional extension can relay an explicitly paired regular profile, or export
cookies while that browser stays open. A toolbar popup shows connection and sync
health. Authentication sharing is off until enabled.

Watch a sandbox browser live inside chat. When a login, OAuth approval or bot
check needs you, the agent pauses and opens the same private desktop for direct
mouse and keyboard input. Finish with Done to resume. Browser chrome, dialogs
and popups stay in that session. Local handoffs ask for attention; they do not
switch your workspace or focus a window.

## Getting started

Install Browser from this marketplace. For a sandbox, also install Sandboxes
and configure a provider and runtime image. Use `bb-browser` from a BB thread;
the thread context selects its session automatically. Agents receive the Browser
skill and use the handoff tool when they need you.

To use your regular profile, open Settings → Browser → Browser connection,
download the extension, load it unpacked in Brave or Chrome, and pair it.
The local browser remains open. Pairing does not enable cookie export by itself.

Two global settings control sandbox behavior: home Tailscale routing and personal
login sharing. Both are off on a fresh public installation. Home routing needs
an exit node and reusable enrollment key; it fails closed if unavailable. Login
sharing seeds new isolated sessions. It does not continuously overwrite their
cookies. Turning it off stops future sharing, not logins already in use.

## Support and integrations

The managed native backend requires Linux, Brave, and Hyprland's Lua window-rule
API. Isolated headed sessions require Linux, TigerVNC or Xvfb, and Openbox; the
Sandboxes image supplies them. The regular-profile extension supports Chromium
browsers, not Firefox. Native process ownership checks are Linux-specific.
There is no claim of full macOS or Windows automation support.

Browser works without Sandboxes for local native and relay workflows. Sandboxes
adds cloud lifecycle, private remote viewing and home-network enrollment.
Pages is not a dependency; the extension carries its own theme assets.
Fast-model tasks are optional and off by default. They send page observations
to the configured provider only after explicit task authorization.

See README.md for commands, authentication limits and verification details.
