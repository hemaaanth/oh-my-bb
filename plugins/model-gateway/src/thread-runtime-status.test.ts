import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountPoolPlugin } from "./server.js";
import { AccountStore, HubTokenStore, ThreadRouteStore, type ThreadRoute } from "./upstreams/store.js";
import { PoolOperations } from "./operations.js";

const T = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MACHINE = { experimental_caller: { kind: "plugin", pluginId: "machine" } } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "gateway-cached-read-"));
  const host = createFakePluginHost({
    pluginId: "model-gateway", dataDir,
    sdk: { hosts: { list: async () => [] }, plugins: { list: async () => ({ plugins: [] }) } },
  });
  let now = T;
  const remote = vi.fn<typeof fetch>(() => { throw new Error("Remote access forbidden"); });
  const register = vi.spyOn(host.bb.rpc, "register");
  await createAccountPoolPlugin({ now: () => now, fetch: remote })(host.bb);
  const handlers = register.mock.calls[0]![1] as unknown as Record<string, (input: unknown, context?: unknown) => unknown>;
  const db = host.bb.storage.database();
  const routes = new ThreadRouteStore(db);
  const seed = (changes: Partial<ThreadRoute> = {}) => routes.put({
    threadId: "thr_observed", harness: "acp-omp", upstreamId: "private-account-reference",
    boundAt: T - MINUTE, usedAt: T, stickyUntil: T + MINUTE, reason: "primary exhausted",
    model: "gpt-6-sol", requestedModel: "claude-opus-4-6", autoModel: "gpt-6-sol",
    autoReason: "private free-form auto reason",
    fallbackCause: { upstreamId: "private-primary", upstreamLabel: "person@example.test",
      category: "rate-limit", status: 429, message: "private upstream key https://secret.test", at: T - MINUTE },
    ...changes,
  });
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { host, db, seed, remote, handlers, setNow: (value: number) => { now = value; },
    read: (threadId = "thr_observed", context: object = MACHINE) =>
      host.harness.behavior.callRpc("threadRuntimeStatusV1", { threadId }, context),
  };
}

const observation = {
  schemaVersion: 1, threadId: "thr_observed", readAt: T,
  availability: "observed", observedAt: T, stale: false,
  route: { harness: "acp-omp", model: "gpt-6-sol", requestedModel: "claude-opus-4-6", autoModel: "gpt-6-sol",
    fallback: "fallback", fallbackCause: { category: "rate-limit", status: 429, observedAt: T - MINUTE } },
  configuredRouting: { status: "not-evaluated" },
};

