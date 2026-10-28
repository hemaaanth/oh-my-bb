# Changelog

## Unreleased
- Remove the legacy Traces view and stop recording its failure and input feed. The old feed table is left in place. Calendar, its turn data, and optional Dispatch calls remain.

- Move Catch up from the thread top bar into the native three-dot menu and sidebar thread menus, with the canonical Journal icon. Keep saved briefing reads, reload, and background refresh unchanged.
- Shorten settings descriptions and remove the backend-details disclosure and Test button. Keep readiness CLI and inference RPC behavior unchanged; setup details remain in the dedicated guide.
- Follow the current SDK's `olderCursor` for full history and briefing coverage. Regression checks cover older work days and a newest-page briefing that cannot claim full-history coverage.
- Move Journal into an independently installable Oh My BB package. Keep its plugin ID, OpenRouter secret ID and storage, SQLite history, category overrides, summary budgets, calendar, and time sheet.
- Separate settings into native Configuration (the OpenRouter key only), Preferences, More, and Oh My BB. Import all saved non-secret values, including the AI backend and subscription model, without resetting state. One finishing reload removes the legacy native editors. `bb journal preferences` replaces the moved fields' native configuration commands and retains validation.
- Keep Dispatch reads optional, off by default, and guarded at execution. Put Dispatch and the AI backend opt-in in Oh My BB. No sibling imports, startup probes, or required suite dependency.
- Add optional Model Gateway subscription inference for all Journal model paths, with no paid-key fallback, bounded JSON inputs, shared call accounting, and readiness CLI.
- Add saved six-section thread briefings with live status, freshness, and honest coverage. Opening or reloading a briefing reads stored rows only. Subscription-only background refresh is bounded; manual refresh is explicit.
- Use the canonical Journal SVG for static navigation and footer branding. Preserve native secret storage and key commands.
- Add a dedicated setup guide under More. Text views and setup use the Settings content width. Calendar and time sheet retain an explicit wider-canvas exception for their day columns.
- Scope catch-up dialog portals, restore focus to the opener, and use a bottom drawer only at narrow viewport widths. Keep desktop dialogs centered. Size filters by their container, constrain long-label select popups, and ignore invalid select emissions.
- Replace project-specific examples with harmless fixtures and include package licensing and third-party notices. No runtime data is included.
