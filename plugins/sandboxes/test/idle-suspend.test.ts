import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNativeIdleSuspend } from "../src/provider/idle-suspend.js";

afterEach(() => {
  vi.useRealTimers();
});
describe("native idle suspend reconciliation", () => {
  it("restores a lost idle deadline after plugin restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    const suspend = vi.fn(async () => ({ id: "host_1" }));
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: {
          list: vi.fn(async () => [
            {
              id: "thread_1",
              environmentId: "environment_1",
              environmentHostId: "host_1",
              archivedAt: null,
              status: "idle",
              updatedAt: Date.now() - 20_000,
            },
          ]),
        },
        hosts: {
          get: vi.fn(async () => ({
            id: "host_1",
            status: "connected",
            machineProviderId: "sandbox-daytona",
            lifecycle: { phase: "active" },
          })),
          experimental_listProviders: vi.fn(async () => [
            { id: "sandbox-daytona", supportsSuspend: true },
          ]),
          experimental_suspend: suspend,
        },
      },
    });
    registerNativeIdleSuspend(fake.bb, { idleMs: () => 15_000 });

    const service = fake.harness.runService("native-idle-suspend-reconcile");
    await vi.advanceTimersByTimeAsync(0);

    expect(suspend).toHaveBeenCalledWith({ hostId: "host_1" });
    service.controller.abort();
    await service.done;
    await fake.harness.dispose();
  });

  it("keeps a machine awake when always on is enabled after an idle timer starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    let alwaysOn = false;
    const suspend = vi.fn(async () => ({ id: "host_1" }));
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: {
          list: vi.fn(async () => [{
            id: "thread_1", environmentId: "environment_1", environmentHostId: "host_1",
            archivedAt: null, status: "idle", updatedAt: Date.now(),
          }]),
        },
        hosts: {
          get: vi.fn(async () => ({
            id: "host_1", status: "connected", machineProviderId: "sandbox-daytona",
            lifecycle: { phase: "active" },
          })),
          experimental_listProviders: vi.fn(async () => [
            { id: "sandbox-daytona", supportsSuspend: true },
          ]),
          experimental_suspend: suspend,
        },
      },
    });
    registerNativeIdleSuspend(fake.bb, {
      idleMs: () => 15_000,
      alwaysOn: () => alwaysOn,
    });
    const service = fake.harness.runService("native-idle-suspend-reconcile");
    await vi.advanceTimersByTimeAsync(0);
    alwaysOn = true;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(suspend).not.toHaveBeenCalled();
    service.controller.abort();
    await service.done;
    await fake.harness.dispose();
  });

  it("suspends a shared host with an idle and an errored thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    const suspend = vi.fn(async () => ({ id: "host_1" }));
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: {
          list: vi.fn(async () => [
            {
              id: "thread_idle",
              environmentId: "environment_1",
              environmentHostId: "host_1",
              archivedAt: null,
              status: "idle",
              updatedAt: Date.now() - 20_000,
            },
            {
              id: "thread_error",
              environmentId: "environment_2",
              environmentHostId: "host_1",
              archivedAt: null,
              status: "error",
              updatedAt: Date.now() - 20_000,
            },
          ]),
        },
        hosts: {
          get: vi.fn(async () => ({
            id: "host_1",
            status: "connected",
            machineProviderId: "sandbox-daytona",
            lifecycle: { phase: "active" },
          })),
          experimental_listProviders: vi.fn(async () => [
            { id: "sandbox-daytona", supportsSuspend: true },
          ]),
          experimental_suspend: suspend,
        },
      },
    });
    registerNativeIdleSuspend(fake.bb, { idleMs: () => 15_000 });

    const service = fake.harness.runService("native-idle-suspend-reconcile");
    await vi.advanceTimersByTimeAsync(0);

    expect(suspend).toHaveBeenCalledWith({ hostId: "host_1" });
    service.controller.abort();
    await service.done;
    await fake.harness.dispose();
  });

  it("does not suspend a shared host while any thread is active", async () => {
    vi.useFakeTimers();
    const suspend = vi.fn(async () => ({ id: "host_1" }));
    const threads = [
      {
        id: "thread_idle",
        environmentId: "environment_1",
        environmentHostId: "host_1",
        archivedAt: null,
        status: "idle",
        updatedAt: Date.now() - 20_000,
      },
      {
        id: "thread_active",
        environmentId: "environment_2",
        environmentHostId: "host_1",
        archivedAt: null,
        status: "active",
        updatedAt: Date.now(),
      },
    ];
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: { list: vi.fn(async () => threads) },
        hosts: {
          get: vi.fn(async () => ({
            id: "host_1",
            status: "connected",
            machineProviderId: "sandbox-daytona",
            lifecycle: { phase: "active" },
          })),
          experimental_listProviders: vi.fn(async () => [
            { id: "sandbox-daytona", supportsSuspend: true },
          ]),
          experimental_suspend: suspend,
        },
      },
    });
    registerNativeIdleSuspend(fake.bb, { idleMs: () => 15_000 });

    const service = fake.harness.runService("native-idle-suspend-reconcile");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(suspend).not.toHaveBeenCalled();
    service.controller.abort();
    await service.done;
    await fake.harness.dispose();
  });

  it("restarts the idle clock when a suspended host is resumed manually", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    const suspend = vi.fn(async () => ({ id: "host_1" }));
    const host = {
      id: "host_1",
      status: "disconnected",
      machineProviderId: "sandbox-daytona",
      lifecycle: { phase: "suspended" },
    };
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: {
          list: vi.fn(async () => [
            {
              id: "thread_1",
              environmentId: "environment_1",
              environmentHostId: "host_1",
              archivedAt: null,
              status: "idle",
              updatedAt: Date.now() - 86_400_000,
            },
          ]),
        },
        hosts: {
          get: vi.fn(async () => host),
          experimental_listProviders: vi.fn(async () => [
            { id: "sandbox-daytona", supportsSuspend: true },
          ]),
          experimental_suspend: suspend,
        },
      },
    });
    registerNativeIdleSuspend(fake.bb, { idleMs: () => 300_000 });

    const service = fake.harness.runService("native-idle-suspend-reconcile");
    await vi.advanceTimersByTimeAsync(0);
    host.status = "connected";
    host.lifecycle = { phase: "active" };
    await vi.advanceTimersByTimeAsync(120_000);
    expect(suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(suspend).toHaveBeenCalledWith({ hostId: "host_1" });
    service.controller.abort();
    await service.done;
    await fake.harness.dispose();
  });
});

