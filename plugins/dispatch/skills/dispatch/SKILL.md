---
name: dispatch
description: "Check and control Dispatch, the BB voice agent, with `bb dispatch`: see what is set up, list live threads, stop or mute the live call, call the owner's phone, and report voice minutes. Use when the user asks about a Dispatch call, its setup, or its cost."
---

# Dispatch

Placeholder from the scaffold. The final text is written once the commands
work (PLAN P5).

Commands: `bb dispatch status`, `live`, `read <thread-id>`, `usage`, `stop`,
`mute`, `unmute`, `call`, and `import --from handsfree`. Most take `--json`.

Setup values are secret. Never print them or ask the user to paste them into a
thread. Point the user to Dispatch settings or
`bb plugin config dispatch set <field> <value>` instead.
