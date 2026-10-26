# Public HTTPS ingress

A webhook sender, such as PostHog or Slack, must reach your machine over HTTPS.
Webhooks does not open a public port, and it does not change BB. You put a
tunnel or a reverse proxy in front of one of two local targets:

- **The webhook listener (recommended).** Set the plugin's **Listener
  port**, for example `43128`. The plugin then listens on
  `127.0.0.1:<port>` and serves only `POST /webhook/<endpoint-id>`. Every other
  path gets 404. The tunnel never reaches the BB server, so no `Host` rewrite is
  needed and the BB API stays private. Endpoint URLs become
  `https://<public-origin>/webhook/wh_…`.
- **The BB deliver route.** Without the listener, forward exactly
  `POST /api/v1/plugins/webhooks/http/deliver?endpoint=wh_…` to the BB server.
  The rules below apply.

## Fresh-machine checklist

- Install Webhooks in BB 0.46.1 or later. Keep BB running on the receiving
  machine. Thread actions need a working agent and an existing thread or project.
- Choose **one** ingress option. Cloudflare is optional. A Cloudflare named
  tunnel needs a Cloudflare account, a domain managed by Cloudflare, and the
  `cloudflared` binary on the receiving machine. Caddy needs its binary, DNS
  pointing at the server, and reachable ports for HTTPS and certificate issuance.
  Another HTTPS proxy can meet the same requirements.
- No other BB plugin is needed for thread actions. For automation actions or a
  receiver publishing `webhooks_receive`, install and enable the plugin, then
  opt in under **Settings → Webhooks → Oh My BB**.
- Set the public URL, create an endpoint, and configure the sender with its URL,
  authentication, and event subscriptions. Slack's signing secret comes from
  the Slack app; generated secrets and bearer tokens are shown once.

Open **Webhooks → Setup guide**, or **Settings → Webhooks → More → Open setup
guide**, for the in-app checklist. Webhooks does not install ingress software,
sign in to Cloudflare, change DNS, open router ports, or manage tunnel services.
The status warning checks URL configuration, not public reachability.

## Start a dedicated listener

Choose an unused local port. These example settings apply immediately:

```sh
bb plugin config webhooks set listenerPort 43128
bb plugin config webhooks set publicBaseUrl https://hooks.example.com
```

Run the tunnel or proxy on the BB machine so `127.0.0.1:43128` reaches the
listener. Expose only `/webhook/`, not the BB app or API. Use one of the next
two examples, then create an endpoint and run the checks at the end of this
guide.

### New Cloudflare named tunnel

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
Sign in and create a dedicated tunnel and hostname:

```sh
cloudflared tunnel login
cloudflared tunnel create bb-webhooks
cloudflared tunnel route dns bb-webhooks hooks.example.com
```

Use the tunnel ID and credentials file path printed by `create`. Save a
configuration file such as `webhooks-tunnel.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /path/to/<tunnel-id>.json
ingress:
  - hostname: hooks.example.com
    path: ^/webhook/
    service: http://127.0.0.1:43128
  - service: http_status:404
```

Validate and run it:

```sh
cloudflared tunnel --config webhooks-tunnel.yml ingress validate
cloudflared tunnel --config webhooks-tunnel.yml run bb-webhooks
```

Keep the process running. For unattended use, configure a
[system service](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/).
Do not put a browser-login Access policy in front of the webhook route:
provider callbacks cannot complete that login. Endpoint authentication still
checks every delivery.

### Caddy with the listener

