# Setup

## Release gate

The owner confirms Hempi is their own app and authorizes public MIT publication of owned code. The accepted grant is recorded in the root and retained Hempi LICENSE files. Separate upstream/helper licenses and exclusions remain in force; see [third-party provenance](THIRD_PARTY.md). Publish only the reviewed current-tree snapshot, not private retained history. Publication permission is not a live installation or native runtime acceptance receipt.

## Build the reviewed source

Use this package's lockfile and a compatible BB CLI:

```sh
npm ci
npm run typecheck
npm run build
npm pack
```

The source build uses development tools, including TypeScript for the exact embedded-source check. Keep development dependencies for this build stage, even when producing production artifacts. The prebuilt runtime pack does not need the source compiler. `prepack` rebuilds and sanitizes source maps. Build and test only this package, not a workspace root.

The manifest declares BB >=0.46 and public SDK >=0.6.37. Its development SDK pin remains 0.6.37. The checkpoint build uses BB 0.46.1 with its SDK 0.6.49; this does not certify every declared version or update the pin.

The runtime pack contains `dist`, assets, skills and notices. It is not a source checkout. Use the reviewed Git tree and lockfile for a rebuild. Never publish private retained Git history or removed-text diffs. See [the local prompt patch](provider/vendor/hempi/LOCAL_PATCH.md).

## Approved installation

After the release gates are accepted, install a reviewed build through BB's normal plugin installation flow. For an approved local source checkout:

```sh
bb plugin install .
```

This command is documentation, not an instruction to switch a running installation during review. Keep its dependencies installed. Do not move a selected live package to a feature worktree.

Open Settings → Agents to save profiles and defaults. Saving a profile does not grant project, runtime, application or toolkit access. A valid profile is portable within native access and independent capability consent. Old membership records remain history only. See [the retirement contract](ASSIGNMENT_HANDOFF.md).

## Required execution runtime

Every execution host needs:

1. A Pi executable with the 1.2.0-or-later settlement/protocol behavior on its worker's `PATH`. Use the binary directly so the BB tool-channel descriptors survive.
2. Model Gateway's Pi extension and a configured route. BB supplies `MODEL_GATEWAY_BASE_URL` and `MODEL_GATEWAY_TOKEN` to managed turns. Missing values fail before model dispatch. Native Pi credentials are not a fallback.
3. Writable persistent host data and session directories. Shared agent memory also needs the primary host's public host RPC and reachable retained recovery copies.
4. The workspace, CLI tools, credentials and mounts required by the requested task. A saved profile does not provision them.

Both full and thin profiles use the `agents` provider. The real model resolves on the execution host. Exact Gateway routes must be available and support the saved effort. An `openai-codex/*` selection still routes the turn through Model Gateway. Consult the separately installed Gateway's setup instructions; its existing host reconciliation command is `bb gateway setup host`.

The host artifact embeds the retained Hempi source and its local original-prompt patch. No remote source checkout is needed. If an installed Hempi is already auto-loaded, it must match the settlement, Gateway, recovery and local-patch requirements. The offline capability probe only prevents duplicate loading. Its flags do not prove version or provenance.

## Existing setup contributions

An installed setup integration can contribute `AGENT_SETUP_SCRIPT`, or an `AGENT_SETUP_ERROR`. The bridge validates these inputs and awaits the staged Python recipe before forwarding the model prompt. It can acknowledge a queued turn while setup is still running. Failure, cancellation or an unresolved setup error prevents prompt dispatch. An execution host using a Python recipe needs the recipe's required Python runtime.

The DM allocation placeholder is not a setup readiness signal. This package does not add a preparation service, a native-thin shortcut, recipe discovery, or a new Environments path.

## Optional integrations

- Projects is not a profile membership authority for portable launch. Explicit legacy availability reads can still require its retained metadata and fail when it is unavailable.
- Automations is required only for the existing channel automation operations. A missing plugin gives an explicit operation error.
- Status Sidebar receives best-effort status snapshots. Its absence does not block normal profile use.
- Pages is used when resolving existing published artifact references.
- Pinpoint and copyediting workflows can use their public role presets. Their tools must be installed for those tasks.
- Clasi can hold shared facts when installed. It is not required to save or launch a profile.
- Private PR Review is not a public dependency. Fresh installs do not seed its profile. Only an already retained mapped/evidenced role keeps the old best-effort callback. An absent role fails before spawning; it is not recreated.

Automatic channel choice and delegated-result return decisions can use the optional Jev service. Configure its API key only after reviewing [the external data flow](PRIVACY.md). Missing choice credentials do not silently authorize a different model route. Existing follow-up failure policy is described in the README.
