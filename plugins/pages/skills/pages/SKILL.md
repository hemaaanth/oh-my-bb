---
name: pages
description: "Make a page: write an HTML or Markdown file, or a folder with index.html and its images, CSS, and other pages (a report, summary, plan, notes, comparison, dashboard, or chart), publish it with page_publish or `bb pages publish`, and show it inline with the ::page directive. Use whenever the user should see a document, a chart, or data that reads better as a page than as chat text, when they ask for a report, a chart, a preview, or a link, or when you update a page you published before. Replaces inline-vis and flint-chart."
---

# Pages

A page is one HTML or Markdown file, or a folder with `index.html`, that BB
shows inline in chat, keeps as versions, and can share as a link. You write the
files. Pages adds the theme, the font, and the chart runtime. Every publish of
changed bytes is a new version.

## When a page is the right surface

- Use a page when the output has a reader: a report, a comparison, a plan, a
  review, a daily summary, or any chart.
- Use a page when a table or chart would be cramped in chat.
- Do not use a page for a short answer. Write it in chat.
- Do not use a page for files that belong in the repo, such as source, docs,
  and config. Commit those instead.
- PR review pages come from the PR Review plugin. Do not write them by hand.

### Offer before you are asked

The user may not know pages exist. Look for output that would read better as one.

- If your answer is a report, a comparison of three or more options, or a table
  of more than about ten rows, make the page and put a short summary in chat.
- If it is borderline, answer in chat and offer the page in one closing line,
  for example "Want this as a page with the chart?"
- Offer at most once per topic. Do not offer for short answers.

## Write the file

- **Reports and one-off output**: write to thread storage,
  `$BB_THREAD_STORAGE/reports/<name>.html`. This keeps the workspace clean.
- **Project docs the user wants in the repo**: write inside the workspace.
- `.html`, `.htm`, `.md`, and `.markdown` are accepted. Markdown is rendered
  with raw HTML off. Use HTML when you need charts or custom layout.
