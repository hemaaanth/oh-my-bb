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
  The call memory rows (Call memory, Remember calls for, Home time zone) are on
  the desktop page only.
  Keep microphone permission, refresh, test, save, shortcut recording, and errors.
- Tools: keep plugin access and the actionable checklist. Remove the read-only
  built-in tool catalogue; it was documentation, not a setting. Keep its RPC unchanged.
- Advanced: keep reasoning model and reset confirmation. Hide the fixed voice model
  when it has only the supported choice. Remove the duplicate credential checklist;
  the native setup form and Readiness already cover it. No RPC is removed.

No server, RPC, storage, or setup-secret behaviour changes. SDK stays at 0.6.49.

## Voice settings — 2026-10-20

The Agent section replaces the voice select with a voice list, a voice style
group, and **Design a voice**.

- Voice list: one bordered, scrolling box (at most 20rem high), with small
  muted group headings: Saved voice, Your voices, GPT-Live, and Realtime
  (unconfirmed). Each row is one pressable line: the name, then language,
  accent, and presentation in muted text, and a check on the chosen voice. A
  ghost icon button plays or stops the sample. Only one sample plays at a time.
- The cost line sits above the list: "Built-in samples are recordings in the
  default style. Your voices and Preview with this style use your OpenAI key,
  about 1¢ per new sample." With no key, the line says built-in samples still
  play, and what the key is needed for. Only the buttons that need a key are
  disabled.
- While a new sample is made, a muted status line under the control that asked
  for it says "Making a sample, about 10 seconds". Built-in samples never show
  it.
- Voice style: five rows with the quiet segmented control from Appearance
  (Pace, Energy, Expressiveness, Turn length, Backchannels), then the style
  notes field, saved on blur, with a character count. One muted line says the
  style is instructions, not exact controls. **Preview with this style** plays
  the chosen voice.
- Design a voice: a closed disclosure with a name, a description (the OpenAI
  docs example is the placeholder), and one **Create voice** button. Errors sit
  under the button.
- No marketing copy, no custom colours.

## Alignment pass — 2026-10-20

- Rows are container queries on the row (`@container`, `@md:` at 28rem). The
  settings column is narrower than the window, so viewport breakpoints put
  controls beside labels that had no room.
- `Row` has three placements. `inline` stacks label and control in a narrow
  column and puts them side by side from 28rem. `trailing` keeps a switch on
  the right at every width. `below` always stacks, for wide fields.
- Labels are `text-sm text-foreground`. Help is `text-xs text-muted-foreground`
  under the label. A group title and its note form one header block.
- `Segmented` is the one segmented control (Appearance style and the five voice
  style rows). It fills the column when stacked and shrinks to its content when
  inline. Each choice is a button with `aria-pressed`.
- `Disclosure` is the one disclosure: a small muted button with a chevron and
  `aria-expanded`. Phone setup (open while phone setup is missing), Full prompt,
  Instruction history, and Design a voice use it.
- Selects are full width when stacked and 14rem when inline.

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
