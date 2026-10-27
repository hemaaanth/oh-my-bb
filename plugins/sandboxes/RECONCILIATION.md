# Sandboxes 2C source reconciliation

This ledger records package-only reconciliation. Exact selected-source and branch receipts remain private with the integration owner. Existing selected fixes are the baseline, not new 2C work. No source reset or whole-repository merge.

## Main delta 0565352b30193ad652f2b5d536c9f29add5ed58f

| File | Decision | Preserved behavior |
| --- | --- | --- |
| docker/install-agent-clis.sh | Port only retired PostHog/Vercel/Railway/Linear/Slack/Notion/Grain installs | HubSpot, Goldsky, ClickHouse, prefix and mise paths |
| docker/smoke-test.sh | Port matching retired executable checks | All remaining runtime checks |
| scripts/publish-freestyle-snapshot.ts (retired) | Historically ported only the retired executable list; later removed by approved standalone-helper retirement | The unused publisher had an absent bootstrap helper and obsolete SDK path. No snapshot invocation. Native Freestyle runtime, snapshot selection, settings and data are unchanged. |
| src/image-catalog.ts | Reconcile retired labels | Remaining image tools and build context |

## Selected baseline preservation

| Files | Disposition |
| --- | --- |
| package.json, package-lock.json | Keep selected Freestyle 0.2.20 and own dependency lock. |
| src/provider/backends/freestyle.ts, test/freestyle-backend.test.ts | Keep v5 SDK, key refresh, grow-only MiB resize, persistent retention and pagination fixes. |
| src/runtime-environment-contract.ts, src/runtime-environment.ts, test/runtime-environment.test.ts | Keep execution-host HOME behavior. |
| src/browser-integration.ts, src/host.ts, src/network-host.ts, src/ssh-contract.ts, test/browser-integration.test.ts, test/ssh-host.test.ts | Keep Browser/network/native-host repairs. No live network or cookie mutation. |
| src/provider/register.ts, test/register.test.ts | Keep native preparation; add truthful cleanup separately. |
| src/server.ts, test/server.test.ts | Keep native lifecycle and provider configuration; add explicit optional integration gates separately. |
| app.tsx, test/app.test.tsx | Keep native controls and functional menus; settings changes are separately reviewable. Header replacement waits for 4M/3C. |
| README.md | Preserve operational limits; update changed contracts only. |
| dist/app.js, dist/host.js, dist/host.meta.json, dist/server.js | Baseline artifacts retained until final package build. Generate tracked dist last. |
| src/store.ts | Existing SQL slots and hashes unchanged. Provider IDs and native ownership unchanged. |
| All other package files | Keep selected baseline unless explicitly listed in a later 2C commit. |

## Migration boundaries

No live state read or mutation. No credential diagnosis, rotation, provider call, machine lifecycle operation, cloud image build, dispatch, register, heal, publication, reload or source switch. Native BB retains machine lifecycle authority. Existing legacy selections remain recorded until their owner completes 3C.

The baseline archive was a cross-package symlink to `../../browser/dist/runtime.tar`, not an independent asset. The previously observed resolved archive (0.2.1, SHA-256 b57e1e59c58325026b396d450877a1fde43e8283f4abcec49c00cd1c08c6d50c) had no accepted provenance. It was not used.

2C replaces that link with a deterministic local runtime archive from exact accepted public Browser commit `29ef6aa242b8d669b7f149a5da76610cacec4883`, package tree `e30a3130e1b50b047086bf318b643aa35e6be3f2`, version 0.3.0. All 90 exported source files matched the integration lead's manifest before packing. No Browser source change or live build. The package-local provenance receipt binds 25 runtime inputs and the independent archive hash. Version equality alone is insufficient.
