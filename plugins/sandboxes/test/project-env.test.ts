import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerNativeProjectEnvironmentSync } from "../src/provider/project-env.js";
import { setImmediate as tick } from "node:timers/promises";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
const thread = makeThreadResponse({ id: "thread-1", environmentId: "environment-1" });
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const jobRequestSchema = z.object({ jobId: z.string().uuid() });
const outcome = (jobId: string, value: object = {}) => ({ schemaVersion: 1, jobId, state: "complete", ready: false, retryable: true, reason: "not_ready", ...value });
function setup(pollMs = 1) {
  let result: unknown | ((id: string) => unknown) = (id: string) => outcome(id);
  let starts = 0;
  let loseStart = false;
  const call = vi.fn(async ({ method, input, outputSchema }: { method: string; input?: unknown; outputSchema?: unknown }) => {
    let raw: unknown;
    if (method === "startPrepare") {
      raw = { jobId: ids[starts++] };
      if (loseStart) throw new Error("Synthetic lost start response");
    } else {
      if (result instanceof Error) throw result;
      raw = typeof result === "function" ? await result(jobRequestSchema.parse(input).jobId) : result;
    }
    return outputSchema instanceof z.ZodType ? outputSchema.parse(raw) : raw;
  });
  let fake = createFakePluginHost({ pluginId: "sandboxes", sdk: {
    threads: { get: async () => thread },
    environments: { get: async () => ({ id: "environment-1", projectId: "project-1", hostId: "host-1", path: "/fixture/workspace", status: "ready" }) },
    hosts: { get: async () => makeHostResponse({ id: "host-1", name: "Fixture", machineProviderId: "sandbox-daytona" }) },
    plugins: { callRpc: call },
  } });
  const writes = vi.spyOn(fake.bb.storage.kv, "set");
  cleanups.push(() => fake.harness.dispose());
  let observer = registerNativeProjectEnvironmentSync(fake.bb, { isPluginRunning: async () => true, pollMs });
  return { get fake() { return fake; }, call, get starts() { return starts; }, get observer() { return observer; },
    setResult: (value: typeof result) => { result = value; }, loseStart: () => { loseStart = true; },
    seed: async (value: object) => { await fake.bb.storage.kv.set(writes.mock.calls[0]![0], value); },
    reload: async () => { fake = await fake.harness.lifecycle.reload(bb => { observer = registerNativeProjectEnvironmentSync(bb, { isPluginRunning: async () => true, pollMs }); }); },
  };
}
const begin = async (test: ReturnType<typeof setup>, state = "not-ready") => {
  await test.fake.harness.behavior.emitThreadEvent("thread.active", { thread });
  await vi.waitFor(async () => expect((await test.observer.status(thread.id)).state).toBe(state));
};

it("caches versioned not-ready across activity/reload and coalesces concurrent owner retry into one replacement", async () => {
  const test = setup();
  await Promise.all([begin(test), begin(test)]);
  await test.reload();
  await begin(test);
  expect(test.starts).toBe(1);
  test.setResult((id: string) => id === ids[0] ? outcome(id) : outcome(id, { ready: true, retryable: false, reason: "ready" }));
  const [a, b] = await Promise.all([test.observer.retry(thread.id), test.observer.retry(thread.id)]);
  expect(a).toMatchObject({ state: "ready", jobId: ids[1], retryable: false, sourceVersion: 1 });
  expect(b).toEqual(a);
  expect(test.starts).toBe(2);
});

it("allows explicit retry of versioned genuine before-remote failure only after a fresh source read", async () => {
  const test = setup();
  test.setResult((id: string) => ({ schemaVersion: 1, jobId: id, state: "failed", retryable: true, reason: "before_remote_work" }));
  await begin(test, "failed");
  expect(await test.observer.retry(thread.id)).toMatchObject({ state: "failed", jobId: ids[1], retryable: true });
  expect(test.starts).toBe(2);
});

