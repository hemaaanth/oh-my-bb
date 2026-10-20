# Settings design findings — 2026-10-19

## References

Inspected the running BB 0.46.1 bundles for Automations, Concurrency limit,
Thread list, and Push notifications. Also checked the SDK 0.6.49 app exports,
the plugin styling guide, and the live Dispatch settings page.

- Automations uses small sentence-case headings, quiet borders, compact metadata,
  and one clear action per row. Empty and error states sit beside the relevant action.
  Its menus use BB's themed Radix controls, not browser select popups.
- Concurrency limit puts labels and short help on the left, controls on the right.
  Fields save without a separate page-wide form. Help uses muted text.
- Thread list uses checked menu choices, small controls, and host icons.
- Push notifications shows setup actions only when permission or setup needs work.
- The SDK exports host capability components, not a general settings or select kit.
  Plugin-owned controls should vendor BB's shadcn source. Portaled menus need the
  plugin portal scope so BB's theme and plugin CSS reach them.

## Dispatch changes

Keep all six groups and the native secret setup form. Use consistent responsive
rows and the vendored BB select in every settings picker. Keep controls at a
shared width, with no custom colours or inset shadows.

- Readiness: two compact mode statuses. Missing setup stays visible. Put webhook
  detail behind a phone setup disclosure with a real setup guide link. Keep the
  pending reload action. Remove the help-only terminal footer and separate webhook row.
- Agent: keep name, voice, instructions, preview, and restore. Collapse saved history
  behind a disclosure. Hide empty history. Reduce the editor's default height.
- Appearance: keep the real pet preview. Replace the wall of mood chips with a
  compact preview picker. Use a quiet segmented control for the two styles.
- Calls: use the same pickers and rows on desktop and the Mobile settings page.
  Keep microphone permission, refresh, test, save, shortcut recording, and errors.
- Tools: keep plugin access and the actionable checklist. Remove the read-only
  built-in tool catalogue; it was documentation, not a setting. Keep its RPC unchanged.
- Advanced: keep reasoning model and reset confirmation. Hide the fixed voice model
  when it has only the supported choice. Remove the duplicate credential checklist;
  the native setup form and Readiness already cover it. No RPC is removed.

No server, RPC, storage, or setup-secret behaviour changes. SDK stays at 0.6.49.

## Verification

The package check passes typecheck, all tests, and build. The live plugin reloads
from its existing local source. Browser checks cover desktop dark and light themes,
the themed voice menu, and mobile-width rows and drawer menus. The voice choice
was changed and restored. No real call was started.

**Host limitation:** BB 0.46.1 mounts `experimental_page: "mobile"` sections only
for the selected machine access provider inside “Accessing bb from your phone”.
It does not mount Dispatch's section on `/settings/mobile`. The registration stays
in place and is covered by the SDK harness. Its microphone, announcements, and
drawer controls share the same components verified on the Dispatch page at mobile
width. Fixing the host mounting path is outside this plugin change.
