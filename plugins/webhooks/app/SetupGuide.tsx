import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ResourceDetailOverviewSection, ResourceDetailPage, ResourceDetailStack } from "@/components/ui/resource-list";
import { PANEL_PATH } from "./data.js";
import { Notice, WEBHOOK_ICON } from "./ui.js";

export function SetupGuide() {
  const navigate = useBbNavigate();
  return (
    <ResourceDetailPage
      title="Set up Webhooks"
      leading={<Icon name={WEBHOOK_ICON} aria-hidden className="size-full text-foreground" />}
      metadata="Connect a sender without exposing the rest of BB."
    >
      <ResourceDetailStack>
        <ResourceDetailOverviewSection label="1. Prepare BB">
          <div className="space-y-2 text-sm leading-relaxed">
            <p>Keep BB running on the receiving machine. For thread actions, configure an agent and create a thread or project.</p>
            <p className="text-muted-foreground">No other plugin is required for thread actions. For Automations or receiver plugins, install and enable the plugin, then enable its integration in Settings → Webhooks → Oh My BB. Receivers must publish <code>webhooks_receive</code>.</p>
          </div>
        </ResourceDetailOverviewSection>
        <ResourceDetailOverviewSection label="2. Route public HTTPS">
          <div className="space-y-3 text-sm leading-relaxed">
            <p>Choose a stable public hostname and a tunnel or HTTPS reverse proxy. Cloudflare is optional; Caddy or another proxy works too.</p>
            <p>Recommended: in Settings → Webhooks, set <strong>Listener port</strong> to an unused port, such as <code>43128</code>, and <strong>Public base URL</strong> to your HTTPS origin.</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-surface-recessed/70 p-3 text-xs"><code>{"bb plugin config webhooks set listenerPort 43128\nbb plugin config webhooks set publicBaseUrl https://hooks.example.com"}</code></pre>
            <p>Forward only <code>/webhook/</code> to <code>http://127.0.0.1:43128</code> on the BB machine. A listener port alone is not a public URL.</p>
            <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
              <li>Cloudflare named tunnel: install <code>cloudflared</code>, sign in to a Cloudflare account with a domain, and add the hostname route. Keep the tunnel running.</li>
              <li>Caddy: install Caddy, point the hostname at the server, and allow inbound HTTPS. Forward only the webhook path.</li>
              <li>Existing tunnel: add the webhook route before a catch-all route. If another plugin owns that tunnel, deliveries depend on it staying up.</li>
            </ul>
            <Notice tone="warning">Do not expose the full BB server. BB Connect requires an owner session, so it cannot receive provider callbacks. Webhooks does not install or manage ingress.</Notice>
            <Button variant="outline" size="sm" onClick={() => navigate.openUrl("https://github.com/hemaaanth/oh-my-bb/blob/main/plugins/webhooks/docs/ingress.md")}>Ingress examples</Button>
          </div>
        </ResourceDetailOverviewSection>
        <ResourceDetailOverviewSection label="3. Create an endpoint">
          <div className="space-y-3 text-sm leading-relaxed">
            <p>Choose the sender's authentication, declare the fields it may supply, and select one fixed action. Start with a test thread.</p>
            <p className="text-muted-foreground">Copy the delivery URL and one-time signing secret or bearer token into the sender. Slack instead needs its app's Signing Secret, not an API token. Configure the sender's event subscriptions too.</p>
            <Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "new" })}>New endpoint</Button>
          </div>
        </ResourceDetailOverviewSection>
        <ResourceDetailOverviewSection label="4. Verify from the sender">
          <div className="space-y-3 text-sm leading-relaxed">
            <p>From outside your network, an unsigned POST to an enabled endpoint should return <code>401</code>. Other public paths should return <code>404</code> on a dedicated webhook hostname.</p>
            <p>Send a real event from the sender, then inspect <strong>Deliveries</strong> on the endpoint. <strong>Send test</strong> runs the real action locally; it does not prove the public route works.</p>
            <p className="text-muted-foreground">Settings apply when saved. If BB still shows Needs configuration after setup, reload Webhooks to clear the warning. Slack acknowledges first; failed actions are recorded but are not retried automatically.</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-surface-recessed/70 p-3 text-xs"><code>bb plugin reload webhooks</code></pre>
          </div>
        </ResourceDetailOverviewSection>
      </ResourceDetailStack>
    </ResourceDetailPage>
  );
}
