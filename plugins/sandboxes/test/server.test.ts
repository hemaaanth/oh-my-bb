import {
  createFakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../src/server.js";

describe("sandboxes plugin server", () => {

  it("loads unconfigured without touching provider services", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "sandboxes" });
    harness.sdk.stub("providers.catalog", async () => []);
    await plugin(bb);

    await expect(harness.callRpc("prepareSsh", { hostId: "host_test" }))
      .rejects.toThrow("Enable sandbox SSH");

    await expect(harness.callRpc("providers")).resolves.toEqual([
      { provider: "daytona", configured: false, enabled: true },
      { provider: "modal", configured: false, enabled: true },
      { provider: "e2b", configured: false, enabled: true },
      { provider: "box", configured: false, enabled: true },
      { provider: "freestyle", configured: false, enabled: true },

    ]);
    await expect(harness.callRpc("providerSettings")).resolves.toMatchObject({
      providers: [
        {
          provider: "daytona",
          enabled: true,
          configured: false,
          credentialsConfigured: false,
          artifactName: null,
        },
        { provider: "modal", enabled: true },
        { provider: "e2b", enabled: true },
        { provider: "box", enabled: true },
        { provider: "freestyle", enabled: true },

      ],
    });
    await expect(harness.callRpc("imageSettings")).resolves.toMatchObject({
      repository: "",
      platform: "",
      registryUsernameConfigured: false,
      registryTokenConfigured: false,
      extraPackages: [],
      recipe: expect.objectContaining({ revision: 0 }),
      providers: [
        { provider: "daytona", credentialsConfigured: false, activeName: null },
        { provider: "modal", credentialsConfigured: false, activeName: null },
        { provider: "e2b", credentialsConfigured: false, activeName: null },

      ],
    });
    await expect(
      harness.runCli(["register-image", "--json"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Set the sandbox image repository"),
    });
    await expect(
      harness.callRpc("setProviderEnabled", {
        provider: "modal",
        enabled: false,
      }),
    ).resolves.toMatchObject({ provider: "modal", enabled: false });
    await expect(harness.callRpc("providers")).resolves.toContainEqual({
      provider: "modal",
      configured: false,
      enabled: false,
    });
    await expect(
      harness.runCli(["provider", "e2b", "disable", "--json"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"enabled": false'),
    });
    await harness.dispose();
  });

  it("turning Always on on resumes a suspended sandbox", async () => {
    const resumed: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: { get: async () => ({ id: "thread-1", environmentId: "env-1" }) },
        environments: { get: async () => ({ id: "env-1", hostId: "host-1" }) },
        hosts: {
          get: async () => ({ id: "host-1", machineProviderId: "sandbox-daytona", lifecycle: { phase: "suspended" } }),
          experimental_resume: async ({ hostId }) => { resumed.push(hostId); return { id: hostId }; },
        },
      },
    });
    harness.sdk.stub("providers.catalog", async () => []);
    await plugin(bb);
    await expect(harness.callRpc("setSandboxAlwaysOn", { threadId: "thread-1", enabled: true }))
      .resolves.toEqual({ enabled: true });
    expect(resumed).toEqual(["host-1"]);
    await expect(harness.callRpc("sandboxAlwaysOn", { threadId: "thread-1" }))
      .resolves.toEqual({ enabled: true });
    await harness.dispose();
  });

  it("reports threads off a sandbox host as unmanaged instead of failing", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: {
          get: async () => ({ id: "thread-local", environmentId: "env-local" }),
        },
        environments: {
          get: async () => ({ id: "env-local", hostId: "host-local" }),
        },
        hosts: {
          get: async () => ({ id: "host-local", machineProviderId: null }),
        },
      },
    });
    harness.sdk.stub("providers.catalog", async () => []);
    await plugin(bb);

    await expect(
      harness.callRpc("threadResources", { threadId: "thread-local" }),
    ).resolves.toEqual({
      managed: false,
      sandboxId: null,
      provider: null,
      state: null,
      capability: "unknown",
      capabilityReason: null,
      latest: null,
      provisioned: null,
      target: null,
      assessment: null,
      stale: false,
      sampleError: null,
    });
    await harness.dispose();
  });
  it("reads the thread's Model Gateway route and treats a missing gateway as no route", async () => {
    const route = {
      harness: "claude-code",
      upstreamKind: "codex-oauth",
      accountLabel: "pro",
      model: "gpt-6-sol",
      chainIndex: 1,
      chain: ["Claude Max", "ChatGPT"],
      stickyUntil: 1_800_000_000_000,
      autoModel: null,
      auto: null,
      fallbackCause: {
        upstreamId: "up_max",
        upstreamLabel: "Claude Max",
        category: "rate-limit",
        status: 429,
        message: "Max is over its limit",
        at: 1_799_999_000_000,
      },
    };
    let gateway: "up" | "down" = "up";
    const calls: unknown[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        plugins: {
          callRpc: async (input) => {
            calls.push(input);
            if (gateway === "down") throw new Error("Plugin model-gateway is not running");
            return route;
          },
        },
      },
    });
    harness.sdk.stub("providers.catalog", async () => []);
    await plugin(bb);

    const { harness: _harness, upstreamKind: _kind, ...expected } = route;
    const { upstreamId: _id, ...cause } = route.fallbackCause;
    await expect(harness.callRpc("threadModelRoute", { threadId: "thr_1" }))
      .resolves.toEqual({ ...expected, fallbackCause: cause });
    expect(calls).toContainEqual(expect.objectContaining({
      pluginId: "model-gateway",
      method: "thread.route",
      input: { threadId: "thr_1" },
    }));
    gateway = "down";
    await expect(harness.callRpc("threadModelRoute", { threadId: "thr_1" })).resolves.toBeNull();
    await harness.dispose();
  });
});

describe("optional integration consent", () => {
  it("does not probe optional integrations without saved enablement", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "sandboxes" });
    await plugin(bb);
    await expect(harness.callRpc("credentialProfiles", null)).rejects.toThrow("Enable projectEnvironments");
    await expect(harness.callRpc("threadAttachments", { threadId: "thread-local" })).rejects.toThrow("Enable");
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await harness.dispose();
  });
});

it("blocks legacy assignment writes without touching native lifecycle or sibling state", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "sandboxes" });
  await plugin(bb);
  await expect(harness.callRpc("updateThreadAttachments", { threadId: "fixture-thread", change: { kind: "skills", ids: ["new-choice"] } })).rejects.toThrow("read-only during migration");
  expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  expect(harness.inspection.sdk.callsTo("hosts.experimental_resume")).toEqual([]);
  await harness.dispose();
});