it.each(["job_unavailable", "completion_unconfirmed"])("does not reuse cached retry authority when fresh source says %s", async reason => {
  const test = setup(); await begin(test);
  test.setResult((id: string) => ({ schemaVersion: 1, jobId: id, state: "unknown", retryable: false, reason }));
  expect(await test.observer.retry(thread.id)).toMatchObject({ state: "unknown", jobId: ids[0], retryable: false });
  await expect(test.observer.retry(thread.id)).rejects.toThrow();
  expect(test.starts).toBe(1);
});

it.each([
  ["legacy failed", { state: "failed", error: "Preparation job is no longer available" }],
  ["legacy ready:false", { state: "complete", result: { ready: false } }],
  ["unsupported version", { schemaVersion: 2, jobId: ids[0], state: "failed", retryable: true, reason: "before_remote_work" }],
  ["contradictory outcome", { schemaVersion: 1, jobId: ids[0], state: "unknown", retryable: true, reason: "job_unavailable" }],
  ["other job", outcome(ids[1])],
  ["extra diagnostic", { ...outcome(ids[0]), error: "not part of the contract" }],
  ["missing source method", new Error("Synthetic method unavailable")],
])("refuses replacement for a fresh %s response despite cached versioned authority", async (_name, response) => {
  const test = setup(); await begin(test);
  test.setResult(response);
  expect(await test.observer.retry(thread.id)).toMatchObject({ state: "unknown", jobId: ids[0], retryable: false });
  expect(test.starts).toBe(1);
});

it.each(["failed", "not-ready", "ready"])("does not trust a cached legacy %s label until explicit versioned reconciliation", async state => {
  const test = setup(); await begin(test);
  await test.seed({ state, jobId: ids[0], reason: "Legacy result" });
  await test.reload();
  expect(await test.observer.status(thread.id)).toMatchObject({ jobId: ids[0], retryable: false });
  await expect(test.observer.retry(thread.id)).rejects.toThrow();
  expect(test.starts).toBe(1);
  expect(await test.observer.reconcile(thread.id)).toMatchObject({ state: "not-ready", jobId: ids[0], retryable: true, sourceVersion: 1 });
  expect(test.starts).toBe(1);
});

it("re-observes a transport-unknown job through running to ready without replacement", async () => {
  const test = setup(); test.setResult(new Error("Synthetic observation disconnect"));
  await begin(test, "unknown");
  await expect(test.observer.retry(thread.id)).rejects.toThrow();
  test.setResult((id: string) => ({ schemaVersion: 1, jobId: id, state: "running", retryable: false, reason: "in_progress" }));
  expect(await test.observer.reconcile(thread.id)).toMatchObject({ state: "running", jobId: ids[0] });
  test.setResult((id: string) => outcome(id, { ready: true, retryable: false, reason: "ready" }));
  expect(await test.observer.reconcile(thread.id)).toMatchObject({ state: "ready", jobId: ids[0] });
  expect(test.starts).toBe(1);
});

it("stops only local polling on disposal and resumes the same source job", async () => {
  const test = setup(); test.setResult((id: string) => ({ schemaVersion: 1, jobId: id, state: "running", retryable: false, reason: "in_progress" }));
  await begin(test, "running");
  await test.reload(); test.setResult((id: string) => outcome(id, { ready: true, retryable: false, reason: "ready" }));
  await begin(test, "ready");
  expect(test.starts).toBe(1);
});

it("persists uncertainty before a lost start response and never starts again on activity or owner retry", async () => {
  const test = setup(); test.loseStart();
  await begin(test, "unknown");
  await test.reload(); await begin(test, "unknown");
  await expect(test.observer.retry(thread.id)).rejects.toThrow();
  await expect(test.observer.reconcile(thread.id)).rejects.toThrow();
  expect(await test.observer.status(thread.id)).toMatchObject({ state: "unknown", jobId: null, retryable: false });
  expect(test.starts).toBe(1);
});

