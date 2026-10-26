// One endpoint: its URL, settings summary, test sender, secret rotation, and deliveries.
import { useEffect, useState } from "react";
import { experimental_copyToClipboard as copyToClipboard, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  ResourceActionButton,
  ResourceActivitySection,
  ResourceDefinitionSection,
  ResourceDetailCollection,
  ResourceDetailConfigurationSection,
  ResourceDetailPage,
  ResourceDetailPanel,
  ResourceDetailStack,
  ResourceListState,
  ResourceMeta,
  ResourceOverflowMenu,
} from "@/components/ui/resource-list";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { DeliveryView, EndpointView } from "../contract.js";
import { describeAction, deliveryUrl, useEndpoint, useWebhooksRpc } from "./data.js";
import { SecretReveal } from "./SecretReveal.js";
import { DeliveryStatusIcon, Field, Notice, WEBHOOK_ICON, deliveryStatusVisuals, messageOf, relativeTime } from "./ui.js";

export const authLabels: Record<EndpointView["authMode"], string> = {
  "standard-webhooks": "Standard Webhooks signature",
  slack: "Slack request signature",
  bearer: "Bearer token",
};

const dedupeLabels: Record<EndpointView["dedupe"]["source"], string> = {
  "webhook-id": "webhook-id header",
  field: "Payload field",
  "body-hash": "Body hash",
};

