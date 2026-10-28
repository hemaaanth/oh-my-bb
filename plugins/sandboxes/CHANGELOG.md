# Unreleased

- Align every provider executor and harness installation with the Node directory used by BB agents. Share create/resume connection setup and project-based machine naming; remove duplicated connector naming and event-based rename heuristics. Confirm empty Boat accounts can retire old uncheckpointed allocations.

- Fix Modal bootstrap hanging on nonempty stdin; close the stream at its actual byte offset, stream progress immediately, and round exec timeouts to supported whole seconds.
- Enforce shared-image agent CLI versions across standard providers, including old vendor-installed CLIs. Replace conflicting global npm links, preserve selected tools and explicit custom-image versions, cache image metadata, and verify repairs before allowing agent execution.
- Clarify Freestyle’s optional base snapshot and Ubuntu default. Explain how to clear or replace a missing custom snapshot without silently changing the selected image. Relate plan-limit resize errors to the selected size and preserve cleanup of the failed VM.

- Rename Box to Boat, use the current Boat API and logo, and preserve existing keys and resources. Set trial-compatible two-hour auto-stop on create/resume; BB still pauses idle machines after the saved idle period.

- Remove manual image rollback/selection and project image pinning from settings, RPC and CLI. Keep current machines, provider defaults, build registration and historical database records.

# Changelog

## Unreleased — Foundations 2C

- Native cleanup reports failure when removal is unknown, a resource cannot be identified, or key reconciliation is unsupported. BB retains its native resource/checkpoint for retry. Daytona no longer swallows provider delete errors.
- Legacy cleanup retains the checkpoint and BB host until provider removal is confirmed.
- Optional Credentials, Catalog, Agents and Projects call paths default off. An explicit one-generation owner import preserves inventoried existing effective behavior without inventing prior consent. Saved destination false wins. Browser retains its own opt-in; Model Gateway remains a required managed-model runtime with pre-allocation readiness checks and fail-closed setup.
- Change integration controls through serialized single-flag patches, preserving other clients' opt-outs, absent fields and import receipts. Reject stale whole-map writes.
- Regenerate shipped styles from clean package sources, without temporary proof fixtures.
- Cache source-owned preparation observations by exact native target. Terminal not-ready does not rerun setup on activity. Unknown outcomes never replay automatically. Disposal stops local observation, not the remote job.
- Image builders use an explicit saved/imported repository or runtime environment override, never checkout origin. Fresh installs have no owner/private builder default.
- Package an independent deterministic Browser runtime from exact accepted public source. Verify source/input/archive receipts before image build, require matching immutable-image labels at registration, and block unproven image activation. Existing images, pins and sessions are retained.
- Preserve attested historical image rollback independently of the current Browser artifact through a reviewed compatibility allowlist. Unknown legacy images remain retained but cannot be newly activated or pinned; their cutover selection restriction requires an owner decision.
- Consume the reviewed Credentials preparationOutcomeV1 boundary. Explicit owner retry re-reads source-owned evidence, coalesces concurrent requests and consumes cached eligibility before start. Legacy/missing/uncertain outcomes cannot replay; Catalog participation remains unconfirmed and permits refresh only.
- Keep owner preparation Refresh bounded while background observation runs. Coalesce same-job reads and discard results from replaced operation/job checkpoints without new setup or retry.
- Move nonsecret defaults into boxed Preferences with a one-generation migration receipt. Keep static secret/authentication identities in native Configuration and preserve the existing file fallback.
- Keep native machine/header controls; make obsolete attachment assignment read-only with exact existing IDs and scope. Unknown native lookup errors no longer appear as Local.
- Collapse provider/image details and More help. Preserve unsaved drafts on realtime updates and failed saves. Operational capacity checks require an explicit action.
- Add standalone package metadata, license and generated source-map path checks. Retire the unused broken standalone Freestyle snapshot publisher from public source and pack; preserve native Freestyle runtime, configured snapshots, settings and data.
