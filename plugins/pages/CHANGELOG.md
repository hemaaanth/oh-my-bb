# Changelog

## 0.6.1

- Prebuilt packages retain runtime and loader files but exclude debug sourcemaps.

- Gallery examples keep wide content inside their cards. Boards retain their own
  horizontal scroll instead of spilling across the page.
- Component categories use a compact keyboard-accessible menu beside Search.
  Search shrinks on narrow panes so the category and BB/Site controls stay on one row.
  Sources are grouped by component below each category's previews.
- Apps size diagrams without an unnecessary scrollbar. Tall and wide app content
  can still scroll.
- Corrected glass materials and quoted expressions in the 3D/shader examples.
- Provenance markers are centered on their vertical chain.
- Added histogram, box, and heatmap charts, series tones, and data-source captions.
  Source captions stay tied to resolved data during asynchronous file changes.
- Added Scene and Shader components, bounded GPU context reuse, native OpenUI
  scene expressions, textures, feedback buffers, and motion preferences.
- Added closed-fence HTML apps with opaque frames, bounded storage, staged answers,
  pane-scoped fullscreen, downloads, and streamed inert previews. Fetch and
  resource loads are blocked; self-navigation can still make a network request.
- Added FileCode source excerpts and static author checks/examples through agent
  tools and the package-local `bb pages` CLI.
- Hidden native code viewers remount when they receive real layout width.
- Component schemas, examples, and skill references now regenerate during builds.
- Images and diagrams share a pane-contained viewer with zoom, pan, pinch,
  gallery navigation, and native modal focus restoration.
- OptionCards supports image choices with separate expand controls that preserve selection.
- Maps support day routes, replayable tours, and credited Wikipedia photos
  through the existing Web lookups setting.
- Expanded coverage formats, security audits, compiler findings, test failure
  details, and benchmarks with measurement conditions and repeated samples.
  Failed commands no longer become a successful benchmark's speed baseline.
- JUnit XML reports retain failure details, source locations, and captured output.
  They also work in Markdown export.
- Acceptance matrices and CSV checks preserve missing and claimed results.
  Installed/deployed provenance exposes mismatched receipts and unproven stages.
- Image comparisons support wipe, motion-aware blink, and pixel differences.
  Transcript comparisons align words, score recognition errors, and seek supplied audio.
- Findings follow-up requests use explicit menu actions. Gallery actions preview
  their request; read-only pages cannot send messages.
- Added current-value Copy as Markdown and `bb pages render` text export.

- Pages uses one canonical SVG in settings, navigation, and panel headers.
- Configuration groups optional keys before behavior controls. Secret storage,
  saved values, setting IDs, and defaults are unchanged.
- More links to the library, component gallery, and setup guide. The gallery
  keeps live previews and source disclosures on its own page.
- Standard app pages use the Settings content width and outlined recessed
  cards. Document canvases intentionally remain full-bleed.
- Rename now takes focus after the page menu closes. Escape cancels without
  saving and returns focus to the page menu.
- Portal test dependencies are pinned to the host's Radix versions.

- Pages now declares `bbPluginSdk >=0.6.49`, the SDK stable BB 0.46.1 ships. It was
  `>=0.4.84`.
- Build tools moved up: TypeScript 7, `@types/react` and `@types/react-dom` 19.3.
- Removed 13 unused development dependencies (`@radix-ui` dialog, select,
  tooltip, hover-card, menubar, navigation-menu and context-menu, `@pierre/diffs`,
  `sonner`, `vaul`, `clsx`, `class-variance-authority`, `tailwind-merge`).
- The README lists the settings, the `bb pages` commands, and the BB version
  Pages needs. The git install example now points at `^0.6.0`.
- A test pins that Pages never asks for configuration on a fresh install, and
  that Here.now and Mapbox each report their own missing setting.

## 0.6.0

- Pages has its own icon set, MingCute (Apache-2.0): about 1,650 glyphs in a
  line and a filled style. Write `<i data-icon="name"></i>` in a page. Pages
  swaps it for an inline SVG in every view, with no script or font. Familiar
  names like `x`, `trash`, and `home` work too. `references/icons.md` lists
  every name.
- Chat components draw MingCute glyphs instead of Lucide. Icon names in
  messages written before still work.
- Buttons outside a form get the theme's button look. They were the
  browser's default grey. `button.primary` is solid.
- An inline page keeps 4px below its last line. At a fractional display
  scale the frame could round its bottom edge down and clip the last row's
  border.

## 0.5.0