export function EndpointDetail({ endpointId, publicBaseUrl, onEdit, onDeleted }: { endpointId: string; publicBaseUrl: string | null; onEdit: () => void; onDeleted: () => void }) {
  const rpc = useWebhooksRpc();
  const { data, error, refetch } = useEndpoint(endpointId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importing, setImporting] = useState(false);

  if (error !== null && data === null) return <ResourceListState state="error" layout="detail" message={error} onRetry={refetch} />;
  if (data === null) return <ResourceListState state="loading" layout="detail" message="Loading endpoint…" loadingRows={3} />;
  const { endpoint, deliveries } = data;
  const slack = endpoint.authMode === "slack";
  const run = (task: () => Promise<unknown>) => {
    setActionError(null);
    setPending(true);
    task()
      .catch((cause) => setActionError(messageOf(cause)))
      .finally(() => setPending(false));
  };
  const rotate = () =>
    slack
      ? setImporting(true)
      : run(async () => {
          const result = await rpc.call("webhooks_rotate_secret", { endpointId });
          setSecret(result.secret);
        });

  return (
    <ResourceDetailPage
      leading={<Icon name={WEBHOOK_ICON} aria-hidden className="size-full shrink-0 text-foreground" />}
      title={endpoint.name}
      metadata={
        <ResourceMeta
          items={[
            endpoint.enabled ? null : "Disabled. Requests get 404.",
            authLabels[endpoint.authMode],
            endpoint.lastDelivery ? `Last delivery ${relativeTime(endpoint.lastDelivery.receivedAt)}` : "No deliveries",
          ]}
        />
      }
      lifecycleControl={
        <Switch
          checked={endpoint.enabled}
          disabled={pending}
          aria-label={endpoint.enabled ? "Disable endpoint" : "Enable endpoint"}
          onCheckedChange={(enabled) => run(() => rpc.call("webhooks_set_enabled", { endpointId, enabled }))}
        />
      }
      overflowMenu={
        <ResourceOverflowMenu
          label={`${endpoint.name} actions`}
          disabled={pending}
          items={[
            { label: slack ? "Replace secret" : "Rotate secret", icon: "RotateCcw", onSelect: rotate },
            { kind: "separator" },
            { label: "Delete", icon: "Trash2", tone: "destructive", onSelect: () => setConfirmDelete(true) },
          ]}
        />
      }
    >
      {actionError === null ? null : <Notice tone="error">{actionError}</Notice>}
      {secret ? <SecretReveal secret={secret} authMode={endpoint.authMode} onDone={() => setSecret(null)} /> : null}
      {importing ? (
        <SecretImport
          onCancel={() => setImporting(false)}
          onSubmit={(value) =>
            run(async () => {
              await rpc.call("webhooks_rotate_secret", { endpointId, secret: value });
              setImporting(false);
            })
          }
        />
      ) : null}

      <ResourceDetailStack>
        <DeliveryUrlSection url={deliveryUrl(publicBaseUrl, endpoint)} placeholderOrigin={publicBaseUrl === null} />

        <ResourceDetailConfigurationSection label="Configuration" actions={<ResourceActionButton label="Edit" icon="Edit" onClick={onEdit} />}>
          <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
            <Row term="Authentication">
              {authLabels[endpoint.authMode]}
              <span className="text-muted-foreground">
                {" "}
                · secret ends …{endpoint.secretHint} · set {relativeTime(endpoint.secretUpdatedAt)}
              </span>
            </Row>
            <Row term="Fields">
              {endpoint.fields.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <ul className="flex flex-col gap-1">
                  {endpoint.fields.map((field) => (
                    <li key={field.name} className="min-w-0 break-words">
                      <span className="font-mono text-xs">{field.name}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        from <span className="font-mono text-xs">{field.path}</span> · {field.type}
                        {field.required ? " · required" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Row>
            <Row term="Duplicates">
              {dedupeLabels[endpoint.dedupe.source]}
              {endpoint.dedupe.source === "field" ? <span className="font-mono text-xs"> {endpoint.dedupe.field}</span> : null}
            </Row>
            <Row term="Action">
              {describeAction(endpoint)}
              {endpoint.action.type === "automation" ? <span className="text-muted-foreground"> · saved prompt</span> : null}
            </Row>
            <Row term="Limits">
              {endpoint.maxBodyBytes} bytes · {endpoint.rateLimitPerMinute} per minute
            </Row>
            {endpoint.rejectedSinceLoad > 0 ? (
              <Row term="Rejected">
                {endpoint.rejectedSinceLoad}
                <span className="text-muted-foreground"> · last: {endpoint.lastRejectedReason}</span>
              </Row>
            ) : null}
          </dl>
        </ResourceDetailConfigurationSection>

        {endpoint.authMode === "bearer" ? null : <TestSender endpoint={endpoint} />}

        <ResourceActivitySection label="Deliveries">
          <ResourceDetailCollection className="divide-border/60">
            {deliveries.length === 0 ? (
              <p className="px-2 py-3 text-center text-sm text-muted-foreground">No deliveries yet.</p>
            ) : (
              deliveries.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} />)
            )}
          </ResourceDetailCollection>
        </ResourceActivitySection>
      </ResourceDetailStack>

      <Dialog open={confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete endpoint?</DialogTitle>
            <DialogDescription>“{endpoint.name}” and its delivery history will be permanently removed. Senders get 404.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const { deleted } = await rpc.call("webhooks_delete", { endpointId });
                  setConfirmDelete(false);
                  if (deleted) onDeleted();
                })
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ResourceDetailPage>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

function DeliveryUrlSection({ url, placeholderOrigin }: { url: string; placeholderOrigin: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <ResourceDefinitionSection
      label="Delivery URL"
      actions={<ResourceActionButton label="Copy URL" tooltipLabel={copied ? "Copied" : "Copy URL"} icon={copied ? "Check" : "Copy"} onClick={() => void copyToClipboard({ text: url }).then(setCopied)} />}
    >
      <ResourceDetailPanel surface="recessed">
        <code className="block select-all truncate px-3 py-2 font-mono text-xs leading-5 text-foreground" title={url}>{url}</code>
      </ResourceDetailPanel>
      {placeholderOrigin ? (
        <Notice tone="warning">Set a public base URL in the plugin settings to get the real origin.</Notice>
      ) : null}
    </ResourceDefinitionSection>
  );
}

/** Takes the signing secret that Slack regenerated. Slack secrets are imported, never generated. */
function SecretImport({ onSubmit, onCancel }: { onSubmit: (secret: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  return (
    <ResourceDetailPanel className="p-4">
      <form
        aria-label="Replace Slack signing secret"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <Field label="New Slack signing secret" hint="From Basic Information in your Slack app. The old one stops working.">
          {(control) => <Input {...control} type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} required autoFocus />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            Save secret
          </Button>
        </div>
      </form>
    </ResourceDetailPanel>
  );
}

/** A starting payload with every declared path filled by an empty value of its type. */
function samplePayload(endpoint: EndpointView): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const field of endpoint.fields) {
    const keys = field.path.split(".");
    let node = root;
    for (const key of keys.slice(0, -1)) {
      const next = node[key];
      node = (next !== null && typeof next === "object" ? next : (node[key] = {})) as Record<string, unknown>;
    }
    node[keys.at(-1)!] = field.type === "string" ? "" : field.type === "boolean" ? false : 0;
  }
  return root;
}

function TestSender({ endpoint }: { endpoint: EndpointView }) {
  const rpc = useWebhooksRpc();
  const [payload, setPayload] = useState(() => JSON.stringify(samplePayload(endpoint), null, 2));
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const send = async () => {
    setPending(true);
    try {
      const response = await rpc.call("webhooks_test", { endpointId: endpoint.id, payload: JSON.parse(payload) });
      setResult(`HTTP ${response.status}\n${JSON.stringify(response.body, null, 2)}`);
    } catch (cause) {
      setResult(cause instanceof SyntaxError ? "Invalid JSON." : messageOf(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <ResourceDefinitionSection label="Test delivery">
      <Field label="Payload" hint="Signed and sent to this endpoint. The action runs for real.">
        {(control) => <Textarea {...control} rows={5} spellCheck={false} className="font-mono text-xs" value={payload} onChange={(event) => setPayload(event.target.value)} />}
      </Field>
      <div>
        <Button variant="outline" size="sm" disabled={pending} onClick={send}>
          <Icon name={pending ? "Loading" : "Sent"} aria-hidden className={pending ? "size-3.5 animate-spin" : "size-3.5"} />
          Send test
        </Button>
      </div>
      {result === null ? null : (
        <ResourceDetailPanel surface="recessed">
          <pre role="status" className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-5 text-foreground">
            {result}
          </pre>
        </ResourceDetailPanel>
      )}
    </ResourceDefinitionSection>
  );
}

function DeliveryRow({ delivery }: { delivery: DeliveryView }) {
  const navigate = useBbNavigate();
  const details = [
    delivery.attempts > 1 ? `${delivery.attempts} attempts` : null,
    delivery.duplicates > 0 ? `${delivery.duplicates} duplicates dropped` : null,
  ].filter(Boolean);
  // The same line as an Automations run row: status glyph, time, then muted detail.
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
      <div className="flex min-h-7 min-w-0 items-center gap-2.5">
        <DeliveryStatusIcon status={delivery.status} tooltip={delivery.error ?? (delivery.automationRunStatus ? `Automation run: ${delivery.automationRunStatus}` : null)} />
        <span className="shrink-0 text-sm text-foreground" title={delivery.receivedAt}>
          {relativeTime(delivery.receivedAt)}
        </span>
        <span className="flex min-w-max flex-1 items-center gap-1.5 text-xs text-subtle-foreground">
          <span className="shrink-0">{deliveryStatusVisuals[delivery.status].label}</span>
          {details.length > 0 ? <span className="shrink-0 whitespace-nowrap">· {details.join(" · ")}</span> : null}
        </span>
        <span className="hidden min-w-0 truncate font-mono text-2xs text-subtle-foreground sm:inline">{delivery.id}</span>
        <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={!delivery.threadId} onClick={() => delivery.threadId && navigate.toThread(delivery.threadId)}>
          Open thread
          <Icon name="ArrowUpRight" aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
