# Pinpoint

Point at a live page and send reviewable visual feedback to BB agents.

Open Pinpoint from a thread's panel launcher. Pick an element, select text, or edit rendered text with the context menu. Each item keeps its page location, conversation, optional screenshot, and review state. The agent marks a change ready. You approve it or reply with more feedback.

## Requirements

BB 0.46.1 or later and Plugin SDK 0.6.49 or later. No API key or other Oh My BB package is required. Dispatch uses the thread's configured BB agent. Its normal provider costs and permissions still apply.

Preview pages run in an opaque-origin sandbox. They cannot use the BB page's origin or storage. Feedback requested from inside a preview must be confirmed in BB.

## Package-local development

```sh
npm ci
npm run check
```

This directory owns its lockfile, source, dependencies, generated assets, host entry, and skills. There are no sibling runtime imports, symlinks, or repository-level runtime dependencies. The generated standalone review client is committed because BB's Git installer omits dev dependencies and never runs lifecycle scripts. Its ignore entry excludes it from Tailwind scanning, not from tracked Git updates. `npm test`, `npm run typecheck`, and `npm run build` regenerate it; include that tracked update with source changes. The package build also removes machine paths from source-map metadata.

The plugin ID stays `pinpoint`. Installing a source package does not publish comments, screenshots, settings, or stored learning approvals. Source selection, publication, and retirement of a private installation are separate operator decisions. Never uninstall to change source: uninstalling can delete plugin state.

## Configuration and setup

Settings → Pinpoint keeps Default URL, Where picks go, and immediate dispatch in native Configuration. Existing setting keys and defaults are preserved. A review chat uses BB's normal child-thread capability when optional Agents integration is off or unavailable.

More → Setup guide opens a dedicated guide. The same guide is reachable from the working panel's settings menu. The browser panel intentionally fills its thread panel; it is a navigation and inspection surface, not a 760px settings page. The setup guide uses the standard 760px outer frame, 16px side gutters, and overlay scrollbar.

The floating toolbar preserves picking, question mode, screenshot preference, text-edit confirmation, numbered pins, three review inboxes, and per-page history. Opening a menu does not dispatch a pick or save a learning. Deletion asks for confirmation naming the feedback; Cancel comes first.

## Optional integrations

Settings → Pinpoint → Oh My BB owns these independent choices. New choices start off. Pinpoint never installs, enables, or probes another plugin at startup.

| Integration | When contacted | Behavior when off or unavailable |
| --- | --- | --- |
| Agents (`agent-profiles`) | Review-chat dispatch, after explicit opt-in | Use BB's normal child thread with the parent agent configuration. Existing child IDs stay in storage. |
| Provider Usage (`provider-usage`) | Dispatch preflight, only when both it and Agents are enabled | Skip the capacity check. Missing or unknown usage is not proof that an agent cannot run. |
| Clasi (`clasi`) | Only an explicitly consented learning write or retry | Approval of the fix still succeeds. A disabled or unavailable save is reported without claiming success. |

BB's thread, project, environment, host RPC, storage, HTTP, realtime, panel, and agent-tool APIs are essential BB capabilities, not dependencies on Agents, Browser, or another suite plugin. The Browser plugin is not installed, enabled, or called by Pinpoint.

### Learning consent

The global Clasi learning switch does not authorize any particular write. Each card's checkbox starts off. The card shows the exact proposed design or copy preference. Pinpoint compares the submitted text, topic, and logical key with the current proposal before recording consent. Approving the fix without the checkbox saves nothing to Clasi.

Pinpoint checks the global switch before writing and again after asynchronous repository-scope lookup. Retries use the stored exact proposal snapshot. Disabling the integration stops new writes and retries without clearing saved choices. A changed, reopened, or deleted item cannot be saved from a stale pending attempt. An already-saved preference is not written again by Retry.

Clasi receives `kind: preference`, design/copy topic, approved value, logical key, repository scope, source thread ID, and a consent reference. Git repositories share their canonical remote hash; a project without a remote uses its BB project ID. Clasi stores the metadata but does not independently validate the external approval event. Pinpoint owns consent enforcement.

Legacy saved preferences and consent text are retained. An unsaved legacy consent that lacks the full topic/key snapshot is not silently promoted into permission for a new write. Reopen the item, let it become ready, and approve the exact learning again. Failed writes remain visible. Tests use disposable stores and a fake Clasi receiver; validation never writes live learning data.

## Preview isolation

The authenticated address-bar route creates a random, expiring resource capability for one thread and one selected app origin. The resource route accepts GET only. It does not forward browser cookies, Authorization, upstream Set-Cookie, or off-origin redirects. Every resource response carries a CSP sandbox header, including when opened outside its iframe. The iframe also omits `allow-same-origin` and popup escape permissions.

