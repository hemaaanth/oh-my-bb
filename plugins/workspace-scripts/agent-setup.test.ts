import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const AGENT = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000001";
const context = { threadId: "th_setup", projectId: "proj_1", hostId: "host_1" };
const environment = { id: "env_1", hostId: "host_1", path: "/workspace", status: "ready" };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function saved(harness: FakePluginHarness) {
  const result = await harness.behavior.runCli(["agent-setup", "list"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout!) as { bindings: { profileId: string; source: string; workspacePath: string | null }[] };
}
async function fixture({ legacy = false, provider = "manual", profileId = AGENT, bound = true } = {}) {
  let manifest = JSON.stringify({ scripts: { prepare: { command: "printf prepared" } }, agentSetup: { script: "prepare", env: { EXAMPLE: "ready" } } });
  let currentEnvironment = { ...environment };
  let allowReads = true;
  let beforeApproval = () => {};
  const stages: unknown[] = [];
  let stage: (input: unknown) => Promise<unknown> = async input => {
    stages.push(input);
    return { setupScript: "/staged/agent-setup.py", env: { EXAMPLE: "ready" } };
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "workspace-scripts",
    sdk: {
      threads: { get: async () => ({ environmentId: "env_1" }) as never },
      environments: { get: async () => currentEnvironment as never, list: async () => [currentEnvironment] as never },
      files: { read: async () => {
        if (!allowReads) throw new Error("Unapproved workspace access");
        return { content: manifest, contentEncoding: "utf8" } as never;
      } },
      hosts: { get: async () => ({ id: "host_1", machineProviderId: provider }) as never },
      plugins: { callRpc: async args => {
        if (args.method === "listProfiles") {
          beforeApproval();
          return [{ id: AGENT, slug: "engineer", name: "Engineer" }, { id: OTHER, slug: "other", name: "Other" }] as never;
        }
        return { profileId, bound } as never;
      } },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "run_setup") return { exitCode: 7, stdout: "fixture output", stderr: "fixture failure" };
      return stage(input);
    },
  });
  if (legacy) await bb.storage.kv.set("security-tools-agents", [AGENT]);
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  return {
    bb, harness, stages,
    manifest(value: unknown) { manifest = JSON.stringify(value); },
    move(path: string) { currentEnvironment = { ...currentEnvironment, path }; },
    disallowReads() { allowReads = false; },
    stage(value: typeof stage) { stage = value; },
    beforeApproval(callback: () => void) {
      let lookups = 0;
      // CLI resolves the agent before previewing, then rechecks it before saving.
      beforeApproval = () => { if (++lookups === 2) callback(); };
    },
    async enable(id = AGENT) {
      return harness.behavior.runCli(["agent-setup", "enable", id], { threadId: "th_setup" });
    },
  };
}

