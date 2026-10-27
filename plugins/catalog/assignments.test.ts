import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import plugin from "./server.js";
import { CatalogStore, migrations } from "./store.js";
import { CatalogAssignmentStore } from "./assignment-store.js";
import { assignmentDigest } from "./assignment-digest.js";
import { type AssignmentRecord, type TransferIdentity, type assignmentStatusSchema } from "./assignment-contract.js";

const release = vi.hoisted(() => ({ version: "0.2.1" }));
vi.mock("./package.json", () => ({ default: { get version() { return release.version; } } }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { release.version = "0.2.1"; for (const cleanup of cleanups.splice(0)) await cleanup(); });
const projectsCaller = { experimental_caller: { kind: "plugin" as const, pluginId: "projects" } };
const BUNDLE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function fixture(records: AssignmentRecord[] = []) {
  const identity: TransferIdentity = { schemaVersion: 1, kind: "bundles", generation: "generation/one", semanticDigest: assignmentDigest(records), destination: "catalog", destinationVersion: release.version, adapterVersion: 1 };
  const source: z.infer<typeof assignmentStatusSchema> = { kind: "bundles", state: "frozen/exported", transfer: identity, reverseGeneration: null };
  let available = true;
  let host: FakePluginHost;
  const calls: string[] = [];
  let afterPage: (() => Promise<void>) | undefined;
  const options = { pluginId: "catalog", sdk: {
    system: { config: async () => ({ primaryHostId: null, dataDir: "/tmp/catalog-assignment-test" }) as never },
    hosts: { list: async () => [] }, threads: { list: async () => [] }, projects: { list: async () => [] },
    plugins: { list: async () => ({ plugins: [] }), callRpc: async ({ method, input }: { method: string; input: unknown }) => {
      calls.push(method);
      if (!available) throw new Error("Source is unavailable");
      if (method === "assignmentStatusV1") return structuredClone(source);
      if (method === "assignmentExportV1") {
        const { cursor } = input as { cursor: number };
        if (afterPage) await afterPage();
        const page = records.slice(cursor, cursor + 200);
        return { ...identity, frozen: true, records: page, recordCount: records.length, nextCursor: cursor + page.length < records.length ? cursor + page.length : null };
      }
      if (method === "bundleAssignmentSnapshot") {
        const references = records.filter((record) => record.type === "reference");
        const projects = new Map<string, string[]>();
        for (const record of references) if (record.projectId !== null) projects.set(record.projectId, [...(projects.get(record.projectId) ?? []), record.targetId]);
        return { globalBundleIds: references.filter((record) => record.projectId === null).map((record) => record.targetId), projects: [...projects].map(([projectId, bundleIds]) => ({ projectId, bundleIds })) };
      }
      if (method === "setGlobalBundle") {
        const change = input as { targetId: string; enabled: boolean };
        if (source.state !== "source-owned") throw new Error("source writer is frozen");
        if (change.enabled) records.push({ type: "reference", projectId: null, targetId: change.targetId });
        return { ok: true };
      }
      throw new Error(`Unexpected source operation ${method}`);
    } },
  } };
  host = createFakePluginHost(options);
  await plugin(host.bb);
  const catalog = new CatalogStore(host.bb.storage.database());
  catalog.saveBundle({ id: BUNDLE, name: "Fixture", description: "", skillIds: [] });
  catalog.saveBundle({ id: OTHER, name: "Other", description: "", skillIds: [] });
  cleanups.push(() => host.harness.lifecycle.dispose());
  return { get host() { return host; }, identity, source, calls, catalog,
    set available(value: boolean) { available = value; }, set afterPage(value: (() => Promise<void>) | undefined) { afterPage = value; },
    async reload(version = release.version) { release.version = version; host = await host.harness.lifecycle.reload(plugin); },
    async stage() { return host.harness.behavior.callRpc("stageAssignmentsV1", identity); },
    async activate() { source.state = "destination-owned"; return host.harness.behavior.callRpc("activateAssignmentsV1", identity); },
  };
}

describe("Catalog assignment authority", () => {
  it("does no source probing or materialization on startup and requires explicit standalone initialization", async () => {
    const f = await fixture();
    expect(f.calls).toEqual([]);
    f.available = false;
    await expect(f.host.harness.behavior.callRpc("snapshot", null)).rejects.toThrow("owner-unavailable");
    await expect(f.host.harness.behavior.callRpc("materialize", { hostId: "fixture-host", homePath: "/tmp/fixture", projectId: null, workspacePath: null })).rejects.toThrow("owner-unavailable");
    expect(f.host.harness.inspection.sdk.callsTo("files.write")).toEqual([]);
    await f.host.harness.behavior.callRpc("initializeAssignmentsV1", { confirmation: "no-legacy-assignments" });
    await f.host.harness.behavior.callRpc("setAssignment", { bundleId: BUNDLE, kind: "project", targetId: "opaque/project", enabled: true });
    expect(await f.host.harness.behavior.callRpc("snapshot", null)).toMatchObject({ assignments: [{ bundleId: BUNDLE, kind: "project", targetId: "opaque/project" }] });
    const count = f.calls.length;
    await f.reload();
    expect(await f.host.harness.behavior.callRpc("snapshot", null)).toMatchObject({ assignments: [{ bundleId: BUNDLE, targetId: "opaque/project" }] });
    expect(f.calls).toHaveLength(count);
  });

  it("review K1 refuses standalone initialization over an existing source writer and requires an explicit absent-source attestation", async () => {
    const f = await fixture([{ type: "reference", projectId: null, targetId: BUNDLE }]);
    f.source.state = "source-owned";
    await expect(f.host.harness.behavior.callRpc("initializeAssignmentsV1", { confirmation: "no-legacy-assignments" })).rejects.toThrow("handoff");
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "uninitialized" });
    for (const method of ["files.mkdir", "files.write", "files.remove"]) expect(f.host.harness.inspection.sdk.callsTo(method)).toEqual([]);
    f.source.state = "not-migrated";
    await expect(f.host.harness.behavior.callRpc("initializeAssignmentsV1", { confirmation: "no-legacy-assignments" })).rejects.toThrow("handoff");
    f.available = false;
    await expect(f.host.harness.behavior.callRpc("initializeAssignmentsV1", {})).rejects.toThrow();
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "uninitialized" });
    await f.host.harness.behavior.callRpc("initializeAssignmentsV1", { confirmation: "no-legacy-assignments" });
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "active", transfer: null });
  });

  it.each(["installed-source-unavailable", "metadata-unavailable"])("review K1 refuses inferred absence when %s", async (failure) => {
    const f = await fixture();
    f.available = false;
    f.host.harness.sdk.stub("plugins.list", async () => {
      if (failure === "metadata-unavailable") throw new Error("native metadata unavailable");
      return { plugins: [{ id: "projects" }] };
    });
    await expect(f.host.harness.behavior.callRpc("initializeAssignmentsV1", { confirmation: "no-legacy-assignments" })).rejects.toThrow(failure === "metadata-unavailable" ? "metadata is unavailable" : "installed but unavailable");
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "uninitialized" });
    for (const method of ["files.mkdir", "files.write", "files.remove"]) expect(f.host.harness.inspection.sdk.callsTo(method)).toEqual([]);
  });

  it("review K2 reads and writes through only the exact reverse-reconciled source without thawing destination rows", async () => {
    const records: AssignmentRecord[] = [{ type: "reference", projectId: "p", targetId: BUNDLE }];
    const f = await fixture(records);
    await f.stage(); await f.activate();
    await f.host.harness.behavior.callRpc("setAssignment", { bundleId: OTHER, kind: "project", targetId: "destination-edit", enabled: true });
    f.source.state = "reverse-frozen";
    const reversed = await f.host.harness.behavior.callRpc("assignmentReverseExportV1", { ...f.identity, cursor: 0, reverseGeneration: null }, projectsCaller) as { records: AssignmentRecord[]; reverseGeneration: string };
    records.splice(0, records.length, ...reversed.records);
    f.source.state = "source-owned"; f.source.reverseGeneration = reversed.reverseGeneration;
    const localBefore = new CatalogAssignmentStore(f.host.bb.storage.database(), f.catalog).records();
    expect(await f.host.harness.behavior.callRpc("snapshot", null)).toMatchObject({ assignments: expect.arrayContaining([{ bundleId: OTHER, kind: "project", targetId: "destination-edit" }]) });
    await f.host.harness.behavior.callRpc("setAssignment", { bundleId: OTHER, kind: "global", targetId: "*", enabled: true });
    expect(f.calls.filter((method) => method === "setGlobalBundle")).toHaveLength(1);
    expect(new CatalogAssignmentStore(f.host.bb.storage.database(), f.catalog).records()).toEqual(localBefore);
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "reverse-frozen" });
    f.available = false;
    await expect(f.host.harness.behavior.callRpc("snapshot", null)).rejects.toThrow("owner-unavailable");
    f.available = true;
    f.source.reverseGeneration = "wrong-reverse-generation";
    await expect(f.host.harness.behavior.callRpc("snapshot", null)).rejects.toThrow("assignment-frozen");
    await expect(f.host.harness.behavior.callRpc("setAssignment", { bundleId: BUNDLE, kind: "global", targetId: "*", enabled: true })).rejects.toThrow("assignment-frozen");
  });

  it("preserves completed reverse authority when a different handoff and delayed abort arrive", async () => {
    const records: AssignmentRecord[] = [{ type: "reference", projectId: null, targetId: BUNDLE }];
    const f = await fixture(records);
    f.catalog.setAssignment(OTHER, "agent-profile", "legacy/profile", true);
    await f.stage(); await f.activate();
    f.source.state = "reverse-frozen";
    const reversed = await f.host.harness.behavior.callRpc("assignmentReverseExportV1", { ...f.identity, cursor: 0, reverseGeneration: null }, projectsCaller) as { records: AssignmentRecord[]; reverseGeneration: string };
    records.splice(0, records.length, ...reversed.records);
    f.source.state = "source-owned"; f.source.reverseGeneration = reversed.reverseGeneration;
    const preserved = () => {
      const db = f.host.bb.storage.database();
      return {
        authority: db.prepare("SELECT * FROM catalog_assignment_authority").all(),
        records: db.prepare("SELECT * FROM catalog_assignment_records ORDER BY record_json").all(),
        history: db.prepare("SELECT * FROM catalog_assignment_history WHERE identity_json = ? ORDER BY id").all(JSON.stringify(f.identity)),
        legacy: new CatalogStore(db).listAssignments(),
      };
    };
    const before = preserved();
    const store = new CatalogAssignmentStore(f.host.bb.storage.database(), f.catalog);
    const different = { ...f.identity, generation: "generation/two", semanticDigest: assignmentDigest(records) };
    let rejected: unknown;
    try { store.stage(different, records); } catch (error) { rejected = error; }
    const afterStage = preserved();
    await f.host.harness.behavior.callRpc("assignmentAbortV1", different, projectsCaller);
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "reverse-frozen", transfer: f.identity });
    expect(afterStage).toEqual(before);
    expect(preserved()).toEqual(before);
    expect(rejected).toMatchObject({ reasonCode: "assignment-frozen" });
    await f.reload();
    expect(preserved()).toEqual(before);
    expect(await f.host.harness.behavior.callRpc("snapshot", null)).toMatchObject({ assignments: [{ bundleId: BUNDLE, kind: "global", targetId: "*" }] });
    await f.host.harness.behavior.callRpc("setAssignment", { bundleId: OTHER, kind: "global", targetId: "*", enabled: true });
    expect(await f.host.harness.behavior.callRpc("snapshot", null)).toMatchObject({ assignments: expect.arrayContaining([{ bundleId: OTHER, kind: "global", targetId: "*" }]) });
    expect(f.calls).toContain("setGlobalBundle");
    expect(preserved()).toEqual(before);
  });

  it("keeps local legacy rows and unresolved source provenance without granting their broader scope", async () => {
    const records: AssignmentRecord[] = [
      { type: "reference", projectId: "deleted/project", targetId: "unresolved/bundle" },
      { type: "legacyBundle", bundleId: BUNDLE, kind: "agent-profile", targetId: "legacy/profile" },
    ];
    const f = await fixture(records);
    f.catalog.setAssignment(BUNDLE, "global", "*", true);
    await expect(f.host.harness.behavior.callRpc("initializeAssignmentsV1", { confirmation: "no-legacy-assignments" })).rejects.toThrow("not-migrated");
    const receipt = await f.stage();
    expect(receipt).toMatchObject({ recordCount: 2, conflicts: 2 });
    expect(new CatalogAssignmentStore(f.host.bb.storage.database(), f.catalog).records()).toEqual([]);
    await expect(f.host.harness.behavior.callRpc("setAssignment", { bundleId: BUNDLE, kind: "global", targetId: "*", enabled: true })).rejects.toThrow("assignment-frozen");
    expect(await f.stage()).toEqual(receipt);
    await expect(f.host.harness.behavior.callRpc("activateAssignmentsV1", f.identity)).rejects.toThrow("Fresh Projects status");
    await f.activate();
    f.available = false;
    const snapshot = await f.host.harness.behavior.callRpc("snapshot", null);
    expect(snapshot).toMatchObject({ assignments: [{ bundleId: "unresolved/bundle", kind: "project", targetId: "deleted/project" }] });
    const preserved = new CatalogAssignmentStore(f.host.bb.storage.database(), f.catalog).records();
    expect(preserved).toEqual(expect.arrayContaining([...records, { type: "legacyBundle", bundleId: BUNDLE, kind: "global", targetId: "*" }]));
    expect(f.catalog.listAssignments()).toEqual([{ bundleId: BUNDLE, kind: "global", targetId: "*" }]);
    await expect(f.host.harness.behavior.callAgentTool("catalog_search", {}, { projectId: "deleted/project", threadId: "fixture-thread" })).rejects.toThrow("unresolved");
  });

  it.each(["not-migrated", "destination-owned", "reverse-frozen"] as const)("does not invent an empty source projection when source is %s", async (state) => {
    const f = await fixture();
    f.source.state = state;
    await expect(f.host.harness.behavior.callRpc("snapshot", null)).rejects.toThrow(state === "not-migrated" ? "not-migrated" : "assignment-frozen");
    expect(f.calls).toEqual(["assignmentStatusV1"]);
  });

  it("uses a fresh exact source commit and durable local activation receipt, then has no Projects boot dependency", async () => {
    const f = await fixture([{ type: "reference", projectId: null, targetId: BUNDLE }]);
    const receipt = await f.stage();
    f.source.state = "destination-owned";
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "staged" });
    await f.reload();
    await expect(f.host.harness.behavior.callRpc("assignmentReadV1", { ...f.identity, method: "globalContext", input: null }, projectsCaller)).rejects.toThrow("assignment-frozen");
    await f.activate();
    const count = f.calls.length;
    f.available = false;
    await f.reload("0.2.2");
    expect(await f.host.harness.behavior.callRpc("assignmentReadV1", { ...f.identity, method: "globalContext", input: null }, projectsCaller)).toEqual({ bundleIds: [BUNDLE] });
    await f.host.harness.behavior.callRpc("assignmentWriteV1", { ...f.identity, method: "setProjectBundle", input: { projectId: "new/project", targetId: OTHER, enabled: true } }, projectsCaller);
    expect(await f.host.harness.behavior.callRpc("snapshot", null)).toMatchObject({ assignments: expect.arrayContaining([{ bundleId: OTHER, kind: "project", targetId: "new/project" }]) });
    expect(await f.host.harness.behavior.callRpc("assignmentReceiptV1", f.identity, projectsCaller)).toEqual(receipt);
    expect(f.calls).toHaveLength(count);
    f.available = true;
    f.source.state = "reverse-frozen";
    const reverse = await f.host.harness.behavior.callRpc("assignmentReverseExportV1", { ...f.identity, cursor: 0, reverseGeneration: null }, projectsCaller) as { records: AssignmentRecord[]; reverseDigest: string; reverseGeneration: string };
    expect(reverse.records).toEqual(expect.arrayContaining([{ type: "reference", projectId: "new/project", targetId: OTHER }]));
    expect(reverse.reverseDigest).toBe(assignmentDigest(reverse.records));
    expect(await f.host.harness.behavior.callRpc("assignmentReverseExportV1", { ...f.identity, cursor: 0, reverseGeneration: null }, projectsCaller)).toEqual(reverse);
    await expect(f.host.harness.behavior.callRpc("setAssignment", { bundleId: OTHER, kind: "project", targetId: "blocked", enabled: true })).rejects.toThrow("assignment-frozen");
  });

  it("pins first activation to release A and lets compatible B reverse-export a never-activated stage only after source reverse-freeze", async () => {
    const records: AssignmentRecord[] = [{ type: "reference", projectId: "p", targetId: BUNDLE }, { type: "legacyBundle", bundleId: BUNDLE, kind: "project-environment", targetId: "legacy/env" }];
    const f = await fixture(records);
    await f.stage();
    f.source.state = "destination-owned";
    await f.reload("0.2.2");
    await expect(f.host.harness.behavior.callRpc("activateAssignmentsV1", f.identity)).rejects.toThrow("running 0.2.2");
    await expect(f.host.harness.behavior.callRpc("assignmentReceiptV1", f.identity, projectsCaller)).rejects.toThrow("running 0.2.2");
    await expect(f.host.harness.behavior.callRpc("assignmentReverseExportV1", { ...f.identity, cursor: 0, reverseGeneration: null }, projectsCaller)).rejects.toThrow("Fresh Projects status");
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "staged" });
    f.source.state = "reverse-frozen";
    expect(await f.host.harness.behavior.callRpc("assignmentReverseExportV1", { ...f.identity, cursor: 0, reverseGeneration: null }, projectsCaller)).toMatchObject({ records: expect.arrayContaining(records), destinationVersion: "0.2.1" });
    await expect(f.host.harness.behavior.callRpc("activateAssignmentsV1", f.identity)).rejects.toThrow("running 0.2.2");
    await expect(f.host.harness.behavior.callRpc("assignmentWriteV1", { ...f.identity, method: "setGlobalBundle", input: { targetId: BUNDLE, enabled: true } }, projectsCaller)).rejects.toThrow("assignment-frozen");
  });

  it.each([0, 2])("rejects unsupported persisted format %i before reads, writes, or reverse export", async (format) => {
    const f = await fixture([{ type: "reference", projectId: null, targetId: BUNDLE }]);
    await f.stage(); await f.activate();
    await f.reload("0.2.2");
    await f.host.harness.behavior.callRpc("setAssignment", { bundleId: OTHER, kind: "project", targetId: "edit-under-B", enabled: true });
    f.host.bb.storage.database().prepare("UPDATE catalog_assignment_authority SET format_version = ? WHERE id = 1").run(format);
    await f.reload("0.2.1");
    for (const [method, input, options] of [
      ["snapshot", null, undefined],
      ["assignmentWriteV1", { ...f.identity, method: "setGlobalBundle", input: { targetId: BUNDLE, enabled: true } }, projectsCaller],
      ["assignmentReverseExportV1", { ...f.identity, cursor: 0, reverseGeneration: null }, projectsCaller],
    ] as const) await expect(f.host.harness.behavior.callRpc(method, input, options)).rejects.toThrow("Unsupported persisted");
    expect(f.host.bb.storage.database().prepare("SELECT COUNT(*) AS n FROM catalog_assignment_records").get()).toEqual({ n: 2 });
  });

  it("keeps a crash before the local activation receipt pre-activation after restart", async () => {
    const f = await fixture([{ type: "reference", projectId: null, targetId: BUNDLE }]);
    await f.stage();
    f.host.bb.storage.database().exec("CREATE TRIGGER simulate_activation_crash BEFORE UPDATE OF state ON catalog_assignment_authority WHEN NEW.state = 'active' BEGIN SELECT RAISE(ABORT, 'simulated activation crash'); END");
    await expect(f.activate()).rejects.toThrow("simulated activation crash");
    expect(f.host.bb.storage.database().prepare("SELECT state, activation_json FROM catalog_assignment_authority").get()).toEqual({ state: "staged", activation_json: null });
    expect(f.host.bb.storage.database().prepare("SELECT COUNT(*) AS n FROM catalog_assignment_records").get()).toEqual({ n: 0 });
    f.host.bb.storage.database().exec("DROP TRIGGER simulate_activation_crash");
    await f.reload("0.2.2");
    await expect(f.host.harness.behavior.callRpc("activateAssignmentsV1", f.identity)).rejects.toThrow("running 0.2.2");
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "staged" });
  });

  it("durably abandons exact stages, rejects late downloads, and cannot abort a different generation or active owner", async () => {
    const f = await fixture([{ type: "reference", projectId: null, targetId: BUNDLE }]);
    await f.stage();
    await expect(f.host.harness.behavior.callRpc("assignmentAbortV1", { ...f.identity, semanticDigest: "0".repeat(64) }, projectsCaller)).rejects.toThrow("Abort identity");
    await f.host.harness.behavior.callRpc("assignmentAbortV1", f.identity, projectsCaller);
    await f.host.harness.behavior.callRpc("assignmentAbortV1", f.identity, projectsCaller);
    await expect(f.stage()).rejects.toThrow("abandoned");
    await f.reload();
    await expect(f.stage()).rejects.toThrow("abandoned");
    const next = { ...f.identity, generation: "generation/two" };
    Object.assign(f.identity, next); f.source.transfer = next;
    await f.stage(); await f.activate();
    await f.host.harness.behavior.callRpc("assignmentAbortV1", { ...next, generation: "generation/one" }, projectsCaller);
    await expect(f.host.harness.behavior.callRpc("assignmentAbortV1", next, projectsCaller)).rejects.toThrow("cannot revoke active");
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "active", transfer: next });
  });

  it("does not resurrect a download when an abort notice arrives while a page is in flight", async () => {
    const f = await fixture([{ type: "reference", projectId: null, targetId: BUNDLE }]);
    const entered = Promise.withResolvers<void>(); const releasePage = Promise.withResolvers<void>();
    f.afterPage = async () => { entered.resolve(); await releasePage.promise; };
    const pending = f.stage();
    await entered.promise;
    await f.host.harness.behavior.callRpc("assignmentAbortV1", f.identity, projectsCaller);
    releasePage.resolve();
    await expect(pending).rejects.toThrow("abandoned");
    expect(await f.host.harness.behavior.callRpc("assignmentStatus", null)).toMatchObject({ state: "uninitialized" });
  });

  it("rejects unauthorized compatibility/transition calls and mismatched identities before mutation", async () => {
    const f = await fixture();
    await expect(f.host.harness.behavior.callRpc("stageAssignmentsV1", f.identity, projectsCaller)).rejects.toThrow("caller-required");
    await f.stage(); await f.activate();
    await expect(f.host.harness.behavior.callRpc("assignmentReadV1", { ...f.identity, method: "globalContext", input: null })).rejects.toThrow("verified Projects");
    await expect(f.host.harness.behavior.callRpc("assignmentWriteV1", { ...f.identity, generation: "wrong", method: "setGlobalBundle", input: { targetId: BUNDLE, enabled: true } }, projectsCaller)).rejects.toThrow("handoff-mismatch");
    expect(await f.host.harness.behavior.callRpc("assignmentReadV1", { ...f.identity, method: "projectContexts", input: { projectIds: ["p", "q"] } }, projectsCaller)).toEqual({ projects: [{ projectId: "p", bundleIds: [] }, { projectId: "q", bundleIds: [] }] });
  });

  it("keeps every historical migration literal and restored legacy assignment unchanged", () => {
    expect(migrations.slice(0, 6).map((sql) => createHash("sha256").update(sql).digest("hex"))).toEqual([
      "30f3954942b6f99ca61c46f35b5fb075150072595fe5fb05086d2ebf3fff88d3", "9bde3f9ca65185f781a3d6047bae99b6523f6a226e488f8eed74f3adc256d36e",
      "302b7d70a2f37c5cc4291ad70772e6d5bd997e30d8391adaffd92702ef212d7d", "6d7b4df2d5573ba70a5ba3284a02537a50e2f50da7348ce928763c6c83707f3f",
      "d0075d2112c27476e8f97dee9c897904df9e907e932dca0f4d154580cac0778c", "f6a2e41f8d4727538822368ceca4a0b879bfb82f3fd9ac0681ac55db9c6b06c9",
    ]);
    const db = new Database(":memory:");
    for (const sql of migrations.slice(0, 6)) db.exec(sql);
    const catalog = new CatalogStore(db);
    catalog.saveBundle({ id: BUNDLE, name: "Legacy", description: "", skillIds: [] });
    catalog.setAssignment(BUNDLE, "agent-profile", "legacy/profile", true);
    for (const sql of migrations.slice(6)) db.exec(sql);
    expect(catalog.listAssignments()).toEqual([{ bundleId: BUNDLE, kind: "agent-profile", targetId: "legacy/profile" }]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });
});
