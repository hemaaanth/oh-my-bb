# Changelog

## 0.1.2

- Match the native settings card layout, shorten Configuration help, and add
  a Credentials shortcut to endpoint authentication. Settings and navigation
  keep the canonical webhook icon.
- Shorten the plugin subtitle to fit the settings header.
- Align overview, detail, new, edit, and setup pages to BB settings' rendered
  760px outer frame, with 16px padding inside each side. Use overlay scrollbars
  to prevent layout shifts and the native 36px header icon.
- Add an in-app setup guide with fresh-machine requirements, HTTPS ingress
  options, optional integrations, and sender-side verification.
- Require a public HTTPS origin for configuration status even when a local
  listener is enabled. Point the warning to the setup guide.
- Expand the Webhooks overview with feature bullets and setup requirements.
  Use marketplace schema v2 to include the long-form listing.
- Remove the overview sentence and breadcrumbs. Keep the endpoint title unchanged
  in edit mode with an Edit configuration subtitle, use protocol-based authentication
  labels, and keep a disabled Open thread action when a delivery has no thread.
- Keep setup guidance generic, without the current installation's hostname.
- Put delivery errors on the status icon's hover/focus tooltip, not inline.
  Keep attempt counts visible and success tooltips limited to recorded metadata.
- Add Oh My BB integration opt-ins for available Automations and receiver plugins.
  Gate both configuration and dispatch. Preserve integrations used by existing
  hooks on upgrade, along with their configuration and secrets.
- Keep receiver-owned descriptions full-width and single-line. Ignore native
  select no-choice events while asynchronous options load, preserving saved actions.
- Compact narrow-screen endpoint rows, allow two-line names, move delivery time
  below the name, and make overview actions share the available width.
- Use page-width container queries for responsive forms. Stack string-limit
  labels above aligned inputs on mobile, without wrapping Allowed values.
- Keep delivery URLs on one clipped line while preserving the complete value
  for copying.

## 0.1.1

- Loads on stable bb 0.46.1. 0.1.0 required plugin SDK 0.6.54, which only
  nightly bb ships, so stable bb marked it incompatible. It now requires SDK
  0.6.49 or later.

## 0.1.0

- Configurable inbound endpoints on one route,
  `POST /api/v1/plugins/webhooks/http/deliver?endpoint=wh_…`.
- Authentication with Standard Webhooks signatures (PostHog-compatible,
  5-minute window), Slack request signatures, or a bearer token. Secrets are
  shown once. Bearer tokens are stored as hashes.
- Slack support: Events API, slash commands, and interactivity. Answers
  `url_verification` and `ssl_check`, acknowledges within Slack's 3 seconds and
  runs the action after, and sends `x-slack-no-retry` on requests that cannot
  pass. Panel presets for events and slash commands.
- Bounded JSON with declared fields: types, required flags, lengths, and
  allowed values.
- Dedupe by `webhook-id`, a declared id field, or body hash. A failed action
  runs again on retry. Records are kept for 30 days.
- Actions: send to one thread, spawn a thread in a configured project and
  environment, run an Automations automation with an event-based idempotency
  key, or hand the declared fields to a plugin. Automations run their saved
  prompt and get no payload. The plugin action calls another plugin's
  discoverable `webhooks_receive` method with an event-based idempotency key.
  The panel lists the plugins that publish it. Endpoints are refused at save
  when the chosen plugin does not.
- An optional loopback listener (`listenerPort`) that serves only
  `POST /webhook/<id>`, so a tunnel never reaches the BB server.
- The `publicBaseUrl` and `listenerPort` settings apply when saved, with no
  plugin reload. A new origin changes the URLs in the panel and `bb webhooks
  show`. A new port closes the old listener and opens the new one, and endpoint
  paths switch with it. Bad values are refused at save: an origin that is not
  https, or a port outside 1024 to 65535.
- BB shows "Needs configuration" for the plugin when no public base URL
  resolves and no listener port is set: `publicBaseUrl` is empty or not an
  https origin, and BB has no https app URL to fall back on. The message names
  the setting. BB cannot clear a banner while the plugin runs, so after you fix
  the setting the banner stays until `bb plugin reload webhooks`. Until the
  setting is saved the panel and `bb webhooks show` print a placeholder origin.
- Webhooks panel, `bb webhooks` CLI, agent skill, and an ingress guide for
  Caddy, Cloudflare Tunnel, and sharing another plugin's named tunnel. The panel uses BB's shared resource UI, so it
  looks like Automations in light and dark themes.
- A webhook icon for the nav entry, the panel, and the marketplace listing.
- Requires bb 0.46.1 or later and plugin SDK 0.6.54 or later. Built with
  TypeScript 7.
