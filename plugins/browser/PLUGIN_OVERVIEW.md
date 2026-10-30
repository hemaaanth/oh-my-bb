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

Install Browser in BB. For managed sandbox viewing and routing, also install
Sandboxes and enable **Enable Sandboxes integration** under Oh My BB.
Configure that plugin's provider and runtime image separately. Browser never
installs or probes it at startup. The `bb-browser` CLI must be installed on
the browser host; plugin startup does not change your command or profiles.

To use your regular profile, open Settings → Browser → More → Browser connection,
download the extension, load it unpacked in Brave or Chrome, and pair it.
The local browser remains open. Pairing does not enable cookie export by itself.

Home Tailscale routing and personal-login sharing are separate global choices.
Both and the Sandboxes integration are off on a fresh installation. Saved
routing, sharing and migrated integration choices remain enabled on upgrade
unless explicitly turned off. Home routing needs an exit node and reusable
enrollment key; it fails closed if unavailable. Login sharing seeds new isolated
sessions. Turning it off stops future sharing, not logins already in use.

Configuration holds keys and authentication-file inputs. Preferences holds
behavior. Connection controls and the collapsed setup guide are under More.

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

Use `bb-browser`, `browser_handoff` and `browser_live` from a BB thread.
See the package README for setup, commands and verification limits.


After navigation, agents can use `bb-browser settle` to wait briefly for a
complete document and quiet DOM, then inspect the result. Relay form filling
supports controlled inputs, textareas, contenteditable fields and date controls,
with checks for readonly, disabled and unsupported fields.
