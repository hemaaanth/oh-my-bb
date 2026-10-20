# Dispatch phone calls

Status: works with the documented Twilio setup. Other carriers are untested.
The full audio path (Twilio into OpenAI over TLS SIP) has not been tried on a
real call from this version. See "What is not verified" at the bottom.

Dispatch can call your own phone. You talk to the agent, and the agent has the
same tools as the in-app voice agent: focus threads, get context, run plugin
commands, start and stop threads, show diffs. The tools run on your machine
against the BB SDK, exactly as they do in the app.

## What you need

- Dispatch and the Webhooks plugin, both installed and enabled.
- An OpenAI API key in a project with GPT-Live access, and that project's id.
- A Twilio account with a voice-capable number.
- A public HTTPS route to the Webhooks plugin, so OpenAI can reach it.

Install both plugins from the `oh-my-bb` marketplace:

```sh
bb marketplace add git:github.com/hemaaanth/oh-my-bb@main
bb plugin install dispatch@oh-my-bb
bb plugin install webhooks@oh-my-bb
```

The setup steps are in [Setup](#setup) below.

## Why Twilio

OpenAI lists LiveKit, Twilio, Telnyx and Daily/Pipecat as partners for live
voice. Twilio fits a BB plugin best:

- Its SIP path lets OpenAI host the audio. The plugin never touches audio. The
  BB plugin SDK has no raw WebSocket media primitive, so a media relay is not
  possible.
- The outbound call is one authenticated `fetch` with inline TwiML. No SDK
  dependency is needed.
- Pricing is pay-as-you-go. Bridging straight to OpenAI adds no AI-orchestration
  fee.

## One session shape for the app and the phone

The app and the phone use the same GPT-Live session description. Only the
transport differs.

- **App:** `POST /v1/live/sessions` with a WebRTC offer. Audio rides a WebRTC
  track in the BB app.
- **Phone:** Twilio bridges the call into OpenAI over SIP. Dispatch accepts the
  SIP session and attaches a sideband WebSocket for the tool loop.

The phone session differs in two places. There is no BB window, so the tool
context has no thread and no project, and the agent asks which one you mean.
`get_context` on the phone returns a note that you are on a call with no
screen, plus the list of live threads. `focus_thread` and `show_diff` still
open in the BB app window, which helps when you are at a desk.

## Flow

```
 palette "Dispatch: call my phone" / pet menu / `bb dispatch call`
        │  rpc phoneDial
        ▼
 placeCall ── publishes a stop for any app call, then:
        │  POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Calls.json
        │    To=<your phone>  From=<Twilio number>
        │    Twiml=<Dial answerOnBridge="true"><Sip>sip:proj_x@sip.api.openai.com;transport=tls;secure=true</Sip>
        ▼
 Twilio rings your phone ── you answer ──► Twilio bridges the call to OpenAI
        ▼
 OpenAI webhook: live.transport.incoming (signed, Standard Webhooks)
        ▼
 Webhooks plugin endpoint (checks the signature, drops repeats)
        │  plugin action ──► dispatch.webhooks_receive { fields: { type, session_id } }
        ▼
 receiveCall ── POST /v1/live/sessions/{session_id}/accept
        ▼
 runSideband ── wss://api.openai.com/v1/live/sessions/{session_id}/attach
        │  function_call ──► tool runs ──► response.item.create ──► response.create
        ▼
 you talk to the agent, and the tools run on your machine
```

## The API calls

1. **Place the call.** `POST /Accounts/{AccountSid}/Calls.json` with
   `Authorization: Basic base64(SID:AuthToken)` and a form body of `To`, `From`
   and `Twiml`. The TwiML is
   `<Response><Dial answerOnBridge="true"><Sip>sip:{proj}@sip.api.openai.com;transport=tls;secure=true</Sip></Dial></Response>`.
   OpenAI takes SIP over TLS only. Without `;transport=tls` you hear silence.
   GPT-Live also needs SRTP media, which `;secure=true` turns on. Without it,
   accept fails with `srtp_required` and the call hangs up when you answer.
   `answerOnBridge` keeps the line ringing until OpenAI picks up.
   If Twilio answers with a non-2xx status, Dispatch shows `Twilio <status>:`
   and the first 300 characters of the body.

2. **Incoming-call webhook.** OpenAI sends `live.transport.incoming` to a
   Webhooks plugin endpoint. The endpoint checks the signature with OpenAI's
   `whsec_…` secret, drops repeats by `webhook-id`, keeps the two declared
   fields, and calls `webhooks_receive` on Dispatch. Dispatch ignores any other
   event type. It warns if the caller is not the Webhooks plugin. A repeated
   delivery for a session that is already open is answered once.

3. **Accept.** `POST /v1/live/sessions/{session_id}/accept` with
   `Authorization: Bearer {OpenAI API key}`. The body is
   `{ "session": { "type": "live", "model", "instructions", "audio": { "output": { "voice" } }, "delegation": … } }`.
   The `session` wrapper is required. SIP negotiates the audio, so there is no
   `transport` and no audio format. If the accept fails, the call row records
   `call.failed` with `OpenAI <status>:` and the first 300 characters of the
   body.

4. **Sideband.** `wss://api.openai.com/v1/live/sessions/{session_id}/attach`,
   opened with the same Bearer header. Never send `session.start`. The host's
   `WebSocket` takes a `{ headers }` init, so no extra dependency is needed.
   Events Dispatch handles:
   - `session.usage.updated`: saved as a `usage.seconds` snapshot.
   - `session.closed`: saved as `call.closed` with the reason and final
     seconds. The call ends and the socket closes.
   - `error`: saved as `error`.
   - `response.event` wrapping `response.output_item.done` with a
     `function_call` item: Dispatch runs the tool. Tools run one at a time, in
     order. Every call gets a `function_call_output`. A failed tool sends
     `Error: …`. When no output is pending, Dispatch sends one
     `response.create` so the agent continues.
   - A socket that closes without `session.closed` is saved as `call.stopped`
     with `unclean: true`, and Dispatch logs a warning. The call may still be up
     at OpenAI, but Dispatch can no longer see it.

5. **Hang up.** When you start another call or stop the call,
   Dispatch posts `POST /v1/live/sessions/{session_id}/hangup`, then waits up
   to five seconds for `session.closed` and closes the socket itself if it
   never comes.

Only one call runs at a time. Starting a phone call stops an app call, and a
phone call that comes in while another phone call is open is refused. If
Dispatch restarts while a phone call is open, the row is closed as unclean on
load.

## Receiving the webhook

Dispatch has no listener or tunnel of its own. Create a Webhooks endpoint that
hands deliveries to Dispatch. Pipe OpenAI's `whsec_…` signing secret on stdin:

```
bb webhooks create --secret-stdin --config '{
  "name": "OpenAI incoming calls",
  "authMode": "standard-webhooks",
  "dedupe": { "source": "webhook-id" },
  "fields": [
    { "name": "type", "path": "type", "type": "string", "required": true, "allowed": ["live.transport.incoming"] },
    { "name": "session_id", "path": "data.session_id", "type": "string", "required": true }
  ],
  "action": { "type": "plugin", "pluginId": "dispatch" }
}'
```

The `session_id` path is `data.session_id`. OpenAI puts the session id inside
`data` in the webhook body, so a path of `session_id` would never match.

Then register the endpoint's public URL in the OpenAI console, under Webhooks,
for `live.transport.incoming` only. Do not also subscribe
`realtime.call.incoming`: only one handler may accept a call.

The Webhooks panel in BB can build the same endpoint. Choose **Hand to a
plugin** and pick Dispatch.

OpenAI must reach the endpoint over public HTTPS. The Webhooks plugin owns
that route. The simplest way is its **Listener port** setting with a tunnel
pointed at it, plus its **Public base URL** setting. The Webhooks package
explains both in `docs/ingress.md`. `bb webhooks show <id>` prints the
endpoint's public URL.

## Call records and cost

Each answered call is a row in the call list with the Phone device. The ledger
holds `call.started`, each `tool.call` and `tool.result`, every `usage.seconds`
snapshot, and `call.closed` or `call.stopped`. The last usage snapshot becomes
the billed seconds. `bb dispatch usage` counts app and phone calls together.
The backend model's tokens are billed on top and are not visible to the plugin.

## Setup

These are the labels in Dispatch settings. All six are secret fields.

| Label | What to put in it |
| --- | --- |
| In-app voice — OpenAI API key | Your OpenAI key. Phone calls use it for accept, hangup and the sideband. |
| Phone calls — Twilio Account SID | `AC…` |
| Phone calls — Twilio Auth Token | The Twilio auth token. |
| Phone calls — Twilio caller number | A voice-capable Twilio number, in E.164. |
| Phone calls — your phone number | The number Dispatch should call, in E.164. |
| Phone calls — OpenAI project id for SIP | `proj_…` |

The webhook signing secret lives in the Webhooks endpoint, not in Dispatch.

Set each value on Dispatch's page in BB's plugin settings, or from a shell:

```sh
bb plugin config dispatch set twilioSid AC0123…
```

The ids are `openaiKey`, `twilioSid`, `twilioToken`, `twilioCallerNumber`,
`yourPhoneNumber`, and `openaiSipProject`. Phone numbers use E.164, like
`+14155550100`. Save an empty value to clear one. No value is ever shown
again after it is saved.

Checklist:

1. Buy a voice-capable Twilio number. Note the SID and Auth Token.
2. Make sure Dispatch and the Webhooks plugin are installed and enabled.
3. In the OpenAI console, note the project id and enable GPT-Live SIP for the
   project. Add a webhook for `live.transport.incoming` and copy its `whsec_…`
   signing secret.
4. Create the Webhooks endpoint above with that secret. Set up its public
   route, and get the URL with `bb webhooks show <id>`.
5. Put that URL into the OpenAI webhook.
6. Fill the six settings.
7. Run `bb dispatch status`. The Phone line must say it is ready. If it lists
   missing labels, fix those first. A missing `webhook route` means the
   Webhooks plugin is absent or disabled.
8. Place the call from the command palette ("Dispatch: call my phone"), the pet
   menu, or `bb dispatch call`.

`bb dispatch call` exits with code 1 and lists the missing labels when setup is
incomplete. It makes no network call in that case.

## What is not verified

SIP audio from Twilio into OpenAI (TLS SIP, SRTP negotiation) was not tried on
a real call for this version. The feature is documented as working with the
Twilio setup above. Other carriers are untested.

Open questions to check on the first real call:

- GPT-Live requires SRTP (checked 2026-10-19: `srtp_required` without
  `;secure=true`). Twilio offers one suite, `AES_CM_128_HMAC_SHA1_80`. If
  GPT-Live rejects it, the fallback is GPT-Live outbound SIP through a Twilio
  Elastic SIP Trunk, which drops the webhook but needs org-level outbound SIP.
- The `hangup` endpoint behaviour, and whether closing the sideband alone also
  ends the call.
- Some reports show an intermittent `404 session_id_not_found` on accept. The
  call row records it as `call.failed` with the status and body.

Later hardening: Twilio status callbacks, answering-machine detection, and
consent rules for outbound calling.
