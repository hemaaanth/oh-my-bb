# Session Share

Share temporary password-protected BB session viewers through Cloudflare Tunnel.

## Package-local development

Requires BB 0.46.1 or newer and Node 22.15 or newer. Run from this package directory:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

This is not an npm workspace. No sibling plugin is needed to install, build, test, or share a View session. Dependencies stay in the installed package directory. Open Graph PNGs use the package-local WebAssembly renderer and bundled Inter font. They do not need native renderer binaries or an install script.

The renderer initializes on the first image request, not during plugin import. This keeps startup compatible with BB's CommonJS loader. Concurrent image requests share the same initialization.

## Configuration

Use BB's native Session Share Configuration form. Existing setting IDs are unchanged.

| Setting | Purpose |
| --- | --- |
| `tunnelToken` | Native secret for an existing named Cloudflare tunnel. |
| `customHostname` | Exact subdomain routed to that named tunnel, such as `share.example.com`. |
| `cloudflaredPath` | Existing executable name or path. Defaults to `cloudflared`. |
| `viewerPort` | Isolated loopback viewer port. Defaults to `43127`. |

Install cloudflared yourself on the BB server machine. Session Share does not download it, install it, or change Cloudflare ingress. In Custom mode, route the configured hostname only to the isolated viewer port. Never route it to BB's server port. A configured named tunnel stays running across share revocations, matching the existing lifecycle. A fresh install with no settings or stored shares starts no tunnel.

**More** contains collapsed **Shared sessions** management and the **Setup guide**. Section headings have no subtitles. Session Share is a single action in the same thread-menu group as Scripts, with no standalone header button or divider. It opens a compact sharing dialog. Revoke confirmation identifies the session and focuses Cancel first.

## Sharing and lifecycle

Open **Session Share** in a thread's **⋯ menu**. Choose Conversation or Pinpoint review and a duration, then **Start sharing**. The dialog defaults to three hours; the CLI retains its one-hour default. The dialog uses your custom hostname automatically when one is configured. An incomplete named-tunnel setup blocks creation instead of falling back to a temporary URL. Without a custom hostname, it uses a temporary URL. Active shares offer Open viewer, Copy link, Copy access code and Revoke. Send the URL and access code privately. Anyone with both can unlock the viewer.

Errors and copy notices use a fixed-height message area, so controls do not move when feedback appears. Longer messages remain scrollable without being truncated.

Quick URLs can change after restart or tunnel recovery. Custom URLs and share paths remain stable. Stored shares restore automatically until expiry or revocation. Plugin disposal closes only its viewer and tunnel subprocesses. It does not stop unrelated tunnels. Tunnel tokens are passed in the child environment, not command arguments, and are redacted from logs and errors.

Guest access codes are scrypt-hashed for unlock checks. The original code is also stored in the local plugin database so the owner can copy it again. Protect that database and its backups as credentials. Guest cookies are HttpOnly, Secure and SameSite=Lax. Sessions expire after four hours or at share expiry, whichever comes first. Revocation removes guest sessions and preview capabilities. A link set to Until revoked has no automatic share expiry.

Guest write APIs require JSON, a valid guest session, matching share scope and a CSRF header. Cross-origin API writes are rejected. Password checks reserve their attempt budget before hashing, including concurrent requests.

## Optional Pinpoint review

Opening the sharing dialog checks for an active Pinpoint preview in that thread and selects Pinpoint review when one is available. A manual Conversation selection is not overwritten by a late response. Missing or inactive Pinpoint defaults to Conversation. Pinpoint is not probed at plugin startup or while the dialog is closed. Restoring a previously selected Review share is also an authorized integration use. Session Share never installs or enables Pinpoint.

Review requires Pinpoint's versioned guest-preview isolation contract. Resource access is GET-only and bound to the selected app origin, share and guest-session expiry. The resource capability is not feedback authority. Every prepared response must carry the sandbox CSP and other safety headers. Incompatible legacy output fails closed. BB and guest cookies, Authorization headers and plugin tokens are never sent to reviewed apps. Cross-origin redirects, embedded URL credentials, known BB origins and the BB server port are rejected. Responses are bounded to 32 MiB and 15 seconds.

Guest Review supports captures, replies and deletion of the participant's own still-held captures. Captures and replies stay held for owner review. They cannot dispatch agent messages, run integrations or enter agent tool output until the owner explicitly releases them in Pinpoint. Guests cannot approve, dismiss, redispatch, reopen, send or submit learning. Owner-adopted captures cannot be deleted by guests.

Review and participant identifiers are separate server-owned pseudonyms, not access codes or URL tokens. Guest rows exclude private routing, actor and learning fields. Screenshot receipts stay server-side, bind one capture, participant and page, expire within 60 seconds and allow each screenshot kind once. Expired receipts and resource capabilities are invalidated when observed; a clock change or later heartbeat cannot revive them.

Review deliberately uses the full browser viewport so the reviewed page retains its usable canvas. View uses a wider, at-most-1180px conversation frame for scrollable tables, while text paragraphs stay narrow. Native settings remain in the host's 760px outer frame, with 16px sides and 728px content at full width.

## CLI

```sh
bb session-share start [<thread-id>] [--minutes N|0] [--mode view|review] [--tunnel quick|custom]
bb session-share list
bb session-share status [<thread-id>]
bb session-share stop [<thread-id>]
```

The thread defaults to the caller's current thread. Zero minutes means Until revoked. CLI output includes access codes; do not paste it into public logs or tickets. Starting a share creates an external tunnel and must be an intentional owner action.

## Assets and licensing

Package code is MIT licensed. The bundled Inter font is covered by `assets/inter-LICENSE.txt`. The canonical static identity is `assets/share.svg`. Third-party runtime dependencies retain their own licenses in `node_modules`.