Picking, screenshots, text editing, numbered pins, same-origin links, SPA navigation, and the panel's Back and Forward controls remain available. Send, reply, approve, dismiss, and delete requests from the reviewed document are untrusted. BB checks the source frame, current thread and page, then shows its own confirmation. The picker handshake token is not proof of user intent. Approving a fix from the preview never approves a learning.

The resource bridge is not a general authenticated browser. POST APIs, WebSockets/HMR, sign-in flows, and undeclared third-party asset origins may not work. BB login cookies are never forwarded to preserve a preview login. For a protected BB Connect app, use its localhost URL from its owning thread when available. The known BB app origins and its server port cannot be preview targets.

Older Session Share review servers do not meet the isolation contract. Their embedded previews are refused until that consumer is updated. Normal Pinpoint in BB does not require Session Share. This migration does not change Session Share or publish its private feedback.

## Access and privacy boundaries

Comments, screenshots, selected text, DOM context, receipts, and approvals stay in BB's private plugin storage. The public repository contains source and synthetic fixtures only. It does not contain runtime databases, credentials, private reports, or feedback history. Do not include secrets, personal information, or customer data in comments or proposed learnings.

The preview bootstrap uses BB's `auth: local` gate. Screenshot writes use authenticated, thread/page-bound RPC, not a page-callable HTTP upload route. Only the scoped, expiring GET resource capability is unauthenticated. It grants access to the selected app's resources, not to BB RPCs, feedback records, or mutation APIs. There is no unauthenticated HTTP feedback endpoint. Resource capabilities are private access tokens; do not publish them.

Optional sharing consumers use authenticated plugin RPCs. `prepareGuestProxy` and the standalone controller require isolation contract version 1; legacy callers fail closed. The consumer must apply the returned CSP and other safety headers to its own HTTP responses, keep the iframe opaque, and enforce guest authentication, thread/page scope, expiry, CSRF, and action permissions on its server. It must reject learning approval and retry inputs, not rely on the guest UI to hide them. Never expose a BB plugin HTTP token to a guest or reviewed page. See [the guest preview contract](docs/guest-preview-contract.md) for the breaking change and migration checklist. Headers on Pinpoint's own route cannot protect another plugin's response.

Guest feedback and replies wait in the separate **Guest feedback** toolbar view. The owner can Delete, Edit the pending guest text, or use the checkmark to approve that exact batch for agent processing. Editing alone saves and sends nothing. A newer guest comment invalidates an older approval snapshot. Every later guest reply returns to Guest feedback, including replies on finished or approved work. **Agent feedback** counts only finished agent work awaiting review; its checkmark approves completion, not another agent run.

The four toolbar views are ordered **User feedback → Guest feedback → Agent feedback → Closed**. Matching Hugeicons person, group, bot and circled-check glyphs each have the same count badge. User feedback is the open-work queue, including questions awaiting an answer and guest requests already approved for processing. Guest feedback holds unapproved guest input. Agent feedback holds finished work for owner review. Closed contains approved or dismissed items. These are queues, not four mandatory sequential steps.

Global immediate dispatch does not authorize a guest to start an agent, send a message, complete work, or save learning. Held input is withheld from agent tools and delivery. Owner-edited guest text is labeled as edited. The original stays private and is excluded from guest and agent projections. Guest deletion is limited to the originating participant's own capture before owner adoption. The guest consumer uses dedicated scoped RPCs, a minimal public row projection, a fixed-library RPC, and short-lived screenshot receipts instead of owner APIs or HTTP forwarding.

The selected app can read feedback intentionally rendered in its pins and popups. App paths are not a secrecy boundary against scripts on that same selected origin. Keep secrets out of feedback.

## Agent tools and CLI

- `pinpoint_list`: open feedback for the agent's project.
- `pinpoint_show`: context and available screenshot pixels for one item.
- `pinpoint_resolve`: report ready, ask a question, or reject with a reason.
- `bb pinpoint list`, `show`, `ready`, `ask`, `reject`, and `comment`: CLI equivalents.
- `bb pinpoint approve` and `delete`: user-only CLI actions; rejected from an agent thread context.

Run `bb pinpoint --help` for command flags. The included `skills/pinpoint/SKILL.md` documents scope classification, agent-asserted diff receipts, questions, and optional learning proposals. Receipts are not independently verified diffs. Legacy `change` intent remains actionable as `fix`; severity only orders work and never makes suggestions optional.

## License

MIT. See `LICENSE` and `THIRD_PARTY.md`.
