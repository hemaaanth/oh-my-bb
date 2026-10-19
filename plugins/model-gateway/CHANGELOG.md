# Changelog

## Unreleased

- The "Needs configuration" message, shown when no account or API key is
  enabled, now names `bb gateway account add` and `bb gateway key add`, and
  says to run `bb plugin reload model-gateway` afterwards, because adding an
  account does not clear the banner by itself.
- Every non-Claude harness goes through the Gateway. Hempi and `agent-<uuid>`
  providers get per-thread Pi Gateway env, found from the provider catalog and
  rescanned when registrations change. The new `acp-prime-agent` harness runs
  one private Prime daemon and config per launch, with its token passed only as
  an env reference. `fx-acp` runs host-managed through a private loopback
  relay and needs no FX login. Pi and OMP share the nine-model Codex catalog.
- `bb gateway setup host [--print|--check]` writes the files omp and Pi need,
  through a new `host.setupFiles` RPC. A standalone `apply-setup-files.mjs`
  does the same inside sandboxes.
- The sidebar footer shows usage limits for each authenticated account, labeled
  Model usage. It opens from a short-lived cache and refreshes on demand.
- The footer and `bb gateway account list` show how many one-off reset credits
  a ChatGPT account has. The count is `available_count`, as ChatGPT's own app
  shows it.
- A Claude OAuth account gets one short retry on a connection failure or an
  HTTP 408, 500, 502, 503, 504, or 529 before the request moves to the next
  chain entry. A thread's route records why it fell back (`fallbackCause`).
- When a Responses upstream sends its answer only in the final `completed`
  event, the translator now returns that answer to a Messages client. A
  `completed` event with no content becomes a retryable error.
- The thread header route badge is gone. The Sandboxes plugin shows the route
  in its machine popover.
- Pi provider discovery runs only in the service, so plugin loading is no
  longer blocked.
- Fixes: the footer no longer crashes on usage cached before reset credits
  existed. The applier CLI has no top-level `await`, so BB can bundle it.

## 0.1.0

- A hub in the BB server that pools Claude and ChatGPT accounts and optional
  API keys behind one chain of upstreams per harness. When one runs out, the
  next request of the running thread goes to the next entry.
- Translation between Anthropic Messages and OpenAI Responses, with replay
  guards so reasoning data from one upstream never reaches another.
- API-key upstreams: Anthropic keys, Anthropic-compatible keys (Kimi, GLM), and
  Responses-compatible keys (OpenAI, OpenRouter, others). A key whose credit is
  gone is benched for 30 minutes.
- Model map, optional automatic model selection through Jev, and a Settings
  section for upstreams, routes, and advanced options.
- `bb gateway` CLI, an agent skill, and the `thread.route` RPC.
