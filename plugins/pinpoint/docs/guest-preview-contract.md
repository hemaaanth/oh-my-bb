# Guest preview isolation contract 1

This is an authenticated plugin-to-plugin contract. It is not a public feedback API. A resource token is not origin isolation and is not consent to a feedback action.

## Breaking change

`prepareGuestProxy` requires `isolationVersion: 1`. An older call is rejected before active page content is returned. The standalone controller also refuses a mount without version 1, explicit `permissions`, and a dedicated `screenshotUploadUrl`. It displays an update notice and does not load the preview.

The old `POST /screenshot`, diagnostic uploads, `GET /picker-lib.js`, and raw `guestAnnotations` projection are removed. Use the dedicated guest RPCs below. Never expose owner `capture`, `update`, `remove`, `list`, or `uploadScreenshot` through a guest transport. Do not restore a generic guest-to-Pinpoint HTTP forwarder.

The older Session Share consumer discards response headers from `prepareGuestProxy`. Its embedded previews are therefore disabled by this cutover. This package does not change that consumer. Normal Pinpoint inside BB remains independent of it. Do not remove the version check to restore an old link.

## Prepared resources

Call `prepareGuestProxy` with:

```ts
{
  isolationVersion: 1,
  targetUrl: "https://preview.example.test/account",
  proxyBase: "https://review.example.test/preview/<random-capability>",
  contentType: "text/html",
  bodyBase64: "..."
}
```

`proxyBase` is an absolute capability **path prefix**, not an arbitrary `?u=` forwarding endpoint. Its final path component must have at least 32 URL-safe characters. The consumer must generate it cryptographically; accepting a suitably shaped string does not prove entropy or scope. The target and review origins must differ. Do not include query strings, fragments, credentials, or CSP syntax in the capability prefix.

The output is `{ isolationVersion: 1, contentType, bodyBase64, headers }`. The receiver must copy **all** returned safety headers to its actual HTTP resource response. They include:

- `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups` plus resource, connection, form, frame, and base restrictions;
- anonymous CORS without `Access-Control-Allow-Credentials`;
- `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

Keep the CSP header on HTML, SVG, scripts, styles, redirects, and error responses, including direct top-level visits. A meta tag or an iframe attribute alone is not a replacement for the HTTP header. Never copy upstream CSP, Set-Cookie, CORS credentials, or other authority-bearing headers over the prepared response.

The containing iframe must use `sandbox="allow-scripts allow-forms allow-popups"` and `referrerpolicy="no-referrer"`. Never add `allow-same-origin`, `allow-popups-to-escape-sandbox`, or top-navigation permissions. An opaque iframe cannot safely read BB DOM, storage, or same-origin APIs. Keep the same protection when the capability is opened outside the expected iframe.

## Capability and resource server

The consumer owns and must enforce these rules before fetching anything:

1. An authenticated, authorized review session chooses one app origin and thread. The guest cannot replace that binding through a URL or body field.
2. A random capability grants GET resource access only. Bind it server-side to that origin, thread, and expiry. Revoke expired access; do not resurrect expired tokens on a later heartbeat. Pinpoint's owner route uses 256-bit tokens and a 30-minute renewable lifetime. Consumer tokens may use the authenticated guest/share expiry, capped at four hours, without renewal or resurrection.
3. Decode only a path and query relative to the bound app origin. Validate every redirect hop before following it. Reject other schemes, embedded credentials, origin changes, and known BB origins or its server port. Never create a generic BB/network/RPC proxy.
4. Never forward BB or guest browser cookies, Authorization, or host plugin credentials to an app. Do not pass plugin HTTP tokens into reviewed content. Protected Connect authentication is not restored by forwarding a BB session.
5. Apply response size and timeout bounds. Pinpoint's owner bridge limits each resource to 32 MiB and direct fetches to 15 seconds.
6. Serve the screenshot library at `<proxyBase>/.pinpoint/picker-lib.js`. Call authenticated `prepareGuestPickerLibrary({ isolationVersion: 1, targetUrl, proxyBase })` for the fixed installed library and its safety headers. Copy those headers too. There is no arbitrary path or body input and no BB HTTP credential forwarding.
7. Preserve path-based URLs for relative modules and assets. Prepared HTML and JavaScript handle static imports, runtime imports, import maps, fetch, images, CSS, and virtual SPA history. Undeclared third-party origins, write APIs, HMR, and login flows are outside this GET bridge.

App-driven pushState/replaceState and Back/Forward keep a per-entry virtual target. Pinpoint restores that target and base URL before app popstate listeners, while history.state and popstate.state expose the original app state only. Picker protocol 6 reloads stale parked previews; isolation contract version remains 1.

Headers emitted by Pinpoint's own HTTP route cannot protect a different plugin's HTTP response. Pinpoint can validate the requested contract version, but cannot independently verify how another server sends those headers. The consumer must prove that behavior.

## Controller and mutation server

Mount `PinpointPublicReview` with the existing root, thread, target, proxy bootstrap, state, navigation, feedback, screenshot-read and CSRF values, plus:

```ts
{
  isolationVersion: 1,
  permissions: { capture: true, reply: true, delete: true },
  screenshotUploadUrl: "./api/preview-screenshot-upload"
}
```

The bootstrap URL can authenticate the viewer and redirect into the scoped resource prefix. Do not put mutation authority into the resource capability.

The controller treats even a valid picker message as untrusted. It checks the source frame and opaque origin, validates its handshake, scopes annotation IDs to the current thread/page, and asks for confirmation outside the reviewed document. The handshake token identifies a picker session, not a human gesture. Native BB can confirm owner actions. The guest controller exposes capture, reply and permitted deletion only; owner approval, dismissal, dispatch and learning actions are hidden and rejected before network writes.

The consumer's state and mutation endpoints must authenticate the guest, enforce share expiry and allowed actions, scope every read/write to its authorized thread/page, and validate CSRF. Never trust submitted scope or hidden controls. The authenticated consumer fixes `threadId`, `url`, `reviewRef` and `participantRef` on the server. References are nonsecret provenance IDs, never raw share access, session, CSRF or resource tokens.

### Guest RPCs

All calls require `isolationVersion: 1`. `scope` below means `{ isolationVersion: 1, threadId, url, reviewRef, participantRef }`.

| RPC | Input and result |
| --- | --- |
| `captureGuest` | Core capture fields plus scope, no `sourceFile`; returns `{ captureId, screenshotUpload: { token, expiresAt } \| null }`. |
| `listGuest` | Scope; returns `{ rows }` recursively whitelisted by `lib/guest-review.ts`. No owner routing, project, source path, learning, receipt, or provenance references. |
| `replyGuest` | Scope plus `{ id, text }`; appends a guest reply without reopening or sending. |
| `deleteGuest` | Scope plus `{ id }`; deletes only the originating participant's own open capture still awaiting owner adoption. No cancellation message. |
| `screenshotGuest` | Scope plus `{ id, kind }`; returns `{ shot: { mime, data } \| null }`. |
| `uploadGuestScreenshot` | `{ isolationVersion: 1, token, kind, mime, screenshot }`; no caller-selected row/thread/page. |

Captures and replies wait in the owner's **Guest feedback** view. Global auto-dispatch, enabled review sharing and optional integration toggles do not authorize guest execution. Held captures are absent from agent tools/CLI and delivery. Pending guest replies are withheld from agent projections and messages, including a reply arriving during owner routing. Each later guest reply returns to Guest feedback, even on completed work. The guest cannot approve processing, complete work, or authorize learning.

Rows contain `{ annotation, workflowState, summary, screenshots, createdAt, guestPending, guestCanDelete, authoredByGuest }`. The annotation whitelist contains pin/comment/text-edit/location fields, a minimal `pinpoint` object with optional `ownerEdited`, and `{ role, content, guest?, ownerEdited? }` conversation messages. Owner-edited text must be labeled as edited. Original guest text, pending owner drafts, revision hashes, and owner routing/provenance stay private. Guest UI can delete only when its permission and `guestCanDelete` are both true. Producer checks remain authoritative.

Owner-only `list` rows carry `guestFeedback: { revision, capture: { comment, textNew } | null, messages: { id, content }[] } | null`. The trusted owner card can edit this local snapshot. Its checkmark calls owner-only `approveGuestFeedback({ id, ...guestFeedback })`. The producer requires the current revision and exact message IDs/order, applies edits and releases that batch atomically, then dispatches. Newer guest input rejects a stale approval or remains held if it arrives during routing. Original text is retained privately and stripped from agent/guest projections. Generic owner feedback/redispatch and completion approval cannot release pending guest input. Never expose this owner snapshot or RPC through a guest transport. Learning still needs the separate global opt-in and exact-text owner consent.

The consumer's capture HTTP response is `{ ok: true, capture: { captureId } }`. Keep `screenshotUpload` server-side, bound to that authenticated guest session and current page. The controller uploads with `clientId` equal to the returned canonical `captureId`, not the requested picker stamp. The consumer looks up that receipt, then calls `uploadGuestScreenshot`. The random receipt expires after 60 seconds; each image kind is write-once and limited to 2 MiB of base64 text. Unknown, expired, deleted, overwritten or mismatched captures fail closed. Text edits receive no upload receipt. Restart loses transient receipts safely.

Selected-page feedback is intentionally rendered in the reviewed document. That app's scripts can read those pins and replies. App paths are not a secrecy boundary against scripts controlling the same selected origin. Do not put secrets in feedback. Isolation protects the rest of BB, not data deliberately rendered into the app.

## Required consumer verification

Use disposable BB/app servers and synthetic sessions. No live BB data, credentials, learning writes, feedback messages, retention changes, or destructive actions.

- Open a hostile synthetic page in the iframe and directly at its capability URL. It must not read the parent DOM/storage or authenticated mock BB endpoints. Its requests must not receive BB credentials.
- Check sandbox/CSP/CORS on every served resource type. Exercise missing/expired tokens, redirect escapes, unknown IDs, cross-thread/page actions, CSRF failures, legacy versions, and direct mutation requests.
- Prove guest capture/reply/delete requires trusted confirmation. Prove direct guest owner-action requests fail without dispatch, messages or Clasi writes. Held input must remain absent from agent tools/CLI/send payloads until exact-batch owner approval. Test a guest reply racing that approval and another reply after completion.
- Exercise static/runtime/inline modules, import maps, CSS, images, fetch, links, SPA navigation, Back/Forward, picking, rendered-text edits, and screenshot persistence.
- Check desktop dialogs, compact drawers, focus return, Escape/outside dismissal, and action access at narrow widths.

Only after those checks pass should the future sharing consumer opt into version 1. Updating a schema literal alone is not a safe migration.
