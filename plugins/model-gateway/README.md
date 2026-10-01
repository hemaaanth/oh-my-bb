# Model Gateway

Model Gateway pools Claude and ChatGPT accounts, and optional paid API keys,
behind one hub in the BB server. Each
harness has a chain of upstreams. When one runs out, the next request of the
running thread goes to the next chain entry. When the client and the upstream
speak different protocols, the hub translates: Claude Code (Messages) behind a
ChatGPT or Responses-key entry, and Codex, omp, FX, nanocodex or Pi
(Responses) behind an Anthropic-compatible key.

Operator guide (commands, chains, model map, legal rule, Pooler cutover):
`skills/model-gateway/SKILL.md`.

Automatic Claude Code failover maps Fable to `gpt-6-astra`, Opus to
`gpt-6-sol`, Sonnet to `gpt-5.6-terra`, and Haiku to `gpt-6-luna`.

## Surfaces

- HTTP, mounted at `/api/v1/plugins/model-gateway/http`:
  `POST /v1/messages`, `POST /v1/messages/count_tokens`, `POST /v1/responses`,
  `WS /v1/responses`, `GET /v1/models`, `HEAD /api/hello`.
- `bb gateway ...` CLI.
- Env for `claude-code`, `codex`, `acp-omp`, `acp-fx`, `acp-nanocodex` and
  `pi`, with a per-thread hub token. See "ACP harnesses and Pi" below.
- Health label `Gateway`, or `Gateway: on fallback` when a recently routed
  thread is past chain entry 0.
- RPC `thread.route({ threadId })` returns
  `{ harness, upstreamKind, accountLabel, model, chainIndex, chain, stickyUntil,
  autoModel, auto } | null`; `chain` holds plain upstream names.
- Realtime channel `model-gateway.route-changed`, payload `{ threadId }`, when
  a thread's binding changes.
- Thread header badge (`app.tsx`), for example `ChatGPT · gpt-6-astra` or
  `kimi · kimi-k3` (a key shows its label), on every routed thread. It is
  quiet on the first chain entry and stronger on a fallback or a Jev pick
  (`ChatGPT · auto → gpt-6-sol (jev 0.82)`). The tooltip shows the chain.
- Settings section `gateway` (`app.tsx`): a status line, one Upstreams list,
  one Routes row per harness (switch, chain in plain names, mapped models,
  Edit drawer with the chain and the per-route Auto (Jev) switch), and
  Advanced (model map, Jev key and model, base URLs, limits, machine tokens).
  The chain "Add" list offers upstream kinds only; per-account entries come
  from `bb gateway chain set`. It calls the same functions as the CLI. Key
  values are write-only; no RPC returns a key, token or OAuth credential.
  RPC: `routing.get`, `key.add`, `chain.options`, `chain.set`,
  `modelMap.set`, `auto.set`, `live.get` (threads on a fallback or a Jev
  pick, and holds), `hold.clear`, plus the ported
  account methods. `chain.set` rejects Claude OAuth outside `claude-code`.
- The sidebar footer shows usage limits for each authenticated Gateway account.
  It opens from a short-lived cache and refreshes limits on demand.

## Failover rules

- Failover happens before the first byte reaches the harness. Errors inside a
  200 stream are forwarded; the harness retries the turn.
- Exhaustion (S6): a 429 with ChatGPT `x-codex-*` over-limit headers or
  Anthropic `anthropic-ratelimit-unified-*-status: rejected`.
- A plain 429 waits once when `retry-after` is 20 seconds or less. Longer: an
  unpinned account moves to the next account; a pinned account moves to the
  next chain entry.
- API keys: a 402, or a 400/403/429 whose body says the credit or balance is
  gone, benches the key for 30 minutes and moves on. Any other 429 is a plain
  hold as above. Keys have no quota headers.
- A request the translator cannot represent gets a 400 and no failover.
- `count_tokens` on a ChatGPT entry or a compatible key is a local estimate
  and does not move the thread.

