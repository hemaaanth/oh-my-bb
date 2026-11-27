import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBoxMachineBackend } from "../src/provider/backends/box.js";

const resource = {
  provider: "box" as const, key: "allocation-fixture", providerSandboxId: "bx_fixture",
  name: "bb-allocation-fixture", machineClass: "default" as const,
  environment: "base", sizeTier: "M" as const,
};
const context = () => ({
  signal: new AbortController().signal, report: { step: vi.fn(), log: vi.fn() },
  checkpoint: vi.fn(async () => {}), hostId: "host_fixture", resource,
});
const backend = () => createBoxMachineBackend({ apiKey: "box_existing_key", machineClass: "default", environment: "base" });
let calls: Array<{ url: string; method: string; body: unknown; headers: Headers }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/commands")) return Response.json({ success: true, stdout: "hello__BBRC__0", stderr: "" });
    return Response.json({ ok: true, sandbox: { id: resource.providerSandboxId, state: "running" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

it("creates through Boat with the existing key and trial-compatible auto-stop", async () => {
  const operation = context();
  const created = await backend().create({ ...operation, key: resource.key, attempt: 1, inputs: {} });
  expect(calls[0]).toMatchObject({ url: "https://boat.dev/api/v1/sandboxes", method: "POST", body: { type: "default", environment: "base", ttlSeconds: 7200 } });
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer box_existing_key");
  expect(created.resource).toEqual(resource);
  expect(operation.checkpoint).toHaveBeenCalledWith(resource);
  expect(backend().definition).toMatchObject({ id: "sandbox-box", runtimeName: "Boat", icon: "./boat-logo.svg" });
});

it("uses a saved base snapshot on new allocations and follows configuration changes", async () => {
  const config = { apiKey: "key", machineClass: "default" as const, environment: "base", snapshotId: "prepared-tools" };
  const instance = createBoxMachineBackend(config);
  const create = () => instance.create({ ...context(), key: resource.key, attempt: 1, inputs: {} });
  await create();
  expect(calls[0]!.body).toMatchObject({ from: "prepared-tools" });
  config.snapshotId = "";
  await create();
  expect(calls[1]!.body).not.toHaveProperty("from");
});

it.each([
  ["running", 10, true], ["idle", 29, true], ["ready", 30, true],
  ["running", 90, false], ["stopped", 10, false], ["archived", 10, false],
])("renews a %s machine with %i minutes left: %s", async (state, minutes, renew) => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return Response.json({ ok: true });
    return Response.json({ sandbox: { id: resource.providerSandboxId, state, archiveAfter: new Date(Date.now() + minutes * 60_000).toISOString() } });
  }));
  await backend().renewLease!(context());
  const patches = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(patches).toHaveLength(renew ? 1 : 0);
  if (renew) expect(JSON.parse(String(patches[0]![1]!.body))).toEqual({ ttlSeconds: 7200 });
});

it("reports deadline renewal failure so the scheduler can retry", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
    ? Response.json({ message: "temporarily unavailable" }, { status: 503 })
    : Response.json({ sandbox: { id: resource.providerSandboxId, state: "running", archiveAfter: new Date().toISOString() } })));
  await expect(backend().renewLease!(context())).rejects.toThrow("temporarily unavailable");
});

it("resumes old Box records with finite auto-stop, executes, pauses and deletes", async () => {
  const instance = backend();
  expect(instance.parseResource(resource)).toEqual(resource);
  const resumed = await instance.resume!(context());
  expect(calls.slice(0, 2)).toMatchObject([
    { url: "https://boat.dev/api/v1/sandboxes/bx_fixture/resume", method: "POST", body: { ttlSeconds: 7200 } },
    { url: "https://boat.dev/api/v1/sandboxes/bx_fixture", method: "GET" },
  ]);
  const onOutput = vi.fn();
  expect(await resumed.executor.exec({ command: ["echo", "hello"], timeoutMs: 1000, stdin: "", signal: context().signal, onOutput })).toEqual({ exitCode: 0 });
  expect(onOutput).toHaveBeenCalledWith("hello");
  await instance.suspend!(context());
  await instance.remove(context());
  expect(calls.slice(2).map(({ url, method }) => ({ url, method }))).toEqual([
    { url: "https://boat.dev/api/v1/sandboxes/bx_fixture/commands", method: "POST" },
    { url: "https://boat.dev/api/v1/sandboxes/bx_fixture/stop", method: "POST" },
    { url: "https://boat.dev/api/v1/sandboxes/bx_fixture", method: "DELETE" },
  ]);
  expect(calls.at(-1)!.headers.get("X-Ascii-Confirm-Delete")).toBe("bx_fixture");
});

