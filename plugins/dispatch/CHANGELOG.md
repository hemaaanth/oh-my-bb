# Changelog

## 0.3.2

- Add experimental in-app Podcast mode with project people, scoped thread control, optional Journal reads, and queued spoken updates.
- Preserve project speaker labels in call transcripts.
- Keep native secret fields together in Configuration. Start ordinary controls
  under a separate Preferences heading, followed by Advanced, More and Oh My BB.
  Secret storage, validation and existing settings commands are unchanged.
- Put setup guidance on its own page, linked from More and missing-setup warnings.
- Reuse the Dispatch SVG for settings, rail and console. Keep the live footer
  avatar, saved appearance and activity feedback.
- Align console, transcript and setup to Settings' 760px outer frame with a stable
  scrollbar gutter. Use pane-width queries for console controls and call columns.
- Ignore settings-select values that are not offered, preserving saved choices
  while device and plugin discovery load.
- Combine all supported built-in voices in one list, including Realtime voices.
  Remove obsolete compatibility warnings without changing saved choices or samples.
- Align Microphone with Speaker and use one responsive width for dropdowns and
  segmented selectors. Keep microphone actions below its picker.
- Shorten settings labels, help and the plugin subtitle. Remove em dashes from UI copy.
- Move call actions into a compact, two-button click disclosure. Leave right-click
  to BB's native footer menu. Opening the disclosure never starts a call.
- Replace the browser colour popup with a themed visual colour popover and presets.
  Preview while dragging and save on release. Hex entry remains optional, with
  validation and Escape cancellation. Opening it does not resize the settings row.
- Left-align colour choices and show the live theme colour beside Theme.
  Use three palette columns in narrow panes to keep labels from overflowing.
- Move general plugin-command permissions into Preferences. Keep Oh My BB for
  suite-specific integration controls.
- Replace the passive Webhooks status with **Manage in Webhooks**, linking to
  the owning receiver switch without reloading BB or duplicating the toggle.
- Include runtime bundles and voice assets in the production package. Normalize
  source-map paths so published artifacts contain no workstation paths.
- Keep shared RPC contracts type-only with respect to the SDK so Git installs
  build correctly after installing production dependencies without dev packages.

## 0.3.1

- Built-in voice samples. Every listed voice has a pre-made sample of the
  sample line in the default voice style, in `voice-samples/`: 31 MP3 files
  (mono, 24 kHz, 32 kbps, 816 KB in total) and a manifest. They play at once,
  with no key and no API call, also during a call. `npm run samples -- --env
  <file>` makes them again and prints the timing of each session.
- `voiceSample` takes `{ voice, style }`. `style: "default"` is the list
  sample; `"saved"` is **Preview with this style**. It returns
  `{ audio, mime, source }`, where `source` is `bundled`, `cache`, or `live`.
- A new sample now ends on quiet. GPT-Live keeps sending silent audio after it
  speaks, so samples used to run to the 15-second cap. Quiet now means no audio
  louder than about -40 dBFS for 1.2 seconds, and the silent edges are cut
  off. A new sample takes about 9–11 seconds instead of 15.
- While a new sample is made, the settings page says "Making a sample, about
  10 seconds". The cost line says built-in samples are recordings in the
  default style, and your own voices and style previews use your key.
- Settings alignment. Rows use container queries, so they follow the width of
  the settings column, not the window. The voice style rows use one shared
  segmented control that fills the column when it is narrow. Phone setup, Full
  prompt, Instruction history, and Design a voice use one shared disclosure.
  Labels and help text use BB's sizes.
- The microphone list leaves out devices with an empty id. Some browsers list
  them before access is granted, and the menu failed on them.

## 0.3.0

- Call memory. A few seconds after a call ends, the user's reasoning model
  writes a title and summary with the user's OpenAI key. Migration 006 adds
  `call_summaries` and a per-call `forget` flag. A failed summary stores a
  fallback built from the tool trace, and missing summaries are retried when
  Dispatch loads.
- Phone and app transcripts. GPT-Live transcript fragments are grouped into
  one `speech.user` or `speech.agent` row per utterance.
- The prompt has a `# Recent calls` section and a "Last call" line. The time
  line uses the caller's time zone. The app sends its zone and a short device
  name. Phone calls use the new **Home time zone** setting.
- A `recall_calls` tool looks up older calls by day or by words.
- **Call memory** and **Remember calls for** (30 days, 90 days, 1 year, or
  forever) in Calls settings. **Forget this call** in the console and
  `bb dispatch forget [call-id]` delete one call's transcript and summary.
