---
name: revyl-device
description: Configure or reveal a disposable Android or iOS Revyl app preview beside the current BB thread.
---

# Revyl device

Use `revyl_show` with `platform: android` or `ios` to open a configured Device tab. Opening the tab only shows a poster; it never starts a billed device. The visitor starts and stops the demo inside Revyl's iframe. The embed creates its own device; it does not attach to or stop a private development session.

If no embed is configured, prepare a compatible app build. Prefer Revyl's hosted build: from the app's Git worktree, define its platform recipe in `.revyl/config.yaml` and run `revyl build --profile <name> --platform ios` (or `android`). The CLI uploads the source to Revyl's cloud runner; the submitting workspace needs the CLI and authentication, but not a local iOS SDK. Display-only BB hosts and sandboxes need neither the CLI nor Revyl credentials. An Android-only app still needs an iOS target before it can build for iOS. Alternatively upload a compatible build through the Revyl dashboard. Select the build under the Revyl app's **App settings → General → Public embed**. Review the selected build and public access with the user. Anyone holding the embed URL can start billable cloud sessions, so do not attach real accounts or secrets. Pass the plain `https://app.revyl.ai/embed/<id>` URL and platform to `revyl_configure`; this maps it to the BB project across local and sandbox threads. Do not put an API key in BB or sandbox configuration. Do not upload source or start a cloud device without the user's approval. Automatic build selection follows the branch's latest build; a pinned selection stays on its chosen build. Revoke unused embeds. Revyl ends embed sessions after 3 minutes idle or 10 minutes active. Closing the BB tab does not stop a running device; use Revyl's Stop control first.
