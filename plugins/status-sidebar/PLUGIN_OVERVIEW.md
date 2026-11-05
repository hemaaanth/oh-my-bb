# Status Sidebar

Group BB threads by working status with nested thread summaries and saved ordering.

## Focus view

Right-click or long-press a section heading and choose **Group by → Focus** to try Attention, Current work, and a collapsed Library. Existing view preferences stay saved until you change them. Questions, failures and unread completed turns lead; running agents stay compact at the bottom of Current work. Status uses small colored glyphs; attention rows show a second line with the reason and age. Project metadata stays in the same position across sections; worktree names are omitted. Selection only changes the highlight.

Focus keeps status bands together: input, unread, drafting, quiet read work, then running. Pins sort first within each band. Attention events order peers; streaming updates do not. Manual ordering remains available. Threads are never grouped or reordered by worktree. Library shows one total; its tooltip gives the count of idle threads inactive for at least 14 days. Expand it to review the marked rows, open them to save work, or use Snooze. Pins, drafts, live/background work, queued messages and unresolved attention are excluded from suggestions. These are review cues only. Nothing is automatically archived. BB archive removes the workspace and worktree; the native archive controls and existing Archived section are unchanged.

Snoozed threads and parents wake for requests or failures. Quiet running work and routine completions do not cancel snooze.

## See what needs attention

Group threads by status or project, or by Projects-owned groups when enabled. Combine a subgroup with recent, status, or manual ordering. Recent shows read work from the past 3 hours (adjustable from its right-click menu). Older read threads sit in Idle above collapsed Working. Delegated child chatter does not fill Unread, and an idle background command does not keep a thread Working. Pinned stays on top; snoozed threads stay in a collapsed group for early wake-up, and Archived stays at the bottom with a 7- or 30-day window and at most 50 loaded rows. Parent summaries include the neediest child. Expand children without leaving the thread list.

BB keeps its navigation rail, footer, split navigation, keyboard targets, and native thread action menus. Status Sidebar adds timed snoozing. It does not replace BB's project or thread lifecycle controls. The sidebar stays narrow; its collapsible setup guide lives in plugin settings, not a separate rail page.

## Works alone

Native BB thread, project, draft, host, and navigation data power the base sidebar. Manual order, snooze times, and collapse preferences remain available. Retired local groups stay stored, but are no longer shown. No account, API key, or sibling package is required. Private state stays on the BB server or in the current client's browser storage.

## Optional integrations

Explicit Oh My BB switches in plugin settings enable Agents, Projects, or Tasks. Agents adds Bots and Channels. Projects supplies shared project groups and project order. Tasks adds query-driven attachment to an existing task. Install and configure each owner separately. All opt-ins default to off. Status Sidebar never installs, enables, or probes siblings at startup. Disabling an integration retains saved state. Previously saved native flags import once; one explicit reload finishes moving their controls to Oh My BB without duplicate editors.

## Requirements

BB 0.46.1 or later. Choose Status Sidebar under Settings → Appearance → Sidebar. Expand More → Setup guide in Status Sidebar's plugin settings. Native Thread list preferences are not rewritten.
