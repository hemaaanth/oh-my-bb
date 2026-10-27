# Projects

Organize native BB projects into groups. Edit project icons, order and routing profiles. These native controls work without Catalog, Credentials, Agents or Status Sidebar, including before assignment import.

## Settings

Configuration holds the OpenRouter and Jev API keys. Preferences autosave the model used to generate project descriptions and the workspace-service preference.

**Groups** comes before **Projects**. Colour buttons open the shared freeform hex picker. Existing named colours remain valid. Project rows show repository, group, configured-machine count and description source. The list initially shows eight projects; search or expand it to find the rest. Edit a project in its settings dialog. Environment metadata and its masked token control share one form. Suggestions use tag pills and preserve drafts across tabs. More contains only the standard setup guide.

There is no integration switchboard. Projects does not manage agent availability or read Tasks. Existing agent-membership rows are inert history; obsolete mutation calls fail with `membership-retired` instead of silently doing work. Projects works without Executor. The optional Skills tab loads skill sets from Executor on demand and reports an unavailable plugin without clearing saved assignments. After a skill edit Projects sends only a project ID (or null for a global change) as a refresh hint to installed Executor. Executor rereads assignments; no token, repository content or routing text is sent. Installed Status Sidebar receives automatic group-refresh hints; its choice of group source remains controlled by Sidebar.

### What project suggestions do

When you type a new-thread prompt, the composer can suggest a project by matching your prompt to saved project descriptions through Jev. Exact repository references can match locally. This does not assign tasks or run agents.

In a project's **Suggestions** tab, **Generate description** explicitly asks the selected OpenRouter model to write a description and tags from that repository's README, package metadata, name and remote URL. It may cost money and replaces that project's description and tags. No task titles are fetched. Editing settings or opening a tab never generates a description. You can write and save the description yourself.

## Assignment readiness

Existing marked `suite-v1` assignment state retains its read/write semantics. Without that marker, assignment APIs fail with `not-migrated`; they never return a successful empty projection. Native groups, project details and routing remain available.

For an existing installation, request **Import legacy assignments**. This explicitly reads Status Sidebar groups/order, Credentials bindings, Catalog assignments. Those three sources must be available. The importer saves a local transaction and a durable receipt before requesting Sidebar remapping. If remapping fails or Projects reloads, retry resumes that receipt. It does not recreate groups or agent profiles. Readiness is recorded only after completion. Nulls, unresolved selections and conflicting legacy records are preserved.

The existing `importLegacy` payload API stages its supplied data and preserves its result shape. It cannot certify omitted assignment kinds as empty. It does not mark readiness. Complete the explicit all-source import afterward. Missing source collections fail instead of becoming empty arrays. Existing native group membership, order, default and non-null credential selections win import conflicts; original legacy input remains in receipts/provenance.

Only a verified no-legacy installation should use **Initialize without legacy assignments**. Missing sources or unknown state are not evidence of an empty installation. The action requires an explicit no-legacy attestation and refuses existing local assignments or a pending import. It never clears another source's state.

Both explicit setup paths check native installed-plugin presence and installed destinations' authoritative `assignmentStatus` before writing readiness/import state. True absence permits standalone setup. An installed destination must be enabled, running and genuinely uninitialized. Active, staged, frozen, old, offline or unknown state blocks without changing assignments. Missing native metadata is not absence, and empty legacy exports are not authority proof.

Destination-first adoption is unsupported in this transitional version. Projects will not create a competing writer beside an existing destination owner. Native project organization remains useful. Run setup actions serially across plugins; simultaneous cross-plugin initialization is unsupported, not distributed-atomic. Completed setup retries remain local no-ops after a transfer.

A legacy consumer must stop on a readiness error. A consumer that catches the error and projects empty skills or null credentials is unsafe to activate until its owner fixes that reader. Projects does not silently accommodate such consumers.

## Assignment handoff

Projects remains the assignment writer until an explicit frozen export and destination receipt have completed. Installing or upgrading another plugin does not transfer authority. Each kind freezes separately:

- `bundles` → Catalog (`catalog`).
- `applicationBindings` → Credentials (`project-environments`).
- `agentPreferences` → Agents (`agent-profiles`).

Exports are bounded, local and identifier-only. Frozen writes stay blocked across crashes and unavailable destinations. Matching generation, digest, kind, destination and version are required. After activation, compatibility setters forward once to the owner. Destination callbacks fail closed instead of recursing. An unavailable owner never revives the old writer.

Before ownership commit, an owner client may abort the exact frozen/staged transfer and resume local writes. Projects durably records its abandoned identity and staged receipt before sending a best-effort discard notice. A late receipt cannot reactivate it. After commit, abort is forbidden; use reverse reconciliation.

The exact destination release is pinned through staging and first activation. Durable activation requires the destination's own committed activation receipt. After that, a compatible release may use the original historical identity only if it supports the schema, adapter and persisted assignment/provenance format. Unsupported formats fail closed even on downgrade. If an upgrade occurs after source commit but before local activation, a compatible release may only reverse-export the preserved stage through the exact source reverse-frozen recovery path; it must not infer activation from source state.

