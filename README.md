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

- [`plugins/model-gateway`](plugins/model-gateway) routes supported BB harnesses
  through ordered provider accounts and optional API-key fallbacks.
- [`plugins/pages`](plugins/pages) publishes versioned HTML and Markdown
  artifacts, organizes them in project folders, and optionally shares them.
- [`plugins/webhooks`](plugins/webhooks) receives signed webhooks, including Slack
  events and slash commands, on configured endpoints and turns approved fields into a thread message, a new thread, or an
  Automations run.
- [`agents/fx-acp`](agents/fx-acp) is an optional standalone ACP adapter for FX.
- [`agents/nanocodex-acp`](agents/nanocodex-acp) is an optional standalone ACP
  adapter for nanocodex.

The agent adapters are not installed by Model Gateway. Model Gateway runs without
either adapter, and each adapter has its own package manifest and tests.

Pages runs without another BB plugin. Its optional chart feature bundles
Highcharts; each user must obtain and manage the Highcharts license required
for their intended use.

Webhooks runs without another BB plugin. Its automation action works only when
the Automations plugin is installed separately, and it runs the saved prompt
without the webhook payload. Senders need a public HTTPS route to one deliver
path; see [`plugins/webhooks/docs/ingress.md`](plugins/webhooks/docs/ingress.md).

## Validate the repository

```sh
./scripts/check.sh
```

The same package-local checks run in CI.
