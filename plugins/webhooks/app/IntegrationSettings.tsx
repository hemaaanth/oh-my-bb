import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useIntegrations, useWebhooksRpc } from "./data.js";
import { messageOf } from "./ui.js";

export function IntegrationSettings() {
  const rpc = useWebhooksRpc();
  const { data, error, refetch } = useIntegrations();
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function toggle(pluginId: string, enabled: boolean) {
    setPending(true);
    setSaveError(null);
    try {
      await rpc.call("webhooks_set_integration", { pluginId, enabled });
      refetch();
    } catch (cause) {
      setSaveError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  if (!error && !data?.length) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-foreground">Oh My BB</h2>
      <div className="divide-y divide-border rounded-md border border-border bg-surface-recessed/70 px-3">
        {data?.map((integration) => (
          <div key={integration.pluginId} className="flex min-w-0 items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="text-sm text-foreground">{integration.name}</p>
              {integration.description ? <p className="mt-0.5 truncate text-xs leading-snug text-subtle-foreground/75" title={integration.description}>{integration.description}</p> : null}
            </div>
            <Switch aria-label={`${integration.name} integration`} checked={integration.enabled} disabled={pending} onCheckedChange={(enabled) => void toggle(integration.pluginId, enabled)} />
          </div>
        ))}
      </div>
      {saveError || error ? <p role="alert" className="text-xs text-destructive">{saveError ?? error}</p> : null}
    </section>
  );
}
