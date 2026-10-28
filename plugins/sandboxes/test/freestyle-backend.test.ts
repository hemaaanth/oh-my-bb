import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FreestyleSdk from "freestyle";
import type { SandboxRuntimeConfig } from "../src/config.js";
import { createFreestyleMachineBackend } from "../src/provider/backends/freestyle.js";
import plugin from "../src/server.js";

// Use the real SDK serializers/authentication, replacing only its HTTP transport.
vi.mock("freestyle", async (importOriginal) => {
  const sdk = await importOriginal<typeof FreestyleSdk>();
  return {
    ...sdk,
    Freestyle: class extends sdk.Freestyle {
      constructor(options: ConstructorParameters<typeof sdk.Freestyle>[0]) {
        super({ ...options, fetch: (input, init) => globalThis.fetch(input, init) });
      }
    },
  };
});

const resource = {
  provider: "freestyle" as const,
  key: "allocation_1",
  providerSandboxId: "vm-fixture",
  name: "bb-allocation_1",
  sizeTier: "M" as const,
  snapshotId: null,
};
const context = () => ({
  signal: new AbortController().signal,
  report: { step: vi.fn(), log: vi.fn() },
  checkpoint: vi.fn(async () => {}),
  hostId: "host_fixture",
  resource,
});
const config = (): NonNullable<SandboxRuntimeConfig["freestyle"]> => ({
  apiKey: "synthetic-old",
  cpu: 4,
  memoryGb: 8,
  storageGb: 20,
  persistence: "sticky",
  snapshotId: null,
});
const vmData = {
  id: resource.providerSandboxId,
  state: "running",
  resources: { cpu: 4, memory: 8192, storage: 20480 },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
type Call = { method: string; path: string; authorization: string | null; body: unknown };
let calls: Call[];
let respond: (call: Call) => Response;

beforeEach(() => {
  calls = [];
  respond = (call) => {
    if (call.method === "GET" && new URL(call.path, "https://fixture.test").pathname.endsWith("/vms")) {
      return Response.json({ vms: [], totalCount: 0, runningCount: 0, startingCount: 0, pausingCount: 0, pausedCount: 0, stoppedCount: 0 });
    }
    if (call.method === "DELETE") return new Response(null, { status: 204 });
    if (call.path.endsWith("/exec-await")) return Response.json({ stdout: "done\n", stderr: "", statusCode: 0 });
    return Response.json(vmData);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Freestyle backend transport", () => {
  it("omits a blank snapshot selection so Freestyle uses its Ubuntu default", async () => {
    const created = await createFreestyleMachineBackend(config()).create({ ...context(), key: resource.key, attempt: 1, inputs: {} });
    expect(calls[0]!.body).not.toHaveProperty("snapshotId");
    expect(created.resource.snapshotId).toBeNull();
  });

  it("explains how to replace a missing custom snapshot without silently changing images", async () => {
    respond = () => Response.json({ code: "BAD_REQUEST", message: "snapshot sh-missing does not exist" }, { status: 400 });
    const operation = context();
    await expect(createFreestyleMachineBackend({ ...config(), snapshotId: "sh-missing" }).create({ ...operation, key: resource.key, attempt: 1, inputs: {} }))
      .rejects.toThrow("clear Base snapshot to use Ubuntu");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ snapshotId: "sh-missing" });
    expect(operation.checkpoint).not.toHaveBeenCalled();
  });

  it("explains plan limits in terms of the selected size and removes the failed VM", async () => {
    respond = (call) => call.path.endsWith("/resize")
      ? Response.json({ code: "LIMIT_EXCEEDED", message: "This plan allows up to 8192 MiB of memory per VM, but this VM requested 12288 MiB." }, { status: 429 })
      : call.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(vmData);
    const operation = context();
    await expect(createFreestyleMachineBackend(config()).create({ ...operation, key: resource.key, attempt: 1, inputs: { size: "M" } }))
      .rejects.toThrow("Freestyle cannot run size M on this plan. Choose a smaller size");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v5/vms/vm-fixture" });
    expect(operation.checkpoint).not.toHaveBeenCalled();
  });

  it("lists through the current v5 API", async () => {
    await createFreestyleMachineBackend(config()).reconcileCleanup({ ...context(), key: resource.key });
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/v5/vms?limit=100&offset=0" },
    ]);
  });

  it("refreshes credentials on an existing backend after config mutation", async () => {
    const settings = config();
    const backend = createFreestyleMachineBackend(settings);
    await backend.reconcileCleanup({ ...context(), key: resource.key });
    Object.assign(settings, { apiKey: "synthetic-new" });
    await backend.reconcileCleanup({ ...context(), key: resource.key });
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer synthetic-old", "Bearer synthetic-new",
    ]);
  });

  it("creates with v5 policy/firewall fields and grows resources in MiB", async () => {
    const backend = createFreestyleMachineBackend(config());
    const operation = context();
    const created = await backend.create({ ...operation, key: resource.key, attempt: 1, inputs: { image: "snapshot-fixture" } });
    expect(calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      {
        method: "POST", path: "/v5/vms",
        body: {
          snapshotId: "snapshot-fixture",
          displayName: resource.name,
          firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
          idleTimeoutSeconds: -1,
        },
      },
      { method: "POST", path: "/v5/vms/vm-fixture/resize", body: { cpu: 4, memory: 12288, storage: 20480 } },
    ]);
    expect(created.resource).toEqual({ ...resource, snapshotId: "snapshot-fixture" });
    expect(operation.checkpoint).toHaveBeenCalledWith(created.resource);
  });

  it.each(["S", "XL"] as const)("only grows dimensions below the requested %s tier", async (size) => {
    respond = () => Response.json({ ...vmData, resources: { cpu: 8, memory: 16384, storage: 40960 } });
    await createFreestyleMachineBackend(config()).create({ ...context(), key: resource.key, attempt: 1, inputs: { size } });
    expect(calls.filter((call) => call.path.endsWith("/resize")).map((call) => call.body)).toEqual(
      size === "S" ? [] : [{ cpu: 16, memory: 32768, storage: 102400 }],
    );
  });

  it("deletes a new VM when resizing fails and does not checkpoint it", async () => {
    respond = (call) => call.path.endsWith("/resize")
      ? Response.json({ code: "LIMIT_EXCEEDED", message: "Resource limit" }, { status: 429 })
      : call.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(vmData);
    const operation = context();
    await expect(createFreestyleMachineBackend(config()).create({ ...operation, key: resource.key, attempt: 1, inputs: {} }))
      .rejects.toThrow("Resource limit");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v5/vms/vm-fixture" });
    expect(operation.checkpoint).not.toHaveBeenCalled();
  });

  it("requests uncapped retention for persistent mode and rejects a plan cap", async () => {
    const settings = { ...config(), persistence: "persistent" as const };
    respond = (call) => call.method === "DELETE"
      ? new Response(null, { status: 204 }) : Response.json({ ...vmData, autoDeleteSeconds: 86400 });
    await expect(createFreestyleMachineBackend(settings).create({ ...context(), key: resource.key, attempt: 1, inputs: {} }))
      .rejects.toThrow("plan without an auto-delete cap");
    expect(calls[0]?.body).toMatchObject({ autoDeleteSeconds: -1 });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v5/vms/vm-fixture" });
  });

  it.each([
    { persistence: "sticky" as const, policy: { autoDeleteSeconds: 86400 } },
    { persistence: "persistent" as const, policy: { autoDeleteSeconds: null, ttlSeconds: null } },
    { persistence: "persistent" as const, policy: {} },
  ])("accepts $persistence only with its promised retention policy ($policy)", async ({ persistence, policy }) => {
    respond = () => Response.json({ ...vmData, ...policy });
    const operation = context();
    await createFreestyleMachineBackend({ ...config(), persistence }).create({
      ...operation, key: resource.key, attempt: 1, inputs: { size: "S" },
    });
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
    expect(calls[0]?.body).toEqual({
      displayName: resource.name,
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
      idleTimeoutSeconds: -1,
      ...(persistence === "persistent" ? { autoDeleteSeconds: -1, ttlSeconds: -1 } : {}),
    });
    expect(operation.checkpoint).toHaveBeenCalledWith({ ...resource, sizeTier: "S" });
  });

  it.each([
    { persistence: "sticky" as const, policy: { autoDeleteSeconds: 0 }, message: "ephemeral VM" },
    { persistence: "persistent" as const, policy: { ttlSeconds: 86400 }, message: "deletion deadline" },
  ])("refuses $persistence when returned policy breaks durable storage ($policy)", async ({ persistence, policy, message }) => {
    respond = (call) => call.method === "DELETE"
      ? new Response(null, { status: 204 }) : Response.json({ ...vmData, ...policy });
    const operation = context();
    await expect(createFreestyleMachineBackend({ ...config(), persistence }).create({
      ...operation, key: resource.key, attempt: 1, inputs: {},
    })).rejects.toThrow(message);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v5/vms", "DELETE /v5/vms/vm-fixture",
    ]);
    expect(operation.checkpoint).not.toHaveBeenCalled();
  });

  it("pauses, resumes, executes, and deletes through v5 handles", async () => {
    const settings = config();
    const backend = createFreestyleMachineBackend(settings);
    await backend.suspend!(context());
    const resumed = await backend.resume!(context());
    Object.assign(settings, { apiKey: "synthetic-new" });
    const output: string[] = [];
    const result = await resumed.executor.exec({
      command: ["printf", "hello world"], stdin: "input", timeoutMs: 1234,
      signal: context().signal, onOutput: (text) => output.push(text),
    });
    await backend.remove(context());
    await backend.removeLegacy("vm-legacy");
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/v5/vms/vm-fixture/pause" },
      { method: "POST", path: "/v5/vms/vm-fixture/start" },
      { method: "POST", path: "/v5/vms/vm-fixture/exec-await" },
      { method: "DELETE", path: "/v5/vms/vm-fixture" },
      { method: "DELETE", path: "/v5/vms/vm-legacy" },
    ]);
    expect(calls[2]?.body).toEqual({ linuxUser: "root", command: "printf %s 'aW5wdXQ=' | base64 -d | 'printf' 'hello world'", timeoutMs: 1234 });
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer synthetic-old", "Bearer synthetic-old", "Bearer synthetic-new", "Bearer synthetic-new", "Bearer synthetic-new",
    ]);
    expect(result).toEqual({ exitCode: 0 });
    expect(output).toEqual(["done\n"]);
  });

  it("reconciles matching display names across list pages before deleting", async () => {
    respond = (call) => call.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({
      vms: call.path.endsWith("offset=0")
        ? [{ ...vmData, id: "vm-first", displayName: resource.name }, { ...vmData, id: "vm-unrelated", displayName: "other" }]
        : [{ ...vmData, id: "vm-last", displayName: resource.name }],
      totalCount: 3, runningCount: 3, startingCount: 0, pausingCount: 0, pausedCount: 0, stoppedCount: 0,
    });
    await createFreestyleMachineBackend(config()).reconcileCleanup({ ...context(), key: resource.key });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v5/vms?limit=100&offset=0", "GET /v5/vms?limit=100&offset=2",
      "DELETE /v5/vms/vm-first", "DELETE /v5/vms/vm-last",
    ]);
  });

  it("ignores only missing VMs, not authentication errors containing misleading prose", async () => {
    const backend = createFreestyleMachineBackend(config());
    respond = () => Response.json({ code: "NOT_FOUND", message: "Gone" }, { status: 404 });
    await backend.suspend!(context());
    await backend.remove(context());
    await backend.removeLegacy("vm-legacy");
    respond = () => Response.json({ code: "UNAUTHORIZED", message: "404 not found in authorization" }, { status: 401 });
    await expect(backend.suspend!(context())).rejects.toMatchObject({ status: 401 });
    await expect(backend.remove(context())).rejects.toMatchObject({ status: 401 });
    await expect(backend.removeLegacy("vm-legacy")).rejects.toMatchObject({ status: 401 });
  });

  it("uses the new saved key on an already registered machine backend", async () => {
    vi.stubEnv("FREESTYLE_API_KEY", "synthetic-old");
    const { bb, harness } = createFakePluginHost({ pluginId: "sandboxes" });
    harness.sdk.stub("providers.catalog", async () => []);
    try {
      await plugin(bb);
      const machine = harness.inspection.registrations.machineProviders.get("sandbox-freestyle")!;
      await machine.remove(context());
      await harness.behavior.callRpc("updateProviderConfiguration", {
        provider: "freestyle", apiKey: "synthetic-new", cpu: "4", memory: "8", storage: "20",
        persistence: "sticky", snapshotId: "",
      });
      await machine.remove(context());
      expect(calls.map((call) => call.authorization)).toEqual(["Bearer synthetic-old", "Bearer synthetic-new"]);
      expect(calls.map((call) => call.path)).toEqual(["/v5/vms/vm-fixture", "/v5/vms/vm-fixture"]);
    } finally {
      await harness.lifecycle.dispose();
      vi.unstubAllEnvs();
    }
  });
});
