# Pages

Pages turns an HTML or Markdown file into a durable BB artifact. It renders the
page inline in chat, keeps its version history, groups it into project folders,
and provides a searchable library for finding earlier work.

## Features

- Publish workspace or thread-storage files with `page_publish` or
  `bb pages publish`, or a folder with `index.html` plus its images, CSS,
  fonts, scripts, and linked pages.
- Organize pages in logical project folders such as `Reports/Weekly`.
- Browse prior artifacts by project, folder, or title with `page_browse`.
- Render Markdown, themed HTML, interactive data tables, and charts.
- Draw icons from MingCute, a less common set of about 1,650 glyphs in line
  and filled styles. A page writes `<i data-icon="name"></i>`; chat
  components use the same glyphs.
- Share a page through Here.now with restricted, password, or public-link
  access. Sharing is optional and requires a Here.now API key. From the
  command line: `bb pages share`, `bb pages unshare`, and `bb pages share-status`.
- Look up and fetch pages with `page_lookup`, `bb pages list`, `bb pages get`,
  `bb pages versions`, and `bb pages pull`.
- Update a stable page by source path, key, or page id while preserving every
  changed version.
- Send feedback from the page panel to the thread. The message carries the
  page id, so the agent republishes the same page.
- Answer forms on a page. A submitted form goes to the thread as one message,
  with each answer under its label. Forms work inline, in live `::inline-vis`
  files, and in the page panel; shared sites ask the reader to open the page
  in BB. A sent form stays locked as sent, with an Edit answers button, and
  stays sent after a reload. A page with a form is published inline by
  default. Select, date, and time fields open themed pickers, and
  number fields get − and + buttons.
- Show live UI in a reply. An agent writes an `openui-lang` code fence, and
  BB draws it in place as the reply streams: stats, tables, bar and line
  charts, tabs, code, diffs, and forms with choices, sliders, toggles, and
  text fields. Buttons send to the thread, and a sent form locks. A fence
  that does not parse shows as code.
- Put the same live UI on a page. A Markdown page takes the same fence, and
  an HTML page takes `<script type="text/openui-lang">`. Publishing saves the
  data, place names, photos, and map tiles the blocks need, so shared sites
  work offline from BB. Buttons and forms there are read-only.

### Upstream features

These features are adapted from GenUI 0.3.1 at
`c9700a34a9cc24961d17771590274e0703dc481c`. They use Pages' existing OpenUI
language and preserve existing form behavior:

- Histogram, box, and heatmap charts, with shared distribution bins and series tones.
- Scene and Shader components, including surfaces, embedded models and lighting,
  feedback buffers, textures, orbit controls, and a six-context GPU budget.
- `app` and `pages-app` fences, plus `App(name, html)` inside OpenUI.
  App scripts run only after the fence closes. Answers are staged for review;
  existing Pages Buttons and Forms still send directly.
- Source captions on Table, Chart, and Stat. Automatic captions follow the
  resolved file result while a different file is loading. `FileCode` reads
  bounded source excerpts with original line numbers. Existing `Snippet`
  remains a supplied-text copy control.
- `page_examples` and `page_check`, also available as `bb pages examples`
  and `bb pages check <file>`. Checks include input boundaries, scenes, GLSL,
  and app script syntax. They do not execute app JavaScript or prove security.
- One image and diagram viewer with fit, zoom, pan, pinch, gallery navigation,
  and focus return to the opener. The viewer stays inside its BB pane.
  OptionCards can show visual choices; expanding an image does not change the choice.
- Maps accept day groups, straight route connections, and replayable tours.
  Optional Wikipedia photos include the author, license, and Commons source.
  These lookups use the existing Web lookups setting and saved-page asset path.
- Coverage reads LCOV, Istanbul, coverage.py, and Go reports, with metric
  selection, uncovered ranges, and file details. Dependencies also reads security
  audits. Findings and test results expose source, failures, and captured output.
- Benchmarks retain repeated measurements and their conditions. Measurements
  from different conditions are not called a performance improvement. Failed
  commands are not used as the fastest successful baseline.
- Acceptance supports device/condition matrices, CSV checks, and evidence
  details. Missing, claimed, and verified results stay distinct. Provenance can
  compare checkout, build, install, and launch receipts against expected facts.
