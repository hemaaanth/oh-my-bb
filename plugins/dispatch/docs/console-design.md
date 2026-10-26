# Console design findings: 2026-10-19

## References

Inspected the running BB 0.46.1 bundles for Automations run history and Thread
list, the Journal time sheet source, and Pages' library source.

- Automations uses compact rows, small status glyphs, quiet separators, and a
  bounded detail width. Status is not a row of decorative chips.
- Journal uses real table headers, fixed numeric columns, tabular figures, and
  subtle row rules. Related values stay together instead of splitting to the edges.
- Thread list keeps active status small and next to the navigation target.
- Pages puts filters next to the collection and keeps empty and error states local.

## Dispatch changes

Use a bounded console with an agent/status header and grouped call actions.
Put Today, Last 7 days, and the report-period voice usage above call history.
Keep daily usage and pricing in a disclosure, not a second always-open table.

Call history uses a table: when, device, duration, estimated cost, and status.
On narrow screens, time and status sit below the device label; duration and cost
stay aligned. Keep the existing filters, pagination, and transcript navigation.
Remove redundant app/phone chips and per-row billed-minute text. Use a quiet
status for calls that did not close cleanly.

A call row shows its summary title, or "Not remembered" for a forgotten call.
The transcript view shows the summary title and text above the transcript, or a
quiet note when there is none. **Forget this call** asks for confirmation
(**Delete transcript and summary**), then deletes both.

Phone dial success has no toast and never renders the provider's success detail.
A shared client-side pending state drives the console and the existing sidebar
accessory. Live status and lifecycle trace events reconcile it with the server.
The footer pet uses the same phone status even when the console is closed:
waiting uses its existing waiting mood; a live phone call uses its awake mood.
Its label names the status and elapsed time. The host treats icon contents as
decorative, so an invisible app overlay also exposes phase changes as an accessible
status announcement. That overlay owns SDK reads and publishes an ordinary store
for the icon; SDK hooks cannot run directly inside a host icon. Footer tap behavior
is unchanged. Do not claim a call is live before the server confirms it. A bounded
waiting state handles missing or failed incoming sessions. Keep setup/error feedback,
with phone numbers masked and Twilio call references removed from displayed text.

Keep SDK 0.6.49 and `experimental_sidebarAccessory`. Do not change telephony,
server RPCs, or storage. Phone controls omit the in-app microphone mute action,
which has no phone transport implementation.

## Verification

The package check covers typecheck, all tests, and build. Live browser checks cover
dark and light themes at desktop and 390 px, filters, usage disclosure, transcript
navigation, and phone waiting/live/ended states. Phone-state screenshots use
intercepted RPC responses in a dedicated browser tab; no real call is placed.
The existing sidebar accessory registration is kept, but the desktop's icon-only
nav does not mount it. The footer pet provides the visible status there.