Point `hooks.example.com` at the server and install
[Caddy](https://caddyserver.com/docs/install). Configure the hostname:

```caddyfile
hooks.example.com {
	@webhook {
		method POST
		path /webhook/*
	}
	handle @webhook {
		request_body {
			max_size 1MB
		}
		reverse_proxy 127.0.0.1:43128 {
			header_up -Cookie
		}
	}
	handle {
		respond 404
	}
}
```

Caddy manages HTTPS certificates. Keep Caddy and BB running. See the
[Caddy quick start](https://caddyserver.com/docs/quick-starts/reverse-proxy)
for running it as a service.

## Share an existing Cloudflare named tunnel

If another plugin already runs a Cloudflare named tunnel on this machine, such
as Session Share with a custom hostname, Webhooks can use the same hostname. A
remotely managed tunnel takes its routes from the Cloudflare dashboard, so
nothing changes on this machine.

1. Set **Listener port** (for example `43128`) and **Public base URL**
   (for example `https://bb.example.com`). Both apply when saved.
2. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels**, choose
   the tunnel, and open **Public Hostname** (called **Published application
   routes** in newer dashboards).
3. Add a route:
   - Hostname: the same hostname, for example `bb.example.com`.
   - Path: `^/webhook/`
   - Service: `HTTP`, URL `localhost:43128`.
4. Move the new route **above** the hostname's existing catch-all route.
   Cloudflare uses the first route that matches.
5. Check it: an unsigned `POST https://bb.example.com/webhook/<id>` must return
   401. Other paths on the hostname keep going to the other plugin.

Webhooks then works only while that tunnel runs. If the other plugin stops its
tunnel, deliveries fail until it starts again. Webhooks does not start, stop,
or check the other plugin.

## Forward to the BB deliver route

The rest of this guide covers the BB deliver route. The same proxies work with
the listener: match the path prefix `/webhook/`, point the proxy at
`127.0.0.1:<listener port>`, and skip the `Host` rewrite.

## Why only one path

The deliver route has no BB login (`auth: "none"`). The plugin authenticates
each request itself, with the endpoint's signature or bearer token. Every other
BB path is the BB API and the BB app. Those must not be reachable from the
internet through this ingress. Do not proxy `/` or `/api/`.

## Why not bb Connect

bb Connect shares need a signed-in BB owner session. A provider callback has no
session, so Connect cannot receive it. Webhooks does not change Connect.

## Rules every ingress must follow

1. Match the exact path `/api/v1/plugins/webhooks/http/deliver` and method
   `POST`. Return 404 for everything else.
2. Keep the query string. It carries the endpoint id.
3. Rewrite the `Host` header to the upstream, such as `127.0.0.1:38886`. BB
   rejects other hostnames with `403 forbidden_host`. The only exception is the
   hostname in `BB_APP_URL`.
4. Forward the body and the `content-type`, `content-length`, `authorization`,
   `webhook-id`, `webhook-timestamp`, `webhook-signature`,
   `x-slack-signature`, and `x-slack-request-timestamp` headers unchanged.
   Do not let the proxy re-encode the body. The signature covers the exact
   bytes. Slack slash commands send `application/x-www-form-urlencoded`, so do
   not limit the content type to JSON at the edge.
5. Drop cookies. The route does not use them.
6. Cap the body at 1 MB. The plugin also checks each endpoint's own limit.
7. Use HTTPS. Standard Webhooks and Slack signatures stop changes and replays,
   but they do not hide the payload. Bearer tokens depend fully on TLS. Slack
   accepts only HTTPS Request URLs with a valid certificate.

Replace `38886` below with the port your BB server listens on, and
`hooks.example.com` with your public hostname.

## Caddy

Caddy gets and renews the TLS certificate for the hostname.

```caddyfile
hooks.example.com {
	@deliver {
		method POST
		path /api/v1/plugins/webhooks/http/deliver
	}
	handle @deliver {
		request_body {
			max_size 1MB
		}
		reverse_proxy 127.0.0.1:38886 {
			header_up Host {upstream_hostport}
			header_up -Cookie
		}
	}
	handle {
		respond 404
	}
}
```

`path` without a `*` matches the exact path. Caddy keeps the query string.

## Cloudflare Tunnel

A named tunnel needs no open inbound port. Cloudflare terminates TLS.

```yaml
tunnel: <tunnel-id>
credentials-file: /home/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: hooks.example.com
    path: ^/api/v1/plugins/webhooks/http/deliver$
    service: http://127.0.0.1:38886
    originRequest:
      httpHostHeader: 127.0.0.1:38886
  - service: http_status:404
```

`path` is a regular expression that matches the path only, not the query
string. Keep the `^` and `$` anchors. The last rule returns 404 for every other
request.

cloudflared cannot filter by method. Other methods reach the route, and the
plugin answers them with 404. To also drop cookies and other methods at the
edge, add a Cloudflare WAF rule for the hostname.

Check the rules before you start the tunnel:

```sh
cloudflared tunnel --config config.yml ingress validate
cloudflared tunnel --config config.yml ingress rule \
  'https://hooks.example.com/api/v1/plugins/webhooks/http/deliver?endpoint=wh_x'
cloudflared tunnel --config config.yml ingress rule 'https://hooks.example.com/api/v1/projects'
```

The first `rule` check must print the `127.0.0.1` service. The second must
print `http_status:404`.

## Other proxies

nginx, Traefik, and cloud load balancers work too. Apply the same rules: an
exact-path `POST` match, the query string kept, `Host` rewritten to the
upstream, the body unchanged, and 404 for everything else.

## Tell the plugin its public origin

Set the plugin's **Public base URL** setting to the public origin, for example
`https://hooks.example.com`. It applies when saved. The panel and
`bb webhooks show` then print the full URL to paste into the sender.

- The setting must be `https://`, with no credentials, query, or fragment.
- A path prefix is kept. Use one if your proxy serves the route under a prefix
  and strips it before forwarding.
- If the setting is empty, the plugin uses `BB_APP_URL`. If neither is set, the
  URLs show `https://<your-public-origin>` as a placeholder, and BB shows
  "Needs configuration" for the plugin, even if a listener port is set. A
  listener is local; it does not provide an HTTPS hostname. Saving the URL
  fixes displayed delivery URLs at once. Reload Webhooks to clear a stale
  configuration warning.

## Check it end to end

From a machine outside your network. With the listener:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  'https://hooks.example.com/webhook/<id>'
# 401: the route is reachable and rejects unsigned requests.
```

With the BB deliver route:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  'https://hooks.example.com/api/v1/plugins/webhooks/http/deliver?endpoint=<id>'
# 401: the route is reachable and rejects unsigned requests.

curl -sS -o /dev/null -w '%{http_code}\n' https://hooks.example.com/api/v1/projects
# 404: the rest of BB is not reachable.
```

A `403` with `forbidden_host` means the proxy did not rewrite `Host`. A `404`
on the first check means the path, query string, or endpoint id is wrong, or
the endpoint is disabled.

Then send a real event from the sender. Watch the endpoint's deliveries in the
Webhooks panel or with `bb webhooks deliveries <id>`.
