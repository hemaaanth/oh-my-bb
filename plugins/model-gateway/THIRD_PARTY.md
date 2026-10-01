## Usage logos

The Claude and OpenAI marks in `provider-icons.tsx` are adapted from
[`bb-plugin-usage/components/provider-logo.tsx`](https://github.com/MayankBansal12/bb-plugin-usage),
MIT, Mayank Bansal 2026.

## Account Pooler

- Source: core BB plugin [`account-pool`](https://github.com/get-bb/bb/tree/main/plugins/account-pool), MIT, Michael Yong 2026.
- Ported as-is (WP1.1: scaffold + passthrough routing), with renames only:
  plugin id `account-pool` -> `model-gateway`, CLI `bb pool` -> `bb gateway`,
  route `/api/v1/plugins/account-pool/http` -> `/api/v1/plugins/model-gateway/http`,
  health label `"Proxied"` -> `"Gateway"`, realtime channels
  `accounts-changed`/`config-changed` -> `model-gateway.accounts-changed`/`model-gateway.config-changed`.
  - `src/hub.ts`, `src/contracts.ts`, `src/rpc.ts`, `src/operations.ts`,
    `src/realtime.ts`, `src/cli.ts`, `src/server.ts` from the same files in
    `account-pool/src/`.
  - `src/upstreams/provider-adapter.ts`, `claude-adapter.ts`, `codex-adapter.ts`,
    `credentials.ts`, `oauth-login.ts`, `codex-device-login.ts`,
    `codex-websocket.ts`, `quota.ts`, `usage.ts`, `request-body.ts`, `store.ts`,
    `upstream-transport.ts` from the same files in `account-pool/src/`.
  - New in the gateway, not ported: the Account Pooler coexistence gate
    (`doctor`), `import-pool`, and (later work packages) `src/chain.ts` and
    `src/translate/**`.
  - One deliberate deviation from the ported source: the Account Pooler's
    `contributeEnv` entries set a `secret` field (`secret: true`/`false`).
    That field exists only in the bb monorepo's in-progress `plugin-sdk`
    source (`packages/plugin-sdk/src/internal/host-policy.ts`); it is not in
    any npm-published `@get-bb/plugin-sdk` version through `0.5.27` (the
    latest at the time of this port), where the entry schema is `.strict()`
    with no `secret` key. Since this plugin pins a published npm version,
    including `secret` fails schema validation and silently
    drops all entries (the SDK logs a warning and returns `[]`). The gateway
    drops `secret` from its ported entries to match the published schema.
- Settings pane: `app.tsx` ports the Account Pooler's settings section from
  `account-pool/app.tsx` (rows, quota values, drawers, sign-in flows, drag
  reorder, Advanced). The gateway adds the API keys, Routing, Chains, Model map
  and Live state sections.
- BB shared UI (`packages/shared-ui/src/components/ui/`, served as
  `packages/plugin-registry/r/*.json`), same license, copied verbatim with only
  import paths changed:
  - `components/ui/button.tsx`, `input.tsx`, `switch.tsx`, `select.tsx`,
    `dropdown-menu.tsx`, `responsive-overlay.tsx`, `collapsible.tsx`,
    `motion.ts`, `coarse-pointer-sizing.ts`, `overlay-trigger.ts`,
    `menu-item-hover.tsx`, `hooks/use-compact-viewport.tsx`,
    `hooks/use-media-query.ts`, and `lib/portal-scope.ts`.
  - `components/ui/resource-list.tsx` holds only `ResourceRowDetailChevron`
    from `resource/row.tsx`.
  - `components/ui/icon.tsx` re-exports the host's `experimental_Icon`.

```
MIT License

Copyright (c) 2026 Michael Yong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## opencodex

- Source: https://github.com/lidge-jun/opencodex (npm `@bitkyc08/opencodex` 2.66.0), commit `e70b3d86fb1201d7951dfeb25e09b7871c433047`.
- Used in `src/translate/` (WP1.3, Messages <-> Responses). The code was adapted, not copied as-is. The `OcxConfig` coupling, desktop aliasing, skill elision, translator budget and telemetry were removed.
  - `messages-to-responses.ts` from `src/claude/inbound.ts`, `inbound-content-options.ts`, `inbound-model-options.ts`
  - `responses-to-messages.ts` from `src/claude/outbound.ts`, `src/lib/sse-decoder.ts`
  - `reasoning-envelope.ts` from `src/responses/reasoning-envelope.ts`
  - `token-estimate.ts` from `src/lib/token-estimate.ts`
- Used in `src/translate/` (WP4.2, Responses -> Messages), same commit. Adapted, not copied as-is:
  the `OcxParsedRequest` model, translator budget, image normalization, tier/fast-mode
  handling, provider config and telemetry were removed; the translator works on the wire JSON.
  - `responses-to-anthropic.ts` from `src/adapters/anthropic.ts` (request build, thinking budget,
    input schema normalization, tool pairing, stream parse), `src/responses/parser.ts` (input items),
    `src/responses/namespace-tool-compat.ts` (namespace tool lowering), and `src/bridge/sse.ts`,
    `src/bridge/internal.ts` (Responses SSE framing, usage)
  - `tool-call-id.ts` vendored from `src/adapters/tool-call-id.ts` (the stateless helper dropped)
  - `reasoning-envelope.ts` gained the `mgwa1:` thinking envelope and (P5) the `mgwk1:` key envelope, `fitReplay` and the key output wrap, modelled on the same file

```
MIT License

Copyright (c) 2026 opencodex contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## model_router (Jev Router)

- Source: https://github.com/soumyacodes007/model_router, MIT.
- Used in `src/jev.ts` (P5): the Jev question wording ("cheapest tier that can
  fully complete this coding request in one pass", "judge the reasoning, not the
  length of the reply") and the 0.6 confidence floor, from
  `src/core/tier-catalog.mjs`. The TypeSafe SDK client was not used; the gateway
  asks Jev through OpenRouter chat completions.

```
MIT License

Copyright (c) 2026 Flavius Pop and Jev Router contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
