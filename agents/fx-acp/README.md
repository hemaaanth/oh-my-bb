# fx-acp

`fx-acp` runs [FX](https://github.com/vercel-labs/fx) (`fx acp`, tested with 0.0.11) as a stdio
ACP agent for BB's ACP providers plugin (`provider-acp`). The provider id stays `acp-fx`.

It is a small relay, not a new agent. It starts `fx acp`, passes every frame through
unchanged, and changes only FX's Provider option:

- FX offers three providers: Vercel AI Gateway, Codex subscription and Grok subscription.
  `fx-acp` pins every session to `codex`, the one the Model Gateway serves.
- It removes the `provider` option from `configOptions`, so BB shows no Provider menu.
- It rejects a client `session/set_config_option` that asks for another provider.

It is a standalone Node package, not a BB plugin. Model Gateway does not install it.

## Install

Node 22.13 or later, and `fx` on `PATH`. `fx-acp` has no runtime dependencies.

```bash
git clone --depth 1 --branch fx-acp/v0.1.0 https://github.com/hemaaanth/oh-my-bb.git
npm pack --pack-destination . ./oh-my-bb/agents/fx-acp
npm install --global ./fx-acp-0.1.0.tgz
```

The tarball produces a copy instead of a symlink to the checkout.

Sign FX in to Codex once on every host that runs FX threads, including each sandbox:
`fx login codex`. FX refuses its codex provider without that login, and then `session/new`
fails with `fx-acp could not select the codex provider: ...`.

## Register in BB

Use this entry in the `customAgents` setting of the ACP providers plugin, in place of the
old `fx` entry. Keep the id `fx`, so the provider id stays `acp-fx` and the Model Gateway
keeps routing it.

```json
{ "id": "fx", "displayName": "FX", "command": "fx-acp" }
```

`customAgents` is one JSON array. Read the current value first and change only the `fx`
entry.

## How it works

| Frame | What `fx-acp` does |
|---|---|
| `session/new`, `session/load`, `session/resume`, `session/fork` result | When the Provider option is not `codex`, it holds the result and sends its own `session/set_config_option { configId: "provider", value: "codex" }` first. Then it forwards the result with the options from that reply, without `provider`. If FX refuses, the client gets a JSON-RPC error instead. |
| `session/set_config_option` result | Forwarded without `provider`. |
| `session/update` with `config_option_update` | Forwarded without `provider`. |
| Client `session/set_config_option` for `provider` | `codex` is forwarded. Any other value gets error `-32602` and never reaches FX. |
| Anything else | Forwarded byte for byte. |

- Launch arguments pass to `fx acp`, for example `fx-acp --model gpt-6-astra`.
- stdout carries ACP frames only. FX's stderr is forwarded unchanged.
- `fx-acp` exits with FX's exit code. It forwards SIGINT, SIGTERM and SIGHUP to FX. When
  FX dies by a signal, `fx-acp` dies by the same signal.
- `FX_BIN` overrides the `fx` command. The tests use it to run a fake FX.

## Test

```bash
npm install
npm test          # vitest, against test/fake-fx.mjs; no real FX, no network
npm run typecheck
```
