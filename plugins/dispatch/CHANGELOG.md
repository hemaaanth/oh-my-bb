# Changelog

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
