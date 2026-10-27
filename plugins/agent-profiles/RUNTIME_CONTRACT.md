# Agents runtime contract

## Stable identities

- Plugin ID: `agent-profiles`.
- Managed provider ID: `agents`; family: `agents`.
- Profile model ID: `agent/<profile UUID>`.
- Plain provider ID: `hempi`; it is not a replacement profile execution path.
- Existing UUIDs, revisions, DM bindings, home paths, memory keys, defaults and legacy built-in role keys remain stored identities.

Full and thin profiles both use the managed provider. Their mission/document behavior differs, not their provider or setup barrier. Old per-agent `agent-<UUID>` provider threads remain history-only. Existing native resume, fork, channel and permanent-DM bindings retain their contracts.

## Portable identity and context

A profile definition is not an access grant. Discovery and normal launch do not call legacy membership readers. Native project/runtime access and independent capability consent still apply.

An explicit task `projectId` overrides the saved launch default for that task only. An explicit environment requires that explicit project. Omitted task context uses the existing saved project/checkouts/machine resolution. Task context never rewrites a saved default or moves a DM, home, memory profile or resumed session.

`assignmentStatus(null)` returns exactly:

```json
{"schemaVersion":1,"kind":"agentPreferences","state":"retained-only"}
```

This is not absence, empty membership or an active destination. Retained source errors do not become empty history. Membership mutation RPCs fail with `membership-retired`. Applied C1 authority or audit rows fail with `membership-recovery-required`; preserve the rows and use the retained recovery release. The complete [retirement and deployment contract](ASSIGNMENT_HANDOFF.md) remains authoritative.

## Model dispatch

The worker resolves the real model and saved effort against its available Pi catalog. Managed turns require both `MODEL_GATEWAY_BASE_URL` and `MODEL_GATEWAY_TOKEN`, then route through `model-gateway`. Native Pi credentials are not a fallback. Missing routes, unavailable pins and unsupported efforts fail before the model prompt.

Pi 1.2.0-or-later protocol behavior is required. Main turns wait for final `agent_settled`, Pi exit and any required memory copy-back before publishing their settled boundary. An earlier `agent_end` is not final settlement. Cancellation, handled prompts and recovery failures keep their existing bridge behavior.

The existing bridge awaits a staged `AGENT_SETUP_SCRIPT` before prompt forwarding. An unresolved `AGENT_SETUP_ERROR`, recipe failure or cancellation blocks that forwarding. A queued acknowledgment is not setup completion. DM allocation placeholders are not readiness barriers. This checkpoint adds no recipe, preparation service, native-thin path or provider operation.

## Memory and local source provenance

Only a profile's DM binds its frozen OptChat memory key. Renaming the slug does not rename that key. Delegated child, sequence and channel turns do not acquire this DM lock. Native project access and installed tools are separate from memory ownership.

The host embeds upstream base `2db99a3ab1175723d022a4a348350be74fbe9824` with the reviewed [local original-prompt patch](provider/vendor/hempi/LOCAL_PATCH.md). `HEMPI_SOURCE_SHA256` identifies exact local bytes. Materialization uses both identities. The local regeneration mode never fetches or reads an external checkout.

Summary prompts target 512 UTF-8 bytes. The unchanged default acceptance tolerance is 640 bytes. Completed oversize replies get at most five attempts, after which the shortest complete reply can still exceed that tolerance. Truncated/tool-call replies do not count as complete summaries; five incomplete replies fail. This is not a hard 512-byte output cap. Offline fake replies prove these protocol paths, not real model quality.

Remote shared memory transfers only the selected profile under its native lock. Hashes and HMAC capabilities protect the transfer protocol. A failed or uncertain copy-back retains recovery data and refuses stale execution. Never erase a pending journal or retained remote copy to force a turn through.

## Optional companions

Fresh public data seeds only the public Pinpoint/text-edit roles. It does not seed a private `pr-review` preset or skill dependency. An existing private role remains only when its saved mapping or the exact already-supported legacy evidence identifies a retained profile. Same-name profiles without that evidence are not adopted. Deleted private profiles are not recreated.

`spawnBuiltInProfile` for an unavailable private role fails before spawn. A retained private role keeps its stored bytes and optional best-effort `pr-review.registerReviewThread({threadId}) -> {ok:true}` callback. The existing receiver authenticates native thread origin; the callback is not a publication permission or proof of human consent. Unrelated public profiles make no private-plugin call.

Automations, Pages, Status Sidebar, Clasi, Pinpoint and copyediting remain feature-specific integrations. A missing optional integration does not create a different model route or an access grant. Jev is a separate optional external channel decision service, not a substitute for Model Gateway. See [privacy](PRIVACY.md).

## Acceptance limits

All 30 installed SQL migration entries remain exact and ordered. No live database, host state, installed source, registration, secret or provider was inspected or changed for this checkpoint. Actual registered factory and bridge fixtures use disposable synthetic data and fake Pi interfaces. They do not certify the native BB shell, a paid model turn, installed extension provenance, future preparation integration, or legal redistribution rights.
