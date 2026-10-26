import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryView, EndpointView, IntegrationView } from "../contract.js";
import plugin from "../server.js";
import { PROJECT, createEndpoint, postSigned, sendConfig, webhooksHost, type Host } from "./test-fakes.js";

let host: Host;
beforeEach(async () => { host = await webhooksHost(); });
afterEach(async () => {
  await host.harness.lifecycle.dispose();
  vi.unstubAllGlobals();
});
const toggle = (pluginId: string, enabled: boolean) => host.harness.behavior.callRpc("webhooks_set_integration", { pluginId, enabled });
const integrations = () => host.harness.behavior.callRpc("webhooks_integrations", null) as Promise<IntegrationView[]>;
const targets = () => host.harness.behavior.callRpc("webhooks_targets", { projectId: PROJECT }) as Promise<{ receivers: Array<{ pluginId: string }>; automations: { available: boolean } }>;
const receiverConfig = () => sendConfig({ action: { type: "plugin", pluginId: "receiver" } });
const payload = { event: { event: "signup" } };

describe("optional integrations", () => {
  it("requires opt-in before offering or calling installed integrations", async () => {
    expect(await targets()).toMatchObject({ receivers: [], automations: { available: false } });
    await expect(createEndpoint(host, receiverConfig())).rejects.toBeInstanceOf(Error);
    await expect(createEndpoint(host, sendConfig({ action: { type: "automation", projectId: PROJECT, automationId: "auto_daily" } }))).rejects.toBeInstanceOf(Error);
    expect(host.rpcCalls).toEqual([]);
    await toggle("receiver", true);
    expect((await targets()).receivers).toEqual([{ pluginId: "receiver", name: "Receiver", description: "Takes test deliveries." }]);
    const { endpoint, secret } = await createEndpoint(host, receiverConfig());
    expect((await postSigned(host, endpoint.id, secret!, payload)).status).toBe(200);
    expect(host.rpcCalls.filter((call) => call.method === "webhooks_receive")).toHaveLength(1);
  });

  it("stops dispatch when disabled, persists that choice, and resumes the same hook and secret", async () => {
    await toggle("receiver", true);
    const { endpoint, secret } = await createEndpoint(host, receiverConfig());
    await toggle("receiver", false);
    host = { ...host, ...await host.harness.lifecycle.reload(plugin) };
    expect((await targets()).receivers).toEqual([]);
    expect((await postSigned(host, endpoint.id, secret!, payload, { id: "paused_event" })).status).toBe(502);
    expect(host.rpcCalls).toEqual([]);
    const retained = await host.harness.behavior.callRpc("webhooks_get", { endpointId: endpoint.id }) as { endpoint: EndpointView; deliveries: DeliveryView[] };
    expect(retained.endpoint.action).toEqual({ type: "plugin", pluginId: "receiver" });
    expect(retained.endpoint.secretHint).toBe(endpoint.secretHint);
    expect(retained.deliveries[0]).toMatchObject({ status: "failed", attempts: 1 });
    await toggle("receiver", true);
    expect((await postSigned(host, endpoint.id, secret!, payload, { id: "paused_event" })).status).toBe(200);
    expect(host.rpcCalls.filter((call) => call.method === "webhooks_receive")).toHaveLength(1);
    const resumed = await host.harness.behavior.callRpc("webhooks_get", { endpointId: endpoint.id }) as { deliveries: DeliveryView[] };
    expect(resumed.deliveries[0]).toMatchObject({ status: "succeeded", attempts: 2, threadId: "thr_received" });
  });

  it("preserves integrations used by hooks when upgrading from before opt-in preferences", async () => {
    await Promise.all([toggle("receiver", true), toggle("automations", true)]);
    const receiver = await createEndpoint(host, receiverConfig());
    const automation = await createEndpoint(host, sendConfig({ action: { type: "automation", projectId: PROJECT, automationId: "auto_daily" } }));
    await host.bb.storage.kv.delete("enabled-integrations");
    host = { ...host, ...await host.harness.lifecycle.reload(plugin) };
    expect((await integrations()).filter((entry) => entry.enabled).map((entry) => entry.pluginId).sort()).toEqual(["automations", "receiver"]);
    expect((await postSigned(host, receiver.endpoint.id, receiver.secret!, payload)).status).toBe(200);
    expect((await postSigned(host, automation.endpoint.id, automation.secret!, payload)).status).toBe(200);
    expect(host.rpcCalls.filter((call) => ["webhooks_receive", "automations_run"].includes(call.method)).map((call) => call.method).sort()).toEqual(["automations_run", "webhooks_receive"]);
  });

  it("offers only enabled installed receivers, without losing preferences when a receiver is disabled in BB", async () => {
    await toggle("receiver", true);
    host.installed.plugins.find((entry) => entry.id === "receiver")!.enabled = false;
    expect((await targets()).receivers).toEqual([]);
    await expect(toggle("receiver", true)).rejects.toBeInstanceOf(Error);
    await expect(toggle("webhooks", true)).rejects.toBeInstanceOf(Error);
    host.installed.plugins.find((entry) => entry.id === "receiver")!.enabled = true;
    expect((await targets()).receivers.map((entry) => entry.pluginId)).toEqual(["receiver"]);
    host.receivers.plugins = [];
    expect((await targets()).receivers).toEqual([]);
    await expect(toggle("receiver", true)).rejects.toBeInstanceOf(Error);
  });

  it("retains independent opt-ins across concurrent changes and reloads", async () => {
    await Promise.all([toggle("receiver", true), toggle("automations", true)]);
    host = { ...host, ...await host.harness.lifecycle.reload(plugin) };
    expect(await targets()).toMatchObject({ receivers: [{ pluginId: "receiver" }], automations: { available: true } });
    await Promise.all([toggle("receiver", false), toggle("automations", false)]);
    host = { ...host, ...await host.harness.lifecycle.reload(plugin) };
    expect(await targets()).toMatchObject({ receivers: [], automations: { available: false } });
  });
});
