---
name: revyl-device
description: Configure or reveal a disposable Android or iOS Revyl app preview beside the current BB thread.
---

# Revyl device

Use `revyl_show` with `platform: android` or `ios` to open a configured Device tab. Opening the tab only shows a poster; it never starts a billed device. The visitor starts and stops the demo inside Revyl's iframe. The embed creates its own device; it does not attach to or stop a private development session.

If no embed is configured, prepare a compatible app build. Prefer Revyl's hosted build: from the app's Git worktree, define its platform recipe in `.revyl/config.yaml` and run `revyl build --profile <name> --platform ios` (or `android`). The CLI uploads the source to Revyl's cloud runner; the submitting workspace needs the CLI and authentication, but not a local iOS SDK. Display-only BB hosts and sandboxes need neither the CLI nor Revyl credentials. An Android-only app still needs an iOS target before it can build for iOS. Alternatively upload a compatible build through the Revyl dashboard. Select the build under the Revyl app's **App settings → General → Public embed**. Review the selected build and public access with the user. Anyone holding the embed URL can start billable cloud sessions, so do not attach real accounts or secrets. Pass the plain `https://app.revyl.ai/embed/<id>` URL and platform to `revyl_configure`; this maps it to the BB project across local and sandbox threads. Do not put an API key in BB or sandbox configuration. Do not upload source or start a cloud device without the user's approval. Automatic build selection follows the branch's latest build; a pinned selection stays on its chosen build. Revoke unused embeds. Revyl ends embed sessions after 3 minutes idle or 10 minutes active. Closing the BB tab does not stop a running device; use Revyl's Stop control first.

## Private builds and device tests

Read the app's development instructions first. If the app uses cloud-only development, keep builds, emulators, test jobs, and benchmarks on approved remote services. Skip `revyl dev` hot reload, which can invoke a local build. Keep credentials in the Revyl CLI's authenticated profile or an approved secret store.

- Review a clean source checkout and its signing configuration before upload. Run `revyl build --remote --profile <profile> --platform <platform> --timeout <seconds> --detach --json`. Follow the job with `revyl build status <job-id> --follow`. Cancel it with `revyl build cancel <job-id>`.
- Agree on a budget and wall-clock deadline before starting. Run `revyl device start --platform <platform> --build-version-id <build-id> --timeout <idle-seconds> --open=false --json`. Save the returned server-issued session ID. The timeout is an idle limit.
- Pass `--session-id <id>` to every device action. Use `screenshot`, `hierarchy`, `tap`, `validation`, and `logs --no-follow` to capture private evidence. Use real coordinate taps when testing a keyboard. Verify extra device capabilities before relying on them.
- Run `revyl device stop --session-id <id>` on success, failure, or cancellation. Verify removal with `revyl device list`. Avoid `--all` and implicit session selection in concurrent threads.
- The CLI is sufficient for BB agents. An MCP client can use `revyl mcp serve --profile core` if it can address each device action by server-issued session ID.
