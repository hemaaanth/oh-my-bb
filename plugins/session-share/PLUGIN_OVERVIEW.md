Give another person a temporary, password-protected view of a BB session without exposing BB's server.

## Share a conversation

Open Session Share beside Scripts in a thread's **⋯ menu**. A compact dialog offers Conversation or Pinpoint review and a duration. Your configured custom hostname is used automatically; otherwise, Session Share uses a temporary hostname. An active Pinpoint preview selects Review by default. If Pinpoint is inactive, open it manually before choosing Review. Conversation mode renders the session in a separate guest viewer. Choose an expiry or revoke access yourself. Send the URL and access code privately. Anyone with both can unlock the viewer. Guest sessions expire within four hours or at share expiry, whichever comes first.

## Review an app

Optional Review mode requires a separately installed Pinpoint with guest-preview isolation contract v1. Guests can capture feedback, reply and delete their own still-held captures. Captures and replies stay held until the owner explicitly releases them in Pinpoint. Guests cannot approve, dispatch or submit learning.

Reviewed apps run in opaque sandboxed previews. BB and guest cookies, Authorization headers and plugin tokens are not forwarded. Incompatible older Pinpoint output fails closed. View works without Pinpoint. Session Share never installs or enables another plugin.

## Requirements and private state

Requires BB 0.46.1 or newer, Node 22.15 or newer, and cloudflared installed on the BB server. Cloudflare Tunnel carries the connection. A custom hostname needs an existing named tunnel and its account configuration. Session Share does not install cloudflared or change ingress. A fresh install starts no tunnel. No paid model service is required.

Use native Configuration for tunnel settings. Setup help starts collapsed under More > Setup guide. Access codes remain in the local plugin database so the owner can copy them again. Protect that database and its backups as credentials.
