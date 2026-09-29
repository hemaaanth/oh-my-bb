---
name: model-gateway
description: Manage the Model Gateway, which routes Claude Code, Codex, omp, FX, nanocodex and Pi through pooled Claude and ChatGPT accounts and paid API keys (Anthropic, Kimi, GLM, OpenAI, OpenRouter), and fails a running thread over to the next upstream in its chain, translating between Messages and Responses when needed. Use whenever the user asks about gateway accounts, API keys, chains, the model map, fallback, the `bb gateway` CLI, Pi routing, or migrating off the core Account Pooler.
---

# Model Gateway

The gateway is one hub inside the BB server. Each thread gets its own hub
token. Each request goes to the first usable entry of the thread's harness
chain. When an upstream runs out, the next request goes to the next entry,
before any byte reaches the harness.

## Chains

A chain is an ordered list of entries per harness. An entry is `<kind>:*`
(every enabled account of that kind, by priority), `<kind>:<label>` (one API
key), or one account id. Kinds: `claude-oauth`, `claude-key`, `chatgpt-oauth`,
`anthropic-compatible-key`, `responses-compatible-key`.

Defaults:

- `claude-code`: `claude-oauth:*`, `claude-key:*`, `chatgpt-oauth:*`
- `codex`, the ACP harnesses and `pi`: `chatgpt-oauth:*`

Examples:

- `bb gateway chain set codex chatgpt-oauth:* anthropic-compatible-key:kimi`
- `bb gateway chain set claude-code claude-oauth:* anthropic-compatible-key:kimi`
- `bb gateway chain set acp-omp chatgpt-oauth:* responses-compatible-key:openrouter`

Sticky rules:

- A thread that fails over stays on the fallback while the primary is
  exhausted or held.
- Inside a tool loop it never moves back.
- It returns to entry 0 only at a new user turn, after the primary resets.

When the client and the upstream speak different protocols the gateway
translates: Claude Code (Messages) on a ChatGPT or Responses-key entry, and
Codex, omp, FX, nanocodex or Pi (Responses) on an Anthropic or
Anthropic-compatible key. Thinking or reasoning the gateway minted from the
other vendor is removed when the thread goes back. While a thread is on
ChatGPT or a compatible key, `count_tokens` is answered from a local estimate.
When an enabled Responses upstream is in the Claude Code chain, the gateway
sets Claude Code's auto-compact window to 160,000 tokens. That leaves room for
the gateway's conservative local estimate before the 272,000-token fallback
window. Existing sessions that already exceed that window need
`bb thread clear <id>` when compaction can no longer fit.

## API keys

API keys bill per token. Say so before suggesting one as a fallback.

- `claude-key`: an Anthropic API key (api.anthropic.com). No `--base-url`.
- `anthropic-compatible-key`: a Messages API at another vendor (Kimi, GLM).
  `--base-url` is what the vendor documents for `ANTHROPIC_BASE_URL`.
- `responses-compatible-key`: a Responses API (OpenAI API, OpenRouter).
  `--base-url` is what the vendor documents for `OPENAI_BASE_URL`, ending in `/v1`.

Add one with the key on stdin only; never put the key in arguments or chat:

```
printf '%s\n' "$KEY" | bb gateway key add anthropic-compatible-key --label kimi --base-url <url> --key-stdin
```

If the user has not given the key to the environment, use the `secrets`
skill to collect it into a dotenv file, then pipe it from there. The gateway
never prints, logs or returns the key.

A key that answers 402, or an error saying credit or balance is gone, sits out
for 30 minutes and the chain moves on. Other 429s are short holds.

## Model map

The model map picks the upstream model for a translated request. Defaults for
`chatgpt-oauth`:

| Claude model | ChatGPT model |
|---|---|
| `claude-fable-*` | `gpt-6-astra` |
| `claude-opus-*` | `gpt-6-sol` |
| `claude-sonnet-*` | `gpt-5.6-terra` |
| `claude-haiku-*` | `gpt-6-luna` |

A request with no matching pattern gets a 400 that names the command to add one.

Map keys are a kind or `<kind>:<label>` for one key; the label map wins. For
a key, an unmatched model passes through unchanged. Examples:

- `bb gateway model-map set anthropic-compatible-key:kimi 'claude-opus-*' kimi-k3` (Claude Code on Kimi)
- `bb gateway model-map set anthropic-compatible-key:kimi 'gpt-6-*' kimi-k3` (Codex on Kimi)
- `bb gateway model-map set responses-compatible-key:openrouter 'gpt-6-*' openai/<model>`

omp, FX, nanocodex and Pi send ChatGPT model names already. omp sees them as
`gw-gpt-6-astra` and so on (omp would route a known id to its own provider);
the gateway strips `gw-`. nanocodex's `kimi-k3`, `@cf/zai-org/glm-5.3` and
`mimo-v2.6-pro` skip ChatGPT entries and need a key entry that serves them.

## omp, FX, nanocodex and Pi

- omp: run `bb gateway setup omp` once. It adds only a `model-gateway`
  provider to `~/.omp/agent/models.yml` on the BB server machine and keeps a
  backup. Other hosts: `bb gateway setup omp --print --server-url <BB_SERVER_URL>`.
  Then pick a `gw-*` model in the acp-omp thread.
