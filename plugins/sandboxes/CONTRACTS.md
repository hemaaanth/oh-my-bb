# Sandboxes 2C contracts and migration manifest

## Native ownership and cleanup

BB owns machine allocation, durable checkpoints, enrollment, retirement and retries. Native provider IDs are unchanged. A failed provider delete or an unsupported allocation-key lookup returns `failed`, never `removed`. Cancellation stops the local operation without confirming removal. Box, E2B and Nirvana cannot currently prove allocation-key cleanup. Their native pending resource stays retained.

For uncertain cleanup, retain the native resource and provider ID. Review the exact allocation in the provider's supported console or API under separate owner authorization. Verify removal there before reconciling BB's pending cleanup through supported native controls. Do not edit the core database or delete an unrelated machine. There is no package command that safely clears an unidentified orphan. If native controls cannot reconcile an old malformed resource, request native BB support with the retained resource evidence. Legacy checkpoints and BB hosts remain until provider removal succeeds.

## Existing behavior import and optional integrations

`integrations:v1` is Sandboxes-owned KV. Fresh installs have Credentials, Catalog, Agents and Projects call paths off. Owner-client-only `updateIntegrations({name,enabled})` changes exactly one named flag, serialized with imports against the latest stored row. Untouched fields and the import receipt are retained; absent fields are not materialized as explicit false. Old whole-map writes and unknown names are rejected, so stale clients cannot reverse another flag's opt-out. No presence-based auto-enable or startup sibling loop.

`importIntegrations` accepts `{schemaVersion:1, sourceGeneration, sourceSemanticDigest, values:{projectEnvironments,catalog,agents,projects}}`. It is an explicit owner-client-only one-generation import of an inventoried existing installation's effective call paths. This does not claim past consent, approve skills, expand credential scope, or enable a sibling plugin. Existing destination fields, including false, win. The same generation/digest/values is a no-op; a mismatch fails. Values and receipt are committed in one KV write. Back up the original row before import. Unresolved active legacy selections remain with their original owners and scope until 3C.

Legacy attachment assignment writes are blocked during 2C. The machine menu retains a read-only projection of the exact existing credential/tool/skill/agent IDs, including unresolved IDs. No records are deleted or broadened. Use each source owner's project settings for new runs. Native lifecycle, Always on, footer, and header controls remain until their accepted replacements.

Browser retains its own opt-in and verified `prepareSandboxV1` boundary. There is no duplicate Sandboxes Browser flag. Rejection or absence causes no empty-payload identity provisioning. Browser cleanup/release boundaries are unchanged.

Model Gateway is required for this package's managed model runtime. There is no local-login fallback. Native create/resume checks the required running dependency before allocating or waking. Gateway setup must succeed before the provider reports agent-ready. This metadata/setup check is not proof that an account can complete a model request. Standalone source/install/configuration/status work without siblings; managed-model runtime does not.

Resume ordering is required-dependency metadata check → provider resume → native bootstrap/connection → Gateway setup verification → Browser's opted-in provisioning → connected-host preview restoration. A setup failure after connection can leave compute awake; this adapter does not delete the machine, data or checkpoint. Reconcile the native lifecycle state before retrying setup/resume. No automatic sleep is claimed. C5 runs separately on native thread activity; it is not a prompt barrier or a strict next step in this sequence.

## C5 stage observation

`projectPreparationStatus({threadId})` reads a persisted Sandboxes observation for the exact native environment/project/host/workspace. It does not start preparation, wake a host, fetch credentials or call a sibling. Credentials owns the underlying job.

`project-preparation:v1:<target-digest>` KV records `state`, `jobId`, `reason`, `retryable` and optional `sourceVersion:1`. Read-only status exposes cached eligibility, never durable retry authority. Legacy failed/ready caches project unknown; legacy not-ready retains its label with retry disabled. They require explicit same-job reconciliation before versioned eligibility can be displayed. No error-text classification or legacy status fallback.

Credentials owns `preparationOutcomeV1({jobId})`. Sandboxes validates its strict version-1 union and exact job identity. Missing/old/malformed/unsupported methods or responses, RPC loss, unavailable jobs and unconfirmed completion fail closed. `retryProjectPreparation` requires owner-client authority and a cached versioned eligible observation, then re-reads that source immediately before one fresh start. Only fresh `retryable:true` permits replacement. Same-target concurrent retries share one operation; observation in progress blocks a new retry. Cached eligibility is consumed with an unknown checkpoint before start, so lost start responses cannot replay after reload.

`reconcileProjectPreparation` only re-observes the known job ID. Source reload/expiry never implies cancellation or retry permission. Catalog participation always remains unconfirmed under its legacy materialization contract, even when its old result says ready. Safe retry is unavailable then; refresh or another human action cannot manufacture stop proof. Running jobs resume local observation by the same ID. Disposal stops local polling only, not the remote process. This protocol does not provide source-global serialization or a prompt barrier.

While a local observer is polling, owner Refresh performs one bounded read of the same job instead of awaiting the polling lifetime. Concurrent Refresh requests share that read. A changed operation or job checkpoint discards its late result. Refresh never starts or retries preparation; cached eligibility still requires the separate fresh-source retry check.

