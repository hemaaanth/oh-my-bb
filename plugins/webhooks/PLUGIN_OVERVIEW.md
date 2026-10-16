Receive webhooks from PostHog, Slack, and other services, and turn them into
thread messages, new threads, automation runs, or plugin calls. Each endpoint checks who
sent the request, accepts only the JSON fields you declare, and drops
duplicates before it acts.

## What you get

Create an endpoint in the Webhooks panel or with `bb webhooks create`. Each
endpoint has its own secret, field shape, body limit, rate limit, dedupe rule,
and one fixed action:

- **Send** a message to an existing thread.
- **Spawn** a new thread in a project and environment you choose.
- **Run** a saved automation from the Automations plugin. A retried event
  cannot start a second run.
- **Hand** the declared fields to a plugin that publishes a
  `webhooks_receive` method. The plugin decides what to do.

The payload never chooses the thread, project, automation, plugin, or permissions.
Only declared fields reach the message, quoted and marked as external data.

## Signed by default

Endpoints verify Standard Webhooks signatures, the scheme PostHog's HTTP
Webhook destination uses, or Slack request signatures. Slack endpoints answer
Slack's URL check, reply within its 3-second limit, and drop its retries. A
bearer-token mode covers senders that cannot sign.
Secrets are shown once. Logs and delivery records never hold payload values.

## Limits

- The automation action runs the automation's saved prompt. Payload fields are
  not forwarded to it. Use send or spawn when the agent needs the event data.
- Slack endpoints acknowledge first and act after, so a failed action is
  recorded but not retried. Socket Mode is not supported.
- Senders need a public HTTPS route to this machine, such as Caddy or a
  Cloudflare Tunnel. An optional loopback listener serves only
  `/webhook/<id>`, so the tunnel never reaches the BB server. bb Connect
  cannot receive provider callbacks. The plugin docs show a narrow setup.

## Standalone by default

Webhooks does not require another BB plugin. The automation action works only
when the Automations plugin is installed separately. The plugin action works
only with a plugin that opts in by publishing `webhooks_receive`.