- The console shows each call's summary.
- A discoverable, read-only `read.calls` RPC for other plugins.
- A grouped voice list: the 21 GPT-Live voices with language, accent, and
  presentation, plus `marin`, and the Realtime voices under "Realtime
  (unconfirmed)". `nova` is gone from the list. The default stays `gleam`, and
  a saved voice that is no longer listed is kept.
- Voice samples. Each voice has a play button. A new sample is one short
  GPT-Live session on the server with the current style; it costs about 1¢.
  Samples are cached in the plugin database (8 MB, least recently played go
  first), are refused during a live call, and never touch calls or usage.
  Migration 007 adds the `voice_samples` table.
- Voice style: pace, energy, expressiveness, turn length, backchannels, and
  notes. It is prompt-based: each choice is one sentence in a new
  "# Voice style" section of the voice prompt, which now sets turn length.
- Design a voice: create an OpenAI prompt-to-voice voice from a name and a
  description, pick it, and remove it from the list. Calls send it as `{ id }`.
  A key without `api.voices.write` gets a clear error.
- New RPCs: `voiceSample`, `voiceCreate`, and `voiceRemove`. New preferences:
  `voiceStyle` and `customVoices`.

## 0.2.0

- Remove `bb dispatch import --from handsfree`, its RPC, and its docs. Handsfree
  was never published, so no one else needs it. Migration 005 drops the empty
  `legacy_token_usage` table, and usage reports no longer have
  `legacyTokenRows`.

## 0.1.1

- Remove the unused `toolCatalog` RPC. The server still builds each
  session's tool list itself.

## 0.1.0

- In-app voice with OpenAI GPT-Live over WebRTC. Start or stop from the
  footer pet, Mod+Shift+H, or the command palette. Mute with Mod+Shift+U.
- A named agent, Juno by default, with 25 tools: list, search, and read
  threads, start, send to, stop, rename, and archive threads, change a thread's
  model, open threads and diffs, and run commands from allowed plugins. It asks
  before it stops or archives a thread.
- Your instructions, added after the built-in prompt, with every saved version
  kept and a read-only view of the full prompt.
- Thread notices: while a call is live, the agent says when a thread finishes
  or fails.
- One call everywhere. A new call stops calls on other devices, and
  `bb dispatch stop` ends them all.
- Phone calls through Twilio and OpenAI SIP. The Webhooks plugin forwards the
  `live.transport.incoming` webhook. Dispatch accepts the session, runs the
  tools over the sideband socket, and hangs up on stop.
- The footer pet, drawn with `agent-robot-avatar`, with style, colour, head
  shape, pointer follow, and antenna flash. A pointer ghost shows where the
  agent is looking.
- The Dispatch console: calls, transcripts with tool traces, and voice minutes
  with an estimated cost at $0.05 per minute. A nav badge shows "Live" or
  "Muted".
- Six secret setup settings. BB shows "Needs configuration" only when the
  OpenAI key is missing. Dispatch reloads itself when the key arrives, or
  shows "Reload to apply".
- Settings sections: Readiness, Agent, Appearance, Calls, Tools, and Advanced,
  plus a short section on BB's mobile settings page.
- `bb dispatch` CLI: `status`, `live`, `read`, `usage`, `stop`, `mute`,
  `unmute`, `call`, and `import`. An agent skill explains them.
- A one-time import from the earlier voice plugin, `bb dispatch import --from
  handsfree`. It is a dry run unless `--apply` is given.
- Requires bb 0.46.1 or later and plugin SDK 0.6.49 or later. The sidebar
  "Live" pill uses `experimental_sidebarAccessory`; SDK 0.6.53 and later
  ignore that field, so the pill is hidden there until Dispatch moves to
  `experimental_useBadge`.
- The agent greets you when a call connects, in the app and on the phone, so
  you know it is ready to listen.
- Phone calls use TLS SIP with SRTP media (`;secure=true`), which GPT-Live
  requires.
- On narrow screens the console header keeps the call buttons on their own row,
  so status text no longer moves them.
- Make the console denser with aligned call history, compact usage totals, and
  grouped call actions. Daily usage and pricing stay in a disclosure.
- Replace phone dial success toasts with waiting, live, and ended status in the
  console, sidebar accessory, and footer pet. Hide provider call references and
  mask phone numbers in displayed error and transcript text.
- Match BB's settings controls: themed pickers, consistent rows, compact setup
  status, collapsed instruction history, and a smaller pet mood picker.
- Remove the static tool catalogue and duplicate credential list. Keep all six
  settings groups, native secret fields, and the mobile controls.