- One file is the default. Put CSS and JavaScript inline. Embed small images as `data:` URIs.
- Keep the file under 10 MB.
- Need real image files, a stylesheet, fonts, or several linked pages? Publish a
  folder instead. See [Publish a folder](#publish-a-folder).

Start from this skeleton:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Activation after launch</title>
</head>
<body class="auto">
<main class="page">
  <h1>Activation after launch</h1>
  <p class="lede">Verified teams enable on day one or not at all.</p>
  <div class="meta-line"><span>PostHog, through 22 Sep</span><span>v3</span></div>
  <h2>What changed</h2>
  <p>…</p>
</main>
</body>
</html>
```

Do not add a stylesheet link, a font, a reset, or `<script src>`. Pages
injects them.

## Publish

```bash
bb pages publish "$BB_THREAD_STORAGE/reports/activation.html" --label "Adds the funnel"
```

Or call the tool: `page_publish({ file: "reports/activation.html", source: "thread-storage", label: "Adds the funnel" })`.
The tool path is relative to its source (`workspace` is the default).

The result contains a directive of this form:

```text
::page{id="<page id>" version="<version id>"}
```

Copy the returned directive **exactly** onto its own line in your reply. Do not
put it in backticks or a code block. Do not invent ids.

Use `folder` (CLI: `--folder`) for a logical subfolder such as `Reports/Weekly`.
The Pages library groups pages by project and folder. When shared, Here.now files
the Site under `Project / Reports/Weekly` (Here.now folders are flat).

### Find prior pages

In a fresh thread, call `page_browse` first when the user refers to an earlier
report or artifact without an id. It defaults to the current project and can
filter by exact `folder` or by a title `query`. Then use `page_lookup` with the
returned page id to inspect its complete version history.

### Versions

A new publish adds a version to an existing page when it matches one of these:

- **The same file path** in the same workspace or thread storage. This is the default.
- **`--key <name>`** (tool: `key`): a stable name such as `boost-daily`. Use it
  for automations and for runs that write the file somewhere new each time.
- **`--page <id>`** (tool: `pageId`): an explicit page id. Use it when the file
  moved or you are in another thread.

A different path with no key or page id makes a **new** page. If you meant to
update a page, pass `--page`. Unchanged bytes add no version.

- Panel feedback arrives as a message that starts with `Feedback on the page`.
  It carries the page ID. Make the change, then republish with that `pageId` so
  the page gets a new version instead of a second page.
- `--label` is the version note. Say what changed, for example "Adds Sep 22", not "update".
- `--title` overrides the title. By default the title comes from `<title>`, then the first `<h1>`, then the file name.
- `page_lookup` or `bb pages get` finds a page by id, key, or producer key.

### Publish a folder

A folder page is `index.html` plus the files it uses: images, CSS, fonts,
scripts, and other `.html` pages. Reference them with relative paths, such as
`img/before.png`, `css/site.css`, or `docs/details.html`.

```bash
bb pages publish "$BB_THREAD_STORAGE/reports/launch"
```

Or call the tool: `page_publish({ dir: "reports/launch", source: "thread-storage" })`.
A CLI path that does not end in `.html`, `.htm`, `.md`, or `.markdown` is a folder.

- `index.html` must be at the top of the folder. It is the page, its title, and its charts.
- Dotfiles, dot-folders, and `node_modules` are skipped.
- Limits: 200 files, 25 MB in total, and 10 MB for `index.html`.
- Paths must be plain relative names. Do not use a top-level `_page/` folder; Pages reserves it.
- The folder path is the page's identity, like a file path. Publishing it again
  replaces the whole file set in a new version. Unchanged files are stored once.
- Links between the folder's pages (`<a href="docs/details.html">`) open inside
  the BB preview. On a shared Here.now link they are normal site links.
- `bb pages pull <id> --out <dir>` writes a folder page back to disk. Without
  `--out`, `pull` prints a single-file page's HTML and refuses a folder page.
- Live `::inline-vis` previews show single files only. Publish a folder to see it.

In the BB preview, Pages rewrites relative references in HTML and CSS: `src`,
`href` on `<link>`, `<a>`, and `<area>`, `srcset`, `poster`, `url()`, and
`@import`. **Paths that scripts build at runtime are not rewritten**, and scripts
have no network, so `fetch("data.json")` fails. Put data the script needs inline
in a `<script type="application/json">` block.

## Sandbox and CSP

Pages run in a sandboxed iframe with a strict Content Security Policy. A page
that breaks these rules looks fine on disk and blank in BB.

- **Inline scripts and styles work.** Tabs, filters, sorting, and toggles are fine.
- **No network from scripts.** `fetch`, XHR, WebSockets, and EventSource are blocked. Put the data in the file.
- **No `eval` and no `new Function`.** Libraries that compile code at runtime fail.
- **No remote scripts, stylesheets, or fonts.** Never load a library from a CDN.
- **Images and media** may be `https:`, `data:`, `blob:`, or files of a folder page. Prefer `data:` or a folder file for anything the page needs.
- **No forms that submit**, no access to the BB window, no storage you can rely on.

## The theme

The theme is hem.so: Inter, quiet colour, weight 500 instead of bold, hairlines
instead of boxes. Every rule is inside `:where()`, so any selector you write
wins. **The theme is a floor, not a cage.** Use it for the ordinary parts. Style
what makes this page itself.

**Light and dark.** Put `class="auto"` on `<body>`. The page then follows the
BB theme in the preview and the reader's system when shared. `class="dark"`
forces dark. With no class the page is light. If you set a colour, use a token
so both themes keep working.

**Tokens** (on `:root`; override them on `:root`, never on `body`):

| Token | Use |
| --- | --- |
| `--bb-bg`, `--bb-surface` | page background, inset blocks |
| `--bb-text`, `--bb-strong`, `--bb-muted` | body text, headings, secondary text |
| `--bb-rule`, `--bb-line` | section hairline, table rows |
| `--bb-accent` | indigo; selection and chart series 1 only |
| `--bb-positive`, `--bb-negative`, `--bb-warning` | status colours |
| `--bb-chart-1` … `--bb-chart-6` | series colours |
| `--bb-measure`, `--bb-wide`, `--bb-dashboard` | 46rem, 62rem, and 80rem page widths |
| `--bb-space-tight`, `-group`, `-block`, `-section` | 0.5, 1, 1.5, 3 rem |
| `--bb-font-sans`, `--bb-font-mono` | font stacks |

**Optional classes**:

- **Page width.** Every page is one of three widths. Pick by content:
  - `main.page`: narrow, 46rem. Articles, reports, plans, notes. The default.
  - `main.page.wide`: wide, 62rem. Wide tables and side-by-side comparisons.
  - `main.page.dashboard`: 80rem. Many charts in a grid.
  A page without `main.page` gets the narrow frame. Do not set your own page width.
- `nav.toc` is the table of contents. Put an empty `<nav class="toc"></nav>`
  right after the header. Pages fills it from the `h2`s (`data-depth="3"` adds
  `h3`s) and marks the section in view. Use it on long pages with four or more
  sections. Add `data-toc="skip"` to a block whose headings should stay out.
- `div.tabs` splits a page into views. Put one `<section data-tab="Name">` per
  tab inside it. Pages adds the tab row. `data-selected` on a section opens it
  first. Use tabs for parallel views of one subject (Overview / Funnel / Raw
  data), not to hide the main finding.
- `div.scroll` scrolls a wide table sideways with a quiet scrollbar.
- `div.data-table` is the sortable, virtualized table for large datasets. It
  accepts JSON columns and rows and renders only the visible rows. It works
  anywhere in a page, including as the only child of a tab section.
- `dl.stats` is a row of headline numbers, right under the header. One
  `<div>` per stat: `<dt>` label, `<dd>` value, optional `<dd class="delta positive">`.
  Colour the delta by what is good (`positive`/`negative`), not by direction.
  Three to five stats.
- `div.grid` lays charts side by side; columns fit the width. `.cols-2` or
  `.cols-3` fixes the count. Use it with `main.page.dashboard`.
- `div.compare` shows before/after or option A/B side by side. Each column opens
  with `<p class="compare-label">Before</p>`; add `positive`, `negative`, or
  `warning` for a dot. A materially downscaled image in a compare block becomes
  keyboard-accessible and opens in a full-screen lightbox.
- `p.lede` is the muted line under the `h1`.
- `div.meta-line` is the quiet metadata row: `<span>` items with a hairline above.
- `dl.list` is a label/content list (`dt` label, `dd` content).
- `div.note` is an inset note. Add `warning`, `danger`, `success`, or `info`, and
  start it with `<span class="tone">Watch</span>`, one tone word.
- `span.badge` is a small status word. Use it rarely.
- `td.num`, `th.num` right-align numbers.
- `ol.findings` lists findings: `<li><span class="sev important"></span><strong>Title</strong><span class="loc">path:12</span><p>…</p></li>`.

## Design rules

Write semantic HTML first: `h1`, `h2`, `p`, `ul`, `table`, `figure`,
`details`. Most pages need no `<style>` at all.

- One `h1`. It is the finding or the subject, not a slogan.
- Left-aligned text at the page measure. Group with whitespace and hairlines.
- Put the most important fact first. Put details in `<details>`.
- Wrap wide tables in `<div class="scroll">` so the page never scrolls sideways.

### Image zoom

Large before/after screenshots inside `div.compare` automatically become
clickable when their intrinsic dimensions exceed their rendered size. The image
opens in a full-screen lightbox and can be closed with Escape, the close button,
or the backdrop.

Use `data-zoom` to opt another image into the same behavior when fine detail
matters. Do not add it to icons, logos, or small decorative images. Always write
useful `alt` text.

The image must be a file the page can load: in a folder page, put the
screenshots next to `index.html` (here in `img/`). In a single-file page, use a
`data:` URI or an `https:` URL.

```html
<div class="compare">
  <div>
    <p class="compare-label negative">Before</p>
    <img data-zoom src="img/before.png" alt="Settings page before the navigation cleanup">
  </div>
  <div>
    <p class="compare-label positive">After</p>
    <img data-zoom src="img/after.png" alt="Settings page after the navigation cleanup">
  </div>
</div>
```

### Data tables

Use a data table for interactive datasets, especially hundreds or thousands of
rows. Use a normal semantic `<table>` for small, static comparisons. Data
tables support 10,000 rows without putting 10,000 elements in the DOM.

```html
<div class="data-table" data-height="520" aria-label="Prospects">
  <script type="application/json">{
    "columns": [
      { "key": "name", "label": "Name", "type": "text", "width": 220 },
      { "key": "email", "label": "Email", "type": "email" },
      { "key": "status", "label": "Status", "type": "pill" },
      { "key": "arr", "label": "ARR", "type": "currency", "currency": "USD", "digits": 0 },
      { "key": "conversion", "label": "Conversion", "type": "percent", "digits": 1 }
    ],
    "rows": [
      {
        "name": "Acme",
        "email": "owner@example.com",
        "status": { "label": "Doing", "tone": "warning", "href": "https://www.linkedin.com/company/acme" },
        "arr": 125000,
        "conversion": 0.184
      },
      { "name": "Northstar", "email": "team@example.com", "status": { "label": "Done", "tone": "success" }, "arr": 98000, "conversion": 0.21 }
    ]
  }</script>
</div>
```

Every column is sortable. Types are `text`, `email`, `pill`, `currency`, and
`percent`. Currency and percent values are numbers; percent uses fractions
(`0.184` displays as `18.4%`). A pill is either a string or an object with
`label`, optional `tone` (`neutral`, `info`, `success`, `warning`, `danger`),
and optional HTTP(S) `href`. Linked pills open in a new tab. Column `width` is
pixels, clamped from 80 to 600. `data-height` is optional and clamped from 240
to 800 pixels.

The footer shows the visible row count and a filter button. Text and email
columns support partial, exact, and regular-expression matches. Pills use a
select built from their values. Currency and percent columns support greater
than and less than; percent filter input uses the displayed value (`20` means
`20%`). Active filters mark their column heading and update query parameters,
so the URL can be copied to reopen the same view. Give each table a stable
`id` when its filtered URLs will be shared.

To make the table a complete tab, place it directly inside a tab section:

```html
<div class="tabs">
  <section data-tab="Overview">…</section>
  <section data-tab="Data"><div class="data-table" id="all-data">…</div></section>
</div>
```

When a data table is the tab section's only child and has no `data-height`, it
automatically fills the remaining viewport height. Set `data-height` to keep a
fixed-height table instead.

Do not use these. They make a page look generated:

- coloured left rails or `border-left` accents;
- gradients;
- pills or rounded chips on every label;
- emoji as icons or section markers;
- centred layouts or centred text blocks;
- bold (`font-weight: 600+`); headings and `strong` are already weight 500;
- a border or box around every block;
- uppercase, letter-spaced eyebrows above headings;
- hero-size titles.

## Charts

Charts are HTML figures with Highcharts options as JSON. Pages loads its own
Highcharts (styled mode) only on pages that contain a chart. Colours and fonts
come from the theme, so charts follow light and dark. **Never load a chart
library from a CDN**, and never draw charts with another library.

```html
<figure class="chart">
  <div class="chart-title">CTA rate fell from 14.7% to zero in four days</div>
  <div class="chart-subtitle">Unique visitors who clicked the CTA, %</div>
  <script type="application/json">{
    "xAxis": { "categories": ["Sep 15", "Sep 16", "Sep 17", "Sep 18", "Sep 19", "Sep 20"] },
    "yAxis": { "title": { "text": "CTA rate" }, "labels": { "format": "{value}%" } },
    "tooltip": { "valueSuffix": "%" },
    "legend": { "enabled": false },
    "series": [{ "type": "line", "name": "CTA rate", "data": [9.1, 14.7, 2.9, 2.3, 0, 0] }]
  }</script>
  <figcaption>Sep 20 is partial.</figcaption>
</figure>
```

A stacked column chart:

```html
<figure class="chart" data-aspect="4/3">
  <div class="chart-title">Paid traffic carried the launch week</div>
  <div class="chart-subtitle">Visitors by source, thousands</div>
  <script type="application/json">{
    "chart": { "type": "column" },
    "xAxis": { "categories": ["Mon", "Tue", "Wed", "Thu", "Fri"] },
    "yAxis": { "title": { "text": "Visitors (k)" } },
    "plotOptions": { "series": { "stacking": "normal" } },
    "series": [
      { "name": "Paid", "data": [12, 14, 18, 22, 25] },
      { "name": "Organic", "data": [8, 9, 9, 10, 12] }
    ]
  }</script>
</figure>
```

Rules:

- The title states the finding, not the metric. The subtitle gives the measure, population, window, and units.
- The title, subtitle, and caption are HTML. Do not set Highcharts `title`, `subtitle`, or `caption`.
- Do not set colours or fonts. They are removed. To pick a colour, use
  `"colorIndex": 0`–`9` on a series or point.
- Formatters are strings only: `"format": "{value}%"`. Functions are rejected.
- No `url`, `href`, or `src` that points to `http`, `//`, or `javascript:`.
- At most 5,000 data points per chart and 20 charts per page. Aggregate first.
- Write `<\/` instead of `</` inside the JSON.
- `data-variant="simple"` hides numbers, ticks, and gridlines for illustrative
  shapes. `data-aspect="16/9"` (the default) sets the canvas shape.
- Any Highcharts series type works: line, area, column, bar, scatter, pie,
  heatmap, sankey, treemap, and more.

**Data table.** Every chart needs a readable data table for people and tools
that cannot see the chart. If the figure has no `<table>`, the runtime adds one.
To control it, add your own after the figcaption:

```html
<details><summary>Data table</summary><table>…</table></details>
```

If the same data already sits in a table right after the chart, add
`data-table="none"` to the `figure` so the runtime does not add a second one.

## Sharing

Sharing makes a public or restricted link. Ask the user first. Then call
`page_share`; BB asks the user to confirm. Never share a page without that confirmation.
