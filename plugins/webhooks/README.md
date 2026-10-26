# Webhooks

Webhooks receives signed webhooks, including Slack events and slash commands,
on configured endpoints and turns approved fields into a thread message, a new
thread, an Automations run, or a call to a plugin that accepts deliveries.

## Features

- One route, `POST /api/v1/plugins/webhooks/http/deliver?endpoint=wh_…`. Each
  endpoint has its own secret, field shape, dedupe rule, rate limit, and action.
- An optional loopback listener that serves only `POST /webhook/wh_…`. Point a
  tunnel at it, and the BB server is never exposed. It can share a Cloudflare
  named tunnel that another plugin already runs.
- Authentication comes before anything else:
  - **Standard Webhooks** signatures (HMAC-SHA256, 5-minute timestamp window).
    PostHog's HTTP Webhook destination sends these when its signing secret is
    set.
  - **Slack request signatures** (`v0` HMAC-SHA256, 5-minute window) for the
    Events API, slash commands, and interactivity. Slack's URL check, quick
    acknowledgement, and retry headers are handled.
  - **Bearer token**, for senders that cannot sign.
- Bounded bodies. JSON for every endpoint, and Slack's form bodies on slack
  endpoints. Each endpoint has a body limit (64 KB default, 1 MB max), a
  depth limit, and declared fields with types, required flags, lengths, and
  allowed values. Undeclared fields are ignored.
- Duplicates are dropped by `webhook-id`, by a declared id field, or by body
  hash. A failed action runs again on the sender's retry.
- Four fixed actions:
  - **Send** a turn to one existing thread.
  - **Spawn** a thread in a configured project and environment.
  - **Run an automation** from the Automations plugin, with an event-based
    idempotency key.
  - **Hand to a plugin** that publishes a `webhooks_receive` method. It gets
    the declared field values and decides what to do.
- The payload never chooses the target thread, project, automation, plugin, or
  permissions.
- A Webhooks panel: create and edit endpoints, see each secret once, copy the
  URL, send a signed test, follow deliveries live, and open the thread a
  delivery reached. Enable or disable an endpoint from the list. Rotate or
  delete it from the menu on its page.
- A `bb webhooks` CLI and an agent skill. Secrets print only with
  `--show-secret`.

## Limit: automations get no payload

The automation action runs the automation's **saved prompt**. Payload fields are
not forwarded, because `automations_run` has no input for event data. Use the
send or spawn action when the agent needs the values.

## Receiver plugins

Install and enable the receiver in BB, then enable it under **Settings →
Webhooks → Oh My BB**. Webhooks owns discovery, authentication, and delivery.
The receiving plugin owns its handler and published name and description.

Another plugin can take deliveries without any change to Webhooks. It
registers one RPC method named `webhooks_receive`, marked discoverable:

```ts
bb.rpc.register(
  defineRpcContract({ webhooks_receive: { input: receiveInput, output: z.object({ threadId: z.string().optional() }) } }),
  {
    webhooks_receive: async (input, { experimental_caller }) => {
      if (experimental_caller.kind !== "plugin" || experimental_caller.pluginId !== "webhooks") throw new Error("Only the Webhooks plugin may call this.");
      // input: { endpointId, endpointName, deliveryId, receivedAt, idempotencyKey, fields }
      return {};
    },
  },
  { experimental_discoverable: true, experimental_description: "What this plugin does with a delivery." },
);
```

- Webhooks calls no other method, and only a plugin chosen in the endpoint
  config. The payload cannot pick the plugin.
- `fields` holds only the declared values. Treat them as untrusted data.
- `idempotencyKey` stays the same when the sender retries one event.
- Answer within BB's 75-second RPC limit. Throwing makes the delivery fail,
  so the sender retries. Return `threadId` to link the delivery to a thread.
- An endpoint is refused at save when the plugin does not publish the method.

## Install

Add the `oh-my-bb` marketplace once:

```sh
bb marketplace add git:github.com/hemaaanth/oh-my-bb@main
```

Then install only Webhooks:

```sh
bb plugin install webhooks@oh-my-bb
```

Or install it directly from Git:

```sh
bb plugin install git:https://github.com/hemaaanth/oh-my-bb.git@^0.1.0 \
  --plugin webhooks \
  --tag-prefix webhooks/
```

## First-time requirements

- BB 0.46.1 or later, kept running on the receiving machine.
- A configured agent and a thread or project for thread actions.
- A stable public HTTPS hostname, routed through a tunnel or reverse proxy.
  Cloudflare is optional. Its named tunnels need a Cloudflare account, a
  domain, and `cloudflared`; Caddy or another HTTPS proxy works instead.
- Sender access to configure its webhook URL, signing secret or bearer token,
  and event subscriptions.

Webhooks does not install or run a tunnel. No other BB plugin is required
unless you choose an automation or receiver-plugin action. BB Connect cannot
receive provider callbacks because it requires an owner session.

Start with **Webhooks → Setup guide**, also available from **Settings →
Webhooks → More**. The [ingress guide](docs/ingress.md) includes fresh-machine
Cloudflare and Caddy examples. A local **Send test** runs the real action but
does not check the public route; finish with an event from the sender.

## Set up an endpoint

1. Open **Webhooks** in the BB sidebar and choose **New endpoint**. Or run
   `bb webhooks create --config-stdin`. See
   [skills/webhooks/SKILL.md](skills/webhooks/SKILL.md) for the config shape.
