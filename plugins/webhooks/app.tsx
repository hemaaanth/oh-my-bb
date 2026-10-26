// Webhooks plugin frontend: one nav panel for managing endpoints.
// Compiled by `bb plugin build`; React and @get-bb/plugin-sdk/app come from the host.
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button.js";
import { PANEL_PATH } from "./app/data.js";
import { WEBHOOK_ICON } from "./app/ui.js";
import { IntegrationSettings } from "./app/IntegrationSettings.js";
import { WebhooksPage } from "./app/WebhooksPage.js";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "webhooks", title: "Webhooks", icon: WEBHOOK_ICON, path: PANEL_PATH, component: WebhooksPage });
  app.slots.settingsSection({ id: "credentials", component: EndpointCredentials });
  app.slots.settingsSection({ id: "more", component: SetupSettings });
  app.slots.settingsSection({ id: "oh-my-bb", component: IntegrationSettings });
});

function EndpointCredentials() {
  const navigate = useBbNavigate();
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-foreground">Credentials</h2>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border bg-surface-recessed/70 px-3 py-3">
        <div className="min-w-0">
          <p className="text-sm text-foreground">Endpoint authentication</p>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">Manage signing secrets and bearer tokens per endpoint.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>Manage endpoints</Button>
      </div>
    </section>
  );
}

function SetupSettings() {
  const navigate = useBbNavigate();
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-foreground">More</h2>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border bg-surface-recessed/70 px-3 py-3">
        <div className="min-w-0">
          <p className="text-sm text-foreground">Setup guide</p>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">Connect a sender over public HTTPS.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "setup" })}>Open setup guide</Button>
      </div>
    </section>
  );
}
