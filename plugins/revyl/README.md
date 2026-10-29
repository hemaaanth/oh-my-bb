# Revyl for BB

The **Device** tab embeds a public Revyl device for the selected Android or iOS app build. The visitor starts the interactive session from Revyl's poster, then taps, swipes, types, and stops it inside the iframe. Merely opening the tab does not start a session. Revyl ends embed sessions after 3 minutes idle or 10 minutes active and bills their device time to your organization. The embed is a separate device from any private development session; it does not attach to one or stop one.

## Set up an app preview

Upload a compatible APK or iOS simulator build to a Revyl app using your existing build process or Revyl dashboard. In that app's **App settings → General → Public embed**, select the platform's branch and build, then copy its plain `https://app.revyl.ai/embed/<id>` URL. This build selection is fixed for that embed; create a new embed and revoke the old one to change it. Tell the agent in the project chat to configure the URL for Android or iOS, or call `revyl_configure` via the plugin RPC with `threadId`, `platform`, and `url`. The mapping is stored by BB project, so threads in local and sandbox environments of the same project see the same app preview.

The embed URL is a bearer capability: anyone who has it can start billable sessions on the selected build. Use disposable app data and no production credentials. Revyl lets you revoke the URL in app settings. The plugin accepts only plain Revyl embed URLs, not minted per-session tokens, and never stores an API key. There is no Revyl CLI requirement on BB hosts or sandboxes. Preparing and uploading a new app build is a separate step; the tab does not build or upload it.

Use `revyl_show` to reveal a configured Device tab. If both platforms are configured, it shows the requested one. Revyl supplies its own Start, Stop, device controls, and countdown. Closing the BB tab is not a Stop command; stop a running session inside Revyl's iframe before closing the tab.

Run `npm ci`, `npm run typecheck`, `npm test`, and `bb plugin build` from this package directory.
