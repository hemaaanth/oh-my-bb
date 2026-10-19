import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createAccountPoolPlugin } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function gateway() {
  let providers = [{ id: "hempi", info: { family: "agents" } }];
  let changed = () => {};
  let unsubscribed = false;
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "mgw-provider-"));
  const host = createFakePluginHost({ pluginId: "model-gateway", dataDir, sdk: {
    hosts: { list: async () => [{ id: "host-one", name: "One" }] },
    subscribe: (args) => {
      if (args.event === "system:changed") changed = () => args.callback({
        entity: "system", type: "changed", changes: ["provider-registrations-changed"],
      });
      return () => { unsubscribed = true; };
    },
    providers: { catalog: async () => providers },
    plugins: { list: async () => ({ plugins: [{ id: "model-gateway", enabled: true }] }) },
  } });
  await createAccountPoolPlugin({ fetch: async () => Response.json({}), importCodexCredentials: async () => ({
    accessToken: "fake-access", refreshToken: "fake-refresh", idToken: null,
    accountId: "fake-account", email: null, expiresAt: Date.now() + 3600000,
  }) })(host.bb);
  await host.harness.behavior.callRpc("account.add", { provider: "codex", source: { kind: "import" }, label: null, priority: 100 });
  const service = host.harness.behavior.runService("pi-providers");
  cleanups.push(async () => { service.controller.abort(); await service.done; await host.harness.lifecycle.dispose(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const env = (providerId: string, threadId = "thread-one") => host.harness.behavior.resolveProviderEnv(providerId, { threadId, projectId: "project-one", hostId: "host-one" });
  return { host, env, service, unsubscribed: () => unsubscribed,
    rescan(next: typeof providers) { providers = next; changed(); } };
}

it("loads and serves HTTP while provider discovery is blocked", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "mgw-provider-"));
  let releaseCatalog!: () => void;
  const pendingCatalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  const catalog = vi.fn(async () => { await pendingCatalog; return []; });
  const host = createFakePluginHost({ pluginId: "model-gateway", dataDir, sdk: {
    hosts: { list: async () => [] },
    providers: { catalog },
    subscribe: () => () => {},
    plugins: { list: async () => ({ plugins: [{ id: "model-gateway", enabled: true }] }) },
  } });
  cleanups.push(async () => {
    releaseCatalog();
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await createAccountPoolPlugin({ fetch: async () => Response.json({}) })(host.bb);
  expect(catalog).not.toHaveBeenCalled();
  const service = host.harness.behavior.runService("pi-providers");
  try {
    await vi.waitFor(() => expect(catalog).toHaveBeenCalledOnce());
    expect((await host.harness.behavior.fetchHttp("GET", "/v1/models")).status).toBe(401);
  } finally {
    service.controller.abort();
    releaseCatalog();
    await service.done;
  }
});

it("shares Pi routing across late providers, isolates threads, and makes removed ids inert", async () => {
  const gw = await gateway();
  const id = "agent-11111111-1111-4111-8111-111111111111";
  await vi.waitFor(async () => expect(await gw.env("hempi")).toHaveLength(2));
  const initial = await gw.env("hempi");
  expect(initial.map(({ name }) => name)).toEqual(["MODEL_GATEWAY_BASE_URL", "MODEL_GATEWAY_TOKEN"]);
  expect(initial[0]!.value).toEqual({ serverPath: "/api/v1/plugins/model-gateway/http/v1" });
  expect((await gw.env("hempi", "thread-two"))[1]!.value).not.toBe(initial[1]!.value);
  gw.rescan([{ id, info: { family: "agents" } }]);
  await vi.waitFor(async () => expect((await gw.env(id)).map(({ name }) => name)).toEqual(["MODEL_GATEWAY_BASE_URL", "MODEL_GATEWAY_TOKEN"]));
  expect(await gw.env("hempi")).toEqual([]);
  await gw.host.harness.behavior.callRpc("routing.set", { provider: "pi", enabled: false });
  expect(await gw.env(id)).toEqual([]);
  await gw.host.harness.behavior.callRpc("routing.set", { provider: "pi", enabled: true });
  await gw.host.harness.behavior.callRpc("bypass.set", { threadId: "thread-one", bypassed: true });
  expect(await gw.env(id)).toEqual([]);
  gw.service.controller.abort(); await gw.service.done;
  expect(gw.unsubscribed()).toBe(true);
});

it("gives Prime its own routing switch and rejects Claude OAuth chains", async () => {
  const gw = await gateway();
  const entries = await gw.env("acp-prime-agent");
  expect(entries[0]!.value).toEqual({ serverPath: "/api/v1/plugins/model-gateway/http/v1" });
  expect(entries[1]!.name).toBe("MODEL_GATEWAY_TOKEN");
  await expect(gw.host.harness.behavior.callRpc("chain.set", { harness: "acp-prime-agent", entries: ["claude-oauth:*"] })).rejects.toThrow(/claude-code/);
  await gw.host.harness.behavior.callRpc("routing.set", { provider: "acp-prime-agent", enabled: false });
  expect(await gw.env("acp-prime-agent")).toEqual([]);
  expect((await gw.env("pi")).map(({ name }) => name)).toEqual(["MODEL_GATEWAY_BASE_URL", "MODEL_GATEWAY_TOKEN"]);
});

it("returns host setup files over the schema RPC with the caller's server URL", async () => {
  const gw = await gateway();
  const result = await gw.host.harness.behavior.callRpc("host.setupFiles", { hostId: "remote-host", serverBaseUrl: "https://remote.example", piAgentDirs: [".pi/agent", ".profiles/sol"] }) as { files: Array<{ content: string; path: string }> };
  expect(result.files[0]!.content).toContain("https://remote.example/api/v1/plugins/model-gateway/http/v1");
  expect(result.files.map(({ path }) => path)).toEqual([".omp/agent/models.yml", ".pi/agent/extensions/model-gateway.js", ".profiles/sol/extensions/model-gateway.js"]);
});