- FX (optional): `bb gateway setup fx` prints installation of the standalone
  `fx-acp` package and its custom agent entry. Model Gateway does not install
  or require it. The adapter pins FX to its Codex provider and hides Vercel AI
  Gateway and Grok. FX still needs
  `fx login codex` once per host; the gateway never forwards that login.
- nanocodex (optional): `bb gateway setup nanocodex` prints installation of the
  standalone `nanocodex-acp` package and the custom agent entry. Model Gateway
  does not install or require it. The command changes no BB settings.
- Pi: run `bb gateway setup pi` once per host. It writes
  `~/.pi/agent/extensions/model-gateway.js`, a small extension that registers
  a `model-gateway` provider from the per-thread env. It never edits
  `models.json`, refuses to overwrite a file it did not write, and backs up a
  changed one. Other hosts and sandboxes: save `bb gateway setup pi --print`
  there; the file is the same everywhere. Then pick a `model-gateway` model in
  the Pi thread.
- `bb gateway routing <acp-omp|acp-fx|acp-nanocodex|pi> --off` stops routing one.

## Legal rule

Claude Max OAuth accounts (`claude-oauth`) serve only Claude Code. The hub
enforces this per request. `bb gateway chain set` rejects a chain that puts a
Claude OAuth account behind any other harness. Do not try to work around it.
For Codex, omp, FX, nanocodex and Pi, the only cross-vendor fallback is a paid
API key.

## Visibility

- Health label: `Gateway`, or `Gateway: on fallback` while a thread routed in
  the last 30 minutes is bound past chain entry 0.
- Thread header badge: for example `ChatGPT · gpt-6-astra` or `kimi · kimi-k3`,
  on every routed thread. It stands out on a fallback entry or a Jev pick
  (`auto → gpt-6-sol (jev 0.82)`). Its tooltip shows the chain.
- Settings > Model Gateway shows a status line, the Upstreams list, one Routes
  row per harness (Edit opens the chain and the Auto (Jev) switch), and
  Advanced (model map, Jev key and model, base URLs, limits). It edits the
  same state as the CLI. It never shows a key value. Per-account chain
  entries are set with `bb gateway chain set`.
- `bb gateway status --thread <id>` shows the upstream, model, chain entry,
  sticky time, and the Jev pick with its reason.

## Automatic model choice (Jev)

- `bb gateway auto <harness> --key <label>` turns it on; `--off` turns it off;
  `bb gateway auto` shows the settings. The key is a `responses-compatible-key`
  holding an OpenRouter key.
- Jev picks at each new user turn and the pick holds through the tool loop.
  Any failure keeps the client's model.
- Jev sees only the truncated last user message and the candidate model
  names. Tell the user this before turning it on.

## Moving off the Account Pooler

The gateway and the core Account Pooler (`account-pool`) cannot both route a
provider. While `account-pool` is installed and enabled, the gateway
contributes no env for `claude-code` or `codex`, and its health label reads
`Gateway: blocked by Account Pooler routing`.

1. `bb gateway import-pool` copies the Pooler's accounts and secret files. No
   re-login. It never prints secret values.
2. Ask the user to disable the `account-pool` plugin.
3. `bb gateway doctor` confirms the state.

## BB upgrade caveat

BB 0.43 rejects a `secret` field on contributed env entries, so the gateway
omits it. Newer BB core makes `secret` required. After BB upgrades past 0.43,
the token entries need `secret: true`, or every env contribution is rejected
and threads are no longer routed.

## CLI

```
bb gateway status [--json]
bb gateway status --thread <id> [--json]
bb gateway chain show [--json]
bb gateway chain set <harness> <entry>...
bb gateway model-map show [--json]
bb gateway model-map set <kind>[:<label>] <pattern> <model>
bb gateway auto [<harness> [--key <label>] [--model <id>] [--off]]
printf '%s\n' "$KEY" | bb gateway key add <claude-key|anthropic-compatible-key|responses-compatible-key> --label <label> [--base-url <url>] [--priority <n>] --key-stdin
bb gateway account add --provider <claude|codex> --login
bb gateway account add --provider <claude|codex> --import [--label <text>] [--priority <n>]
bb gateway account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
bb gateway account login-poll --session <id>
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb gateway account login-complete --session <id> --code-stdin
bb gateway account list [--json]
bb gateway account remove|enable|disable <id>
bb gateway account priority <id> <n>
bb gateway account reorder <claude|codex> <id>...
bb gateway account hold <id> --until <+1h|ISO time> | --clear   (test hook: treat as exhausted)
bb gateway routing <claude|codex|acp-omp|acp-fx|acp-nanocodex|pi> [--off]
bb gateway config
bb gateway config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold> <value>
bb gateway token rotate --machine <id-or-name>
bb gateway bypass <thread-id> [--off]
bb gateway doctor
bb gateway import-pool
bb gateway setup omp [--print] [--server-url <url>]
bb gateway setup fx
bb gateway setup nanocodex
bb gateway setup pi [--print]
```