2. Declare the fields the action may use, such as `event` at `event.event`.
3. Write the message with `{{field}}` placeholders.
4. Save. Copy the signing secret now. It is shown once.
5. Route public HTTPS to this machine. The simplest way: set **Listener
   port** (for example `43128`) and point a tunnel's `/webhook/` path
   at `localhost:<port>`. See [docs/ingress.md](docs/ingress.md), including how
   to share an existing Cloudflare named tunnel.
6. Set **Public base URL** in the plugin settings. Both settings apply when you
   save them. No reload is needed.
7. Paste the URL and secret into the sender.

Settings keeps **Configuration** for the public URL and listener port.
**Credentials → Manage endpoints** opens endpoint authentication and secret
rotation. Secrets remain per endpoint; there is no shared API key.

**Oh My BB** controls optional Automations and receiver integrations. The action
picker only offers enabled, available integrations. Fresh installations start
with integrations off. Upgrades keep integrations used by saved endpoints enabled.
Disabling an integration blocks its saves and delivery actions; it does not delete
endpoints or secrets. Re-enable it to resume those hooks.

Delivery errors appear only in the status icon's hover/focus tooltip. Attempts
and duplicate counts stay inline. Success icons have a tooltip only when recorded
result metadata is available; delivery history does not infer HTTP status codes.

Overview, detail, new, edit, and setup pages match BB settings' outer page shell:
a centered 760px frame with 16px padding inside each side (728px content at full
width). Overlay scrollbars keep short and long pages aligned. Detail and setup
headers use the native 36px icon and title style.

Narrow views use compact endpoint rows: names can wrap, with the action and last
delivery below them. Full authentication and target details remain on the endpoint
page. Responsive layouts follow the page's available width, including narrow panes.
String-field limit labels sit above their inputs on mobile. Delivery URLs stay on
one clipped line; the copy action still uses the complete URL.

### PostHog

1. Create an endpoint with the `standard-webhooks` mode and `webhook-id`
   dedupe.
2. In PostHog, add an **HTTP Webhook** destination.
3. Set the URL to the endpoint's URL and the method to `POST`.
4. Paste the plugin's secret into the destination's **Signing secret** input.
5. PostHog's default body is `{"event": "{event}", "person": "{person}"}`.
   Declare paths such as `event.event`, `event.distinct_id`, or
   `person.properties.email`.

PostHog keeps the `webhook-id` the same on retries. A retried event is
recognized as a duplicate.

### Slack

Slack signs every request with the app's signing secret. It sends no bearer
token, and the old verification token is not used. Create one endpoint per
Slack feature, because each has its own Request URL.

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Copy the **Signing Secret** from **Basic Information → App Credentials**.
   It is not a bot token.
3. In the Webhooks panel, choose **New endpoint**, set **Authentication** to
   **Slack request signature**, and paste the signing secret. The **Slack
   events** and **Slack slash command** buttons fill in fields, dedupe, and a
   message. Or pipe the secret to
   `bb webhooks create --config '…' --secret-stdin`.
4. Paste the endpoint URL into the Slack app:
   - **Event Subscriptions → Request URL**. Slack sends a signed
     `url_verification` request, and the plugin answers it. Then subscribe to
     only the events you need, such as `app_mention`.
   - Or **Slash Commands → Request URL** for one command.
   - Or **Interactivity & Shortcuts → Request URL**.
5. Install the app to the workspace.

How slack endpoints behave:

- Slack needs an answer within 3 seconds. The plugin answers 200 as soon as the
  delivery is checked and recorded, then runs the action. A failed action is
  recorded as `failed` and is not retried.
- Events dedupe on `event_id`, so Slack's retries are dropped. Slash commands
  dedupe on `trigger_id`.
- A slash command gets a private `Received. Delivery whd_….` reply.
- Requests that cannot pass (400, 413, 415, 422) carry `x-slack-no-retry: 1`.
  Slack counts them as failures, so subscribe only to events the endpoint
  declares.
- Anyone in the workspace who can use the app can trigger the action.
- Socket Mode is not supported. Slack needs the public HTTPS route.

## Security

- No BB login is needed on the deliver route. The plugin checks the signature or
  token before it parses the body, writes to storage, or runs an action. The
  only exception is Slack's `ssl_check` probe, which gets an empty 200 and
  touches nothing.
- The ingress must forward only the webhook listener or the deliver path. Do
  not expose the BB API. The listener binds to `127.0.0.1` and answers 404 to
  every other path and method.
- Signing secrets, including Slack's, are stored in plugin storage on the BB
  server, because signature checks need them. Bearer tokens
  are stored only as hashes. Neither appears in the panel after the first
  reveal, in CLI output without `--show-secret`, in logs, or in settings.
- Logs hold endpoint ids, delivery ids, and reason codes only. Delivery records
  hold a hashed dedupe key, the status, and target ids. They hold no payload.
  Errors have field values removed.
- Messages begin with `[Webhook delivery · …]` and quote every value. They say
  that the values are data, not instructions.
- Delivery records are kept for 30 days.

## Optional integration

Webhooks runs without any other plugin. A plugin action calls only the
chosen plugin's `webhooks_receive`, and the panel lists plugins that publish
it. The automation action calls the
Automations plugin's `automations_get`, `automations_list`, and
`automations_run` RPCs only when you choose an automation target or an endpoint
uses one. The plugin never installs,
enables, or probes Automations at startup. Without Automations, the panel says
so, and automation endpoints are refused at save.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