it("consumes prior retry evidence before a replacement whose start response is lost", async () => {
  const test = setup(); await begin(test);
  test.loseStart();
  expect(await test.observer.retry(thread.id)).toMatchObject({ state: "unknown", jobId: null, retryable: false });
  await test.reload(); await begin(test, "unknown");
  await expect(test.observer.retry(thread.id)).rejects.toThrow();
  await expect(test.observer.reconcile(thread.id)).rejects.toThrow();
  expect(test.starts).toBe(2);
});

it("does not persist a late source observation after its observer is disposed", async () => {
  const test = setup();
  let release: (value: unknown) => void = () => { throw new Error("Fixture gate was not initialized"); };
  const gate = new Promise(resolve => { release = resolve; });
  test.setResult(() => gate);
  await begin(test, "running");
  const oldOperation = test.observer.reconcile(thread.id);
  await vi.waitFor(() => expect(test.call.mock.calls.filter(([request]) => request.method === "preparationOutcomeV1")).toHaveLength(2));
  await test.reload();
  test.setResult((id: string) => ({ schemaVersion: 1, jobId: id, state: "unknown", retryable: false, reason: "job_unavailable" }));
  await begin(test, "unknown");
  release(outcome(ids[0]));
  expect(await oldOperation).toMatchObject({ state: "unknown", retryable: false });
  expect(await test.observer.status(thread.id)).toMatchObject({ state: "unknown", jobId: ids[0], retryable: false });
  expect(test.starts).toBe(1);
});

it("returns a bounded same-job refresh while the background observer is polling", async () => {
  const test = setup(10_000);
  test.setResult((id: string) => ({ schemaVersion: 1, jobId: id, state: "running", retryable: false, reason: "in_progress" }));
  await begin(test, "running");
  await vi.waitFor(() => expect(test.call.mock.calls.filter(([request]) => request.method === "preparationOutcomeV1")).toHaveLength(1));
  test.setResult((id: string) => outcome(id));
  const refreshed = await Promise.race([
    Promise.all([test.observer.reconcile(thread.id), test.observer.reconcile(thread.id)]),
    tick().then(() => null),
  ]);
  expect(refreshed).toEqual([
    expect.objectContaining({ state: "not-ready", jobId: ids[0], retryable: true, sourceVersion: 1 }),
    expect.objectContaining({ state: "not-ready", jobId: ids[0], retryable: true, sourceVersion: 1 }),
  ]);
  expect(test.call.mock.calls.filter(([request]) => request.method === "preparationOutcomeV1")).toHaveLength(2);
  expect(test.starts).toBe(1);
});

it("does not restore an old refresh result after a replacement start loses its response", async () => {
  const test = setup(10_000);
  let releaseObservation!: (value: object) => void;
  let releaseRefresh!: (value: object) => void;
  const observation = new Promise<object>(resolve => { releaseObservation = resolve; });
  const refreshing = new Promise<object>(resolve => { releaseRefresh = resolve; });
  let reads = 0;
  test.setResult((id: string) => ++reads === 1 ? observation : reads === 2 ? refreshing : outcome(id));
  await begin(test, "running");
  await vi.waitFor(() => expect(reads).toBe(1));
  const refresh = test.observer.reconcile(thread.id);
  await vi.waitFor(() => expect(reads).toBe(2));
  releaseObservation(outcome(ids[0]));
  await vi.waitFor(async () => expect((await test.observer.status(thread.id)).state).toBe("not-ready"));
  await tick();
  test.loseStart();
  await expect(test.observer.retry(thread.id)).resolves.toMatchObject({ state: "unknown", jobId: null, retryable: false });
  releaseRefresh(outcome(ids[0]));
  await expect(refresh).resolves.toMatchObject({ state: "unknown", jobId: null, retryable: false });
  await expect(test.observer.status(thread.id)).resolves.toMatchObject({ state: "unknown", jobId: null, retryable: false });
  await expect(test.observer.retry(thread.id)).rejects.toBeInstanceOf(Error);
  expect(test.starts).toBe(2);
});