The existing Credentials wire contract still exposes no binding/profile/token revision and no remote cancellation API. Automatic invalidation waits for that source-owned contract. Proposed dependency (not implemented): a bounded read `workspacePreparationRevisionV1({projectId,hostId,workspacePath}) → {revision,selectionRevision,profileRevision,tokenRevision}` with opaque revision strings and no secret material. Source owner must define atomicity and token-rotation semantics before a consumer uses it. `sourceVersion` identifies the outcome wire only, not a configuration revision.

## H3 image builder

No Git-origin inference. Runtime `BB_SANDBOX_IMAGE_BUILD_REPO` has highest precedence, then an explicit saved preference, then a one-generation imported route. An explicit empty preference disables an imported route. Fresh installs contain no private builder default.

`image-build-repository:v1` KV stores optional `explicit` and an optional import receipt. `saveImageBuildRepository` and `importImageBuildRepository` require the owner client. Import input is `{schemaVersion:1,sourceGeneration,sourceSemanticDigest,repository:"owner/repository"}`. The same input is idempotent; changed input fails. Explicit destination preference wins. One KV write commits route and receipt. `bb sandbox import-image-builder --repository fixture-owner/image-builder --generation fixture-generation --digest <sha256> --yes` is the supported CLI form. It does not dispatch. Only synthetic examples belong in package source.

A configured repository must have active `sandbox-image.yml` and support `browser_source_commit`, `browser_inputs_sha256`, and `browser_archive_sha256` inputs. It must build the reviewed artifact and emit matching OCI labels. Missing/unconfigured builder fails before dispatch. No public workflow is supplied in 2C. The existing private workflow's compatibility remains an integration-lead release gate, not a claimed remote test.

## Browser artifact and image provenance

`docker/browser-runtime.tar` is a regular package-local file. `docker/browser-runtime.provenance.json` records exact source commit/tree, version, deterministic build recipe, per-file modes/hashes, input digest and archive hash. The source-controlled receipt is the reviewed trust root. Do not accept an arbitrary receipt from a runtime caller.

Offline verification: `node docker/verify-browser-runtime.mjs`. This checks the archive hash, exact file set, every input hash, input-manifest digest and package identity. Docker verifies before installation and rejects mismatching build arguments. Runtime context staging rejects sibling symlinks or missing/tampered receipts. Image dispatch forwards the expected source/input/archive digests. Registration requires all three OCI labels on the immutable image digest, not just a Browser version label.

SQL migration history is immutable. 2C appends only `sandbox_image_provenance`. It links image ID to immutable image reference and verified source/input/archive digests. `browser-runtime.compatibility.json` independently lists reviewed artifact identities supported by `sandboxes-v1`; retain compatible historical entries when the current build artifact changes. Known attested history can therefore be selected without matching today's archive. Unknown or incompatible images cannot be newly activated or pinned. Existing records, defaults, hosts and Browser sessions remain retained. Legacy images without receipts need verified immutable-image provenance recovery or an explicit owner decision accepting a temporary selection restriction before cutover. A rebuild is not equivalent to preserved rollback. There is no unknown-provenance bypass. The harness-heal script does not replace Browser runtime archives.

To reproduce the archive, export only `plugins/browser` at the receipt's exact public commit. Verify every source file against the accepted source manifest. Pack `package.json docker browser-extension THIRD-PARTY-NOTICES LICENSE` using GNU tar `--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner`. Review changed inputs before updating the receipt, Docker pins and archive together. Never build from a live Browser root or an old private sibling.

## Settings migration and UI

`preferences:v1` stores nonsecret behavior values, revision and a native-settings import receipt. One-generation import preserves explicit destination false/empty values. The first registration still exposes the old native behavior fields; reload only this plugin once to finish hiding those declarations. The next registration reports `migrationPending:false`. Old native values and static secret identities are not deleted. Saving Preferences is revision-checked and does not run setup; no-op saves do not change the row. Before rolling old code back after preference edits, freeze writes and reverse-export the new values through supported same-plugin settings APIs.

Static provider credentials are declared in native Configuration under their existing secret key identities. The existing provider secret-file and absent-only dotenv readers remain; their files are not deleted, rotated or copied into nonsecret preferences. A newer explicit native value wins. Actual live identity/precedence equality remains an integration-owner cutover check.

Settings use a 760-pixel outer maximum, 16-pixel sides and 728-pixel content maximum. Native static plugin/provider SVG identity, footer and menus are retained rather than replaced. The compact native machine popover/drawer is the deliberate width exception; it is not a second full settings page. Preferences, provider/image controls and Oh My BB are boxed; More is collapsed. Capacity and operational upgrades require explicit actions. Error/loading states and drafts remain visible. No core styles or profile hacks are used.

## Remaining release limits

The unused legacy standalone snapshot publisher is retired from the public source and package. No replacement bootstrap or snapshot builder is supplied. Native Freestyle runtime, configured provider snapshot selection, settings and stored snapshot data are unchanged. No snapshot was built or published. Provider lifecycle, private workflow compatibility, accounts, network and image acceptance require separate owner authorization. Offline synthetic fixtures do not certify paid infrastructure.
