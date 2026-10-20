# Import from Handsfree

Dispatch replaces the earlier BB voice plugin, Handsfree. The import copies
your Handsfree settings, setup values, and call history into Dispatch. It
never changes or deletes anything that belongs to Handsfree.

## Two rules

- **It is a dry run unless you pass `--apply`.** A dry run reports what would
  be copied and writes nothing.
- **It runs once.** An applied import writes a marker. After that, every run
  is refused, dry runs too. There is no `--force`.

## Run it

1. Look first:

   ```sh
   bb dispatch import --from handsfree
   ```

   This is the dry run. `--dry-run` does the same thing. The report ends with
   "Run again with --apply to write these changes."

2. Write it:

   ```sh
   bb dispatch import --from handsfree --apply
   ```

   The report starts with "Import done."

Options:

| Option | What it does |
| --- | --- |
| `--from handsfree` | Required. Handsfree is the only source. |
| `--dry-run` | Report only. This is already the default. |
| `--apply` | Write the changes. Cannot be used with `--dry-run`. |
| `--include-legacy-usage` | Also copy Handsfree's old token usage rows. They are skipped by default. |
| `--json` | Print the report as JSON. |

## What it reads

All reads are read-only. The databases are opened in read-only mode.

- Handsfree's `config` row in BB's own database, `<data dir>/bb.db`.
- Handsfree's secret files in `<data dir>/plugins/handsfree/secrets/`.
- Handsfree's history database, `<data dir>/plugins/handsfree/data.db`.

A missing part is skipped. A missing history database is noted in the report.

## What it copies

**Preferences.** Name, voice, voice model, reasoning model, announcements,
mobile drawer behaviour, which plugins the agent may run, the two shortcuts,
and the pet's look. A value Dispatch cannot use is set to its default, and the
report lists it under "reset to default". Handsfree's credential preference is
dropped, because Dispatch uses only an API key.

**Setup values.** Each Handsfree secret file goes into the matching Dispatch
setting:

| Handsfree file | Dispatch setting |
| --- | --- |
| `openaiApiKey` | In-app voice — OpenAI API key |
| `twilioAccountSid` | Phone calls — Twilio Account SID |
| `twilioAuthToken` | Phone calls — Twilio Auth Token |
| `twilioFromNumber` | Phone calls — Twilio caller number |
| `destinationNumber` | Phone calls — your phone number |
| `openaiSipProjectId` | Phone calls — OpenAI project id for SIP |

The report says only **copied**, **absent**, or **invalid** for each one. It
never shows a value. An invalid value fails the setting's format check and is
left unset.

**Instructions.** Handsfree saved whole prompts. They do not fit Dispatch,
which keeps its built-in prompt and adds yours after it. If Handsfree had
prompt versions, the import adds one short revision instead, by author
`import`: "Do not fill the silence before acting. Act first, then report what
happened." Edit or remove it in **Agent**.

**Calls.** Each Handsfree session becomes one call in the Dispatch console,
with its device, start and end time, billed seconds, and trace events. A
session from a SIP device becomes a phone call.

**Legacy token usage.** Handsfree counted tokens, not minutes. Those rows are
skipped unless you pass `--include-legacy-usage`. When copied, each row is
kept whole. The usage view notes how many there are and does not price them.

## Run it again

The marker is a Dispatch storage key, `import.handsfree`. A refused run names
it and the date of the first import. To import again, delete that key from
Dispatch's plugin storage by hand. Calls that are already there are not added
twice.

## If it fails

- BB can refuse to save the setup values. Then the import stops before the
  marker is written. Preferences and calls may already be copied. Fix the
  values, or set them in Dispatch settings, and run `--apply` again. Calls and
  the imported instructions are not added twice.
- Any other failure prints one line and exits non-zero.
