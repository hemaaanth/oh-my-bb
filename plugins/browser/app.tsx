import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BrowserLive } from "./components/browser-live";
import { BrowserHandoff } from "./components/browser-handoff";
import { BrowserPreferencesSettings, BrowserIntegrationSettings, BrowserMoreSettings } from "./components/browser-settings";
import { BROWSER_HANDOFF_RENDERER } from "./src/browser-handoff-renderer";

export default definePluginApp(app => {
  app.slots.messageDirective({id:"browser-live",component:BrowserLive});
  app.slots.pendingInteraction({ id: BROWSER_HANDOFF_RENDERER, component: BrowserHandoff });
  app.slots.settingsSection({ id: "preferences", component: BrowserPreferencesSettings });
  app.slots.settingsSection({ id: "integrations", component: BrowserIntegrationSettings });
  app.slots.settingsSection({ id: "more", component: BrowserMoreSettings });
});
