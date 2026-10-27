import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerRuntimeEnvironment } from "../src/runtime-environment.js";

describe("sandbox runtime environment", () => {
  function setup(machineProviderId = "sandbox-daytona") {
    const callbacks = new Map<string, (context: { hostId: string }) => Promise<unknown>>();
    const call = vi.fn(async () => ({ home: "/home/execution-user" }));
    let start: (signal: AbortSignal) => Promise<void>;
    const bb = {
      background: { service: (_: string, service: { start: typeof start }) => { start = service.start; } },
      hosts: { experimental_client: () => ({ call }) },
      sdk: {
        providers: { catalog: async () => [{ id: "agents" }, { id: "codex" }, { id: "acp-omp" }] },
        hosts: { get: vi.fn(async () => ({ machineProviderId })) },
      },
      providers: { experimental_contributeEnv: (id: string, callback: (context: { hostId: string }) => Promise<unknown>) => callbacks.set(id, callback) },
    };
    return { bb: bb as unknown as BbPluginApi, callbacks, call, start: (signal: AbortSignal) => start(signal) };
  }
  it("supplies the execution host's HOME for each catalog provider", async () => {
    const { bb, callbacks, call } = setup();
    await registerRuntimeEnvironment(bb);
    expect([...callbacks.keys()]).toEqual(expect.arrayContaining(["agents", "codex", "acp-omp"]));
    for (const callback of callbacks.values()) {
      expect(await callback({ hostId: "host_remote" })).toEqual([
        { name: "HOME", value: "/home/execution-user", reason: "Sandbox execution user's home directory" },
      ]);
    }
    expect(call).toHaveBeenCalledWith("runtimeEnvironment", null, { hostId: "host_remote" });
  });
  it("registers baseline HOME without waiting for the startup-blocked catalog", () => {
    const test = setup();
    test.bb.sdk.providers.catalog = vi.fn(() => new Promise<never>(() => {}));
    expect(registerRuntimeEnvironment(test.bb)).toBeUndefined();
    expect(test.callbacks.has("agents")).toBe(true);
    expect(test.bb.sdk.providers.catalog).not.toHaveBeenCalled();
  });
  it("adds custom providers after the factory has returned", async () => {
    const test = setup();
    test.bb.sdk.providers.catalog = vi.fn(async () => [{ id: "custom-agent" }] as never);
    registerRuntimeEnvironment(test.bb);
    const controller = new AbortController();
    const service = test.start(controller.signal);
    await vi.waitFor(() => expect(test.callbacks.has("custom-agent")).toBe(true));
    controller.abort();
    await service;
  });
  it("does not change local or manually enrolled machines", async () => {
    const { bb, callbacks, call } = setup("manual");
    await registerRuntimeEnvironment(bb);
    expect(await callbacks.get("agents")!({ hostId: "host_local" })).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });
});