it('keeps independent desktop and maintenance holds until both release',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
 const suspend=vi.fn(async()=>({id:'host_fixture'}));
 const fake=createFakePluginHost({pluginId:'sandboxes',sdk:{threads:{list:async()=>[{id:'thr_fixture',environmentId:'env_fixture',environmentHostId:'host_fixture',archivedAt:null,status:'idle',updatedAt:Date.now()-120000}] as never},hosts:{get:async()=>({id:'host_fixture',status:'connected',machineProviderId:'sandbox-daytona',lifecycle:{phase:'active'}}) as never,experimental_listProviders:async()=>[{id:'sandbox-daytona',supportsSuspend:true}] as never,experimental_suspend:suspend}}});
 const holds=registerNativeIdleSuspend(fake.bb,{idleMs:()=>15000});
 holds.hold('host_fixture');holds.hold('host_fixture','desktop:fixture');holds.release('host_fixture');
 const service=fake.harness.runService('native-idle-suspend-reconcile');
 await vi.advanceTimersByTimeAsync(60000);expect(suspend).not.toHaveBeenCalled();
 holds.release('host_fixture','desktop:fixture');await vi.advanceTimersByTimeAsync(60001);expect(suspend).toHaveBeenCalledWith({hostId:'host_fixture'});
 service.controller.abort();await service.done;await fake.harness.dispose();
});
