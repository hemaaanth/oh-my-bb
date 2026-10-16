# Changelog

## Unreleased

- A plugin action. It hands the declared field values to another plugin's
  discoverable `webhooks_receive` method, with an event-based idempotency key.
  The panel lists the plugins that publish it. Endpoints are refused at save
  when the chosen plugin does not.

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
  environment, or run an Automations automation with an event-based idempotency
  key. Automations run their saved prompt and get no payload.
- An optional loopback listener (`listenerPort`) that serves only
  `POST /webhook/<id>`, so a tunnel never reaches the BB server.
- Webhooks panel, `bb webhooks` CLI, agent skill, and an ingress guide for
  Caddy, Cloudflare Tunnel, and sharing another plugin's named tunnel. The panel uses BB's shared resource UI, so it
  looks like Automations in light and dark themes.
- A webhook icon for the nav entry, the panel, and the marketplace listing.
