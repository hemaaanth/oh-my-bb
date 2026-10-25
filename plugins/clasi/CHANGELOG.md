# Changelog

## Unreleased

- Migrate Clasi as an independently installable Oh My BB package with its own lockfile.
- Keep existing database migrations, scope derivation, retention budgets, settings IDs, memory-write RPCs, and agent tools unchanged.
- Replace cross-package test imports with synthetic package-local retention and scope fixtures. Add reload preservation coverage.
- Align standard pages with BB Settings geometry, recessed cards, container-responsive controls, and one canonical branding SVG. Link the dedicated guide from the Clasi header and Settings → More.
- Keep Select popups aligned to their trigger width and wrap long scope labels in narrow panels.
- Use compact icon buttons for Resolve, Dismiss, and Delete, with accessible labels and scoped hover/focus tooltips. Keep tooltip text to the action name; identify the record only in delete confirmation.
- Remove the retired repository Napkin importer, activation hook, parser, dashboard metadata, and import UI. Preserve already-imported records and immutable migration history.
- Preserve native Configuration and document Pinpoint's optional, explicit learning-consent boundary.
- Include standalone usage, privacy limits, license, and third-party notices. No live data is included.

## 0.2.1

Private-source version retained by this migration. No public release or tag is created here.
