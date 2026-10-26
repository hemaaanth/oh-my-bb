import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

describe("independent sidebar", () => {
  it("loads saved groups and ordering without any sibling RPC", async () => {
    const calls: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: { plugins: { callRpc: async ({ pluginId }) => {
        calls.push(pluginId);
        throw new Error("No sibling plugins installed");
      } } },
    });
    await plugin(bb);
    expect(calls).toEqual([]);
    const { workspaces } = await harness.behavior.callRpc("listWorkspaces", null);
    const workspaceId = workspaces.find((row: { isDefault: boolean }) => row.isDefault)!.id;
    await harness.behavior.callRpc("setThreadOrder", { threadIds: ["fixture-second", "fixture-first"], workspaceId });
    expect(await harness.behavior.callRpc("listThreadOrder", { workspaceId })).toEqual({ threadIds: ["fixture-second", "fixture-first"] });
    expect(await harness.behavior.callRpc("listAgents", { fresh: true })).toBeNull();
    expect(await harness.behavior.callRpc("listChannels", null)).toBeNull();
    await expect(harness.behavior.callRpc("openAgent", { profileId: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow("Enable Agents");
    await expect(harness.behavior.callRpc("listAttachableTasks", { threadId: "fixture-first", query: "fixture" })).rejects.toThrow("Enable Tasks");
    expect(calls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("preserves historical local group IDs and saved names", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "status-sidebar" });
    const db = bb.storage.database();
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0)");
    const insert = db.prepare("INSERT INTO workspaces (id, name, color, position, is_default) VALUES (?, ?, ?, ?, ?)");
    insert.run("ws_personal", "Saved default", "amber", 0, 1);
    insert.run("ws_work", "Saved second", "blue", 1, 0);
    await plugin(bb);
    const { workspaces } = await harness.behavior.callRpc("listWorkspaces", null);
    expect(workspaces.map((group: { id: string; name: string }) => [group.id, group.name])).toEqual([
      ["ws_personal", "Saved default"], ["ws_work", "Saved second"],
    ]);
    await harness.lifecycle.dispose();
  });

  it("keeps local groups and assignments across integration toggles and reload", async () => {
    let { bb, harness } = createFakePluginHost({ pluginId: "status-sidebar" });
    await plugin(bb);
    const created = await harness.behavior.callRpc("createWorkspace", { name: "Fixture section" });
    await harness.behavior.callRpc("renameWorkspace", { workspaceId: created.workspaceId, name: "Renamed fixture" });
    await harness.behavior.callRpc("setProjectWorkspace", { projectId: "fixture-project", workspaceId: created.workspaceId });
    await harness.behavior.callRpc("setThreadWorkspace", { threadId: "fixture-thread", workspaceId: created.workspaceId });
    await harness.behavior.callRpc("setProjectOrder", { projectIds: ["fixture-project"], workspaceId: created.workspaceId });
    const saved = await harness.behavior.callRpc("listWorkspaces", null);
    await harness.behavior.callRpc("setIntegrations", { projectsIntegration: true });
    await expect(harness.behavior.callRpc("listWorkspaces", null)).rejects.toThrow();
    await harness.behavior.callRpc("setIntegrations", { projectsIntegration: false });
    ({ harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("listWorkspaces", null)).toEqual(saved);
    await expect(harness.behavior.callRpc("setWorkspaceOrder", { workspaceIds: [created.workspaceId] })).rejects.toThrow("every section");
    const defaultId = saved.workspaces.find((row: { isDefault: boolean }) => row.isDefault)!.id;
    await expect(harness.behavior.callRpc("deleteWorkspace", { workspaceId: defaultId })).rejects.toThrow("Cannot delete");
    await harness.behavior.callRpc("deleteWorkspace", { workspaceId: created.workspaceId });
    const after = await harness.behavior.callRpc("listWorkspaces", null);
    expect(after.workspaces.find((row: { id: string }) => row.id === defaultId)!.projectIds).toContain("fixture-project");
    expect(after.workspaces.some((row: { id: string }) => row.id === created.workspaceId)).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("discards Agents results that arrive after authorization changes", async () => {
    const response = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      settings: { agentsIntegration: true },
      sdk: { plugins: { callRpc: async () => {
        calls += 1;
        started.resolve();
        return response.promise;
      } } },
    });
    await plugin(bb);
    expect(calls).toBe(0);
    const pending = harness.behavior.callRpc("listAgents", { fresh: true });
    await started.promise;
    await harness.behavior.callRpc("setIntegrations", { agentsIntegration: false });
    await harness.behavior.callRpc("setIntegrations", { agentsIntegration: true });
    response.resolve({ agents: [], excludedThreadIds: ["late-fixture"] });
    expect(await pending).toBeNull();
    await harness.lifecycle.dispose();
  });
});
