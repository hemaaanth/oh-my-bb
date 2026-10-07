# Changelog

## Unreleased

- Publish a folder with `index.html` plus its images, CSS, fonts, scripts, and
  other pages (`page_publish { dir }`, `bb pages publish <dir>`). Limits: 200
  files, 25 MB. Unchanged files are stored once across versions.
- Links between a folder's pages open inside the BB preview; shared Here.now
  links upload the folder as a site.
- `bb pages pull <id> --out <dir>` writes a page version's files to a folder.
- Open outside links from a page through BB.
- Send feedback from the page panel to the thread, with the page id to
  republish.
- The publish result names the page id to pass for later updates.
- The skill tells agents when to offer a page before the user asks.

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
