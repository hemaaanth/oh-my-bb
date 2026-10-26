# Settings design findings: 2026-10-19

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

## Voice settings: 2026-10-20

The Agent section replaces the voice select with a voice list, a voice style
group, and **Design a voice**.

- Voice list: one bordered, scrolling box (at most 20rem high), with small
  muted group headings: Saved voice, Your voices and Built-in voices.
  GPT-Live and Realtime choices share the built-in list. Each row shows the
  name, known language, accent and presentation, and a check on the chosen voice. A
  ghost icon button plays or stops the sample. Only one sample plays at a time.
- The cost line above the list says built-in samples are free, while custom
  and styled previews cost about 1¢. Without a key, it explains that custom
  voices need an OpenAI key. Only actions that need a key are disabled.
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

## Alignment pass: 2026-10-20

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

## Settings standardization: 2026-10-22

This pass supersedes the six top-level groups above.

- Keep the six credentials together in BB's native Configuration form. Do not
  move secrets or replace native settings commands to change a heading.
- Start a separate Preferences section below the native key form. Its short
  help distinguishes key entry from behavior controls. Status and the Agent,
  Plugin access, Appearance and Calls cards follow, then Advanced, More and Oh My BB.
- A separate Credentials heading is not required for plugin-wide keys.
  Per-resource credential forms stay with their resource.
- More opens the dedicated setup page. Missing-setup warnings link there too.
- General plugin-command access belongs in Preferences because it covers all
  installed plugins, not just Oh My BB packages.
- Oh My BB links to Webhooks settings when Webhooks is enabled. Webhooks owns
  and enforces the Dispatch receiver switch at endpoint save and delivery.
  Do not duplicate that toggle or confuse plugin availability with opt-in state.
  The native URL link preserves SPA navigation and the current client runtime.
  No integration default or execution boundary changes in this pass.
- Static identity surfaces use the canonical Dispatch SVG. The live footer
  avatar remains an operational control, with its saved appearance, activity
  feedback and call actions. Do not replace it with a glyph.
- Console, transcript and setup use a 760px outer frame with 16px side padding.
  They reserve a native scrollbar gutter, matching Settings. At a 1280px
  viewport, their outer left edge is 415px and content width is 728px.
  Overlay ScrollArea had centered the same frame 5px farther right.
- Console controls and call columns respond to the Dispatch pane's content
  width. Settings selects ignore values absent from their offered choices.

Package-local typecheck, 502 tests and build passed. Live verification used
read-only navigation, existing call transcripts, the footer menu and settings
pickers. Settings, console, transcript and setup were measured at 320, 360,
390, 480, 640 and 760px viewport widths without horizontal overflow. No
validation call or message was sent. The user approved keeping the native key
form and separating ordinary controls under Preferences.

## Voice and control refinement: 2026-10-22

- The owner confirmed that Realtime voices work. Show all 31 built-in voices
  together, without compatibility warnings. Keep saved voice IDs and samples.
- Dropdowns and segmented controls use the same 18rem width on wide rows.
  Choices share that width evenly. Narrow rows use the available width.
- The microphone Save action sits with its secondary actions below the picker,
  so Microphone and Speaker share the same right edge.
  Popups align to the trigger's right edge, including wider option lists.
- Labels and help are short. Native credential help fits one line at the
  standard wide settings frame. Text wraps when a narrow pane needs it.
- Remove em dashes from plugin-owned UI text. No secret IDs, stored values,
  validation rules or operational settings change.

Typecheck, all 501 tests and build passed. Live measurements at 320, 360, 390,
480, 640, 760 and 1280px show equal selector widths, matching right edges and
no horizontal overflow. Wide-pane subtitles fit one line. The microphone popup
uses end alignment, with less than 1px difference between its layout right edge
and the trigger. Saved Sage remains selected. No call or sample was played.

## Footer and colour refinement: 2026-10-22

- BB owns the footer button, click disclosure and native context menu. The live
  avatar does not intercept right-click or long-press events.
- Two equal-width call buttons share one row inside the native disclosure:
  Talk in app (End call while active) and Call my phone. Opening it is inert.
  The phone action remains disabled while dialing or when setup is missing.
- Keep the native disclosure frame instead of building another overlay system.
- Appearance uses BB-styled preset buttons and a visual colour popover, not the
  browser popup or an expanding inline panel. The colour area and hue slider work with
  pointer, touch and keyboard input. Preview locally while dragging; save only
  when the interaction ends.
- Hex entry is optional. Invalid partial values never write preferences.
  Enter or blur commits a complete hex colour; Escape cancels that text edit.
- Keep the saved theme/custom colour and all other pet appearance fields.

Typecheck, all 503 tests and build passed. Live checks confirmed the native
Hide from footer / Customize footer menu, unchanged avatar and equal-width
footer actions on one row, without text overflow.

The visual picker selected a colour with the pointer, updated the pet preview,
and retained the choice after reloading the verification tab. The original
Theme setting was restored and checked after another reload. The regression
test also covers keyboard selection, save-on-release and remount persistence.
At viewport widths of 320, 360, 390, 480, 640 and 760px, the popover remains
inside the viewport without overflow. Opening it changes neither the colour
row's height nor the next control's position (both measured deltas: 0px).
Escape cancels the pending hex edit and restores focus to the trigger.
Outside click closes the popover. The saved colour remains unchanged.
No call or sample was started for validation.
