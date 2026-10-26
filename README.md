# oh-my-bb

Independent plugins and agent adapters for [BB](https://getbb.app).

Every plugin in this repository owns its manifest, lockfile, tests, documentation,
and runtime dependencies. Plugins may integrate with other tools, but they do not
require another plugin or a repository-level package to build or run.

## Add the marketplace

```sh
bb marketplace add git:github.com/hemaaanth/oh-my-bb@main
```

Adding the marketplace only makes its plugins discoverable. BB installs nothing
until you choose a plugin.

## Install one plugin directly

```sh
bb plugin install git:https://github.com/hemaaanth/oh-my-bb.git@^0.1.0 \
  --plugin model-gateway \
  --tag-prefix model-gateway/
```

Each plugin has an entry in [`.bb/plugins.json`](.bb/plugins.json). Releases use
plugin-specific tags such as `model-gateway/v0.1.0`, so plugins can update on
independent schedules. Standalone agent packages use the same convention, such
as `fx-acp/v0.1.0`.

## Packages

- [`plugins/clasi`](plugins/clasi) retains scoped context, reusable lessons, and
  workflow feedback for BB agents. Records stay in the private BB database.
- [`plugins/dispatch`](plugins/dispatch) lets you drive BB by voice. A named agent
  answers in the app or over a phone call, and reads, starts, and steers threads.
- [`plugins/model-gateway`](plugins/model-gateway) routes supported BB harnesses
  through ordered provider accounts and optional API-key fallbacks.
- [`plugins/journal`](plugins/journal) records dated work history and agent time,
  and offers workspace catch-up and saved thread briefings. AI is optional; choose
  subscription-only Model Gateway inference or an explicitly configured OpenRouter key.
- [`plugins/pages`](plugins/pages) publishes versioned HTML and Markdown
  artifacts, organizes them in project folders, and optionally shares them.
- [`plugins/webhooks`](plugins/webhooks) receives signed webhooks, including Slack
  events and slash commands, on configured endpoints and turns approved fields into a
  thread message, a new thread, an Automations run, or a call to a plugin that accepts
  deliveries.
- [`plugins/workspace-scripts`](plugins/workspace-scripts) runs `bb.json` commands
  and tracks workspace services through BB's native thread-actions menu.
- [`plugins/status-sidebar`](plugins/status-sidebar) groups BB threads by working
  status with nested thread summaries and saved ordering. Agents, Projects, and
  Tasks are optional explicit integrations; the base sidebar runs alone.
- [`agents/fx-acp`](agents/fx-acp) is an optional standalone ACP adapter for FX.
- [`agents/nanocodex-acp`](agents/nanocodex-acp) is an optional standalone ACP
  adapter for nanocodex.
- [`agents/prime-agent-acp`](agents/prime-agent-acp) is an optional standalone ACP
  adapter for Prime Agent.

Journal runs without another BB plugin. Its optional subscription backend requires
Model Gateway, and its optional Dispatch call display is off by default. OpenRouter
is an alternative paid API backend. Opening a saved thread briefing never calls a model.

The agent adapters are not installed by Model Gateway. Model Gateway runs without
any adapter, and each adapter has its own package manifest and tests.

Dispatch runs without another BB plugin for in-app voice, which needs only an
OpenAI API key. Its phone calls work only when the Webhooks plugin is installed
separately; see [`plugins/dispatch/docs/phone-calls.md`](plugins/dispatch/docs/phone-calls.md).

Pages runs without another BB plugin. Its optional chart feature bundles
Highcharts; each user must obtain and manage the Highcharts license required
for their intended use.

Webhooks runs without another BB plugin. Its automation action works only when
the Automations plugin is installed separately, and it runs the saved prompt
without the webhook payload. Senders need a public HTTPS route to one deliver
path; see [`plugins/webhooks/docs/ingress.md`](plugins/webhooks/docs/ingress.md).

Scripts runs without another BB plugin. Its optional Agents startup preparation
uses explicit saved approvals; ordinary commands and manual preparation remain
independent. See [`plugins/workspace-scripts`](plugins/workspace-scripts) for the
schema and [migration design lessons](docs/migrations/scripts.md) for accepted
ownership rules and the deliberately deferred setup-guide reconciliation.

## Validate the repository

```sh
./scripts/check.sh
```

The same package-local checks run in CI. `scripts/packages.txt` is the one list of
packages that `check.sh` and CI both read. To add a package, add its directory there.
`./scripts/check.sh plugins/pages` checks one package.
