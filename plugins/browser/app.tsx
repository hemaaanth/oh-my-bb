import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BrowserLive } from "./components/browser-live";
import { BrowserHandoff } from "./components/browser-handoff";
import { BrowserCookieSettings } from "./components/browser-cookie-settings";
import { BROWSER_HANDOFF_RENDERER } from "./src/browser-handoff-contract";

export default definePluginApp(app => {
  app.slots.messageDirective({id:"browser-live",component:BrowserLive});
  app.slots.pendingInteraction({ id: BROWSER_HANDOFF_RENDERER, component: BrowserHandoff });
  app.slots.settingsSection({ id: "connection", title: "Browser connection", description: "Isolated sessions own their login state. Relay uses the paired regular profile and shared authentication on its desktop host.", component: BrowserCookieSettings });
});
