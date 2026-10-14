// Webhooks plugin frontend: one nav panel for managing endpoints.
// Compiled by `bb plugin build`; React and @get-bb/plugin-sdk/app come from the host.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PANEL_PATH } from "./app/data.js";
import { WEBHOOK_ICON } from "./app/ui.js";
import { WebhooksPage } from "./app/WebhooksPage.js";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "webhooks", title: "Webhooks", icon: WEBHOOK_ICON, path: PANEL_PATH, component: WebhooksPage });
});
