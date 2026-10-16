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
import type { EndpointView } from "../contract.js";
import { EndpointDetail, authLabels } from "./EndpointDetail.js";
import { EndpointForm } from "./EndpointForm.js";
import { PANEL_PATH, describeAction, useEndpoint, useOverview, useWebhooksRpc, type Overview } from "./data.js";
import { DeliveryStatusIcon, Notice, messageOf, relativeTime } from "./ui.js";

export function WebhooksPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const { data, error, refetch } = useOverview();
  const go = (sub: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: sub });
  const [first, second] = subPath.split("/").filter(Boolean);
  const name = first ? (data?.endpoints.find((endpoint) => endpoint.id === first)?.name ?? first) : "";

  let body;
  if (first === "new") body = <EndpointForm onSaved={(id) => go(id)} onCancel={() => go("")} />;
  else if (first && second === "edit") body = <EditEndpoint endpointId={first} onDone={() => go(first)} />;
  else if (first) body = <EndpointDetail endpointId={first} publicBaseUrl={data?.publicBaseUrl ?? null} onEdit={() => go(`${first}/edit`)} onDeleted={() => go("")} />;
  else body = <EndpointList overview={data} error={error} onRetry={refetch} onOpen={go} />;

  const trail: Crumb[] =
    first === "new"
      ? [{ label: "Endpoints", sub: "" }, { label: "New endpoint" }]
      : first && second === "edit"
        ? [{ label: "Endpoints", sub: "" }, { label: name, sub: first }, { label: "Edit" }]
        : first
          ? [{ label: "Endpoints", sub: "" }, { label: name }]
          : [];

  // The page frame of BB's own resource pages (Automations).
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className={`mx-auto box-border min-h-full w-full max-w-5xl px-4 pb-4 pt-3 md:px-5 md:pt-4 ${first ? "" : "h-full"}`}>
        {trail.length > 0 ? (
          <div className="mx-auto mb-4 w-full max-w-3xl">
            <Breadcrumbs trail={trail} onOpen={go} />
          </div>
        ) : null}
        {body}
      </div>
    </div>
  );
}

type Crumb = { label: string; sub?: string };

/** The host header shows only the panel title, so sub pages carry the trail. Same look as BB's header breadcrumbs. */
function Breadcrumbs({ trail, onOpen }: { trail: Crumb[]; onOpen: (sub: string) => void }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {trail.map((crumb, index) => (
          <li key={index} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <Icon name="ChevronRight" aria-hidden className="size-3.5 shrink-0 text-subtle-foreground" /> : null}
            {crumb.sub !== undefined ? (
              <button
                type="button"
                onClick={() => onOpen(crumb.sub!)}
                className="-mx-2 inline-flex min-h-7 min-w-0 cursor-pointer items-center rounded-md px-2 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="truncate">{crumb.label}</span>
              </button>
            ) : (
              <span aria-current="page" className="min-w-0 truncate text-foreground">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
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
      <ResourceListPanel>
        {overview.endpoints.map((endpoint) => (
          <EndpointRow key={endpoint.id} endpoint={endpoint} onOpen={() => onOpen(endpoint.id)} />
        ))}
      </ResourceListPanel>
    );
  }
  return (
    <ResourceCollectionPage
      id="webhooks-endpoints"
      description="Turn incoming webhooks into thread messages, new threads, automation runs, or plugin calls."
      actions={
        <Button size="sm" onClick={() => onOpen("new")}>
          <Icon name="Plus" aria-hidden className="size-4" />
          New endpoint
        </Button>
      }
    >
      {/* The same right inset as the description and actions bands above. */}
      <div className="flex flex-col gap-3 md:pr-3">
        {overview !== null && error !== null ? <Notice tone="error">{error}</Notice> : null}
        {overview !== null && overview.publicBaseUrl === null ? (
          <Notice tone="warning">Set a public base URL in the plugin settings so senders can reach this machine.</Notice>
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
  return (
    <ResourceRow
      // Like Automations: the resource glyph, swapped for a status icon only when the last delivery needs attention.
      leading={<DeliveryStatusIcon status={last && last.status !== "succeeded" ? last.status : "none"} className="size-4" />}
      title={endpoint.name}
      description={
        toggleError !== null ? (
          <span className="text-destructive">{toggleError}</span>
        ) : (
          <ResourceMeta
            items={[authLabels[endpoint.authMode], describeAction(endpoint), endpoint.rejectedSinceLoad > 0 ? `${endpoint.rejectedSinceLoad} rejected` : null]}
          />
        )
      }
      muted={!endpoint.enabled}
      trailingMeta={
        <span className="whitespace-nowrap pr-2 text-xs text-subtle-foreground" title={last?.receivedAt}>
          {endpoint.enabled ? (last ? relativeTime(last.receivedAt) : "No deliveries") : "Disabled"}
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
