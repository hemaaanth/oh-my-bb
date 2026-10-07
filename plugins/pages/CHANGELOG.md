# Changelog

## Unreleased

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
