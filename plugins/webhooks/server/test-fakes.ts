// Test-only plugin host with recorded thread, project, Automations, and receiver plugin calls.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { vi } from "vitest";
import plugin from "../server.js";
import { signSlackRequest, signStandardWebhook } from "./auth.js";

export const LOOPBACK = "http://127.0.0.1:47011";
export const PROJECT = "proj_test";
export const THREAD = "thr_target";

type RpcCall = { pluginId: string; method: string; input: Record<string, unknown> };

export async function webhooksHost(options: { settings?: Record<string, string>; appUrl?: string | null } = {}) {
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
  const spawned: Array<Record<string, unknown>> = [];
  const rpcCalls: RpcCall[] = [];
  const archived = new Set<string>();
  /** When set, the next actions (send, spawn, automations_run) throw this. */
  const failure: { error: Error | null } = { error: null };
  /** automations_list / automations_get answers. Null means the plugin is missing. */
  const automations: { items: Array<{ id: string; name: string; problem?: string }> | null } = {
    items: [{ id: "auto_daily", name: "Daily triage" }, { id: "auto_broken", name: "Broken", problem: "missing-agent-prompt" }],
  };
  /** Plugins that publish webhooks_receive. A receiver answers with `{ threadId }`. */
  const receivers: { plugins: Array<{ pluginId: string; displayName: string }> } = { plugins: [{ pluginId: "receiver", displayName: "Receiver" }] };
  let runs = 0;

  const { bb, harness } = createFakePluginHost({
    pluginId: "webhooks",
    loopbackBaseUrl: LOOPBACK,
    appUrl: options.appUrl ?? null,
    ...(options.settings ? { settings: options.settings } : {}),
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (!threadId.startsWith("thr_")) throw Object.assign(new Error("not found"), { status: 404 });
          return { id: threadId, projectId: PROJECT, archivedAt: archived.has(threadId) ? 1_790_000_000_000 : null } as never;
        },
        send: async ({ threadId, mode, input }) => {
          if (failure.error) throw failure.error;
          sent.push({ threadId, mode, text: input.map((part) => (part.type === "text" ? part.text : "")).join("") });
          return { ok: true, delivery: "sent" } as never;
        },
        spawn: async (input) => {
          if (failure.error) throw failure.error;
          spawned.push(input as unknown as Record<string, unknown>);
          return { id: `thr_spawned_${spawned.length}` } as never;
        },
      },
      projects: {
        get: async ({ projectId }) => {
          if (projectId !== PROJECT) throw Object.assign(new Error("not found"), { status: 404 });
          return { id: projectId, name: "Test Project" } as never;
        },
        list: async () => [{ id: PROJECT, name: "Test Project" }] as never,
      },
      plugins: {
        experimental_discoverRpc: async ({ pluginId, method } = {}) =>
          receivers.plugins
            .filter((plugin) => (pluginId === undefined || plugin.pluginId === pluginId) && (method === undefined || method === "webhooks_receive"))
            .map((plugin) => ({ ...plugin, method: "webhooks_receive", methodDescription: null, registrationDescription: "Takes test deliveries.", inputSchema: {}, outputSchema: {} })),
        callRpc: async ({ pluginId, method, input }) => {
          rpcCalls.push({ pluginId, method, input: input as Record<string, unknown> });
          if (receivers.plugins.some((plugin) => plugin.pluginId === pluginId)) {
            if (method !== "webhooks_receive") throw new Error(`unexpected method ${method}`);
            if (failure.error) throw failure.error;
            return { threadId: "thr_received" };
          }
          if (pluginId !== "automations" || automations.items === null) throw new Error("plugin automations is not available");
          const { automationId } = input as { automationId?: string };
          if (method === "automations_list") return automations.items;
          if (method === "automations_get") {
            const found = automations.items.find((item) => item.id === automationId);
            if (!found) throw new Error("automation not found");
            return found;
          }
          if (method === "automations_run") {
            if (failure.error) throw failure.error;
            runs += 1;
            return { run: { id: `run_${runs}`, status: "running", threadId: `thr_run_${runs}` } };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    },
  });
  await plugin(bb);

  // service.test() posts to bb.server.loopbackBaseUrl; route that into the fake host.
  const prefix = `${LOOPBACK}/api/v1/plugins/webhooks/http`;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (!href.startsWith(prefix)) throw new Error(`unexpected fetch ${href}`);
    return harness.behavior.fetchHttp(init?.method ?? "GET", href.slice(prefix.length), init);
  });

  return { bb, harness, sent, spawned, rpcCalls, archived, failure, automations, receivers };
}

