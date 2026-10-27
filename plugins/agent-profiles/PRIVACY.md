# Privacy and data flow

## Local records

Agents stores profile UUIDs, names, avatars, persona/instructions, revisions, model choices, saved project/machine defaults, DM bindings, channel history, work state and schedule state in BB's plugin storage. Full-agent mission/persona history and task/channel reports can contain user content. Native BB threads retain their own messages, attachments, execution state and session references.

The editor also retains unsent profile/document drafts on the viewing device. Channel composer drafts and recent emoji choices use browser local storage. These can contain unsent text, attachment references or persona content. They are not encrypted by this plugin. Clearing a browser cache does not delete server records or host memory.

Legacy project/sandbox membership rows remain historical data. They are not capability grants. An explicit legacy availability read can fetch actual retained Projects metadata. An unavailable or malformed source fails; it is not reported as empty history. Normal portable profile discovery, launch and the profile editor do not need this history.

## Execution hosts and memory

Managed turns send the requested task, applicable persona/instructions and selected conversation/memory context to Pi on the execution host. Pi runs agent turns with full permission. Installed tools and extensions can read files, execute commands and use the network within their actual host access. Selecting a profile does not bypass native project access or independent toolkit/application consent. The bridge is not a sandbox for arbitrary installed Pi extensions or their own SDK children.

Host `dataDir` contains generated instructions, embedded source, import markers, memory transfer journals and recovery receipts. Temporary bridge files use `tempDir`. Native sessions use the configured bridge session directory, normally `~/.bb/pi-bridge-sessions`. The selected OptChat profile lives under the owning host's `OPTCHAT_HOME`, normally `~/.optchat`.

Only an agent's DM binds its frozen shared memory key. Remote DM turns copy that selected profile to a private operation home on the execution host. The profile can include hidden files, binary files, logs, metadata and Git checkpoints. The transfer deliberately excludes other profiles, `last-profile`, Pi authentication and recovery guard files. This exclusion is not a promise that a full-permission tool cannot read other accessible files.

HMAC capabilities, bounded chunks and file/manifest hashes authenticate and verify the transfer. They do not encrypt profile files at rest. Protect host directories and backups. Failed copy-back can leave the only new memory in a retained remote directory. Recovery journals/receipts can contain host IDs, paths and operation identities. Do not delete them to force a new turn. Restore connectivity and use the recovery flow.

## Required Model Gateway route

Every managed model turn requires the BB-supplied Gateway URL/token and the execution host's Gateway Pi extension. This includes full profiles, thin profiles and the memory helper model routes. Native Pi login files are not a fallback.

The configured Gateway and its upstream provider receive the actual model request. It can include task text, persona, selected memory, tool results and delegated work. Their retention, account pooling, API approvals and remote service policies belong to that configured Gateway/provider. Agents does not make those requests anonymous or promise zero retention. Do not put secrets in instructions or memory unless the intended route may receive them.

The profile stores route identifiers, not an API credential. Gateway runtime credentials are separate environment contributions. Agent-memory control capabilities are stripped before Pi/helper launch. Keep setup scripts and tool output free of secret values; their diagnostics can be visible in a thread.

## Optional Jev service

When used, automatic channel selection and delegated-result follow-up decisions send HTTPS POST requests to `https://api.typesafe.ai/v1/systemone`, using model `jev-latest` and the separately configured Jev API key.

Selection sends the channel title, conversation roles/names/text and candidate IDs/names/handles/descriptions. Return decisions send the original requesting agent/name/handle/text, result agent names/handles/status/text and conversation title. These are content-bearing requests, not anonymous counters. They are not routed through Model Gateway. Review the service's terms and data handling before supplying its key.

A missing key fails before a request. Automatic selection errors remain visible. Existing delegated-return logic can still choose a follow-up when its decision service is unavailable; this does not erase the privacy implications of requests that were already sent. Retries for 429/529 and request timeouts keep the existing behavior. Choice logs can contain channel titles, selected handles and probability/confidence values.

## Other integrations

- Status Sidebar receives local best-effort agent snapshots: shown agent IDs, names, avatars, canonical DM IDs and excluded thread IDs. Channel snapshots carry IDs/names, pinned/unread/active flags, member counts and update times, not message bodies. Missing Status Sidebar does not block profile use.
- Automations receives the schedule and prompt/context needed for an explicitly requested channel automation.
- Pages receives an existing page/version reference when Agents resolves published artifacts.
- A retained private PR Review role can send only its spawned `threadId` through the existing best-effort `registerReviewThread` callback. Fresh public profiles do not require or call that private plugin. The receiver's origin check is not human consent to publish anything.
- Clasi, skills, browsers and other installed tools have their own data policies. Agents does not copy their state into this package or grant them new access.

## UI assets and network scope

The package includes its branding SVGs and emoji avatar markup. Glyph rendering uses the viewing system's fonts; no font is redistributed. Emoji search data comes from the locked `emoji-picker-react` dataset through Agents' own versioned BB route. Searching that loaded data happens locally. It does not need an emoji image CDN.

This checkpoint adds no product analytics, telemetry collector or background Gateway probe. Existing scheduled/channel work can create model activity when enabled or requested. BB, installed tools, configured providers and remote services can have their own telemetry and retention policies.

## Removal, export and review

Profile exports can contain instructions, model defaults and referenced skills. Review them before sharing. A profile deletion has existing safety restrictions after channel authorship or a permanent DM reservation. It is not an erase-all operation for promoted native threads, remote backups, external provider requests or browser storage.

Never publish a live database, host data directory, OptChat profile, native session, dotenv/auth file, browser profile, private proof bundle or recovery copy as a package asset. Runtime packs contain code, static assets, skills and notices only. All checkpoint fixtures use synthetic data. Offline fixtures do not certify native shell behavior or real provider retention.
