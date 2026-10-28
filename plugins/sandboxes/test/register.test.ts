import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { describe, expect, it, vi } from "vitest";
import { registerSandboxBackend } from "../src/provider/register.js";
import type { SandboxBackend } from "../src/provider/sandbox-backend.js";

type Resource = { id: string; key: string };

function setup(runtimeError?: Error) {
  const calls: string[] = [];
  let machine: Record<string, (context: unknown) => Promise<unknown>> = {};
  const warn = vi.fn();
  const bb = {
    experimental_environments: { register: vi.fn() },
    log: { warn },
    sdk: { threads: { get: vi.fn(async () => ({ projectId: "proj_1", environmentId: null })) }, projects: { get: vi.fn(async () => ({ name: "Shared project" })) } },
    experimental_machines: {
      register: vi.fn((definition) => {
        machine = definition;
      }),
      bootstrap: vi.fn(async ({ key }: { key: string }) => {
        calls.push(`bootstrap ${key}`);
        return { hostId: "host_1" };
      }),
    },
  } as unknown as BbPluginApi;
  const executor = { exec: vi.fn() } as unknown as MachineExecutor;
  const backend = {
    definition: {
      id: "sandbox-test",
      displayName: "Test",
      description: "",
      environmentDescription: "",
      runtimeName: "Test",
      icon: "box",
      ephemeral: true,
      inputs: {},
    },
    parseInputs: (value: unknown) => value,
    parseResource: (value: unknown) => value as Resource,
    allocationKey: (resource: Resource) => resource.key,
    create: vi.fn(async () => ({ resource: { id: "vm_1", key: "thr_created" }, executor })),
    suspend: async ({ resource }: { resource: Resource }) => resource,
    resume: vi.fn(async ({ resource }: { resource: Resource }) => ({ resource, executor })),
    reconcileCleanup: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  } as unknown as SandboxBackend<unknown, Resource>;
  const prepareMachine = vi.fn(async (input: { key: string; executor: MachineExecutor }) => {
    calls.push(`prepare ${input.key}`);
    expect(input.executor).not.toBe(executor);
    expect(input.executor.exec).toBeTypeOf("function");
  });
  registerSandboxBackend(bb, backend, {
    now: () => 0,
    requireRuntime: async () => { if (runtimeError) throw runtimeError; },
    onConnected: async (hostId) => {
      calls.push(`connected ${hostId}`);
    },
    prepareMachine,
  });
  const context = {
    report: { log: vi.fn() } as unknown as PluginMachineProviderProgress,
    signal: new AbortController().signal,
  };
  return { bb, backend, machine, calls, context };
}

describe("registerSandboxBackend prepareMachine", () => {
  it("offers project checkout and personal workspace choices on the same machine provider", () => {
    const { bb } = setup();
    expect(vi.mocked(bb.experimental_environments.register).mock.calls).toEqual([
      [expect.objectContaining({
        id: "sandbox-test",
        machineProviderId: "sandbox-test",
        environmentProviderId: "project-checkout",
      })],
      [expect.objectContaining({
        id: "sandbox-test-personal",
        displayName: "Test",
        machineProviderId: "sandbox-test",
        environmentProviderId: "personal-workspace",
      })],
    ]);
    expect(bb.experimental_machines.register).toHaveBeenCalledTimes(1);
  });

  it("prepares a created machine with its key before it is connected", async () => {
    const { machine, calls, context } = setup();
    const result = await machine.create({ ...context, key: "thr_created", inputs: {} });
    expect(result).toMatchObject({ status: "created", name: "Test · Shared project" });
    expect(calls).toEqual(["bootstrap thr_created", "prepare thr_created", "connected host_1"]);
  });

  it("prepares a resumed machine with its key before it is connected", async () => {
    const { machine, calls, context } = setup();
    await machine.resume({ ...context, hostId: "host_2", resource: { id: "vm_2", key: "thr_resumed" } });
    expect(calls).toEqual(["bootstrap thr_resumed", "prepare thr_resumed", "connected host_2"]);
  });
});

describe("native cleanup truth", () => {
  it("retains malformed resources when no allocation key can be recovered", async () => {
    const { backend, machine, context } = setup();
    backend.parseResource = () => { throw new Error("old schema"); };
    await expect(machine.remove({ ...context, hostId: "host_1", resource: {} }))
      .resolves.toMatchObject({ status: "failed", message: expect.stringContaining("old schema") });
    expect(backend.reconcileCleanup).not.toHaveBeenCalled();
  });

  it("reports failed key reconciliation instead of forgetting the native resource", async () => {
    const { backend, machine, context } = setup();
    backend.parseResource = () => { throw new Error("old schema"); };
    vi.mocked(backend.reconcileCleanup).mockRejectedValue(new Error("provider outcome unknown"));
    await expect(machine.remove({ ...context, hostId: "host_1", resource: { key: "allocation-1" } }))
      .resolves.toEqual({ status: "failed", message: "provider outcome unknown" });
  });

  it("reports removed only after key reconciliation succeeds", async () => {
    const { backend, machine, context } = setup();
    backend.parseResource = () => { throw new Error("old schema"); };
    await expect(machine.remove({ ...context, hostId: "host_1", resource: { key: "allocation-1" } }))
      .resolves.toEqual({ status: "removed" });
    expect(backend.reconcileCleanup).toHaveBeenCalledWith(expect.objectContaining({ key: "allocation-1" }));
  });

  it("propagates cancellation without acknowledging removal", async () => {
    const { backend, machine, context } = setup();
    const controller = new AbortController();
    backend.parseResource = () => { throw new Error("old schema"); };
    vi.mocked(backend.reconcileCleanup).mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      controller.signal.throwIfAborted();
    });
    await expect(machine.remove({ ...context, signal: controller.signal, hostId: "host_1", resource: { key: "allocation-1" } }))
      .rejects.toThrow("cancelled");
  });
});

it("fails before allocation or resume when the required model runtime is unavailable", async () => {
  const { backend, machine, context } = setup(new Error("Model Gateway is required"));
  expect(await machine.create({ ...context, key: "fixture", inputs: {} })).toEqual({ status: "failed", message: "Model Gateway is required" });
  expect(backend.create).not.toHaveBeenCalled();
  await expect(machine.resume({ ...context, hostId: "host_1", resource: { id: "vm_1", key: "fixture" } })).rejects.toThrow("Model Gateway is required");
  expect(backend.resume).not.toHaveBeenCalled();
});
