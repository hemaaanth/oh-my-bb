import { createHash } from "node:crypto";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./server.js";
import { ProjectsStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const actions = [
  { method: "initializeFreshV1", input: { confirmation: "no-legacy-assignments" } },
  { method: "importLegacyFromSourcesV1", input: null },
] as const;
const uninitialized = { state: "uninitialized", transfer: null, destinationRevision: null, conflicts: 0 };
const running = (id: string) => ({ id, enabled: true, status: "running" });

async function fixture(installed = [running("catalog")], status: unknown = uninitialized) {
  const host = createFakePluginHost({ pluginId: "projects", settings: { routingModel: "synthetic/saved-model" }, sdk: {
    subscribe: () => () => {}, projects: { list: async () => [] },
    plugins: { list: async () => ({ plugins: installed }), callRpc: async ({ method }) => {
      if (method === "assignmentStatus") return status;
      if (method === "legacyWorkspaceSnapshot") return { workspaces: [{ id: "legacy/group", name: "Legacy", color: "blue", isDefault: true, projectIds: ["native/project"] }] };
      if (method === "legacySnapshot") return { profiles: [], projects: [{ id: "native/project", profileId: "legacy/profile" }] };
      if (method === "legacyAssignments") return { assignments: [{ bundleId: "legacy/bundle", kind: "project", targetId: "native/project" }] };
      if (method === "listProfiles") return [];
      if (method === "remapLegacyProjectGroups") return { ok: true };
      throw new Error(`Unexpected setup RPC: ${method}`);
    } },
  } });
  await plugin(host.bb);
  cleanups.push(() => host.harness.lifecycle.dispose());
  const native = new ProjectsStore(host.bb.storage.database());
  const group = native.saveGroup({ name: "Native", color: "green", makeDefault: true });
  native.setProjectOrder(group.id, ["native/project"]);
  native.updateProject("native/project", { icon: "native-icon", credentialId: null });
  await host.harness.behavior.callRpc("updateRoutingProfile", { projectId: "native/project", description: "Native manual profile", keywords: ["native"], aliases: ["local"], repositories: ["example/native"], notFor: ["unrelated"] });
  return host;
}

async function snapshot(host: FakePluginHost) {
  return {
    database: createHash("sha256").update(host.bb.storage.database().serialize()).digest("hex"),
    preferences: await host.harness.behavior.callRpc("preferences", null),
  };
}

async function expectBlocked(host: FakePluginHost, action: typeof actions[number], message: string) {
  const before = await snapshot(host);
  await expect(host.harness.behavior.callRpc(action.method, action.input)).rejects.toThrow(message);
  expect(await snapshot(host)).toEqual(before);
  expect(new ProjectsStore(host.bb.storage.database()).hasMigration("suite-v1")).toBe(false);
  expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS n FROM assignment_import_receipts").get()).toEqual({ n: 0 });
}

describe("explicit setup destination authority", () => {
  it.each(actions)("$method rejects an already active Catalog without changing native data or preferences", async (action) => {
    const host = await fixture([running("catalog")], { ...uninitialized, state: "active" });
    await expectBlocked(host, action, "Destination-first adoption is unsupported");
  });

  it.each([
    { id: "project-environments", state: "staged" },
    { id: "agent-profiles", state: "reverse-frozen" },
  ])("blocks $state ownership in $id, not only Catalog", async ({ id, state }) => {
    const host = await fixture([running(id)], { ...uninitialized, state });
    await expectBlocked(host, actions[0], "Destination-first adoption is unsupported");
  });

  it("rejects an installed but offline owner instead of interpreting RPC failure as absence", async () => {
    const host = await fixture();
    host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("offline"); });
    await expectBlocked(host, actions[1], "assignmentStatus is unavailable or unsupported");
  });

  it("rejects a disabled destination even if a stale RPC could report uninitialized", async () => {
    const host = await fixture([{ ...running("catalog"), enabled: false, status: "disabled" }]);
    await expectBlocked(host, actions[0], "installed but not running");
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });

  it.each([
    { label: "old status shape", status: { assignments: [] } },
    { label: "unknown state", status: { ...uninitialized, state: "frozen" } },
    { label: "uninitialized with retained provenance", status: { ...uninitialized, destinationRevision: "unresolved/stage", conflicts: 1 } },
  ])("refuses $label without writing a partial import", async ({ status }) => {
    const host = await fixture([running("catalog")], status);
    await expectBlocked(host, actions[1], "not-migrated");
  });

  it.each(actions)("$method refuses unavailable native metadata", async (action) => {
    const host = await fixture([]);
    host.harness.sdk.stub("plugins.list", async () => { throw new Error("native metadata offline"); });
    await expectBlocked(host, action, "Destination absence is not established");
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });

  it("refuses malformed native metadata instead of substituting an empty list", async () => {
    const host = await fixture([]);
    host.harness.sdk.stub("plugins.list", async () => ({}));
    await expectBlocked(host, actions[0], "Destination absence is not established");
  });

  it("initializes a truly absent standalone installation without a destination RPC", async () => {
    const host = await fixture([]);
    await host.harness.behavior.callRpc(actions[0].method, actions[0].input);
    await host.harness.behavior.callRpc("setGlobalBundle", { targetId: "standalone/bundle", enabled: true });
    expect(await host.harness.behavior.callRpc("globalContext", null)).toEqual({ agentIds: [], bundleIds: ["standalone/bundle"] });
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });

  it.each(actions)("$method accepts genuinely uninitialized destinations and preserves native organization", async (action) => {
    const host = await fixture([running("catalog"), running("project-environments"), running("agent-profiles")]);
    const native = new ProjectsStore(host.bb.storage.database());
    const before = native.getConfiguration("native/project");
    await host.harness.behavior.callRpc(action.method, action.input);
    expect(native.hasMigration("suite-v1")).toBe(true);
    expect(native.getConfiguration("native/project")).toMatchObject({ groupId: before.groupId, icon: before.icon, routingProfile: before.routingProfile });
    if (action.method === "importLegacyFromSourcesV1") expect(await host.harness.behavior.callRpc("projectContext", { projectId: "native/project" })).toMatchObject({ credentialId: "legacy/profile", bundleIds: ["legacy/bundle"] });
  });

  it("keeps completed setup retries local after a transfer rather than reopening destination ownership", async () => {
    const host = await fixture([]);
    await host.harness.behavior.callRpc(actions[0].method, actions[0].input);
    const frozen = await host.harness.behavior.callRpc("assignmentHandoffV1", { phase: "freeze", kind: "bundles", destination: "catalog", destinationVersion: "1.0.0" }) as { transfer: Record<string, unknown> };
    host.harness.sdk.stub("plugins.callRpc", async () => ({ ...frozen.transfer, phase: "staged", recordCount: 0, destinationRevision: "durable/revision", conflicts: 0 }));
    for (const phase of ["stage", "commit"]) await host.harness.behavior.callRpc("assignmentHandoffV1", { ...frozen.transfer, phase });
    const before = await snapshot(host);
    host.harness.sdk.stub("plugins.list", async () => { throw new Error("Completed retries must not recheck setup metadata"); });
    host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Completed retries must not contact a destination"); });
    for (const action of actions) expect(await host.harness.behavior.callRpc(action.method, action.input)).toEqual({ ok: true });
    expect(await snapshot(host)).toEqual(before);
    expect(await host.harness.behavior.callRpc("assignmentStatusV1", { kind: "bundles" })).toMatchObject({ state: "destination-owned", transfer: frozen.transfer });
  });

  it("does not inspect native plugin presence or destinations on startup or ordinary native views", async () => {
    const host = await fixture();
    await host.harness.behavior.callRpc("organizationSnapshot", null);
    await host.harness.behavior.callRpc("groupsSnapshot", null);
    expect(host.harness.inspection.sdk.callsTo("plugins.list")).toEqual([]);
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });
});
