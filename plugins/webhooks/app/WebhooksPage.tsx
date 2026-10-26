// The Webhooks nav panel. The sub path picks the view:
// "" lists endpoints, "new" creates one, "<id>" shows one, "<id>/edit" edits it.
import { useState } from "react";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  ResourceCollectionPage,
  ResourceListPanel,
  ResourceListState,
  ResourceMeta,
  ResourceRow,
  ResourceRowDetailChevron,
} from "@/components/ui/resource-list";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { EndpointView } from "../contract.js";
import { EndpointDetail, authLabels } from "./EndpointDetail.js";
import { EndpointForm } from "./EndpointForm.js";
import { SetupGuide } from "./SetupGuide.js";
import { PANEL_PATH, describeAction, useEndpoint, useOverview, useWebhooksRpc, type Overview } from "./data.js";
import { DeliveryStatusIcon, Notice, messageOf, relativeTime } from "./ui.js";

export function WebhooksPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const { data, error, refetch } = useOverview();
  const go = (sub: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: sub });
  const [first, second] = subPath.split("/").filter(Boolean);

  let body;
  if (first === "setup") body = <SetupGuide />;
  else if (first === "new") body = <EndpointForm onSaved={(id) => go(id)} onCancel={() => go("")} />;
  else if (first && second === "edit") body = <EditEndpoint endpointId={first} onDone={() => go(first)} />;
  else if (first) body = <EndpointDetail endpointId={first} publicBaseUrl={data?.publicBaseUrl ?? null} onEdit={() => go(`${first}/edit`)} onDeleted={() => go("")} />;
  else body = <EndpointList overview={data} error={error} onRetry={refetch} onOpen={go} />;

  // Match BB settings' outer page shell; overlay scrollbars do not shift content.
  return (
    <ScrollArea className="h-full min-h-0 flex-1">
      <div className="@container/webhooks mx-auto box-border w-full max-w-[760px] px-4 pb-4 pt-4 md:pt-5">
        {body}
      </div>
    </ScrollArea>
  );
}

function EditEndpoint({ endpointId, onDone }: { endpointId: string; onDone: () => void }) {
  const { data, error, refetch } = useEndpoint(endpointId);
  if (error !== null && data === null) return <ResourceListState state="error" layout="detail" message={error} onRetry={refetch} />;
  if (data === null) return <ResourceListState state="loading" layout="detail" message="Loading endpoint…" loadingRows={3} />;
  // Keyed by id so a realtime refetch does not reset the form mid-edit.
  return <EndpointForm key={data.endpoint.id} endpoint={data.endpoint} onSaved={onDone} onCancel={onDone} />;
}

function EndpointList({ overview, error, onRetry, onOpen }: { overview: Overview | null; error: string | null; onRetry: () => void; onOpen: (sub: string) => void }) {
  let list;
  if (overview === null) {
    list = error === null ? <ResourceListState state="loading" message="Loading endpoints…" loadingRows={3} /> : <ResourceListState state="error" message={error} onRetry={onRetry} />;
  } else if (overview.endpoints.length === 0) {
    list = <ResourceListState state="empty" message="No endpoints yet." />;
  } else {
    list = (
      <ResourceListPanel className="px-3 @min-[40rem]/webhooks:px-4">
        {overview.endpoints.map((endpoint) => (
          <EndpointRow key={endpoint.id} endpoint={endpoint} onOpen={() => onOpen(endpoint.id)} />
        ))}
      </ResourceListPanel>
    );
  }
  return (
    <ResourceCollectionPage
      id="webhooks-endpoints"
      actions={
        <div className="flex w-full items-center gap-2 @min-[40rem]/webhooks:w-auto">
          <Button variant="outline" size="sm" className="flex-1 @min-[40rem]/webhooks:flex-none" onClick={() => onOpen("setup")}>Setup guide</Button>
          <Button size="sm" className="flex-1 @min-[40rem]/webhooks:flex-none" onClick={() => onOpen("new")}>
            <Icon name="Plus" aria-hidden className="size-4" />
            New endpoint
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {overview !== null && error !== null ? <Notice tone="error">{error}</Notice> : null}
        {overview !== null && overview.publicBaseUrl === null ? (
          <Notice tone="warning">Set a public base URL and route HTTPS to this machine. <button type="button" className="underline underline-offset-2" onClick={() => onOpen("setup")}>Open setup guide</button></Notice>
        ) : null}
        {list}
      </div>
    </ResourceCollectionPage>
  );
}

function EndpointRow({ endpoint, onOpen }: { endpoint: EndpointView; onOpen: () => void }) {
  const rpc = useWebhooksRpc();
  const [pending, setPending] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const last = endpoint.lastDelivery;
  const deliveryTime = endpoint.enabled ? (last ? relativeTime(last.receivedAt) : "No deliveries") : "Disabled";
  const compactAction = endpoint.action.type === "plugin" ? `Plugin: ${endpoint.action.pluginId}`
    : endpoint.action.type === "automation" ? "Automation"
    : endpoint.action.type === "spawn" ? "New thread" : "Thread message";
  return (
    <ResourceRow
      className="gap-x-2 @min-[40rem]/webhooks:gap-x-3"
      // Like Automations: the resource glyph, swapped for a status icon only when the last delivery needs attention.
      leading={<DeliveryStatusIcon status={last && last.status !== "succeeded" ? last.status : "none"} className="size-4" />}
      title={endpoint.name}
      description={
        toggleError !== null ? (
          <span className="text-destructive">{toggleError}</span>
        ) : (
          <>
            <span className="block @min-[40rem]/webhooks:hidden" title={`${authLabels[endpoint.authMode]} · ${describeAction(endpoint)}`}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate">{compactAction}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0" title={last?.receivedAt}>{deliveryTime}</span>
              </span>
              {endpoint.rejectedSinceLoad > 0 ? <span className="block">{endpoint.rejectedSinceLoad} rejected</span> : null}
            </span>
            <span className="hidden @min-[40rem]/webhooks:block">
              <ResourceMeta items={[authLabels[endpoint.authMode], describeAction(endpoint), endpoint.rejectedSinceLoad > 0 ? `${endpoint.rejectedSinceLoad} rejected` : null]} />
            </span>
          </>
        )
      }
      muted={!endpoint.enabled}
      trailingMeta={
        <span className="hidden whitespace-nowrap pr-2 text-xs text-subtle-foreground @min-[40rem]/webhooks:inline" title={last?.receivedAt}>
          {deliveryTime}
        </span>
      }
      persistentActions={
        <Switch
          checked={endpoint.enabled}
          disabled={pending}
          aria-label={`${endpoint.enabled ? "Disable" : "Enable"} ${endpoint.name}`}
          onCheckedChange={(enabled) => {
            setPending(true);
            setToggleError(null);
            rpc
              .call("webhooks_set_enabled", { endpointId: endpoint.id, enabled })
              .catch((cause) => setToggleError(messageOf(cause)))
              .finally(() => setPending(false));
          }}
        />
      }
      trailingVisual={<ResourceRowDetailChevron />}
      openLabel={`Open ${endpoint.name}`}
      onOpen={onOpen}
    />
  );
}