describe("shared agent preparation", () => {
  it("keeps default startup and unconfigured turns independent of Agents", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workspace-scripts" });
    await plugin(bb);
    cleanups.push(() => harness.lifecycle.dispose());
    expect(harness.inspection.sdk.calls).toEqual([]);
    expect(await harness.behavior.resolveProviderEnv("agents", context)).toEqual([]);
    expect(harness.inspection.sdk.calls).toEqual([]);
    expect(harness.experimental_hostRpcCalls).toEqual([]);
  });

  it("migrates existing selections only to an immutable recipe and keeps their old machine restriction", async () => {
    const test = await fixture({ legacy: true });
    const result = await saved(test.harness);
    expect(result).toEqual({ bindings: [expect.objectContaining({ profileId: AGENT, source: "recipe", workspacePath: null })] });
    expect(await test.harness.behavior.resolveProviderEnv("agents", context)).toEqual([]);
    expect(test.stages).toEqual([]);
  });

  it("keeps a saved security recipe active across reload without reading workspace commands", async () => {
    const test = await fixture({ legacy: true, provider: "sandbox-daytona" });
    await saved(test.harness);
    const approved = await test.bb.storage.kv.get("agent-setup:v1");
    const reloaded = await test.harness.lifecycle.reload(plugin);
    cleanups.push(() => reloaded.harness.lifecycle.dispose());
    test.disallowReads();
    const values = await reloaded.harness.behavior.resolveProviderEnv("agents", context);
    expect(values.some(value => value.name === "AGENT_SETUP_SCRIPT")).toBe(true);
    expect(values.some(value => value.name === "AGENT_SETUP_ERROR")).toBe(false);
    expect(await reloaded.bb.storage.kv.get("agent-setup:v1")).toEqual(approved);
  });

  it("keeps ineligible migrated turns independent of optional Agents discovery", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspace-scripts",
      sdk: { hosts: { get: async () => ({ id: "host_1", machineProviderId: "manual" }) as never } },
    });
    await bb.storage.kv.set("security-tools-agents", [AGENT]);
    await plugin(bb);
    cleanups.push(() => harness.lifecycle.dispose());
    expect(await harness.behavior.resolveProviderEnv("agents", context)).toEqual([]);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });

  it("does not resurrect removed choices when an old migration key remains", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workspace-scripts" });
    await bb.storage.kv.set("security-tools-agents", [AGENT]);
    await bb.storage.kv.set("agent-setup:v1", { bindings: [], recipes: {} });
    await plugin(bb);
    cleanups.push(() => harness.lifecycle.dispose());
    expect(await saved(harness)).toEqual({ bindings: [] });
    expect(await harness.behavior.resolveProviderEnv("agents", context)).toEqual([]);
  });

  it("does not discard old authorizations when replacement data is invalid", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workspace-scripts" });
    await bb.storage.kv.set("security-tools-agents", [AGENT]);
    await bb.storage.kv.set("agent-setup:v1", { bindings: "invalid" });
    await plugin(bb);
    cleanups.push(() => harness.lifecycle.dispose());
    expect(await harness.behavior.runCli(["agent-setup", "list"])).toEqual(expect.objectContaining({ exitCode: 2 }));
    expect(await bb.storage.kv.get("security-tools-agents")).toEqual([AGENT]);
  });

  it("rejects a workspace move while CLI approval is being checked", async () => {
    const test = await fixture();
    test.beforeApproval(() => test.move("/unreviewed-location"));
    expect(await test.enable()).toEqual(expect.objectContaining({ exitCode: 2, stderr: expect.stringContaining("changed") }));
    expect(await saved(test.harness)).toEqual({ bindings: [] });
  });

  it("does not substitute workspace commands for a migrated security authorization", async () => {
    const test = await fixture({ legacy: true, provider: "sandbox-daytona" });
    test.disallowReads();
    const result = await test.harness.behavior.resolveProviderEnv("agents", context);
    expect(result.some(value => value.name === "AGENT_SETUP_SCRIPT")).toBe(true);
    expect(result.some(value => value.name === "AGENT_SETUP_ERROR")).toBe(false);
  });

  it("keeps workspace setup opt-in and supports ordinary hosts", async () => {
    const test = await fixture();
    await test.enable();
    expect(test.stages).toEqual([]);
    const values = await test.harness.behavior.resolveProviderEnv("agents", context);
    expect(values.some(value => value.name === "AGENT_SETUP_SCRIPT")).toBe(true);
    expect(test.stages).toEqual([expect.objectContaining({ cwd: "/workspace", recipe: expect.objectContaining({ command: "printf prepared" }) })]);
  });

  it.each([{ profileId: OTHER }, { bound: false }])("does not apply another agent's setup: %j", async options => {
    const test = await fixture(options);
    await test.enable();
    expect(await test.harness.behavior.resolveProviderEnv("agents", context)).toEqual([]);
    expect(test.stages).toEqual([]);
  });

  it("rejects changed commands and moved workspaces before staging", async () => {
    const test = await fixture();
    test.beforeApproval(() => test.manifest({ scripts: { prepare: { command: "printf changed" } }, agentSetup: { script: "prepare" } }));
    expect(await test.enable()).toEqual(expect.objectContaining({ exitCode: 2, stderr: expect.stringContaining("changed") }));
    test.beforeApproval(() => {});
    await test.enable();
    test.move("/different-workspace");
    expect(await test.harness.behavior.resolveProviderEnv("agents", context)).toEqual([expect.objectContaining({ name: "AGENT_SETUP_ERROR", value: expect.stringContaining("workspace changed") })]);
    expect(test.stages).toEqual([]);
  });

  it("requires approval again when an enabled recipe's environment changes", async () => {
    const test = await fixture();
    await test.enable();
    test.manifest({ scripts: { prepare: { command: "printf prepared" } }, agentSetup: { script: "prepare", env: { EXAMPLE: "different" } } });
    expect(await test.harness.behavior.resolveProviderEnv("agents", context)).toEqual([expect.objectContaining({ name: "AGENT_SETUP_ERROR", value: expect.stringContaining("changed") })]);
    expect(test.stages).toEqual([]);
  });

  it("retains concurrent owner changes and allows removal without optional discovery", async () => {
    const test = await fixture();
    await Promise.all([test.enable(AGENT), test.enable(OTHER)]);
    const both = await saved(test.harness);
    expect(both.bindings.map(value => value.profileId).sort()).toEqual([OTHER, AGENT].sort());
    test.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Agents is unavailable"); });
    expect(await test.harness.behavior.runCli(["agent-setup", "disable", AGENT])).toEqual(expect.objectContaining({ exitCode: 0 }));
    expect((await saved(test.harness)).bindings.map(value => value.profileId)).toEqual([OTHER]);
  });

  it("returns a required-setup error within Core's staging deadline", async () => {
    const test = await fixture();
    await test.enable();
    const pendingStage = Promise.withResolvers<unknown>();
    test.stage(() => pendingStage.promise);
    vi.useFakeTimers();
    const pending = test.harness.behavior.resolveProviderEnv("agents", context);
    await vi.advanceTimersByTimeAsync(3_501);
    expect(await pending).toEqual([expect.objectContaining({ name: "AGENT_SETUP_ERROR", value: expect.stringContaining("timed out") })]);
    pendingStage.resolve({ setupScript: "/unused.py", env: {} });
  });

  it("propagates preparation failure through the blocking CLI without requiring Agents", async () => {
    const test = await fixture();
    const result = await test.harness.behavior.runCli(["prepare"], { threadId: "th_setup" });
    expect(result).toEqual(expect.objectContaining({ exitCode: 7, stdout: "fixture output", stderr: "fixture failure" }));
    expect(test.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });
});
