# Pages

Pages turns an HTML or Markdown file into a durable BB artifact. It renders the
page inline in chat, keeps its version history, groups it into project folders,
and provides a searchable library for finding earlier work.

## Features

- Publish workspace or thread-storage files with `page_publish` or
  `bb pages publish`.
- Organize pages in logical project folders such as `Reports/Weekly`.
- Browse prior artifacts by project, folder, or title with `page_browse`.
- Render Markdown, themed HTML, interactive data tables, and charts.
- Share a page through Here.now with restricted, password, or public-link
  access. Sharing is optional and requires a Here.now API key.
- Update a stable page by source path, key, or page id while preserving every
  changed version.

## Install

Add the `oh-my-bb` marketplace once:

```sh
bb marketplace add git:github.com/hemaaanth/oh-my-bb@main
```

Then install only Pages:

```sh
bb plugin install pages@oh-my-bb
```

Or install it directly from Git:

```sh
bb plugin install git:https://github.com/hemaaanth/oh-my-bb.git@^0.1.0 \
  --plugin pages \
  --tag-prefix pages/
```

## Highcharts license

Pages includes a bundled Highcharts runtime for its chart feature. Highcharts
is not licensed under MIT. **You must obtain and manage your own Highcharts
license for your intended use.** Installing Pages does not grant a commercial
Highcharts license. See [Highcharts licensing](https://www.highcharts.com/license)
and [THIRD_PARTY.md](THIRD_PARTY.md).

Pages without charts does not invoke the Highcharts runtime.

## Optional integrations

Pages runs without any other BB plugin. PR Review can publish structured review
documents into Pages and receive actions from their page menu when PR Review is
also installed. Pages does not install or require PR Review.

Here.now sharing is also optional. Unconfigured installations still support
publishing, folders, browsing, versioning, and local previews.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Run `npm run build:charts` only after changing the chart runtime. The generated
bundle is committed because installed Git plugins build with production
dependencies only.

## License

Original Pages source code is MIT licensed. Bundled third-party components keep
their own licenses. See [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md).