Rollback requires a frozen reverse export containing all destination edits before source authority resumes. Do not downgrade a destination or restore an old database to bypass this barrier.

After a completed reverse, another forward handoff is unsupported. Projects keeps the original transfer identity and reverse generation for destination read/write-through, and rejects a new freeze before changing rows or receipts. Ordinary source writes and destination delegation remain available. Do not clear the reverse marker or use freeze/abort to reset it.

[ASSIGNMENT_HANDOFF.md](./ASSIGNMENT_HANDOFF.md) defines exact C1 wire schemas, digest rules, destination adapter obligations, mixed-version gates and expected data differences. Destination adapters must be implemented and verified in their own packages before any real transfer. No transfer or source deployment occurs as part of installing this implementation.

## Routing profiles

Projects stores a description, keywords, aliases, repositories, a “Not for” list and learned guidance for each project. Manual fields remain editable without auth keys or assignment readiness. Existing generated and manual profiles are preserved until an explicit edit or generation action.

The saved profile model and server-only OpenRouter key control explicit profile generation. Startup, reload, periodic time, project notifications, key/model changes and routing trace collection do not generate profiles or learned guidance. Use the existing generation actions or commands below to refresh profiles; use `learn` to update learned guidance. Legacy import and assignment export do not trigger generation. Task-source evidence is read only when its optional integration is enabled.

“Refresh stale generated profiles” and `backfill` create missing profiles and replace stale generated profiles, including their descriptions and routing terms. Manual profiles stay unchanged. These actions use the saved model and may incur cost; they do not restore earlier values.

The generation RPCs accept SDK client callers only. Plugin-origin requests are rejected before project/evidence reads or model calls; no plugin initiating contract is approved. SDK client access includes UI, CLI and agents, not proof of human approval. Learning remains an explicit CLI action.

Jev suggestions remain in the native new-thread composer. Exact repository references can route without Jev; other suggestions require its configured key. Fork drafts retain their native project. The native project picker, agent avatars, menus and footer remain host-owned.

Routing history and learned guidance remain in Projects. No routing settings, history, model data or secrets enter assignment exports. Commands remain:

```sh
bb projects routing status
bb projects routing backfill
bb projects routing regenerate --project <id>
bb projects routing history
bb projects routing learn
```

## Development and distribution

Run from this package, not the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The package uses the public BB Plugin SDK and packaged UI components. It has no sibling runtime imports or mandatory suite install. The settings layout is bounded to 760px with 16px sides; native menus and composer placement stay native. SQL migrations are append-only.

The package is MIT-licensed under [LICENSE](./LICENSE). [THIRD_PARTY.md](./THIRD_PARTY.md) records the configured BB UI origin, actual dependency metadata and retained license notices without asserting unverified icon provenance.

Isolated SDK fixtures and browser component harnesses prove local handlers, state transitions and UI behavior. They do not certify provider lifecycle, paid model behavior, real secret access, native host overlay arbitration or live plugin activation. Those require separate owner-controlled acceptance.

## Application environments

Projects now owns the former Credentials implementation. Open **Settings → Projects → Projects**, then edit a project and select **Environment**. Each project has its own environment configuration. Existing shared configurations are retained with an explicit shared-edit warning.

Metadata saves preserve fields they do not edit, reject stale project/profile selections, and run no setup. Tokens stay in private installation storage. Agent instructions, `query_clickhouse`, existing workspace opt-outs and the on-host `bb-project-env-run` wrapper are retained. Remote Executor credentials are separate.

The `project-environments` package is a stateless compatibility adapter for existing RPC callers and `bb project-env`. Keep it installed until those callers move. It forwards execution to Projects; no second database or job queue is opened. The transport cannot promise cancellation of a remote preparation after a lost CLI/RPC connection. Never replay an unknown preparation.

Private setup recipes are not bundled. The former machine and workspace recipes are project-owned `.bb/setup/machine.sh` and `.bb/setup/workspace.sh`. Their existing preparation order and credential wrapper are retained. Copying a recipe does not execute it or change a project's existing `bb.json`/`paseo.json`.

See [the merge runbook](../../docs/migrations/project-environments.md) before upgrading an existing installation. Do not simply enable the merged runtime against an unmigrated Credentials database.

## Project commands and services

Scripts is merged into Projects. The old workspace-scripts plugin is uninstalled after its KV and effective autostart preference are copied. Projects owns the native Scripts action, environment-scoped service records and existing approved pre-prompt setup. The CLI is `bb projects scripts …`; routing uses `bb projects routing …`. Application commands stay in each project's bb.json or paseo.json, and setup source stays in project-owned .sh files. See [migration](../../docs/migrations/scripts.md).

All management is in settings: Preferences saves automatically; Projects has one row per native project with an editor; Groups has swatch/name/delete rows; More contains only the standard setup-guide row. No Projects navPanel or Add project button is registered. The native BB surface owns creating projects. Existing shared environments and explicit save/confirmation guards remain intact.