- Pages now needs BB 0.46.1 or later.
- An ```` ```openui-lang ```` fence in an assistant reply renders in place as
  Pages components, live while it streams: Stack, Heading, Text, Callout,
  Stat, Stats, Table, Progress, Chart (bar or line), Tabs, Code, Diff,
  Input, Slider, Toggle, Choice, Button, and Form. Code and Diff use BB's
  own viewers. A button sends its label and its form's answers to the
  thread. A sent form locks with the clicked button marked, stays locked
  after a reload, and shows Edit answers. A failed send unlocks it. A
  fence that does not parse shows as code.
- Chat charts draw with Highcharts, the same as page charts. Treemap,
  CalendarHeatmap, Gauge, Sparkline, Waterfall, and a Benchmark ranking
  draw with Highcharts too, through the same loader and theme.
- Published pages and shared sites draw every chat component. Write an
  `openui-lang` fence in a Markdown page, or
  `<script type="text/openui-lang">` in an HTML page. A test renders every
  gallery example through the page runtime, so chat cannot show a component
  a page cannot. Pages that have a block load `_page/spec.js`; others do not.
- On a page, components that send to the thread are read-only. Publishing
  saves each block's Query answers (only the files and git data the publish
  can read), place names, photo searches, and the map tiles of each map's
  opening view. Tiles are saved as images, so the Mapbox token stays on the
  server.
- The settings Components gallery has a BB and Site switch. Site shows each
  example the way a shared site draws it.
- The skill ships `references/openui.md`, generated from the component
  library and checked by a test. Agents are told to use a fence for small UI
  in one reply and a page for the rest.
- Inside BB, pages use a smaller type scale. Inline pages match the chat text.
  The panel and cards are one step larger. Shared sites keep the full scale.
- `body.auto` pages take BB's own colours, fonts, and radius in previews, and
  follow theme changes live. A page's own token overrides still win.
- The accent and chart colours follow BB's theme too.
- Inline text matches BB's chat text exactly: size, line height, spacing, and
  the same Inter cut.
- Inline pages show at their full height. They are never clipped and have no
  "Open full page" button.
- Heatmaps named by `chart.type` now get a colour scale. Before, every
  cell took one colour.
- The page panel uses BB's background.
- Cards show the top of the page at full size instead of zoomed out.
- The library's project and folder filters open themed menus instead of the
  browser's selects.

## 0.4.0

- Forms on a page send their answers to the thread the page is shown in, as
  one queued message with the page id. Each answer goes under the label the
  reader saw, and the clicked button is the action. Forms send from the page
  panel and inline pages. A form marked `data-bb-pages-manual`, or cancelled
  by the page's own script, sends nothing.
- A retried form is sent once. One thread takes at most ten forms a minute.
- Shared sites keep forms from navigating and tell the reader to open the page
  in BB.
- The theme styles forms: text, date, number, select, multi-select, textarea,
  checkbox, radio, and range, plus `.field`, `.field-row`, `.choices`, and
  `.actions` for layout, and a look for each form state.
- A sent form stays locked with its answers and the clicked button marked,
  and shows Edit answers to send again. It stays sent after a reload, per
  thread and page version (or file content).
- Forms in live `::inline-vis` files send to the thread too.
- Select, date, and time fields open themed pickers in place of the
  browser's: a list with groups and a check on the chosen option, a month
  calendar with Today and Clear, and a list of times at the field's step.
  Number fields get − and + buttons. Mark a field `data-bb-pages-native` to
  keep the browser's control. A focused field shows an accent border and no outer ring, so nothing
  is cut off at the edge of an inline page. Chosen options in a multi-select
  keep the theme's colours while it has focus.
- Inline pages keep a 2px side inset, so a full-width field's border is not
  cut off at the frame's right edge on a fractional display scale.
- `page_publish` shows a page with a form inline by default, since a card
  cannot send forms.

## 0.3.0

- Publish a folder with `index.html` plus its images, CSS, fonts, scripts, and
  other pages (`page_publish { dir }`, `bb pages publish <dir>`). Limits: 200
  files, 25 MB. Unchanged files are stored once across versions.
- Links between a folder's pages open inside the BB preview, through the frame
  bridge. Shared Here.now links upload the folder as a site.
- `bb pages pull <id> --out <dir>` writes a page version's files to a folder.
- Send feedback from the page panel to the thread, with the page id to
  republish.
- The publish result names the page id to pass for later updates.
- The skill tells agents when to offer a page before the user asks.

## 0.2.0

- Add a borderless inline display: `display="inline"` on `::page`,
  `::inline-vis`, and `::artifact` shows the page itself in the reply, fitted to
  its content height, with an "Open in panel" button on hover or focus.
  `page_publish` and `bb pages publish --display` bake it into the directive.
  Cards stay the default.
- Previews now talk to BB through a frame bridge. Theme changes apply without
  reloading the page, and `http(s)` links, including data-table pill links,
  open through BB. Shared and published sites do not include the bridge.
- Tell agents that the reader already sees a published page, so replies must
  not announce, describe, or restate it.
- Inline local images at publish. `<img src>`, simple `srcset`, `poster`, SVG
  `<image href>`, CSS `url()`, and Markdown images that point at local files
  are embedded as `data:` URIs in the stored version.
- Resolve relative image paths from the page's folder. Accept absolute paths
  only inside the thread's workspace or thread storage. Leave remote, `data:`,
  and `blob:` URLs untouched.
- Cap each image at 5 MiB and the inlined page at 10 MiB. Publish fails with a
  list of missing, oversized, non-image, or out-of-root paths and how to fix them.
- Compare inlined bytes, so changing only an image adds a version.
- Inline readable local images in the live `::inline-vis` preview too. Unusable
  ones stay as written.
- Tell agents to reference local images by path instead of base64-encoding them.

## 0.1.1

- Open large before/after screenshots in an accessible full-screen lightbox.
- Allow any detail-heavy image to opt into the lightbox with `data-zoom`.

## 0.1.0

- Publish HTML and Markdown files as versioned BB pages.
- Organize pages into logical project folders and browse artifacts by project,
  folder, or title with `page_browse`.
- Render themed pages, interactive data tables, and Highcharts charts.
- Share pages through Here.now with restricted, password, or public-link access.
- Support optional PR Review document publishing and page actions without
  requiring the PR Review plugin.
