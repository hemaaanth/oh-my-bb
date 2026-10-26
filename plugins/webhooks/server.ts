// Webhooks plugin backend. One public route (POST /deliver), an optional
// loopback listener (POST /webhook/<id>) for a tunnel, owner-only RPC for the
// panel, and a `bb webhooks` CLI for agents.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHANGED_CHANNEL, rpcContract, type EndpointView } from "./contract.js";
import { registerCli } from "./server/cli.js";
import { createDeliverer } from "./server/deliver.js";
import { createIntegrations } from "./server/integrations.js";
import { LISTENER_PATH_PREFIX, keepListening, parseListenerPort } from "./server/listener.js";
import { MIGRATIONS } from "./server/migrations.js";
import { createService, deliveryPathOf } from "./server/service.js";
import { createStore } from "./server/store.js";

export { rpcContract };
export type { RpcContract } from "./contract.js";

/** An origin like https://hooks.example.com, with no path, query, or credentials. */
export function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Shown in `bb plugin list` and the plugin page. BB has no way to clear the banner while the plugin
 * runs, so it stays until the next load even after the setting is fixed. Saved settings apply at once.
 */
function needsBaseUrlMessage(configured: string): string {
  const problem = configured.trim()
    ? "Public base URL is invalid and BB has no public HTTPS URL."
    : "Set a public HTTPS base URL for webhook deliveries.";
  return `${problem} Open Settings → Webhooks, then More → Setup guide. Route HTTPS through a tunnel or proxy to the listener or BB delivery route; a listener port alone is not public ingress. Set publicBaseUrl to that origin. Changes apply when saved; reload Webhooks to clear this warning (\`bb plugin reload webhooks\`).`;
}

const baseUrlSchema = z.string().refine((value) => !value.trim() || normalizeBaseUrl(value) !== null, "Use an https:// origin without credentials, query, or fragment, like https://hooks.example.com.");
const portSchema = z.string().refine((value) => parseListenerPort(value) !== "invalid", "Use a port from 1024 to 65535, or leave it empty to turn the listener off.");

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    publicBaseUrl: {
      type: "string",
      label: "Public base URL",
      description: "HTTPS origin for delivery URLs. Leave empty to use BB's public URL.",
      default: "",
      experimental_schema: baseUrlSchema,
    },
    listenerPort: {
      type: "string",
      label: "Listener port",
      description: "Local tunnel port for /webhook/<id>. Leave empty to disable.",
      default: "",
      experimental_schema: portSchema,
    },
  });
  const values = await settings.get();

  const resolveBaseUrl = (configured: string) => {
    const url = normalizeBaseUrl(configured) ?? normalizeBaseUrl(bb.server.experimental_appUrl);
    if (configured.trim() && normalizeBaseUrl(configured) === null) bb.log.warn("publicBaseUrl is not an https:// URL without query or credentials; it is ignored.");
    return url;
  };
  let publicBaseUrl = resolveBaseUrl(values.publicBaseUrl);
  let flagged = false;
  const checkConfiguration = (configured: string) => {
    if (publicBaseUrl !== null || flagged) return;
    flagged = true;
    bb.status.needsConfiguration(needsBaseUrlMessage(configured));
  };
  checkConfiguration(values.publicBaseUrl);

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createStore(db);

  const changed = (endpointId?: string) => bb.realtime.publish(CHANGED_CHANNEL, endpointId ? { endpointId } : {});
  const integrations = await createIntegrations(bb, store, () => changed());
  const deliverer = createDeliverer(bb, store, integrations);
  let listener = openListener(bb, values.listenerPort, deliverer.handle);
  const publicPathOf = (endpointId: string) => (listener ? `${LISTENER_PATH_PREFIX}${endpointId}` : deliveryPathOf(endpointId));
  const service = createService({ bb, store, deliverer, integrations, publicBaseUrl: () => publicBaseUrl, publicPathOf, changed });
  const urlOf = (endpoint: EndpointView) => `${publicBaseUrl ?? "https://<your-public-origin>"}${endpoint.deliveryPath}`;

  // Settings apply live: a new origin changes the URLs shown, and a new port reopens the listener.
  // Changes run one at a time, so a quick second save waits for the first listener to close.
  let disposed = false;
  let applying = Promise.resolve();
  settings.onChange((next, prev) => {
    applying = applying
      .then(async () => {
        if (disposed) return;
        if (next.publicBaseUrl !== prev.publicBaseUrl) publicBaseUrl = resolveBaseUrl(next.publicBaseUrl);
        if (next.listenerPort !== prev.listenerPort) {
          await listener?.close();
          listener = openListener(bb, next.listenerPort, deliverer.handle);
        }
        checkConfiguration(next.publicBaseUrl);
        changed();
      })
      .catch((error) => bb.log.error(`could not apply settings: ${error instanceof Error ? error.message : String(error)}`));
  });

  deliverer.register();
  // Slack actions finish after their 200. Let them record a result before storage closes.
  bb.onDispose(async () => {
    disposed = true;
    await applying;
    await listener?.close();
    await deliverer.settled(10_000);
  });

  bb.rpc.register(rpcContract, {
    webhooks_overview: () => service.overview(),
    webhooks_get: ({ endpointId }) => service.get(endpointId),
    webhooks_create: (input) => service.create(input),
    webhooks_update: (input) => service.update(input),
    webhooks_set_enabled: ({ endpointId, enabled }) => service.setEnabled(endpointId, enabled),
    webhooks_delete: ({ endpointId }) => service.delete(endpointId),
    webhooks_rotate_secret: (input) => service.rotateSecret(input),
    webhooks_deliveries: ({ endpointId, limit }) => service.deliveries(endpointId, limit),
    webhooks_test: (input) => service.test(input),
    webhooks_targets: (input) => service.targets(input),
    webhooks_integrations: () => integrations.list(),
    webhooks_set_integration: async ({ pluginId, enabled }) => {
      await integrations.setEnabled(pluginId, enabled);
      return null;
    },
  });

  registerCli(bb, service, urlOf);

  bb.background.schedule("prune-deliveries", "17 3 * * *", () => {
    const removed = store.prune(new Date());
    if (removed > 0) bb.log.info(`pruned ${removed} old deliveries`);
  });

  if (publicBaseUrl === null) bb.log.info("no public base URL set; delivery URLs show a placeholder origin");
}

/** Starts the loopback listener when its port is set. A failure is logged and leaves only the BB route. */
function openListener(bb: BbPluginApi, value: string, handle: Parameters<typeof keepListening>[0]["handle"]): { close: () => Promise<void> } | null {
  const port = parseListenerPort(value);
  if (port === null) return null;
  if (port === "invalid") {
    bb.log.warn("listenerPort must be a port from 1024 to 65535; the webhook listener is off.");
    return null;
  }
  return keepListening({
    port,
    handle,
    onError: (reason) => bb.log.warn(`webhook listener request failed reason=${reason}`),
    onListening: (actual) => bb.log.info(`webhook listener on 127.0.0.1:${actual}`),
    onGiveUp: (reason) => bb.log.warn(`webhook listener could not start on 127.0.0.1:${port}: ${reason}`),
  });
}
