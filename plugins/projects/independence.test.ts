import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { ProjectsStore } from "./store.js";
import { AssignmentStore } from "./assignment-store.js";

const legacyDestinations = ["catalog", "project-environments", "agent-profiles"];
function absentHost(installedDestinations: readonly string[] = []) {
  return createFakePluginHost({ pluginId: "projects", sdk: {
    subscribe: () => () => {}, projects: { list: async () => [] },
    plugins: { list: async () => ({ plugins: installedDestinations.map((id) => ({ id, enabled: true, status: "running" })) }), callRpc: async () => { throw new Error("sibling absent"); } },
  } });
}

describe("standalone readiness", () => {
  it("keeps unimported assignments blocked without probing missing siblings", async () => {
    const { bb, harness } = absentHost();
    await plugin(bb);
    await expect(harness.behavior.callRpc("projectContext", { projectId: "native-project" })).rejects.toThrow("not-migrated");
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("blocks destructive empty projections while preserving bindings and materialized folders", async () => {
    const folder = await mkdtemp(join(tmpdir(), "projects-1p-"));
    const materialized = join(folder, "catalog-unresolved", "SKILL.md");
    await mkdir(join(folder, "catalog-unresolved"));
    await writeFile(materialized, "synthetic materialized skill\n");
    const { bb, harness } = absentHost();
    try {
      await plugin(bb);
      const store = new ProjectsStore(bb.storage.database());
      store.updateProject("retired/project", { credentialId: "unresolved/profile", icon: "kept" });
      store.toggleProjectReference("bundle", "retired/project", "unresolved/bundle", true);
      const before = store.getConfiguration("retired/project");
      for (const [method, input] of [
        ["snapshot", null], ["projectContext", { projectId: "retired/project" }], ["projectContexts", { projectIds: ["retired/project"] }],
        ["bundleAssignmentSnapshot", null], ["globalContext", null], ["credentialAssignments", { credentialId: "unresolved/profile" }],
        ["agentAssignments", { agentId: "unresolved/agent" }], ["bundleAssignments", { bundleId: "unresolved/bundle" }],
        ["updateProject", { projectId: "retired/project", credentialId: null }], ["removeBundle", { bundleId: "unresolved/bundle" }],
      ] as const) await expect(harness.behavior.callRpc(method, input)).rejects.toThrow("not-migrated");
      await expect(harness.behavior.callRpc("initializeFreshV1", { confirmation: "no-legacy-assignments" })).rejects.toThrow("Existing or pending assignments");
      expect(store.getConfiguration("retired/project")).toEqual(before);
      expect(await readFile(materialized, "utf8")).toBe("synthetic materialized skill\n");
      expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await harness.lifecycle.dispose(); await rm(folder, { recursive: true }); }
  });

  it("runs native groups and startup services independently before assignment initialization", async () => {
    const { bb, harness } = absentHost();
    await plugin(bb);
    const group = await harness.behavior.callRpc("saveGroup", { name: "Standalone", color: "blue" });
    await expect(harness.behavior.callRpc("organizationSnapshot", null)).resolves.toMatchObject({ groups: expect.arrayContaining([group]), assignmentStatus: expect.arrayContaining([{ kind: "bundles", state: "not-migrated", transfer: null, reverseGeneration: null }]) });
    for (const service of harness.inspection.registrations.services) {
      const running = harness.behavior.runService(service.name);
      running.controller.abort();
      await running.done;
    }
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await expect(harness.behavior.callRpc("importLegacy", {})).rejects.toThrow("Use explicit no-legacy initialization");
    await expect(harness.behavior.callRpc("initializeFreshV1", { confirmation: "no-legacy-assignments" }, { experimental_caller: { kind: "plugin", pluginId: "catalog" } })).rejects.toThrow("owner-client-required");
    await harness.behavior.callRpc("initializeFreshV1", { confirmation: "no-legacy-assignments" });
    await harness.behavior.callRpc("setGlobalBundle", { targetId: "standalone/bundle", enabled: true });
    expect(await harness.behavior.callRpc("globalContext", null)).toEqual({ agentIds: [], bundleIds: ["standalone/bundle"] });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("keeps marked reads unchanged when all definition sources are absent", async () => {
    const { bb, harness } = absentHost();
    await plugin(bb);
    const store = new ProjectsStore(bb.storage.database());
    store.markMigration("suite-v1");
    store.updateProject("native/project", { credentialId: "profile/opaque" });
    store.toggleProjectReference("bundle", "native/project", "bundle/project", true);
    store.toggleGlobalReference("bundle", "bundle/global", true);
    store.toggleGlobalReference("agent", "agent/global", true);
    expect(await harness.behavior.callRpc("projectContext", { projectId: "native/project" })).toMatchObject({ credentialId: "profile/opaque", agentIds: ["agent/global"], bundleIds: ["bundle/global", "bundle/project"] });
    expect(await harness.behavior.callRpc("bundleAssignmentSnapshot", null)).toEqual({ globalBundleIds: ["bundle/global"], projects: [{ projectId: "native/project", bundleIds: ["bundle/project"] }] });
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("persists explicit source consent and profile-model preference across reload without probing", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "projects", settings: { routingModel: "saved/model", openRouterApiKey: "synthetic-secret-do-not-export" }, sdk: { subscribe: () => () => {}, projects: { list: async () => [] }, plugins: { callRpc: async () => { throw new Error("absent"); } } } });
    await plugin(bb);
    await harness.behavior.callRpc("updatePreferences", { catalogIntegration: true, agentsIntegration: false });
    const loaded = await harness.lifecycle.reload(plugin);
    expect(await loaded.harness.behavior.callRpc("preferences", null)).toMatchObject({ routingModel: "saved/model", catalogIntegration: true, agentsIntegration: false, credentialsIntegration: false });
    expect(Object.keys(loaded.harness.inspection.registrations.settingsDescriptors).sort()).toEqual(["jevApiKey", "openRouterApiKey"]);
    const result = await loaded.harness.behavior.callRpc("organizationSnapshot", null);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-do-not-export");
    expect(loaded.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await loaded.harness.lifecycle.dispose();
  });
});

describe("explicit legacy import", () => {
  it("makes no partial writes when a named legacy source is missing", async () => {
    const { bb, harness } = absentHost();
    await plugin(bb);
    const store = new ProjectsStore(bb.storage.database());
    const before = store.listGroups();
    await expect(harness.behavior.callRpc("importLegacyFromSourcesV1", null)).rejects.toThrow("sibling absent");
    expect(store.listGroups()).toEqual(before);
    expect(store.hasMigration("suite-v1")).toBe(false);
    expect(new AssignmentStore(bb.storage.database()).records("bundles")).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("resumes a crashed remap without reimporting or regenerating native IDs", async () => {
    const { bb, harness } = absentHost(legacyDestinations);
    let remapFails = true;
    let sourceReads = 0;
    harness.sdk.stub("plugins.callRpc", async ({ method }) => {
      if (method === "assignmentStatus") return { state: "uninitialized", transfer: null, destinationRevision: null, conflicts: 0 };
      if (method === "remapLegacyProjectGroups") { if (remapFails) throw new Error("crash after durable import"); return { ok: true }; }
      sourceReads++;
      if (method === "legacyWorkspaceSnapshot") return { workspaces: [{ id: "legacy/group", name: "Imported", color: "green", isDefault: false, projectIds: ["native/project"] }] };
      if (method === "legacySnapshot") return { profiles: [], projects: [{ id: "native/project", profileId: "opaque/profile" }, { id: "explicit/null", profileId: null }] };
      if (method === "legacyAssignments") return { assignments: [{ bundleId: "unknown/bundle", kind: "project-environment", targetId: "unknown/profile" }] };
      if (method === "listProfiles") return [{ id: "paid/profile/unchanged", name: "Synthetic", slug: "synthetic", isDefault: false }];
      throw new Error(method);
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("importLegacyFromSourcesV1", null)).rejects.toThrow("crash after durable import");
    const store = new ProjectsStore(bb.storage.database());
    const groupBefore = store.listGroups();
    expect(store.hasMigration("suite-v1")).toBe(false);
    await expect(harness.behavior.callRpc("projectContext", { projectId: "native/project" })).rejects.toThrow("not-migrated");
    await expect(harness.behavior.callRpc("initializeFreshV1", { confirmation: "no-legacy-assignments" })).rejects.toThrow("pending assignments");
    const loaded = await harness.lifecycle.reload(plugin);
    remapFails = false;
    loaded.harness.sdk.stub("plugins.callRpc", async ({ method }) => {
      if (method === "assignmentStatus") return { state: "uninitialized", transfer: null, destinationRevision: null, conflicts: 0 };
      if (method !== "remapLegacyProjectGroups") throw new Error("Resume must not read legacy sources again");
      return { ok: true };
    });
    await loaded.harness.behavior.callRpc("importLegacyFromSourcesV1", null);
    await loaded.harness.behavior.callRpc("importLegacyFromSourcesV1", null);
    expect(sourceReads).toBe(4);
    expect(new ProjectsStore(loaded.bb.storage.database()).listGroups()).toEqual(groupBefore);
    expect(await loaded.harness.behavior.callRpc("projectContext", { projectId: "native/project" })).toMatchObject({ credentialId: "opaque/profile", agentIds: ["paid/profile/unchanged"] });
    expect(new AssignmentStore(loaded.bb.storage.database()).records("bundles")).toContainEqual({ type: "legacyBundle", bundleId: "unknown/bundle", kind: "project-environment", targetId: "unknown/profile" });
    expect(new AssignmentStore(loaded.bb.storage.database()).records("applicationBindings")).toContainEqual({ type: "binding", projectId: "explicit/null", credentialId: null });
    await loaded.harness.lifecycle.dispose();
  });

  it("retains conflicting and unresolved records; same payload retry is a no-op and changed payload fails", async () => {
    const { bb, harness } = absentHost();
    await plugin(bb);
    const store = new ProjectsStore(bb.storage.database());
    store.updateProject("native/project", { credentialId: "explicit/current" });
    const input = { credentialBindings: [{ projectId: "native/project", credentialId: "legacy/conflict" }, { projectId: "missing/project", credentialId: null }], catalogAssignments: [
      { bundleId: "unknown/bundle", kind: "project-environment", targetId: "unknown/profile" },
      { bundleId: "conflicting/profile-bundle", kind: "project-environment", targetId: "legacy/conflict" },
    ] };
    const result = await harness.behavior.callRpc("importLegacy", input);
    expect(await harness.behavior.callRpc("importLegacy", input)).toEqual(result);
    await expect(harness.behavior.callRpc("importLegacy", { ...input, credentialBindings: [] })).rejects.toThrow("input changed");
    expect(store.getConfiguration("native/project").credentialId).toBe("explicit/current");
    expect(store.getConfiguration("native/project").bundleIds).toEqual([]);
    expect(new AssignmentStore(bb.storage.database()).records("bundles")).toContainEqual({ type: "legacyBundle", bundleId: "conflicting/profile-bundle", kind: "project-environment", targetId: "legacy/conflict" });
    expect(new AssignmentStore(bb.storage.database()).records("applicationBindings")).toContainEqual({ type: "legacyBinding", projectId: "native/project", credentialId: "legacy/conflict" });
    await harness.lifecycle.dispose();
  });
  it("preserves existing native group membership, order and default during explicit import", async () => {
    const { bb, harness } = absentHost();
    await plugin(bb);
    const store = new ProjectsStore(bb.storage.database());
    const nativeGroup = store.saveGroup({ name: "Native", color: "green", makeDefault: true });
    store.setProjectOrder(nativeGroup.id, ["first/project", "native/project"]);
    const before = store.getConfiguration("native/project");
    const imported = await harness.behavior.callRpc("importLegacy", { groups: [
      { id: "legacy/group", name: "Legacy", color: "blue", isDefault: true, projectIds: ["native/project", "new/project"] },
    ] }) as { groupMappings: Array<{ groupId: string }> };
    expect(store.getConfiguration("native/project")).toEqual(before);
    expect(store.defaultGroup().id).toBe(nativeGroup.id);
    expect(store.getConfiguration("new/project").groupId).toBe(imported.groupMappings[0]!.groupId);
    await harness.lifecycle.dispose();
  });
  it("stages payload imports without certifying unimported kinds as empty", async () => {
    const { bb, harness } = absentHost(legacyDestinations);
    await plugin(bb);
    const input = { credentialBindings: [{ projectId: "native/project", credentialId: "legacy/profile" }] };
    const imported = await harness.behavior.callRpc("importLegacy", input);
    await expect(harness.behavior.callRpc("projectContext", { projectId: "native/project" })).rejects.toThrow("not-migrated");
    await expect(harness.behavior.callRpc("initializeFreshV1", { confirmation: "no-legacy-assignments" })).rejects.toThrow("pending assignments");
    expect(await harness.behavior.callRpc("importLegacy", input)).toEqual(imported);
    expect(new ProjectsStore(bb.storage.database()).getConfiguration("native/project").credentialId).toBe("legacy/profile");
    harness.sdk.stub("plugins.callRpc", async ({ method }) => {
      if (method === "assignmentStatus") return { state: "uninitialized", transfer: null, destinationRevision: null, conflicts: 0 };
      if (method === "legacyWorkspaceSnapshot") return { workspaces: [] };
      if (method === "legacySnapshot") return { profiles: [], projects: [] };
      if (method === "legacyAssignments") return { assignments: [] };
      if (method === "listProfiles") return [];
      if (method === "remapLegacyProjectGroups") return { ok: true };
      throw new Error(`Unexpected source method: ${method}`);
    });
    await harness.behavior.callRpc("importLegacyFromSourcesV1", null);
    await expect(harness.behavior.callRpc("projectContext", { projectId: "native/project" })).resolves.toMatchObject({ credentialId: "legacy/profile" });
    expect(await harness.behavior.callRpc("importLegacy", input)).toEqual(imported);
    await harness.lifecycle.dispose();
  });

  it.each(["credentials", "bundles"])("rejects a missing %s legacy collection instead of importing authoritative empty state", async (missing) => {
    const { bb, harness } = absentHost(legacyDestinations);
    await plugin(bb);
    harness.sdk.stub("plugins.callRpc", async ({ method, outputSchema }) => {
      const reply = method === "assignmentStatus" ? { state: "uninitialized", transfer: null, destinationRevision: null, conflicts: 0 }
        : method === "legacyWorkspaceSnapshot" ? { workspaces: [] }
        : method === "legacySnapshot" ? { profiles: [], ...(missing === "credentials" ? {} : { projects: [] }) }
        : method === "legacyAssignments" ? missing === "bundles" ? {} : { assignments: [] }
        : method === "listProfiles" ? [] : { ok: true };
      const parsed = await outputSchema["~standard"].validate(reply);
      if (parsed.issues) throw new Error("Incomplete legacy source collection");
      return parsed.value;
    });
    await expect(harness.behavior.callRpc("importLegacyFromSourcesV1", null)).rejects.toThrow("Incomplete legacy source collection");
    expect(new ProjectsStore(bb.storage.database()).hasMigration("suite-v1")).toBe(false);
    await expect(harness.behavior.callRpc("projectContext", { projectId: "native/project" })).rejects.toThrow("not-migrated");
    await harness.lifecycle.dispose();
  });
});