it("reconciles cleanup by matching allocation name bb-<key>", async () => {
  const operation = { ...context(), key: resource.key };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sandboxes: [], pageInfo: { hasMore: false } })));
  await expect(backend().reconcileCleanup(operation)).resolves.toBeUndefined();

  // Unrelated sandboxes do not block cleanup confirmation.
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sandboxes: [{ id: "other", name: "bb-other" }], pageInfo: { hasMore: false } })));
  await expect(backend().reconcileCleanup(operation)).resolves.toBeUndefined();

  // A matching allocation name is deleted before confirming cleanup.
  const deleted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deleted.push(url);
      return Response.json({ ok: true });
    }
    return Response.json({ sandboxes: [{ id: "bx_match", name: `bb-${resource.key}` }], pageInfo: { hasMore: false } });
  }));
  await expect(backend().reconcileCleanup(operation)).resolves.toBeUndefined();
  expect(deleted).toEqual(["https://boat.dev/api/v1/sandboxes/bx_match"]);
});

it("runs managed machines inside the prepared container and uploads stdin outside command history", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method: init?.method ?? "GET", body, headers: new Headers(init?.headers) });
    if (url.endsWith("/commands/1")) return Response.json({ running: false, exitCode: 0, stdout: "", stderr: "" });
    if (url.endsWith("/commands")) return Response.json(body.detached ? { processId: 1 } : { success: true, stdout: "hello__BBRC__0", stderr: "" });
    return Response.json({ sandbox: { id: resource.providerSandboxId, state: "running" } });
  }));
  const instance = createBoxMachineBackend({ apiKey: "key", machineClass: "default", environment: "base", snapshotId: "verified", runtimeContainer: true });
  const created = await instance.create({ ...context(), key: resource.key, attempt: 1, inputs: {} });
  expect(calls[0]!.body).toMatchObject({ from: "verified" });
  expect(created.resource.runtimeContainer).toBe(true);
  await created.executor.exec({ command: ["node", "-e", "process.stdout.write('hello')"], stdin: "private-bootstrap", timeoutMs: 1000, signal: context().signal, onOutput: () => {} });
  const upload = calls.find(call => call.url.endsWith("/files"));
  expect(upload?.body).toMatchObject({ content: Buffer.from("private-bootstrap").toString("base64"), encoding: "base64" });
  const command = (calls.at(-1)!.body as { command: string }).command;
  expect(command).toContain("'docker' 'exec' '-i' '-e' 'IS_SANDBOX=1' 'bb-sandbox-runtime'");
  expect(command).not.toContain("private-bootstrap");
  expect(command).not.toContain(Buffer.from("private-bootstrap").toString("base64"));
  // Resource metadata owns the execution format even after the active image changes.
  const legacyConfig = backend();
  const resumed = await legacyConfig.resume!({ ...context(), resource: created.resource });
  expect(resumed.resource.runtimeContainer).toBe(true);
  const resumeCommands = calls.filter(call => call.url.endsWith("/commands")).map(call => (call.body as { command: string }).command);
  expect(resumeCommands.at(-1)).toContain("install-daemon.pid");
  expect(resumeCommands.at(-1)).toContain("/cmdline");
});

it("directs new machines to the shared image setup until a snapshot exists", async () => {
  expect(await backend().availability()).toMatchObject({ status: "setup-required" });
  const prepared = createBoxMachineBackend({ apiKey: "key", machineClass: "default", environment: "base", snapshotId: "verified", runtimeContainer: true });
  expect(await prepared.availability()).toEqual({ status: "available" });
});
