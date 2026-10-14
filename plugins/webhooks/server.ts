// Webhooks plugin backend. One public route (POST /deliver), an optional
// loopback listener (POST /webhook/<id>) for a tunnel, owner-only RPC for the
// panel, and a `bb webhooks` CLI for agents.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANGED_CHANNEL, rpcContract, type EndpointView } from "./contract.js";
import { registerCli } from "./server/cli.js";
import { createDeliverer } from "./server/deliver.js";
import { LISTENER_PATH_PREFIX, keepListening, parseListenerPort } from "./server/listener.js";
import { MIGRATIONS } from "./server/migrations.js";
import { createService } from "./server/service.js";
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

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    publicBaseUrl: {
      type: "string",
      label: "Public base URL",
      description:
        "The HTTPS origin senders use, like https://hooks.example.com. Reload to apply.",
      default: "",
    },
    listenerPort: {
      type: "string",
      label: "Listener port",
      description:
        "Local port that serves /webhook/<id>. Point your tunnel here. Leave empty to turn it off. Reload to apply.",
      default: "",
    },
  });
  const values = await settings.get();
  const configured = values.publicBaseUrl;
  const publicBaseUrl = normalizeBaseUrl(configured) ?? normalizeBaseUrl(bb.server.experimental_appUrl);
  if (configured.trim() && normalizeBaseUrl(configured) === null) bb.log.warn("publicBaseUrl is not an https:// URL without query or credentials; it is ignored.");

  const db = bb.storage.database();
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createStore(db);

  const changed = (endpointId: string) => bb.realtime.publish(CHANGED_CHANNEL, { endpointId });
  const deliverer = createDeliverer(bb, store);
  const listener = openListener(bb, values.listenerPort, deliverer.handle);
  const publicPathOf = listener ? (endpointId: string) => `${LISTENER_PATH_PREFIX}${endpointId}` : undefined;
  const service = createService({ bb, store, deliverer, publicBaseUrl, publicPathOf, changed });
  const urlOf = (endpoint: EndpointView) => `${publicBaseUrl ?? "https://<your-public-origin>"}${endpoint.deliveryPath}`;

  deliverer.register();
  // Slack actions finish after their 200. Let them record a result before storage closes.
  bb.onDispose(async () => {
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