- Compare supports reference/candidate images, wipe and blink views, and pixel
  differences with tolerance and changed regions. Blink follows motion preferences.
- Transcript can align recognition tracks against a reference, show word errors,
  and seek a supplied recording from words or errors. It does not transcribe audio.
- Findings has explicit fix requests in click menus. Opening a menu sends
  nothing. The gallery previews the request; exported pages cannot send it.
- Copy as Markdown uses the current field values and loaded data. Use
  `bb pages render path/to/report.md` for plain-text export, or add `--state`
  with a JSON object to export supplied field values. Omit the path to render
  the current thread's latest component output.

App frames have an opaque origin. Fetches and remote resource loads are blocked.
**An app can still navigate its own frame and make a network request.**
Do not put secrets in apps. Storage is bounded per app and across saved apps.
Published pages and downloads cannot send app answers into BB.

The gallery has a compact category menu beside Search, with full names and keyboard
navigation. Each category puts its component-named code disclosures in a Sources
section below the live previews.


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
bb plugin install git:https://github.com/hemaaanth/oh-my-bb.git@^0.6.0 \
  --plugin pages \
  --tag-prefix pages/
```

Pages needs BB 0.46.1 or later.

## Settings

Open Settings → Plugins → Pages. Every setting is optional, and Pages never asks
you to configure it before use. Each feature shows its own status where you use it.

Configuration keeps the Here.now and Mapbox keys together before sharing defaults
and Web lookups. Keys use BB's native secret storage; setting IDs and CLI commands
are unchanged.

More links to the library, a dedicated component gallery, and the setup guide.
The gallery keeps live BB/Site previews and source disclosures off the settings
page. The setup guide covers optional keys, sharing access, and chart licensing.

| Setting | What it does | If unset |
| --- | --- | --- |
| Here.now API key | Lets Pages create and update shared sites. Stored as a secret. | The Share popover and `page_share` say the key is not set. |
| Mapbox token | Map tiles. Stored as a secret. | Maps show their places on a blank grid, with a note naming the token. |
| Default access | Access for a new share: restricted, password, or link. Defaults to password. | Password. |
| Default allowed domains | Comma-separated email domains that fill Restricted access in the Share popover. | Empty. |
| Web lookups | Lets maps, image search, and galleries fetch tiles, place names, and photos. On by default. | When off, those components show a short note. |
| Animations | Controls motion in charts, boards, scenes, and apps. System reduced motion also applies. | On. |

Changes apply to the next request. You do not need to reload.

The library, gallery, and setup guide use a 760px outer frame with 16px side
padding (728px content at full width). Symmetric scrollbar gutters keep these
pages centered when content starts scrolling. Page previews and document
canvases remain full-bleed on purpose: exported HTML, charts, and custom layouts
keep their own reading width. Their panel header is 36px tall.

## Highcharts license

Pages includes a bundled Highcharts runtime for its charts, on pages and in chat. Highcharts
is not licensed under MIT. **You must obtain and manage your own Highcharts
license for your intended use.** Installing Pages does not grant a commercial
Highcharts license. See [Highcharts licensing](https://www.highcharts.com/license)
and [THIRD_PARTY.md](THIRD_PARTY.md).

Highcharts loads only when a chart draws. See [THIRD_PARTY.md](THIRD_PARTY.md)
for OpenUI, Generative UI, and the other credits.

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

Run `npm run build:icons` after changing the glyph table in
`render/icons/generate.mjs` or upgrading `mingcute_icon`. Run `npm run build:charts` only after changing the chart runtime. The generated
bundle is committed because installed Git plugins build with production
dependencies only.

## License

Original Pages source code is MIT licensed. Bundled third-party components keep
their own licenses. See [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md).

PR Review documents may include an optional `diffBreakdown` with categorized file and line counts. Pages renders it before review coverage, labels partial inventories, and reports binary files separately. Documents without statistics remain readable.

PR Review pages use the Pages theme, keyboard-accessible Review/Diagrams/Coverage tabs, and zoomable diagrams. The same version renders a compact summary when opened through `display="inline"`, and the full page in its panel or shared view. `publishDocument` accepts `display: "card" | "inline"` to select the returned directive; the document and identity stay the same.
