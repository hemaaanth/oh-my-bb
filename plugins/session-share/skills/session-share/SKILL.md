---
name: session-share
description: Create, inspect, and revoke password-protected Session Share links for BB threads.
---

# Session Share

Use `bb session-share` only when the owner intentionally asks to share or revoke a session. Creating a share starts a Cloudflare tunnel. Never use live public shares as a test fixture.

- `bb session-share start [<thread-id>] [--minutes N|0] [--mode view|review] [--tunnel quick|custom]`
- `bb session-share list`
- `bb session-share status [<thread-id>]`
- `bb session-share stop [<thread-id>]`

The thread defaults to the current thread. CLI defaults remain View, Quick and 60 minutes. Zero minutes means Until revoked. Output contains the URL and access code. Treat access codes as secrets and send them only to the intended recipient.

Set the existing `cloudflaredPath`, `viewerPort`, `customHostname` and secret `tunnelToken` in native Configuration. Session Share does not install cloudflared or change ingress. Never route a tunnel to the BB server.

View works without Pinpoint. Review is an explicit optional integration that requires a compatible Pinpoint version and an existing live target in the selected thread. Do not install, enable or probe another plugin on startup. See the package README and More → Setup guide for lifecycle and storage limits.