export type Host = Awaited<ReturnType<typeof webhooksHost>>;

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** POSTs a Standard Webhooks request the way PostHog sends one. */
export function postSigned(
  host: Host,
  endpointId: string,
  secret: string,
  payload: unknown,
  options: { id?: string; timestamp?: number; headers?: Record<string, string>; body?: string } = {},
) {
  const body = options.body ?? JSON.stringify(payload);
  const id = options.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = options.timestamp ?? nowSeconds();
  return host.harness.behavior.fetchHttp("POST", `/deliver?endpoint=${endpointId}`, {
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signStandardWebhook({ secret, id, timestamp, body }),
      ...options.headers,
    },
    body,
  });
}

export function postBearer(host: Host, endpointId: string, token: string | null, payload: unknown, headers: Record<string, string> = {}) {
  return host.harness.behavior.fetchHttp("POST", `/deliver?endpoint=${endpointId}`, {
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(payload),
  });
}

/** POSTs a request signed the way Slack signs Events API, slash command, and interaction requests. */
export function postSlack(
  host: Host,
  endpointId: string,
  secret: string,
  body: string,
  options: { form?: boolean; timestamp?: number; headers?: Record<string, string> } = {},
) {
  const timestamp = options.timestamp ?? nowSeconds();
  return host.harness.behavior.fetchHttp("POST", `/deliver?endpoint=${endpointId}`, {
    headers: {
      "content-type": options.form ? "application/x-www-form-urlencoded" : "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signSlackRequest({ secret, timestamp, body }),
      ...options.headers,
    },
    body,
  });
}

/** A made-up Slack signing secret: 32 lowercase hex characters, like the real ones. */
export const SLACK_SECRET = "0123456789abcdef0123456789abcdef";

export const slackEventsConfig = (overrides: Record<string, unknown> = {}) => ({
  name: "Slack mentions",
  authMode: "slack",
  fields: [
    { name: "event_id", path: "event_id", type: "string", required: true, maxLength: 100 },
    { name: "event_type", path: "event.type", type: "string", required: true, maxLength: 100 },
    { name: "user", path: "event.user", type: "string", maxLength: 100 },
    { name: "text", path: "event.text", type: "string", maxLength: 4000 },
  ],
  dedupe: { source: "field", field: "event_id" },
  action: { type: "send", threadId: THREAD, message: "Slack {{event_type}} from {{user}}: {{text}}" },
  ...overrides,
});

export type Created = { endpoint: { id: string; secretHint: string; authMode: string }; secret: string | null };

export const sendConfig = (overrides: Record<string, unknown> = {}) => ({
  name: "PostHog alerts",
  authMode: "standard-webhooks",
  fields: [
    { name: "event", path: "event.event", type: "string", required: true, maxLength: 100 },
    { name: "person", path: "person.properties.email", type: "string" },
  ],
  dedupe: { source: "webhook-id" },
  action: { type: "send", threadId: THREAD, message: "Event {{event}} from {{person}}." },
  ...overrides,
});

export async function createEndpoint(host: Host, config: Record<string, unknown> = sendConfig(), secret?: string): Promise<Created> {
  return (await host.harness.behavior.callRpc("webhooks_create", { config, ...(secret ? { secret } : {}) })) as Created;
}
