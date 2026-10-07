# Changelog

## Unreleased

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
