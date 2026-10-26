// Panel data hooks. The server publishes `webhooks-changed` after every write
// and every delivery, so views refetch instead of polling.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { DeliveryView, EndpointView, IntegrationView, RpcContract } from "../contract.js";
import { messageOf } from "./ui.js";

/** Must match CHANGED_CHANNEL in contract.ts. The app does not bundle the contract module. */
export const CHANGED_CHANNEL = "webhooks-changed";
export const PANEL_PATH = "webhooks";

export type Overview = { endpoints: EndpointView[]; deliverPath: string; publicBaseUrl: string | null };

export const useWebhooksRpc = () => useRpc<RpcContract>();

export type Targets = {
  projects: { id: string; name: string }[];
  automations: { available: boolean; items: { id: string; name: string }[]; message: string | null };
  receivers: { pluginId: string; name: string; description: string | null }[];
};

function useLoaded<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    load().then(
      (value) => {
        setData(value);
        setError(null);
      },
      (cause) => setError(messageOf(cause)),
    );
  }, [load]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);
  return { data, error, refetch };
}

export function useOverview() {
  const rpc = useWebhooksRpc();
  return useLoaded<Overview>(useCallback(() => rpc.call("webhooks_overview", null), [rpc]));
}

export function useEndpoint(endpointId: string) {
  const rpc = useWebhooksRpc();
  return useLoaded<{ endpoint: EndpointView; deliveries: DeliveryView[] }>(
    useCallback(() => rpc.call("webhooks_get", { endpointId }), [rpc, endpointId]),
  );
}

export function useIntegrations() {
  const rpc = useWebhooksRpc();
  return useLoaded<IntegrationView[]>(useCallback(() => rpc.call("webhooks_integrations", null), [rpc]));
}

export function useTargets(projectId: string) {
  const rpc = useWebhooksRpc();
  const id = projectId.trim();
  return useLoaded<Targets>(useCallback(() => rpc.call("webhooks_targets", id ? { projectId: id } : {}), [rpc, id])).data;
}

export const deliveryUrl = (publicBaseUrl: string | null, endpoint: EndpointView) =>
  `${publicBaseUrl ?? "https://<your-public-origin>"}${endpoint.deliveryPath}`;

export function describeAction(endpoint: EndpointView): string {
  const action = endpoint.action;
  if (action.type === "send") return `Send to thread ${action.threadId}`;
  if (action.type === "spawn") return `Spawn a thread in project ${action.projectId}`;
  if (action.type === "plugin") return `Hand to plugin ${action.pluginId}`;
  return `Run automation ${action.automationId}`;
}