## API-key upstreams (P4)

API keys bill per token. Use them as fallbacks, not as the primary, unless
that is the point.

| Kind | Protocol | Base URL | Examples |
|---|---|---|---|
| `claude-key` | Messages | `anthropicUpstreamBaseUrl` (api.anthropic.com) | Anthropic API key |
| `anthropic-compatible-key` | Messages | required; what the vendor documents for `ANTHROPIC_BASE_URL` | Kimi, GLM |
| `responses-compatible-key` | Responses | required; what the vendor documents for `OPENAI_BASE_URL` (ends in `/v1`) | OpenAI API, OpenRouter |

Why these three: the hub only needs to know the wire protocol and where to
send it. Vendors differ only in base URL and model names, and the model map
covers names. `claude-key` stays separate because it predates P4, uses the
Anthropic adapter's rate-limit headers, and pools several keys like the Pooler.

```
printf '%s\n' "$KIMI_KEY" | bb gateway key add anthropic-compatible-key --label kimi --base-url <url> --key-stdin
printf '%s\n' "$OR_KEY" | bb gateway key add responses-compatible-key --label openrouter --base-url https://openrouter.ai/api/v1 --key-stdin
bb gateway chain set codex chatgpt-oauth:* anthropic-compatible-key:kimi
bb gateway chain set claude-code claude-oauth:* anthropic-compatible-key:kimi
bb gateway model-map set anthropic-compatible-key:kimi 'claude-opus-*' kimi-k3
bb gateway model-map set anthropic-compatible-key:kimi 'gpt-6-*' kimi-k3
```

- The key is read from stdin only (the bb CLI turns `--key-stdin` into one
  line). It is stored like the account secrets (`0600` file) and never
  printed, logged or returned by the CLI or RPC.
- Labels are unique per kind. Chain entries name one key as `<kind>:<label>`
  or every key of a kind as `<kind>:*`. Each compatible key is tried on its own.
- Model map keys are `<kind>` or `<kind>:<label>`; the label map wins. With no
  match, a key gets the client's model unchanged (nanocodex `kimi-k3` on a
  Kimi key), after omp's `gw-` prefix is stripped.
- Same protocol: passthrough with the mapped model. The ChatGPT-only field
  stripping does not apply to keys, so `max_output_tokens`, `temperature` and
  `top_p` reach the key.
- Responses client behind a Messages key (`src/translate/responses-to-anthropic.ts`):
  tool-call ids are mapped to ids Anthropic accepts, `custom` tools become a
  one-string-field tool, Codex `namespace` tools are flattened and restored,
  nanocodex's `additional_tools` input item becomes Messages tools. Reasoning
  effort becomes a thinking budget (adaptive thinking for Claude models that
  require it). ChatGPT encrypted reasoning is dropped. Anthropic thinking comes
  back as a `reasoning` item with an `mgwa1:` envelope; it is replayed only to
  the same upstream model and dropped before any Responses upstream. This works
  over the HTTP and WebSocket routes.
- Replay rule: a thinking or reasoning block goes back only to the upstream
  that made it. Anthropic accounts (Max, `claude-key`) count as one upstream,
  ChatGPT accounts as another, and each compatible key as its own
  (`<kind>:<label>`). A compatible key's own signatures, `redacted_thinking`
  data and `encrypted_content` reach the client inside an `mgwk1:` envelope and
  are unwrapped only for that key. Everything else is dropped before sending, so
  failback from Kimi to Max, or from OpenRouter to ChatGPT, never sends a
  foreign signature. Genuine Max thinking still goes to Max unchanged.
- Hosted Responses tools (for example `web_search`) and input items with no
  Messages form (for example ChatGPT `compaction`) are left out on a Messages
  key. The gateway logs this once per thread and kind, with no body content.
  Losing a `compaction` item loses the history it summarized.

## Automatic model choice (Jev, P5)

