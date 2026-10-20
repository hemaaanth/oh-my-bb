Drive BB by voice. Talk to a named agent in the app or over a phone call, and it reads, starts, and steers your threads.

## What you get

Tap the pet in the sidebar footer, or press Mod+Shift+H, and say what you
want. The agent, Juno by default, answers in one or two short sentences and
acts first. It can:

- Tell you what is running, and read what a thread did last.
- Start a thread, send it a message, change its model, rename, stop, or
  archive it. It asks before it stops or archives one.
- Bring a thread or its diff on screen.
- Run commands from the plugins you allow.

While a call is live, it also tells you when a thread finishes or fails. The
pet shows what the agent is doing: listening, talking, reading, or working.

The Dispatch console lists every call with its transcript, the tools it ran,
and the voice minutes it used.

The agent remembers past calls. After each call, your reasoning model writes a
short summary with your OpenAI key. The agent sees your last few calls and your
local time, and can look up older ones. Summaries and transcripts stay in
Dispatch's database for 90 days by default. You can turn memory off, keep it
longer or shorter, or forget one call. Other plugins may read call summaries
through the read-only `read.calls` RPC. `bb dispatch` checks setup, stops or mutes the
call, and reports usage.

## Two modes

In-app voice needs only an OpenAI API key with GPT-Live access. Audio goes
straight from your browser to OpenAI.

Phone calls need a Twilio account and number, your phone number, an OpenAI
project id for SIP, and the Webhooks plugin to hear when a call arrives. You
get the same agent and the same tools, with no screen.

BB shows "Needs configuration" only when the OpenAI key is missing. After you
add it, Dispatch reloads itself.

## Cost

Voice time is estimated at $0.05 per minute. The reasoning model's tokens,
including call summaries, are billed by OpenAI on top and are not counted. Phone calls also use Twilio
minutes.

## Standalone by default

In-app voice needs no other BB plugin. Phone calls work only when the Webhooks
plugin is installed separately. Dispatch never installs or enables it.
