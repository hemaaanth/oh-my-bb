# nanocodex-acp

`nanocodex-acp` runs [nanocodex](https://www.npmjs.com/package/nanocodex) 0.6.5 as a stdio
ACP agent. BB's ACP providers plugin (`provider-acp`) launches it as a custom agent. The
provider id is `acp-nanocodex`.

It is a standalone Node package, not a BB plugin. Model Gateway does not install it.

All model traffic goes to the Model Gateway. There is no direct ChatGPT or OpenAI mode.

## Install

Node 22.13 or later.

```bash
git clone --depth 1 --branch nanocodex-acp/v0.1.0 https://github.com/hemaaanth/oh-my-bb.git
npm pack --pack-destination . ./oh-my-bb/agents/nanocodex-acp
npm install --global ./nanocodex-acp-0.1.0.tgz
nanocodex-acp --list-models
```

The tarball produces a copy instead of a symlink to the checkout.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `NANOCODEX_API_BASE_URL` | yes | The gateway's Responses base URL, `http(s)://`. It may carry a path prefix, for example `<BB server>/api/v1/plugins/model-gateway/http/v1`. |
| `MODEL_GATEWAY_TOKEN` | yes | The gateway hub token. It is sent as `Authorization: Bearer <token>`. |

The agent derives the WebSocket URL from `NANOCODEX_API_BASE_URL`: it swaps `http` to `ws`
(or `https` to `wss`) and appends `/responses`. It always passes that URL to nanocodex.
This matters: when the WebSocket URL is not set, nanocodex silently connects to
`wss://api.openai.com/v1/responses` (spike S3).

If either variable is missing, or the base URL is not http(s), `session/new` fails with a
clear error and nanocodex never starts. The Model Gateway contributes both variables for
provider `acp-nanocodex` (plan WP3.2). You do not set them by hand.

## Register in BB

Add this entry to the `customAgents` setting of the ACP providers plugin
(Settings → Plugins → ACP providers).

```json
{
  "id": "nanocodex",
  "displayName": "nanocodex",
  "command": "nanocodex-acp",
  "modelCli": {
    "listArgs": ["--list-models"],
    "selectFlag": "--model",
    "primaryModels": ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]
  },
  "reasoningCli": {
    "flag": "--thinking",
    "supportedLevels": ["none", "low", "medium", "high", "xhigh", "max"],
    "defaultLevel": "medium"
  },
  "permissionCli": {
    "full": ["--permission-mode", "full"],
    "workspaceWrite": ["--permission-mode", "accept-edits"]
  }
}
```

`customAgents` is one JSON array. `bb plugin config provider-acp set customAgents '[...]'`
replaces the whole array. So read the current value first and append this entry to it; do not
drop existing entries such as `fx` or `omp`.

## How BB drives it

BB's ACP bridge starts one `nanocodex-acp` process per thread. It uses these methods:

| ACP | nanocodex |
|---|---|
| `initialize` | Capabilities: no `loadSession`, no image input, no auth methods. |
| `session/new` | `Transport.openAi({ apiKey, apiBaseUrl, websocketUrl })` from the environment, then `Agent.create` with the session `cwd` as the workspace. |
| `session/prompt` | `agent.turn.prompt()`; waits for `turn.result()`. |
| `session/cancel` | `turn.cancel()`. The prompt ends with `stopReason: "cancelled"`. |
| `session/update` | From `events.watch()`, see below. |
| `session/request_permission` | Sent by the permission shim, see below. |

The bridge also knows `session/load`, `session/fork`, `session/set_model` and
`session/set_config_option`. It calls them only when the agent advertises them, and
nanocodex-acp does not. Custom agents never fork.

**Model.** `--list-models` prints the six ids nanocodex 0.6.5 accepts: `gpt-6-sol`,
`gpt-6-luna`, `gpt-6-astra`, `@cf/zai-org/glm-5.3`, `kimi-k3`, `mimo-v2.6-pro`. BB passes
the thread's choice as `--model <id>` at launch (`modelCli.selectFlag`). The gateway maps these
ids to real upstream models, so there is no aliasing here.

**Reasoning.** BB passes the reasoning level as `--thinking <level>` at launch
(`reasoningCli`). The six levels are nanocodex's `thinking` values.

**Permission mode.** BB passes the mode as a launch flag (`permissionCli`).
`--permission-mode accept-edits` is the default. BB rejects `auto` for ACP agents, so it never
arrives.

**Events.**

| nanocodex event | `session/update` |
|---|---|
| `assistant.delta` | `agent_message_chunk` |
| `assistant.message` | `agent_message_chunk`, only if no delta carried that item |
| `reasoning.summary.delta` | `agent_thought_chunk` |
| `tool.call` | `tool_call`, status `pending` |
| `tool.result` | `tool_call_update`, status `completed` or `failed` |
| `run.*` | none; the turn ends through `turn.result()` |

## Tools and permissions

nanocodex has no permission hook. nanocodex-acp gives it the Node OS-process tools from
`nanocodex-tools/node`, rooted at the session `cwd`, and wraps each tool handler:

- `exec_command` asks `session/request_permission` before it runs.
- `write_stdin` asks only when it sends input. A poll without input does not ask.
- With `--permission-mode full`, nothing asks.
- "Always allow" skips the question for that tool for the rest of the session.
- A rejected or cancelled request fails the tool call. The command does not run.

nanocodex has no separate file-edit tool. It edits files through `exec_command`. So in
`accept-edits` mode every command asks, including commands that only edit files.

nanocodex also always gives the model its own tools. Their status:

| Tool | Status |
|---|---|
| `exec` (Code Mode) | **Off.** The agent uses `toolMode: "direct"`. Code Mode JavaScript gets `require`, so it could reach `fs` and `child_process` without the gate. |
| `wait` | Off. It is part of Code Mode. |
| `spawn_agent`, `send_agent_message`, `wait_agent`, `interrupt_agent`, `close_agent`, `list_agents`, `submit_result` | On. nanocodex 0.6.5 has no public switch to turn them off. They do not touch the OS themselves: child agents run on the same host tools, the wrapped `exec_command` and `write_stdin`, so every child command still asks (read from the nanocodex source; not tested). Child tool calls do not appear as `tool_call` updates (only the root session's events are watched); they appear only as permission requests. |

## Develop

```bash
npm ci
npm run typecheck
npm test
```

`npm test` runs `node --test` inside a new user and network namespace
(`unshare -rn`, loopback only). So a wrong URL fails the test instead of reaching
`api.openai.com`. The test starts a mock of the gateway's `WS /v1/responses` route on
`127.0.0.1` and drives the agent with a small ACP client. It checks:

- `initialize`, `session/new`, `session/prompt`, with a real `echo` command run in the session
  `cwd`;
- the derived WebSocket URL keeps the path prefix, and the bearer token is sent;
- Code Mode `exec` is not offered to the model;
- the `tool_call` update comes before the permission request in `accept-edits` mode;
- a rejected command does not run; `full` mode does not ask;
- a reasoning summary arrives as `agent_thought_chunk`;
- `session/cancel` ends the turn as `cancelled`;
- `session/new` fails when `NANOCODEX_API_BASE_URL` is missing, and nothing connects;
- `--list-models` prints the six ids.

## Limits

- No `session/load`. When BB has to start a new agent process for an existing thread (for
  example after a server restart), the thread continues in a fresh nanocodex session without
  its earlier history. BB shows a warning when this happens.
- Image prompts are not supported. BB sends them as text placeholders.
- The subagent path (`spawn_agent`) is not covered by the test.