`bb gateway auto <harness> --key <label>` lets TypeSafe Jev pick the model at
each new user turn. The key is a `responses-compatible-key` holding an
OpenRouter key (`--base-url https://openrouter.ai/api/v1`). `--model <id>`
sets Jev's OpenRouter model id (default `typesafe/jev-1.13`).

- Candidates, cheapest first: `claude-sonnet-5`, `claude-opus-5-5` for Claude
  Code; the ChatGPT models of the model map (`gpt-6-luna`, `gpt-6-sol`,
  `gpt-6-astra`) for the Responses harnesses. A candidate is offered only when
  a legal, unheld, unexhausted account in the chain can serve it. One
  candidate is used without asking.
- The pick replaces the client's model. The chain then routes it as usual:
  legal guard, holds, model map and failover do not change.
- The pick holds for the thread until the next user turn; it never changes
  inside a tool loop. Only requests with client tools ask again, so Claude
  Code's title and WebSearch side calls do not. Side calls on other models
  (Haiku, FX's title model, nanocodex `kimi-k3`) keep their model.
- Fail open: an error, a confidence below 0.6, an unreadable answer, or no
  answer within 2 seconds keeps the client's model and the chain's normal order.
- Shown in `bb gateway status --thread <id>` (`Auto: auto → gpt-6-sol (jev
  0.82)`) and in the header badge (`auto → gpt-6-sol`).
- Privacy: each Jev call sends OpenRouter only the last user message
  (truncated to 4,000 characters) and the candidate model names. No system
  prompt, history, tool output or file content. Prompts are never logged.
- Known limit: a Claude Code subagent's first request looks like a new user
  turn, so it asks Jev again (the same rule the failback uses).

## ACP harnesses and Pi (omp, FX, nanocodex, Pi)

All four speak OpenAI Responses and default to `chatgpt-oauth:*`. Any key
kind can follow in their chains; Claude OAuth never can.

| Harness | Env | Hub token | Setup |
|---|---|---|---|
| `acp-omp` | `MODEL_GATEWAY_TOKEN` | `Authorization: Bearer` | `bb gateway setup omp` writes a `model-gateway` provider into `~/.omp/agent/models.yml` (omp cannot read `baseUrl` from env) |
| `acp-fx` | `FX_E2E_OPENAI_CODEX_RESPONSES_URL`, `FX_E2E_OPENAI_CODEX_MODELS_URL` | query `?gateway_token=` | Optional: `bb gateway setup fx` prints standalone `fx-acp` setup; FX needs its own `fx login codex` per host |
| `acp-nanocodex` | `NANOCODEX_API_BASE_URL`, `MODEL_GATEWAY_TOKEN` | `Authorization: Bearer`, over `WS /v1/responses` | Optional: `bb gateway setup nanocodex` prints standalone `nanocodex-acp` setup |
| `pi` | `MODEL_GATEWAY_BASE_URL`, `MODEL_GATEWAY_TOKEN` | `Authorization: Bearer` | `bb gateway setup pi` writes `~/.pi/agent/extensions/model-gateway.js` (or under `PI_CODING_AGENT_DIR`) |

- FX's token rides in the query because core matches plugin routes by exact
  path, so a `/t/<token>/` path segment would never reach the plugin. FX also
  sends its own ChatGPT bearer, `chatgpt-account-id` and `originator`; the hub
  replaces all three and drops the query token before the upstream call.
- Codex sends its token as `x-bb-account-pool-token` (core's pool config); the
  hub also accepts `x-bb-model-gateway-token` and a bearer.
- omp sees ChatGPT models as `gw-<model>` (omp routes known ids to its
  built-in provider). `GET /v1/models` for an omp token lists them.
- Bodies from these harnesses are fitted to the ChatGPT Codex backend on a
  ChatGPT entry: the model is mapped, and `max_output_tokens`, `temperature`,
  `top_p`, `stop` and `user` are dropped. Everything else, including
  nanocodex's `additional_tools` input item, passes through.
- nanocodex `kimi-k3`, `@cf/zai-org/glm-5.3` and `mimo-v2.6-pro` skip ChatGPT
  entries. With no key entry to serve them they get a 400 naming
  `bb gateway key add`.
- Pi (spike, Pi 0.87.1): Pi ignores `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`,
  and `models.json` does not expand env in `baseUrl` (only in `apiKey`). So the
  gateway ships a small Pi extension that registers a `model-gateway` provider
  (`openai-responses`) from the two env values. The file is the same on every
  host and never touches `models.json`. It always registers, so BB's Pi model
  catalog (spawned without thread env) lists the models; outside a routed
  thread they cannot connect. `setup pi` refuses to overwrite a file it did not
  write and backs up a changed one.
- `bb gateway routing <acp-omp|acp-fx|acp-nanocodex|pi> --off` stops the env.
  These harnesses get env only while their chain names an enabled account they
  may use.

## Legal rule

Claude Max OAuth accounts serve only Claude Code on `/v1/messages*`. This is
checked per request (`isLegalUpstream` in `src/chain.ts`), and chain settings
that break it are rejected. So for Codex, omp, FX, nanocodex and Pi the only
cross-vendor fallback is a paid API key.

## BB upgrade caveat

BB 0.43 rejects a `secret` field on env entries, so the gateway omits it.
Unreleased core makes `secret: z.boolean()` required. When BB upgrades past
0.43, add `secret: true` to the token entries in `src/server.ts`, or every
contribution is rejected.

## Coexistence with the Account Pooler

Only one of `account-pool` or `model-gateway` should drive a given provider's
environment at a time. The gateway checks `bb.sdk.plugins.list()` for
`account-pool` before contributing env for `claude-code`/`codex`; while the
Pooler is installed and enabled, the gateway contributes nothing for those
providers and reports
`Gateway: blocked by Account Pooler routing` as its health label.
`bb gateway doctor` reports the coexistence state, including the Pooler's own
`Proxied` health label where visible.

BB core resolves a provider's health label from the *first* loaded plugin
that has any env resolver registered for it (`resolveProviderEnvHealth` in
`plugin-service.ts`), independent of which plugin's env entries actually won
name collisions. That means the Pooler's `Proxied` label is only guaranteed
visible through `providerStates` when the Pooler happens to load before the
gateway — it is not a reliable *absence* signal. `bb.sdk.plugins.list()` is
the load-order-independent signal and is what gates env contribution; the
`providerStates` check is a secondary, confirming diagnostic used only inside
`doctor`.

## Migrating from the Account Pooler

`bb gateway import-pool` copies the Pooler's account metadata and secret files
into the gateway's own store, preserving file mode, without re-authenticating
and without ever printing secret values. The Pooler's account list lives in
the shared host `bb.db` (table `plugin_kv`, row `plugin_id='account-pool',
key='accounts:v1'`), not in the Pooler's own per-plugin `data.db` — a plugin
cannot call another plugin's `bb.storage.kv` live, so `import-pool` reads that
row directly from `bb.db`. Secrets live at
`<dataDir>/plugins/account-pool/secrets/accounts/account-<uuid>.json` (mode
`0600`) and are copied byte-for-byte.

After importing, disable the `account-pool` plugin. Until then the gateway
routes nothing for `claude-code` and `codex`.

## Third-party code

See `THIRD_PARTY.md`. The upstream ports (`src/upstreams/`, `src/hub.ts`,
`src/contracts.ts`, `src/rpc.ts`, `src/operations.ts`, `src/realtime.ts`,
`src/cli.ts`, `src/server.ts`) are forked from the core Account Pooler
(MIT, Michael Yong 2026). `src/translate/` is adapted from opencodex (MIT);
`src/translate/tool-call-id.ts` is vendored from it.
`components/ui/` and `lib/portal-scope.ts` come from BB shared UI and the BB
shadcn registry, as in the other plugins in this repo; `THIRD_PARTY.md` lists
the files.
