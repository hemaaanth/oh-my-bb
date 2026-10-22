import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { describe, expect, it, vi } from "vitest";
import { registerSandboxBackend } from "../src/provider/register.js";
import type { SandboxBackend } from "../src/provider/sandbox-backend.js";

type Resource = { id: string; key: string };

function setup() {
  const calls: string[] = [];
  let machine: Record<string, (context: unknown) => Promise<unknown>> = {};
  const bb = {
    experimental_environments: { register: vi.fn() },
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
    displayName: () => "Test VM",
    create: async () => ({ resource: { id: "vm_1", key: "thr_created" }, executor }),
    suspend: async ({ resource }: { resource: Resource }) => resource,
    resume: async ({ resource }: { resource: Resource }) => ({ resource, executor }),
  } as unknown as SandboxBackend<unknown, Resource>;
  const prepareMachine = vi.fn(async (input: { key: string; executor: MachineExecutor }) => {
    calls.push(`prepare ${input.key}`);
    expect(input.executor).toBe(executor);
  });
  registerSandboxBackend(bb, backend, {
    now: () => 0,
    onConnected: async (hostId) => {
      calls.push(`connected ${hostId}`);
    },
    prepareMachine,
  });
  const context = {
    report: { log: vi.fn() } as unknown as PluginMachineProviderProgress,
    signal: new AbortController().signal,
  };
  return { machine, calls, context };
}

describe("registerSandboxBackend prepareMachine", () => {
  it("prepares a created machine with its key before it is connected", async () => {
    const { machine, calls, context } = setup();
    const result = await machine.create({ ...context, key: "thr_created", inputs: {} });
    expect(result).toMatchObject({ status: "created" });
    expect(calls).toEqual(["bootstrap thr_created", "prepare thr_created", "connected host_1"]);
  });

  it("prepares a resumed machine with its key before it is connected", async () => {
    const { machine, calls, context } = setup();
    await machine.resume({ ...context, hostId: "host_2", resource: { id: "vm_2", key: "thr_resumed" } });
    expect(calls).toEqual(["bootstrap thr_resumed", "prepare thr_resumed", "connected host_2"]);
  });
});
