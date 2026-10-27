/// <reference lib="es2024.promise" />
import { setImmediate as nextTurn } from "node:timers/promises";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { fakeExecutor } from "./test-support/executor-fake.js";
import { CatalogStore } from "./store.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); vi.unstubAllGlobals(); });
const PROFILE = "11111111-1111-4111-8111-111111111111";
function fixture(configured = false) {
  const host = createFakePluginHost({ pluginId: "catalog", settings: configured ? { executorUrl: "https://executor.test", executorApiKey: "key" } : {}, sdk: {
    projects: { list: async () => [{ id: "fixture-project", name: "Fixture project", kind: "standard", gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] }] },
    hosts: { list: async () => [] }, threads: { list: async () => [] },
    system: { config: async () => ({ primaryHostId: null, dataDir: "/tmp/catalog-settings-test" }) as never },
    plugins: { callRpc: async ({ method }) => {
      if (method === "catalogContextForThread") return { profileId: PROFILE, bound: true };
      if (method === "listProfiles") return [{ id: PROFILE, slug: "fixture-profile" }];
      throw new Error("No assignment source is installed");
    } },
  } });
  cleanups.push(() => host.harness.lifecycle.dispose());
  return host;
}

describe("Catalog settings boundaries", () => {
  it("opens settings without sibling probes, initialization, materialization or remote checks", async () => {
    const fetcher = vi.fn(async () => { throw new Error("A view cannot invoke a remote service"); });
    vi.stubGlobal("fetch", fetcher);
    const { bb, harness } = fixture();
    await plugin(bb);
    expect(await harness.behavior.callRpc("preferences", null)).toEqual({ agentsIntegration: false });
    expect(await harness.behavior.callRpc("catalogOverview", null)).toMatchObject({ assignments: null, assignmentState: { state: "uninitialized" } });
    expect(await harness.behavior.callRpc("executorConfiguration", null)).toEqual({ configured: false, url: null, mappings: [] });
    await harness.behavior.callRpc("executorConnections", null);
    harness.inspection.registrations.agentConfigurationProvider!(makePluginAgentConfigurationContext());
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    for (const method of ["files.mkdir", "files.write", "files.remove"]) expect(harness.inspection.sdk.callsTo(method)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await bb.storage.kv.get("preferences")).toBeUndefined();
    expect(bb.storage.database().prepare("SELECT COUNT(*) AS n FROM catalog_assignment_authority").get()).toEqual({ n: 0 });
  });

  it("preserves saved false, legacy mapped-profile consent, keys and toolkit maps across reload", async () => {
    const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const host = fixture(true);
    const map = { [`agent:${PROFILE}`]: ["fixture"], "*": ["fixture"] };
    await host.bb.storage.kv.set("executor-toolkits", map);
    await plugin(host.bb);
    expect(await host.harness.behavior.callRpc("preferences", null)).toEqual({ agentsIntegration: true });
    expect(await host.bb.storage.kv.get("preferences")).toBeUndefined();
    await host.harness.behavior.callRpc("updatePreferences", { agentsIntegration: false });
    const reloaded = await host.harness.lifecycle.reload(plugin);
    cleanups.push(() => reloaded.harness.lifecycle.dispose());
    expect(await reloaded.harness.behavior.callRpc("preferences", null)).toEqual({ agentsIntegration: false });
    expect(await reloaded.bb.storage.kv.get("executor-toolkits")).toEqual(map);
    expect(await reloaded.harness.behavior.callRpc("executorConfiguration", null)).toMatchObject({ configured: true });
    await reloaded.harness.behavior.callAgentTool("executor_execute", { code: "fixture" }, { projectId: "fixture-project", threadId: "fixture-thread" });
    expect(reloaded.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });

  it("binds the all-scope settings getter and toolkit mutations to the client channel", async () => {
    const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = fixture(true);
    await bb.storage.kv.set("executor-toolkits", { "plugin:example-worker": ["fixture"] });
    await plugin(bb);
    const options = { experimental_caller: { kind: "plugin" as const, pluginId: "other-worker" } };
    const before = executor.calls.length;
    await expect(harness.behavior.callRpc("executorConfiguration", null, options)).rejects.toBeInstanceOf(Error);
    await expect(harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: ["fixture"], expectedToolkits: [] }, options)).rejects.toBeInstanceOf(Error);
    expect(executor.calls).toHaveLength(before);
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({ "plugin:example-worker": ["fixture"] });
    const metadata = await harness.behavior.callRpc("executorConfiguration", null);
    expect(metadata).toEqual({ configured: true, url: "https://executor.test", mappings: [{ scope: "plugin", targetId: "example-worker", toolkits: ["fixture"] }] });
    expect(executor.calls).toHaveLength(before);
  });

  it("saves toolkit choices through the native API and permits revocation with an optional source off", async () => {
    const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = fixture(true);
    await bb.storage.kv.set("executor-toolkits", { [`agent:${PROFILE}`]: ["fixture"] });
    await bb.storage.kv.set("preferences", { agentsIntegration: false });
    await plugin(bb);
    await expect(harness.behavior.callRpc("setExecutorToolkits", { scope: "agent", targetId: PROFILE, toolkits: ["fixture"], expectedToolkits: ["fixture"] })).rejects.toThrow("Enable Agents");
    await harness.behavior.callRpc("setExecutorToolkits", { scope: "agent", targetId: PROFILE, toolkits: [], expectedToolkits: ["fixture"] });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await harness.behavior.callRpc("setExecutorToolkits", { scope: "project", targetId: "fixture-project", toolkits: ["fixture"], expectedToolkits: [] });
    expect(await harness.behavior.callAgentTool("executor_execute", { code: "fixture" }, { projectId: "fixture-project", threadId: "fixture-thread" })).toBe("ran execute");
    await expect(harness.behavior.callRpc("setExecutorToolkits", { scope: "project", targetId: "fixture-project", toolkits: ["missing"], expectedToolkits: ["fixture"] })).rejects.toThrow("no toolkit named missing");
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({ "fixture-project": ["fixture"] });
  });

  it("persists a later false after an earlier opt-in has a delayed KV write", async () => {
    const { bb, harness } = fixture();
    await plugin(bb);
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    let delayed = false;
    vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === "preferences" && (value as { agentsIntegration: boolean }).agentsIntegration && !delayed) {
        delayed = true;
        started.resolve();
        await gate.promise;
      }
      return set(key, value);
    });
    const optIn = harness.behavior.callRpc("updatePreferences", { agentsIntegration: true });
    await started.promise;
    const revoke = harness.behavior.callRpc("updatePreferences", { agentsIntegration: false });
    await nextTurn();
    gate.resolve();
    await Promise.all([optIn, revoke]);
    expect(await harness.behavior.callRpc("preferences", null)).toEqual({ agentsIntegration: false });
    expect(await bb.storage.kv.get("preferences")).toEqual({ agentsIntegration: false });
    const reloaded = await harness.lifecycle.reload(plugin);
    cleanups.push(() => reloaded.harness.lifecycle.dispose());
    expect(await reloaded.harness.behavior.callRpc("preferences", null)).toEqual({ agentsIntegration: false });
  });

  it("rejects stale renames rather than restoring weekly checks or removed custom-set skills", async () => {
    const { bb, harness } = fixture();
    await plugin(bb);
    const store = new CatalogStore(bb.storage.database());
    const sourceFields = { name: "Fixture source", repositoryUrl: "https://example.invalid/skills.git", gitRef: "main", subdirectory: "", updatePolicy: "review" as const, enabled: true };
    const source = await harness.behavior.callRpc("saveSource", sourceFields);
    await harness.behavior.callRpc("saveSource", { ...sourceFields, id: source.id, expected: sourceFields, enabled: false });
    await expect(harness.behavior.callRpc("saveSource", { ...sourceFields, id: source.id, expected: sourceFields, name: "Stale rename" })).rejects.toThrow("source changed");
    await expect(harness.behavior.callRpc("saveSource", { ...sourceFields, id: source.id, name: "Old client rename" })).rejects.toThrow("source changed");
    expect(store.requireSource(source.id)).toMatchObject({ name: "Fixture source", enabled: false });
    await harness.behavior.callRpc("saveSource", { ...sourceFields, id: source.id, enabled: false, name: "Current rename", expected: { ...sourceFields, enabled: false } });
    expect(store.requireSource(source.id)).toMatchObject({ name: "Current rename", enabled: false });

    store.saveRelease(source.id, "fixture-revision", [{ skillId: "fixture", name: "Fixture skill", description: "Synthetic safe skill", relativePath: "fixture", digest: "fixture-digest", files: [{ path: "SKILL.md", content: "Synthetic fixture", contentEncoding: "utf8" }] }], true);
    const skill = store.listApprovedSkills()[0]!;
    const bundleFields = { name: "Fixture set", description: "Synthetic set", skillIds: [skill.id] };
    const bundle = await harness.behavior.callRpc("saveBundle", bundleFields);
    await harness.behavior.callRpc("saveBundle", { ...bundleFields, id: bundle.id, expected: bundleFields, skillIds: [] });
    await expect(harness.behavior.callRpc("saveBundle", { ...bundleFields, id: bundle.id, expected: bundleFields, name: "Stale set rename" })).rejects.toThrow("custom set changed");
    expect(store.requireBundle(bundle.id)).toMatchObject({ name: "Fixture set", skillIds: [] });
    await harness.behavior.callRpc("saveBundle", { ...bundleFields, id: bundle.id, name: "Current set rename", skillIds: [], expected: { ...bundleFields, skillIds: [] } });
    expect(store.requireBundle(bundle.id)).toMatchObject({ name: "Current set rename", skillIds: [] });
  });

  it("rejects stale toolkit grants before remote lookup while allowing an explicit clear", async () => {
    const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = fixture(true);
    await plugin(bb);
    await harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: ["fixture"], expectedToolkits: [] });
    await harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: [], expectedToolkits: ["fixture"] });
    const before = executor.calls.length;
    await expect(harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: ["fixture"], expectedToolkits: ["fixture"] })).rejects.toThrow("mapping changed");
    expect(executor.calls).toHaveLength(before);
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({});
    await harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: ["fixture"], expectedToolkits: [] });
    await harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: [], expectedToolkits: [] });
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({});
  });

  it("keeps a later toolkit revocation after an earlier grant waits for metadata", async () => {
    const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let held = false;
    let armed = false;
    vi.stubGlobal("fetch", (async (input, init) => {
      if (armed && !held && new URL(String(input)).pathname === "/api/toolkits") {
        held = true;
        started.resolve();
        await gate.promise;
      }
      return executor.fetcher(input, init);
    }) as typeof fetch);
    const { bb, harness } = fixture(true);
    await plugin(bb);
    armed = true;
    const grant = harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: ["fixture"], expectedToolkits: [] });
    await started.promise;
    const revoke = harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: [], expectedToolkits: [] });
    await nextTurn();
    gate.resolve();
    await Promise.all([grant, revoke]);
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({});
    expect(await harness.behavior.callRpc("executorConfiguration", null)).toMatchObject({ mappings: [] });
  });

  it("does not install an in-memory toolkit grant when its durable save fails", async () => {
    const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = fixture(true);
    await plugin(bb);
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === "executor-toolkits") throw new Error("Synthetic storage unavailable");
      return set(key, value);
    });
    await expect(harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: ["fixture"], expectedToolkits: [] })).rejects.toThrow("storage unavailable");
    expect(await harness.behavior.callRpc("executorConfiguration", null)).toMatchObject({ mappings: [] });
    expect(await bb.storage.kv.get("executor-toolkits")).toBeUndefined();
  });

  it("reports committed grants and offline revocations when advisory metadata refresh fails", async () => {
    const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
    const detailPath = "/api/toolkits/tk_0/connections";
    const upstreamBody = "Synthetic upstream detail body must not enter the saved-state warning";
    const requests: string[] = [];
    let offline = false;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (offline || path === detailPath) return new Response(upstreamBody, { status: 503 });
      return executor.fetcher(input, init);
    });
    const { bb, harness } = fixture(true);
    await plugin(bb);
    const warn = vi.spyOn(bb.log, "warn");
    await expect(harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: ["fixture"], expectedToolkits: [] })).resolves.toEqual({ ok: true });
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({ "*": ["fixture"] });
    expect(await harness.behavior.callRpc("executorConfiguration", null)).toMatchObject({ mappings: [{ scope: "global", targetId: "*", toolkits: ["fixture"] }] });
    expect(requests.filter((path) => path === detailPath)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    offline = true;
    const beforeClear = requests.length;
    await expect(harness.behavior.callRpc("setExecutorToolkits", { scope: "global", targetId: "*", toolkits: [], expectedToolkits: ["fixture"] })).resolves.toEqual({ ok: true });
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({});
    expect(await harness.behavior.callRpc("executorConfiguration", null)).toMatchObject({ mappings: [] });
    expect(requests.length - beforeClear).toBeLessThanOrEqual(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(upstreamBody);
  });

  it("keeps existing large mappings readable and revocable without Executor", async () => {
    const fetcher = vi.fn(async () => { throw new Error("Revocation cannot require a remote service"); });
    vi.stubGlobal("fetch", fetcher);
    const { bb, harness } = fixture();
    const toolkits = Array.from({ length: 150 }, (_, index) => `fixture-${index}`);
    await bb.storage.kv.set("executor-toolkits", { "plugin:example-worker": toolkits });
    await plugin(bb);
    const configuration = await harness.behavior.callRpc("executorConfiguration", null);
    const mapping = configuration.mappings[0]!;
    await harness.behavior.callRpc("setExecutorToolkits", { ...mapping, toolkits: [], expectedToolkits: mapping.toolkits });
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({});
    const reloaded = await harness.lifecycle.reload(plugin);
    cleanups.push(() => reloaded.harness.lifecycle.dispose());
    expect(await reloaded.harness.behavior.callRpc("executorConfiguration", null)).toMatchObject({ configured: false, mappings: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a later project revocation after an earlier grant waits for native metadata", async () => {
    const executor = fakeExecutor({ toolkits: { fixture: ["fixture.*"] } });
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = fixture(true);
    await plugin(bb);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    harness.sdk.stub("projects.list", async () => {
      entered.resolve();
      await gate.promise;
      return [{ id: "fixture-project", name: "Fixture project", kind: "standard", gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] }];
    });
    const grant = harness.behavior.callRpc("setExecutorToolkits", { scope: "project", targetId: "fixture-project", toolkits: ["fixture"], expectedToolkits: [] });
    await entered.promise;
    const revoke = harness.behavior.callRpc("setExecutorToolkits", { scope: "project", targetId: "fixture-project", toolkits: [], expectedToolkits: [] });
    await nextTurn();
    gate.resolve();
    await Promise.all([grant, revoke]);
    expect(await bb.storage.kv.get("executor-toolkits")).toEqual({});
    expect(await harness.behavior.callRpc("executorConfiguration", null)).toMatchObject({ mappings: [] });
  });
});
