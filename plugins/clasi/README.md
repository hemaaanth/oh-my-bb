# Clasi

Retain scoped context, reusable lessons, and workflow feedback for BB agents.

Clasi stores Context, Napkins, and Papercuts in BB's private plugin SQLite database. It runs independently of all other Oh My BB packages. No external account, API key, model request, or repository-root dependency is required.

## Install and check

Requires BB 0.46.1 or later, Node.js with TypeScript stripping support, and npm.

Install from the public main branch; this does not require a release tag:

```sh
bb plugin install git:https://github.com/hemaaanth/oh-my-bb.git@ref:main --plugin clasi
```

For local development, run from this package directory:

```sh
npm ci
npm run check
bb plugin install .
```

`check` runs TypeScript, the package's tests, and `bb plugin build`. Tests use disposable SDK harness storage. They do not read or change the owner's memories. Build artifacts stay in ignored `dist/`.

Open **More → Clasi** in BB's navigation. **Guide** in the Clasi header explains scopes, retention, and optional integration behavior. Open Clasi's native Configuration in Settings to adjust instruction limits; Settings → More → Open guide also reaches the guide.

## Scopes and retained data

- **Everywhere** (`global`): all projects and environments on this BB server.
- **Repository** (`project`): worktrees with the same canonical Git remote. Non-Git projects fall back to their BB project ID.
- **This worktree** (`environment`): one environment.

Environment records override project records with the same logical key; project records override global records. Canonical remote hashing, scope keys, database migrations, settings IDs, RPC methods, and agent-tool names are unchanged in this public migration. Existing saved state needs no export, rewrite, deletion, or reindex.

Context and bounded Napkins enter agent instructions while Clasi is enabled. Agents evaluate non-trivial work for safe durable guidance; they are not required to save a record. No raw conversation is captured automatically. Papercuts inject only open severity counts. Their details stay in the dashboard and management interfaces.

Native Configuration controls `contextCharacterCap`, `napkinsPerCategory`, and `designCopyReserve`. Design/copy records use a separate bounded reserve. These limits control instruction injection, not retention. Stored records remain until explicitly removed. Resolving or dismissing a Papercut retains its history.

## Privacy and consent

Store only generalized derived guidance. Never retain raw prompts, messages, terminal output, source excerpts, paths, credentials, PII, or customer data. Input validation rejects multiline text, absolute paths, several credential patterns, and oversized fields. It is not a complete privacy or content classifier; callers must enforce the policy before sending anything.

Design/copy Context and Napkins require explicit user acceptance. `saveContext` accepts `provenance` and `consentRef` as audit metadata. These fields never enter agent instructions. A missing consent reference flags a design/copy Context record as unconsented; it does not block injection or establish permission. The migration preserves this existing behavior.

The panel, CLI, and RPC can expose retained records to authorized BB users and callers. Do not publish their output or copy an owner's database into fixtures. Clasi does not provide an external sharing or synchronization service.

## Optional Pinpoint integration

Pinpoint is an independent optional consumer of Clasi's `saveContext` RPC. Install and enable each plugin separately if desired. Clasi never imports Pinpoint code, probes its presence, installs it, or enables it at startup or execution.

Pinpoint owns the learning opt-in. Its execution path requires a stored explicit consent event before calling `saveContext`; approval without the learning opt-in writes nothing. The call sends the approved generalized preference, canonical project scope, topic, source thread ID, and `pinpoint:<annotation-id>` consent reference. An unavailable Clasi write must be reported as failed by the caller, never as saved. This package preserves that RPC contract without requiring Pinpoint in its test or runtime dependency graph.

The Clasi-side tests cover this incoming payload and audit isolation with synthetic records. They do not claim to exercise an installed Pinpoint instance or its UI. There is no duplicate integration toggle in Clasi because the per-learning decision belongs to Pinpoint.

## Commands

```sh
bb clasi status
bb clasi list global
bb clasi list project:<project-id>
bb clasi list environment:<environment-id>
bb clasi remove napkin <uuid> --confirm
```

`project` and `environment` without an ID use the current CLI context when available. Deletion requires `--confirm`. Agent tools retain their names: `clasi_remember_context`, `clasi_remember_napkin`, `clasi_mark_napkin_hit`, `clasi_capture_papercut`, and `clasi_update_papercut`.

## Public package boundaries

Only tracked source and static assets were migrated. No private history, runtime database, live memory, environment configuration, or secret is included. Tests keep their boundary fixtures inside this package. React and the Plugin SDK frontend runtime are supplied by BB; all package-local build/test dependencies are declared here. There are no cross-package imports or symlinks.

Standard pages use BB Settings geometry: a 760px outer frame with 16px side padding and 728px content at full width. Layout responds to the panel container, not the desktop viewport. Branding uses one canonical SVG. The settings form remains native.

See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md), [CHANGELOG.md](CHANGELOG.md), and [THIRD_PARTY.md](THIRD_PARTY.md).
