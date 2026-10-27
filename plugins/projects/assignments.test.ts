import Database from "better-sqlite3";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { assignmentDigest, AssignmentStore } from "./assignment-store.js";
import { assignmentStatusSchema, destinations, exportPageSchema, transferIdentitySchema, type AssignmentKind, type AssignmentRecord, type TransferIdentity } from "./assignments.js";
import { migrations, ProjectsStore } from "./store.js";
import plugin from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const pluginCaller = (pluginId: string) => ({ experimental_caller: { kind: "plugin" as const, pluginId } });

async function fixture(marked = true) {
  const host = createFakePluginHost({ pluginId: "projects", sdk: {
    subscribe: () => () => {}, projects: { list: async () => [{ id: "native/project", kind: "standard", name: "Synthetic", gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] }] },
    plugins: { callRpc: async () => { throw new Error("destination absent"); } },
  } });
  await plugin(host.bb);
  if (marked) new ProjectsStore(host.bb.storage.database()).markMigration("suite-v1");
  cleanups.push(() => host.harness.lifecycle.dispose());
  return host;
}

async function freeze(host: FakePluginHost, kind: AssignmentKind = "bundles") {
  const result = assignmentStatusSchema.parse(await host.harness.behavior.callRpc("assignmentHandoffV1", { phase: "freeze", kind, destination: destinations[kind], destinationVersion: "1.0.0" }));
  return transferIdentitySchema.parse(result.transfer);
}

function adapter(host: FakePluginHost, identity: TransferIdentity, records: AssignmentRecord[]) {
  let available = true;
  let bounce = false;
  let writes = 0;
  let stagedIdentity = identity;
  let reverseFrozen = false;
  host.harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input }) => {
    if (!available) throw new Error("offline");
    expect(pluginId).toBe(identity.destination);
    if (method === "assignmentReceiptV1") return { ...stagedIdentity, phase: "staged", recordCount: records.length, destinationRevision: "staged/revision", conflicts: 0 };
    if (method === "assignmentWriteV1") {
      if (bounce) return host.harness.behavior.callRpc("setProjectBundle", { projectId: "native/project", targetId: "bounce", enabled: true }, pluginCaller(identity.destination));
      const status = assignmentStatusSchema.parse(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: identity.kind }));
      if (status.state !== "destination-owned" || reverseFrozen) throw new Error("destination frozen");
      writes++;
      records.push({ type: "reference", projectId: "native/project", targetId: "new/destination-write" });
      return { ok: true };
    }
    if (method === "assignmentReadV1") return { bundleIds: records.flatMap((record) => record.type === "reference" ? [record.targetId] : []) };
    if (method === "assignmentReverseExportV1") {
      reverseFrozen = true;
      const request = input as { cursor: number };
      const page = records.slice(request.cursor, request.cursor + 200);
      return { ...identity, reverseGeneration: "reverse/1", reverseDigest: assignmentDigest(records), frozen: true, recordCount: records.length, records: page, nextCursor: request.cursor + page.length < records.length ? request.cursor + page.length : null };
    }
    throw new Error(`Unexpected adapter method ${method}`);
  });
  return { records, get writes() { return writes; }, set available(value: boolean) { available = value; }, set bounce(value: boolean) { bounce = value; }, set identity(value: TransferIdentity) { stagedIdentity = value; }, get reverseFrozen() { return reverseFrozen; } };
}

