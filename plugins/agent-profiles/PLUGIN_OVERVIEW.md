# Package overview

Agents is the stable `agent-profiles` plugin. It stores reusable full/thin identities and exposes profile, DM, channel, delegation, schedule and document operations. It does not turn a profile into a project membership or capability grant.

## Runtime and caller map

| Surface | Owned source | Runtime boundary |
| --- | --- | --- |
| Profile discovery, edits, defaults and retained role compatibility | `server/profiles.ts` | Public BB SDK; Projects only for explicit historical availability reads; private callback only for a retained mapped role |
| Managed model catalog and environment | `server/providers.ts` | Public provider SDK; stable `agents` provider and `agent/<UUID>` IDs |
| Host and Pi bridge | `provider/host.ts`, `provider/bridge/` | Pi executable, public provider bridge, required configured Model Gateway, existing awaited setup contribution |
| Shared DM memory | `server/agent-memory.ts`, `provider/` | Signed HTTP and public typed host RPC; selected profile only; fail-closed copy-back/recovery |
| Channel decision service | `server/channels/jev.ts` | Optional explicit Jev key and content-bearing HTTPS requests |
| Channel automations | `server/channels/channel-automations.ts` | Optional Automations RPC; operation fails clearly if unavailable |
| Artifact references | `server/channels/rpc.ts` | Optional Pages `getPage` RPC for an existing reference |
| Sidebar status | `server.ts`, `server/profiles.ts` | Best-effort Status Sidebar snapshots; no required sibling registration |
| Profile/channel UI | `app/`, `app.tsx`, `styles.css` | Public SDK UI and BB-provided frontend runtime; native project selector is a launch default only |
| Emoji search | `server/emoji-data.ts`, `app/shared/emoji-data.ts` | Locked local dataset, versioned same-BB route, local search and system glyphs |

There are no cross-package implementation imports. Integrations use public SDK/native contracts or fixed plugin RPC IDs. Gateway is a required managed-turn runtime dependency, not an optional fallback. Projects, Catalog/Executor, Credentials and any private plugin are not imported as frameworks. This checkpoint introduces no new preparation path or startup Gateway/private-plugin probe.

## Package contents

The prebuilt runtime pack includes:

- Server, app and host JavaScript, app CSS, public metadata and sanitized source maps under `dist/`.
- The embedded retained Hempi source and Node-only profile-lock closure inside the host artifact.
- `assets/robot.svg` and every declared emoji branding SVG under `assets/emoji/`.
- The `agents` skill under `skills/`.
- Owner license, third-party notices, provider/vendor grants and base/local-patch provenance.
- README, setup, privacy, runtime/retirement contracts and changelog.

It excludes raw implementation/test trees, fixtures, proof bundles, lock/install directories and developer scripts. The reviewed source Git snapshot retains the source, tests, generator, lockfile and local build script needed for an independent source build. The source snapshot is not the private retained Git history.

Own runtime libraries are Hugeicons free icon data/react adapter, Radix Slot, the emoji dataset and Zod. The native frontend runtime supplies the documented React/BB UI shims. Build/test tools, including TypeScript, the SDK pin and SQLite test fixtures, remain development dependencies. Exact locked versions and the received license texts are recorded in [third-party provenance](THIRD_PARTY.md).

## Configuration and data boundaries

Profiles store route/default IDs and user text, not Gateway or Jev credentials. Existing secret settings and provider environment contributions stay with their owning native/plugin contracts. Selecting a saved profile does not widen native project access, toolkit/application consent or installed tool permissions.

Read [setup](SETUP.md) before execution and [privacy](PRIVACY.md) before configuring remote services. Keep DM/home/memory/default identities during upgrades. Preserve every installed SQL migration and retained row. An applied C1 authority generation needs retained recovery, not a portable-release reset.

## Acceptance boundary

The owner authorizes MIT publication of owned Agents/Hempi code, with separate upstream/helper notices retained. Offline registered handlers, fake Pi bridge/consumer tests and component visual proof do not certify paid model quality, every installed extension, native full-shell integration or future preparation consumers. Publish the reviewed current-tree snapshot, not private retained history. Live source changes remain a separate approved action.
