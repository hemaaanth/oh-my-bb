# prime-agent-acp

Run Prime Agent 0.10.0 as an ACP agent through BB Model Gateway.
This is a standalone Node package. It has no runtime dependencies.
Model Gateway does not install or require it.

## Install

Install Node 22.13 or later and `prime-agent` on each host's PATH.
Build and install this package from its own directory:

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack
npm install --global ./prime-agent-acp-0.1.0.tgz
```

Set this entry in `provider-acp.customAgents`. Keep the other entries in that array.
The provider id stays `acp-prime-agent`.

```json
{
  "id": "prime-agent",
  "displayName": "Prime Agent",
  "command": "prime-agent-acp",
  "args": ["--mode", "acp"],
  "modelCli": {
    "listArgs": ["model-list"],
    "selectFlag": "--model"
  }
}
```

The command is bare and PATH-resolved. It replaces the machine-specific `pa-acp.sh` command.
No plugin setting is changed by installing this package.

## Gateway and isolation

Inference requires both `MODEL_GATEWAY_BASE_URL` and `MODEL_GATEWAY_TOKEN`.
Model Gateway contributes these per thread.
Without either value the adapter fails before launching Prime. It never falls back to a local Prime login.

Each launch creates a private temporary Prime agent directory and a short, unique daemon socket.
Its `models.json` defines provider `model-gateway`, API `openai-responses`, and `authHeader: true`.
The API key is the environment reference `MODEL_GATEWAY_TOKEN`, not the token value.
The URL must not contain credentials, query parameters, or a fragment.
The adapter launches Prime offline, so startup discovery does not contact model providers.

Prime starts its own daemon with that environment. Two concurrent adapter launches do not share a daemon or auth store.
When the ACP client exits, the adapter sends a forced shutdown request directly to its private daemon socket, then removes the temporary directory.
It never runs the public `prime-agent shutdown` command: that command discovers and stops other daemons too.
The socket protocol follows [Prime 0.10.0's daemon client](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.10.0/crates/pa-cli/src/daemon_client.rs).
This is a foreground ACP integration, not a way to retain background Prime workers after BB disconnects.
Prime 0.10.0 advertises `loadSession: false` over ACP.

`--model model-gateway/gpt-6-sol` becomes `--provider model-gateway --model gpt-6-sol`.
Slashes after the provider remain part of the model id.
A bare model id also selects `model-gateway`.
Direct provider names and API-key or daemon-socket overrides are refused.
`PRIME_AGENT_BIN` can select the Prime executable.

## Model discovery

`prime-agent-acp model-list` keeps the old shim's `provider/model - model (provider)` format.
It lists the gateway defaults without needing a thread token or a Prime login.
Those defaults are `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`, and `gpt-5.6-terra`.
A custom model selected with `--model` is also registered in the launch's config.
`gpt-6.1-sol` uses 500,000 context tokens and 128,000 output tokens.
Without `--model`, the adapter selects `gpt-6-sol`, as the old shim did.
The gateway chain decides which upstream serves the model.

`prime-agent-acp --version` reports the adapter version without launching Prime.

## Verified behavior

With the real Prime Agent 0.10.0 binary, a local fake Responses gateway completed ACP prompts.
Two concurrent clients sent their own expected Bearer auth from their request workers.
Closing the first client left the second client's worker usable. Both private daemons and their tracked workers then exited.
The scratch-home scan found no synthetic tokens on disk. Both private config directories were removed.
No paid model call or copied login was used.