async function stageCommit(host: FakePluginHost, identity: TransferIdentity) {
  await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "stage" });
  await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "commit" });
}
describe("assignment authority", () => {
  it("aborts an exact frozen identity, restores writes and retains its audit across later generations and restore", async () => {
    const host = await fixture();
    const identity = await freeze(host);
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "abort" }, pluginCaller("catalog"))).rejects.toThrow("owner-client-required");
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, semanticDigest: "0".repeat(64), phase: "abort" })).rejects.toThrow("handoff-mismatch");
    expect(await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "abort" })).toMatchObject({ state: "source-owned", transfer: identity });
    await host.harness.behavior.callRpc("setGlobalBundle", { targetId: "source/after-abort", enabled: true });
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "abort" });
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual([{ type: "reference", projectId: null, targetId: "source/after-abort" }]);
    await expect(host.harness.behavior.callRpc("assignmentExportV1", { kind: "bundles", generation: identity.generation })).rejects.toThrow("Freeze this assignment kind");
    const next = await freeze(host);
    expect(next.generation).not.toBe(identity.generation);
    expect(await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "abort" })).toMatchObject({ state: "frozen/exported", transfer: next });
    const restored = new Database(host.bb.storage.database().serialize());
    const restoredAuthority = new AssignmentStore(restored);
    expect(restoredAuthority.abort(identity).status).toMatchObject({ state: "frozen/exported", transfer: next });
    expect(() => restoredAuthority.requireWritable("bundles")).toThrow("assignment-frozen");
    const abandoned = z.object({ identity_json: z.string(), previous_state: z.string(), receipt_json: z.null() }).parse(restored.prepare("SELECT * FROM assignment_aborts WHERE kind = 'bundles' AND generation = ?").get(identity.generation));
    expect(JSON.parse(abandoned.identity_json)).toEqual(identity);
    expect(abandoned.previous_state).toBe("frozen/exported");
    restored.close();
  });

  it("aborts staged ownership without waiting for destination discard and rejects a stale commit", async () => {
    const host = await fixture();
    const identity = await freeze(host);
    let discardStarted = false;
    host.harness.sdk.stub("plugins.callRpc", async ({ method }) => {
      if (method === "assignmentReceiptV1") return { ...identity, phase: "staged", recordCount: 0, destinationRevision: "staged/abandoned", conflicts: 0 };
      if (method === "assignmentAbortV1") { discardStarted = true; return new Promise(() => {}); }
      throw new Error(method);
    });
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "stage" });
    expect(await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "abort" })).toMatchObject({ state: "source-owned" });
    expect(discardStarted).toBe(true);
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "commit" })).rejects.toThrow("Stage the frozen transfer");
    await host.harness.behavior.callRpc("setGlobalBundle", { targetId: "source/staged-abort", enabled: true });
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual([{ type: "reference", projectId: null, targetId: "source/staged-abort" }]);
    const abandoned = z.object({ receipt_json: z.string(), previous_state: z.string() }).parse(host.bb.storage.database().prepare("SELECT * FROM assignment_aborts WHERE kind = 'bundles' AND generation = ?").get(identity.generation));
    expect(abandoned.previous_state).toBe("destination-staged");
    expect(JSON.parse(abandoned.receipt_json)).toMatchObject({ destinationReceipt: { destinationRevision: "staged/abandoned" } });
  });

  it("rejects abort after commit and throughout reverse reconciliation without reviving the source writer", async () => {
    const host = await fixture();
    const identity = await freeze(host);
    const remote = adapter(host, identity, []);
    await stageCommit(host, identity);
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "abort" })).rejects.toThrow("Cannot abort destination-owned");
    await host.harness.behavior.callRpc("setGlobalBundle", { targetId: "still/destination-owned", enabled: true });
    expect(remote.writes).toBe(1);
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual([]);
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-freeze" });
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "abort" })).rejects.toThrow("Cannot abort reverse-frozen");
    expect(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toMatchObject({ state: "reverse-frozen" });
  });

  it.each(["stage", "commit"] as const)("does not resurrect an aborted transfer when a pending %s receipt returns", async (phase) => {
    const host = await fixture();
    const identity = await freeze(host);
    adapter(host, identity, []);
    if (phase === "commit") await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "stage" });
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pendingReceipt = new Promise((resolve) => { release = resolve; });
    host.harness.sdk.stub("plugins.callRpc", async ({ method }) => {
      if (method === "assignmentReceiptV1") { entered(); return pendingReceipt; }
      if (method === "assignmentAbortV1") return { ok: true };
      throw new Error(method);
    });
    const pending = host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase });
    const rejected = expect(pending).rejects.toThrow("handoff-mismatch");
    await started;
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "abort" });
    await host.harness.behavior.callRpc("setGlobalBundle", { targetId: "source/race-preserved", enabled: true });
    const next = phase === "commit" ? await freeze(host) : null;
    release({ ...identity, phase: "staged", recordCount: 0, destinationRevision: "staged/revision", conflicts: 0 });
    await rejected;
    expect(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toMatchObject({ state: next ? "frozen/exported" : "source-owned", transfer: next ?? identity });
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual([{ type: "reference", projectId: null, targetId: "source/race-preserved" }]);
  });

  it.each(["stage", "commit"] as const)("keeps concurrent identical %s retries idempotent", async (phase) => {
    const host = await fixture();
    const identity = await freeze(host);
    adapter(host, identity, []);
    if (phase === "commit") await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "stage" });
    let release!: (value: unknown) => void;
    let entered!: () => void;
    let waiting = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const receipt = new Promise((resolve) => { release = resolve; });
    host.harness.sdk.stub("plugins.callRpc", async () => { if (++waiting === 2) entered(); return receipt; });
    const calls = [host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase }), host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase })];
    await started;
    release({ ...identity, phase: "staged", recordCount: 0, destinationRevision: "staged/revision", conflicts: 0 });
    const expected = { kind: "bundles", state: phase === "stage" ? "destination-staged" : "destination-owned", transfer: identity, reverseGeneration: null };
    expect(await Promise.all(calls)).toEqual([expected, expected]);
    expect(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toEqual(expected);
  });

  it.each(["bundles", "applicationBindings"] as const)("freezes %s locally, rejects plugin-driven authority changes, and exports opaque IDs", async (kind) => {
    const host = await fixture();
    const store = new ProjectsStore(host.bb.storage.database());
    store.updateProject("unknown/project", { credentialId: "opaque/profile" });
    store.updateProject("null/project", { credentialId: null });
    store.toggleProjectReference("bundle", "deleted/project", "unresolved/bundle", true);
    store.toggleGlobalReference("agent", "opaque/agent", true);
    const before = new AssignmentStore(host.bb.storage.database()).records(kind);
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { phase: "freeze", kind, destination: destinations[kind], destinationVersion: "1.0.0" }, pluginCaller(destinations[kind]))).rejects.toThrow("owner-client-required");
    const identity = await freeze(host, kind);
    const page = exportPageSchema.parse(await host.harness.behavior.callRpc("assignmentExportV1", { kind, generation: identity.generation }));
    expect(page.records).toEqual(before);
    expect(page.semanticDigest).toBe(assignmentDigest(before));
    await expect(host.harness.behavior.callRpc(kind === "bundles" ? "setGlobalBundle" : "updateProject", kind === "applicationBindings" ? { projectId: "native/project", credentialId: null } : { targetId: "opaque/new", enabled: true })).rejects.toThrow("assignment-frozen");
    expect(new AssignmentStore(host.bb.storage.database()).records(kind)).toEqual(before);
  });

  it("retains old destination write-through while source-owned", async () => {
    const host = await fixture();
    await host.harness.behavior.callRpc("setProjectBundle", { projectId: "native/project", targetId: "old/catalog", enabled: true }, pluginCaller("catalog"));
    await host.harness.behavior.callRpc("updateProject", { projectId: "native/project", credentialId: "old/credentials" }, pluginCaller("project-environments"));
    expect(new ProjectsStore(host.bb.storage.database()).getConfiguration("native/project")).toMatchObject({ credentialId: "old/credentials", bundleIds: ["old/catalog"] });
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });

  it.each(["generation", "semanticDigest", "destination", "destinationVersion", "kind", "adapterVersion"] as const)("rejects a mismatched %s receipt without reopening either writer", async (field) => {
    const host = await fixture();
    const identity = await freeze(host);
    const remote = adapter(host, identity, []);
    remote.identity = { ...identity, [field]: field === "semanticDigest" ? "0".repeat(64) : field === "kind" ? "applicationBindings" : field === "adapterVersion" ? 2 : "wrong" } as TransferIdentity;
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "stage" })).rejects.toThrow();
    expect(assignmentStatusSchema.parse(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).state).toBe("frozen/exported");
    await expect(host.harness.behavior.callRpc("setGlobalBundle", { targetId: "no/write", enabled: true })).rejects.toThrow("assignment-frozen");
  });

  it("forwards once only after durable commit, rejects destination bounce, and never falls back offline", async () => {
    const host = await fixture();
    await host.harness.behavior.callRpc("setProjectBundle", { projectId: "native/project", targetId: "source/original", enabled: true });
    const identity = await freeze(host);
    const sourceBefore = new AssignmentStore(host.bb.storage.database()).records("bundles");
    const remote = adapter(host, identity, [...sourceBefore]);
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "stage" });
    await expect(host.harness.behavior.callRpc("setGlobalBundle", { targetId: "not/yet", enabled: true })).rejects.toThrow("assignment-frozen");
    expect(remote.writes).toBe(0);
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "commit" });
    await host.harness.behavior.callRpc("setProjectBundle", { projectId: "native/project", targetId: "new/destination-write", enabled: true });
    expect(remote.writes).toBe(1);
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual(sourceBefore);
    expect(await host.harness.behavior.callRpc("projectContext", { projectId: "native/project" })).toMatchObject({ bundleIds: ["source/original", "new/destination-write"] });
    await expect(host.harness.behavior.callRpc("setGlobalBundle", { targetId: "bounce", enabled: true }, pluginCaller("catalog"))).rejects.toThrow("handoff-loop");
    remote.bounce = true;
    await expect(host.harness.behavior.callRpc("setProjectBundle", { projectId: "native/project", targetId: "bounce", enabled: true })).rejects.toThrow("handoff-loop");
    expect(remote.writes).toBe(1);
    remote.available = false;
    await expect(host.harness.behavior.callRpc("setGlobalBundle", { targetId: "offline", enabled: true })).rejects.toThrow("owner-unavailable");
    await expect(host.harness.behavior.callRpc("projectContext", { projectId: "native/project" })).rejects.toThrow("owner-unavailable");
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual(sourceBefore);
  });

  it("restores all destination writes through frozen reverse export before source writes resume", async () => {
    const host = await fixture();
    const identity = await freeze(host);
    const remote = adapter(host, identity, []);
    await stageCommit(host, identity);
    await host.harness.behavior.callRpc("setProjectBundle", { projectId: "native/project", targetId: "new/destination-write", enabled: true });
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-freeze" });
    await expect(host.harness.behavior.callRpc("setGlobalBundle", { targetId: "too/early", enabled: true })).rejects.toThrow("assignment-frozen");
    remote.available = false;
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-commit" })).rejects.toThrow("offline");
    expect(assignmentStatusSchema.parse(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).state).toBe("reverse-frozen");
    remote.available = true;
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-commit" });
    expect(remote.reverseFrozen).toBe(true);
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual(remote.records);
    const retry = await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-commit" });
    expect(retry).toMatchObject({ state: "source-owned", reverseGeneration: "reverse/1" });
    await host.harness.behavior.callRpc("setGlobalBundle", { targetId: "source/resumed", enabled: true });
    expect(remote.writes).toBe(1);
  });

  it("preserves completed reverse identity and rows when repeat freeze is refused, including after restart", async () => {
    const host = await fixture();
    const identity = await freeze(host);
    const remote = adapter(host, identity, []);
    await stageCommit(host, identity);
    await host.harness.behavior.callRpc("setProjectBundle", { projectId: "native/project", targetId: "new/destination-write", enabled: true });
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-freeze" });
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-commit" });
    const completed = await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" });
    expect(completed).toMatchObject({ state: "source-owned", transfer: identity, reverseGeneration: "reverse/1" });
    const before = host.bb.storage.database().serialize();
    await expect(freeze(host)).rejects.toThrow("handoff-mismatch");
    expect(host.bb.storage.database().serialize()).toEqual(before);
    expect(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toEqual(completed);
    const reloaded = await host.harness.lifecycle.reload(plugin);
    cleanups.push(() => reloaded.harness.lifecycle.dispose());
    const afterRestart = reloaded.bb.storage.database().serialize();
    expect(await reloaded.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toEqual(completed);
    await expect(freeze(reloaded)).rejects.toThrow("handoff-mismatch");
    expect(reloaded.bb.storage.database().serialize()).toEqual(afterRestart);
    await reloaded.harness.behavior.callRpc("setProjectBundle", { projectId: "native/project", targetId: "catalog/read-through-write", enabled: true }, pluginCaller("catalog"));
    expect(await reloaded.harness.behavior.callRpc("projectContext", { projectId: "native/project" }, pluginCaller("catalog"))).toMatchObject({ bundleIds: ["catalog/read-through-write", "new/destination-write"] });
    expect(remote.writes).toBe(1);
    expect(await reloaded.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toEqual(completed);
  });

  it.each(["frozen/exported", "destination-staged", "destination-owned", "reverse-frozen"] as const)("restores a durable %s snapshot without enabling a second writer", async (state) => {
    const host = await fixture();
    const identity = await freeze(host);
    adapter(host, identity, []);
    if (state !== "frozen/exported") await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "stage" });
    if (state === "destination-owned" || state === "reverse-frozen") await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "commit" });
    if (state === "reverse-frozen") await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-freeze" });
    const db = host.bb.storage.database();
    const restored = new Database(db.serialize());
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    const restoredAuthority = new AssignmentStore(restored);
    expect(restoredAuthority.status("bundles")).toEqual(new AssignmentStore(db).status("bundles"));
    expect(() => restoredAuthority.requireWritable("bundles")).toThrow("assignment-frozen");
    restored.close();
    const reloaded = await host.harness.lifecycle.reload(plugin);
    cleanups.push(() => reloaded.harness.lifecycle.dispose());
    expect(await reloaded.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toMatchObject({ state });
    expect(await reloaded.harness.behavior.callRpc("assignmentHandoffV1", { phase: "freeze", kind: "bundles", destination: "catalog", destinationVersion: "1.0.0" })).toMatchObject({ transfer: identity });
  });

  it("exports bounded, frozen pages and does not mutate native routing/group state", async () => {
    const host = await fixture();
    const store = new ProjectsStore(host.bb.storage.database());
    store.updateProject("native/project", { icon: "◈", credentialId: "profile/kept" });
    store.saveRoutingProfile("native/project", { description: "Manual profile", keywords: ["kept"], aliases: [], repositories: [], notFor: [], source: "manual", fingerprint: null });
    for (let n = 0; n < 405; n++) store.toggleProjectReference("bundle", `native/${n}`, `bundle/${n}`, true);
    const before = store.getConfiguration("native/project");
    const identity = await freeze(host);
    const records: AssignmentRecord[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = exportPageSchema.parse(await host.harness.behavior.callRpc("assignmentExportV1", { kind: "bundles", generation: identity.generation, cursor }));
      expect(page.records.length).toBeLessThanOrEqual(200);
      records.push(...page.records);
      cursor = page.nextCursor;
    }
    expect(records).toEqual(new AssignmentStore(host.bb.storage.database()).records("bundles"));
    expect(assignmentDigest(records)).toBe(identity.semanticDigest);
    expect(store.getConfiguration("native/project")).toEqual(before);
    await expect(host.harness.behavior.callRpc("assignmentExportV1", { kind: "bundles", generation: "wrong" })).rejects.toThrow("handoff-mismatch");
  });

  it("appends schema without changing restored legacy assignments or learned routing", () => {
    const db = new Database(":memory:");
    for (const sql of migrations.slice(0, 4)) db.exec(sql);
    const store = new ProjectsStore(db);
    store.markMigration("suite-v1");
    store.updateProject("retired/project", { icon: "✓", credentialId: "unresolved/profile" });
    store.toggleProjectReference("bundle", "retired/project", "disabled/bundle", true);
    store.saveRoutingLearning("retired/project", { learnedFor: ["preserved"], learnedNotFor: ["also preserved"], fingerprint: "old-fingerprint" });
    const before = store.getConfiguration("retired/project");
    for (const sql of migrations.slice(4)) db.exec(sql);
    expect(new ProjectsStore(db).getConfiguration("retired/project")).toEqual(before);
    expect(new AssignmentStore(db).status("bundles").state).toBe("source-owned");
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });
  it.each(["applicationBindings"] as const)("forwards and reverse-reconciles %s without changing IDs or native configuration", async (kind) => {
    const host = await fixture();
    const local = new ProjectsStore(host.bb.storage.database());
    local.updateProject("native/project", { icon: "kept", credentialId: "old/profile" });
    local.updateProject("null/project", { credentialId: null });
    local.toggleProjectReference("agent", "native/project", "old/agent", true);
    const authority = new AssignmentStore(host.bb.storage.database());
    const before = authority.records(kind);
    const identity = await freeze(host, kind);
    let records = [...before];
    let writes = 0;
    host.harness.sdk.stub("plugins.callRpc", async ({ method, input }) => {
      if (method === "assignmentReceiptV1") return { ...identity, phase: "staged", recordCount: before.length, destinationRevision: "staged/revision", conflicts: 0 };
      if (method === "assignmentWriteV1") {
        if (kind === "applicationBindings") {
          const request = z.object({ input: z.object({ projectId: z.string(), credentialId: z.string().nullable() }) }).parse(input);
          records = records.filter((record) => record.type !== "binding" || record.projectId !== request.input.projectId);
          records.push({ type: "binding", ...request.input });
        } else {
          const request = z.object({ input: z.object({ projectId: z.string(), targetId: z.string(), enabled: z.literal(true) }) }).parse(input);
          records.push({ type: "reference", projectId: request.input.projectId, targetId: request.input.targetId });
        }
        writes++;
        return { ok: true };
      }
      if (method === "assignmentReadV1") return kind === "applicationBindings" ? { credentialId: "new/profile" } : { agentIds: ["old/agent", "new/agent"] };
      if (method === "assignmentReverseExportV1") return { ...identity, reverseGeneration: "reverse/current", reverseDigest: assignmentDigest(records), recordCount: records.length, frozen: true, records, nextCursor: null };
      throw new Error(method);
    });
    await stageCommit(host, identity);
    await host.harness.behavior.callRpc(kind === "applicationBindings" ? "updateProject" : "setProjectAgent", kind === "applicationBindings" ? { projectId: "native/project", credentialId: "new/profile" } : { projectId: "native/project", targetId: "new/agent", enabled: true });
    expect(writes).toBe(1);
    expect(authority.records(kind)).toEqual(before);
    const context = await host.harness.behavior.callRpc("projectContext", { projectId: "native/project" });
    expect(context).toMatchObject(kind === "applicationBindings" ? { credentialId: "new/profile" } : { agentIds: ["old/agent", "new/agent"] });
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-freeze" });
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-commit" });
    expect(authority.records(kind)).toEqual([...records].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    expect(local.getConfiguration("native/project").icon).toBe("kept");
    if (kind === "applicationBindings") expect(local.getConfiguration("null/project").credentialId).toBeNull();
  });

  it.each(["digest", "duplicate", "wrong-kind", "cursor", "count"] as const)("keeps reverse reconciliation frozen after invalid %s evidence", async (failure) => {
    const host = await fixture();
    const identity = await freeze(host);
    adapter(host, identity, []);
    await stageCommit(host, identity);
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-freeze" });
    const records: AssignmentRecord[] = failure === "wrong-kind" ? [{ type: "binding", projectId: "p", credentialId: null }] : [
      { type: "reference", projectId: "p", targetId: "b" },
      ...(failure === "duplicate" ? [{ type: "reference" as const, projectId: "p", targetId: "b" }] : []),
    ];
    host.harness.sdk.stub("plugins.callRpc", async () => ({
      ...identity, reverseGeneration: "bad/reverse", reverseDigest: failure === "digest" ? "0".repeat(64) : assignmentDigest(records),
      recordCount: failure === "count" ? records.length + 1 : records.length, frozen: true, records, nextCursor: failure === "cursor" ? 0 : null,
    }));
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-commit" })).rejects.toThrow("handoff-mismatch");
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual([]);
    expect(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toMatchObject({ state: "reverse-frozen" });
  });
  it("pins a durable staged revision and refuses commit if that receipt changes", async () => {
    const host = await fixture();
    const identity = await freeze(host);
    adapter(host, identity, []);
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "commit" })).rejects.toThrow("Stage the frozen transfer");
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "stage" });
    const saved = z.object({ receipt_json: z.string() }).parse(host.bb.storage.database().prepare("SELECT receipt_json FROM assignment_transfers WHERE kind = 'bundles'").get());
    expect(JSON.parse(saved.receipt_json)).toMatchObject({
      sourcePluginId: "projects", sourceGeneration: identity.generation, sourceSemanticDigest: identity.semanticDigest,
      destinationRevision: "staged/revision", countByKind: { bundles: 0 }, conflicts: 0, phase: "destination-staged",
    });
    host.harness.sdk.stub("plugins.callRpc", async () => ({ ...identity, phase: "staged", recordCount: 0, destinationRevision: "changed/revision", conflicts: 0 }));
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "commit" })).rejects.toThrow("staged revision");
    expect(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toMatchObject({ state: "destination-staged" });
  });
  it("preserves batch order and repeated IDs, and blocks incomplete owner projections instead of empty assignments", async () => {
    const host = await fixture();
    const local = new ProjectsStore(host.bb.storage.database());
    local.updateProject("first/project", { credentialId: "first/profile" });
    local.updateProject("second/project", { credentialId: null });
    const identity = await freeze(host);
    adapter(host, identity, []);
    await stageCommit(host, identity);
    let incomplete = false;
    host.harness.sdk.stub("plugins.callRpc", async () => ({ projects: [
      { projectId: "first/project", bundleIds: ["destination/first"] },
      ...incomplete ? [] : [{ projectId: "second/project", bundleIds: ["destination/second"] }],
    ] }));
    const result = await host.harness.behavior.callRpc("projectContexts", { projectIds: ["second/project", "first/project", "second/project"] });
    expect(result).toMatchObject({ projects: [
      { projectId: "second/project", credentialId: null, bundleIds: ["destination/second"] },
      { projectId: "first/project", credentialId: "first/profile", bundleIds: ["destination/first"] },
      { projectId: "second/project", credentialId: null, bundleIds: ["destination/second"] },
    ] });
    incomplete = true;
    await expect(host.harness.behavior.callRpc("projectContexts", { projectIds: ["first/project", "second/project"] })).rejects.toThrow("Owner batch projection is incomplete");
    expect(local.getConfiguration("first/project").credentialId).toBe("first/profile");
  });
  it("refuses reverse exports that omit preserved unresolved legacy records", async () => {
    const host = await fixture(false);
    await host.harness.behavior.callRpc("importLegacy", { catalogAssignments: [
      { bundleId: "unresolved/bundle", kind: "project-environment", targetId: "unknown/profile" },
    ] });
    host.harness.sdk.stub("plugins.list", async () => ({ plugins: ["catalog", "project-environments", "agent-profiles"].map((id) => ({ id, enabled: true, status: "running" })) }));
    host.harness.sdk.stub("plugins.callRpc", async ({ method }) => {
      if (method === "assignmentStatus") return { state: "uninitialized", transfer: null, destinationRevision: null, conflicts: 0 };
      if (method === "legacyWorkspaceSnapshot") return { workspaces: [] };
      if (method === "legacySnapshot") return { profiles: [], projects: [] };
      if (method === "legacyAssignments") return { assignments: [] };
      if (method === "listProfiles") return [];
      if (method === "remapLegacyProjectGroups") return { ok: true };
      throw new Error(`Unexpected source method: ${method}`);
    });
    await host.harness.behavior.callRpc("importLegacyFromSourcesV1", null);
    const store = new AssignmentStore(host.bb.storage.database());
    const preserved = store.records("bundles");
    const identity = await freeze(host);
    const remote = adapter(host, identity, [...preserved]);
    await stageCommit(host, identity);
    await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-freeze" });
    remote.records.length = 0;
    await expect(host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase: "reverse-commit" })).rejects.toThrow("omitted preserved legacy records");
    expect(store.records("bundles")).toEqual(preserved);
    expect(store.status("bundles").state).toBe("reverse-frozen");
  });
  it("keeps post-activation retries local with immutable historical identity and receipt", async () => {
    const host = await fixture();
    const identity = await freeze(host);
    const remote = adapter(host, identity, []);
    await stageCommit(host, identity);
    const before = host.bb.storage.database().prepare("SELECT identity_json, receipt_json FROM assignment_transfers WHERE kind = 'bundles'").get();
    remote.available = false;
    for (const phase of ["stage", "commit"]) expect(await host.harness.behavior.callRpc("assignmentHandoffV1", { ...identity, phase })).toMatchObject({ state: "destination-owned", transfer: identity });
    expect(host.bb.storage.database().prepare("SELECT identity_json, receipt_json FROM assignment_transfers WHERE kind = 'bundles'").get()).toEqual(before);
    await expect(host.harness.behavior.callRpc("setGlobalBundle", { targetId: "must-not-revive-source", enabled: true })).rejects.toThrow("owner-unavailable");
    expect(new AssignmentStore(host.bb.storage.database()).records("bundles")).toEqual([]);
  });
});
