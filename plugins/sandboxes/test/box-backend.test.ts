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
