# Changelog

## Unreleased

- Remove the sidebar rail page. Open the setup guide in a dialog from settings or the thread panel.

- Prepare an independent `plugins/pinpoint` package with its own lockfile, SDK pin, build, tests, skill, icon, and setup guide.
- Keep existing plugin ID, setting keys, stored feedback, screenshots, routing IDs, and learning choices.
- Add explicit, default-off Agents, Provider Usage, and Clasi integration controls under Settings → Pinpoint → Oh My BB. No startup cross-plugin probes.
- Bind learning approval to the exact text, topic, and logical key. Gate writes and retries on the global opt-in. Preserve newer item state across asynchronous writes.
- Retain legacy consent without silently authorizing a broader pending write. Block guest learning authorization in the standalone review client.
- Add named deletion confirmation with Cancel first and preserve the specialized browser review controls.
- Normalize source-map metadata so package builds do not distribute absolute machine paths.
- Isolate owner previews with an opaque iframe and CSP sandbox headers on a scoped, expiring GET resource capability. Never forward BB login cookies, Authorization, Set-Cookie, or off-origin redirects.
- Keep picking, screenshots, rendered text editing, links, SPA navigation, and panel history. Require BB-owned confirmation for requests sent from the reviewed document; a picker token is not user consent.
- Add a thread/page-bound screenshot RPC and stage screenshot pixels until the capture is confirmed.
- Version the guest preview contract and refuse legacy prepared-content callers and controller mounts. Older Session Share embedded previews need a separate consumer update; Session Share source is unchanged.
- Document authenticated-preview limitations and the required guest response headers, capability scope, and server-side consent boundaries.
- Hold guest captures and replies in a separate Guest feedback view for exact-batch owner approval. Exclude pending guest input from agent tools, CLI and delivery, including routing races; global auto-dispatch does not grant guest execution.
- Add scoped guest capture/read/reply/delete APIs, minimal nested projections, participant-owned deletion and 60-second write-once screenshot receipts. Remove raw legacy guest reads and HTTP library forwarding.
- Restrict the standalone controller to explicit capture/reply/delete permissions. Preserve owner approvals and exact-text learning consent inside BB.
- Commit the generated standalone runtime asset so managed Git installs build with production dependencies and lifecycle scripts disabled.
- Restore virtual preview URLs on app-driven Back and Forward after opaque-origin history fallback. Keep app object, primitive and null state intact in history.state and popstate.state; restore the base URL before app listeners.
- Add compact same-row Delete, Edit and checkmark controls for guest feedback. Keep owner edits local until approval, reject stale batches, and retain originals privately without exposing them to guests or agents.
- Return new guest comments on ready, approved or dismissed work to Guest feedback. Keep Agent feedback for finished agent work awaiting review only; completion approval cannot bypass pending guest input.
- Keep the finished-work checkmark beside the reply controls and shorten reply prompts. Bound guest editors and the eight-control toolbar at narrow widths.
- Order the toolbar as User feedback, Guest feedback, Agent feedback and Closed. Use matching Hugeicons person/group/bot/circled-check glyphs, consistent count badges and accessible view descriptions.