describe("registered threadRuntimeStatusV1", () => {
  it("returns only the last observed route, not today's configured chain or account metadata", async () => {
    const gw = await fixture();
    gw.seed();
    expect(await gw.read()).toEqual(observation);
    // Current policy/account edits must not rewrite historical observations.
    await gw.host.bb.storage.kv.set("config", { chains: { "acp-omp": ["responses-compatible-key:private-label"] } });
    await gw.host.bb.storage.kv.set("accounts:v1", [{ label: "private-account-label", email: "private@example.test" }]);
    expect(await gw.read()).toEqual(observation);
    expect(await gw.read("thr_observed", { experimental_caller: { kind: "client" } })).toEqual(observation);
  });

  it("keeps missing, stale, expired, and clock-skewed observations honest without deleting them", async () => {
    const gw = await fixture();
    expect(await gw.read("thr_absent")).toEqual({
      schemaVersion: 1, threadId: "thr_absent", readAt: T, availability: "missing",
      observedAt: null, stale: null, route: null, configuredRouting: { status: "not-evaluated" },
    });
    gw.seed();
    gw.setNow(T + 30 * MINUTE - 1);
    expect(await gw.read()).toMatchObject({ availability: "observed", stale: false });
    gw.setNow(T + 30 * MINUTE);
    expect(await gw.read()).toMatchObject({ availability: "observed", observedAt: T, stale: true, route: observation.route });
    gw.setNow(T + 7 * DAY);
    expect(await gw.read()).toMatchObject({ availability: "observed", stale: true });
    gw.setNow(T + 7 * DAY + 1);
    expect(await gw.read()).toMatchObject({ availability: "expired", observedAt: T, stale: true, route: null });
    expect(new ThreadRouteStore(gw.db).get("thr_observed")?.usedAt).toBe(T);
    gw.setNow(T - 1);
    expect(await gw.read()).toMatchObject({ availability: "observed", observedAt: T, stale: true });
  });

  it("denies unauthenticated or other-plugin callers and rejects spoofing, enumeration, and host input", async () => {
    const gw = await fixture();
    gw.seed();
    const get = vi.spyOn(ThreadRouteStore.prototype, "get");
    for (const pluginId of ["pages", "journal", "Machine", "machine "]) {
      await expect(gw.read("thr_observed", { experimental_caller: { kind: "plugin", pluginId } })).rejects.toThrow(/forbidden/i);
    }
    const handler = gw.handlers.threadRuntimeStatusV1!;
    for (const context of [undefined, {}, { caller: "machine" }, { experimental_caller: { pluginId: "machine" } }]) {
      await expect(Promise.resolve().then(() => handler({ threadId: "thr_observed" }, context))).rejects.toThrow(/forbidden/i);
    }
    for (const input of [{}, { threadId: "" }, { threadId: "x".repeat(257) }, { threadId: ["thr_observed"] },
      { threadId: "thr_observed", caller: "machine" }, { threadId: "thr_observed", hostId: "host-elsewhere" }]) {
      await expect(gw.host.harness.behavior.callRpc("threadRuntimeStatusV1", input, MACHINE)).rejects.toThrow();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("does no remote, host, credential, overview, pruning, cache, or persisted mutation work on repeated reads", async () => {
    const gw = await fixture();
    gw.seed();
    const before = gw.db.serialize();
    const changes = gw.db.prepare("SELECT total_changes() AS count").get();
    const sdkCalls = gw.host.harness.inspection.sdk.calls.length;
    const signals = gw.host.harness.inspection.realtimeSignals.length;
    const forbidden = [
      vi.spyOn(AccountStore.prototype, "list"), vi.spyOn(AccountStore.prototype, "readSecret"),
      vi.spyOn(HubTokenStore.prototype, "prune"), vi.spyOn(HubTokenStore.prototype, "rotate"),
      vi.spyOn(ThreadRouteStore.prototype, "prune"), vi.spyOn(ThreadRouteStore.prototype, "put"),
      vi.spyOn(PoolOperations.prototype, "list"), vi.spyOn(PoolOperations.prototype, "status"),
      vi.spyOn(gw.host.bb.storage.kv, "get"), vi.spyOn(gw.host.bb.storage.kv, "set"),
      vi.spyOn(fs, "readFile"), vi.spyOn(fs, "writeFile"), vi.spyOn(fs, "rm"),
    ];
    for (let i = 0; i < 3; i++) {
      expect(await gw.read()).toEqual(observation);
      expect(await gw.read("thr_absent")).toMatchObject({ availability: "missing" });
    }
    gw.setNow(T + 8 * DAY);
    expect(await gw.read()).toMatchObject({ availability: "expired" });
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    expect(gw.remote).not.toHaveBeenCalled();
    expect(gw.host.harness.inspection.sdk.calls).toHaveLength(sdkCalls);
    expect(gw.host.harness.inspection.realtimeSignals).toHaveLength(signals);
    expect(gw.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
    expect(gw.db.serialize()).toEqual(before);
  });

  it("bounds unsupported identifiers and never infers a fallback from current configuration", async () => {
    const gw = await fixture();
    gw.seed({ harness: "future-harness", model: "x".repeat(257), requestedModel: null, autoModel: null,
      reason: "free-form private reason", fallbackCause: null });
    expect(await gw.read()).toMatchObject({ route: { harness: null, model: null, requestedModel: null,
      autoModel: null, fallback: "unknown", fallbackCause: null } });
    gw.seed({ model: "https://private.test/model", requestedModel: "person@example.test",
      autoModel: "private model label" });
    expect(await gw.read()).toMatchObject({ route: { model: null, requestedModel: null, autoModel: null } });
    gw.seed({ reason: "primary", fallbackCause: null });
    expect(await gw.read()).toMatchObject({ route: { fallback: "primary", fallbackCause: null } });
    gw.seed({ reason: "fallback", fallbackCause: null });
    expect(await gw.read()).toMatchObject({ route: { fallback: "fallback", fallbackCause: null } });
  });
});
