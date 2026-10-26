Connect an authenticated webhook sender to a fixed action in BB.
Choose what each endpoint accepts and what it is allowed to start.

## Key features

- **Four actions:** message an existing thread, start a thread in a project,
  run a saved automation, or deliver declared fields to a receiver plugin.
- **Sender authentication:** Standard Webhooks signatures, Slack request
  signatures, or bearer tokens. Signing secrets and tokens stay per endpoint.
- **Bounded input:** declare field names, paths, types, and limits. The payload
  cannot choose the target, permissions, or action.
- **Duplicate protection:** identify repeated events by webhook ID, a declared
  field, or body hash. Set a body limit and request rate for each endpoint.
- **Slack support:** Events API, slash commands, and interactivity, including
  URL verification and prompt acknowledgement. Socket Mode is not supported.
- **Delivery controls:** enable or pause endpoints, rotate secrets, inspect
  delivery results, and send a signed test that runs the real action.
- **UI and CLI:** manage endpoints in the Webhooks page or with `bb webhooks`.
  Delivery records omit payload values. Bearer tokens are stored as hashes.

## First-time setup

1. Keep BB running on the machine that will receive requests. Configure an
   agent and a thread or project for thread actions.
2. Provide a public HTTPS hostname through a tunnel or reverse proxy. The
   recommended route exposes only the optional loopback listener, not BB.
3. In Settings → Webhooks, set **Listener port** and **Public base URL**.
4. Open **Webhooks → Setup guide**, then create an endpoint. Declare its
   fields, choose one action, and copy its delivery URL and one-time secret
   into the sender. Slack uses the app's own signing secret.
5. Send an event from the sender and inspect the delivery result.

Cloudflare is optional. A Cloudflare named tunnel needs a Cloudflare account,
`cloudflared`, and a domain managed by Cloudflare. Caddy or another HTTPS proxy
works instead. You install and operate ingress separately; Webhooks does not
install software, configure DNS, or open your router. BB Connect cannot receive
provider callbacks because it requires an owner session.

## Optional integrations and limits

- **Automations:** install and enable Automations, then opt in under
  Settings → Webhooks → **Oh My BB**. It runs the saved prompt without webhook fields.
- **Receiver plugins:** install and enable a plugin publishing `webhooks_receive`,
  then enable its integration under **Oh My BB**. The receiver owns its behavior
  and description. Direct thread actions need no other plugin.
- **Opt-in:** fresh installs start with integrations off. Upgrades preserve
  integrations used by existing hooks. Disabling one stops its actions, not its
  saved configuration or secrets.
- **Slack failures:** Slack requests are acknowledged before the action runs.
  Failed actions are recorded but are not retried automatically.

[Full setup and ingress examples](https://github.com/hemaaanth/oh-my-bb/blob/main/plugins/webhooks/docs/ingress.md)
