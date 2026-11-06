import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

const CAPABILITY_ID = "2f576f36-0d16-4f76-9a21-b66bcb47e100";

describe("native Catalog capabilities", () => {
  it("registers a synthetic capability and exposes it only in its assigned project", async () => {
    const notifications: unknown[] = [];
    const projects = new Map<string, Set<string>>();
    const { bb, harness } = createFakePluginHost({ pluginId: "catalog", sdk: {
      system: { config: async () => ({ primaryHostId: null, dataDir: "/tmp/bb-test" }) as never },
      hosts: { list: async () => [] }, threads: { list: async () => [] },
      projects: { list: async () => [{ id: "fixture-project", kind: "standard", name: "Fixture", gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] }] },
      plugins: { list: async () => ({ plugins: [] }), callRpc: async (request) => {
        if (request.pluginId === "fixture-native" && request.method === "assignmentChanged") { notifications.push(request.input); return { ok: true }; }
        // Projects owns where a capability is available.
        if (request.method === "bundleAssignmentSnapshot") return { globalBundleIds: [], projects: [...projects].map(([projectId, ids]) => ({ projectId, bundleIds: [...ids] })) };
        if (request.method === "setProjectBundle") {
          const { projectId, targetId, enabled } = request.input as { projectId: string; targetId: string; enabled: boolean };
          const ids = projects.get(projectId) ?? new Set<string>();
          if (enabled) ids.add(targetId); else ids.delete(targetId);
          projects.set(projectId, ids);
          return { ok: true };
        }
        throw new Error(`Unexpected RPC: ${request.method}`);
      } },
    } });
    await plugin(bb);
    const capability = { id: CAPABILITY_ID, pluginId: "fixture-native", name: "Fixture capability", description: "Synthetic capability for isolated tests.",
      toolIds: ["fixture_action"], skillIds: ["fixture"],
      setup: [{ key: "fixtureToken", label: "Fixture token", description: "Synthetic auth", secret: true, required: true }], assignmentChangedRpc: "assignmentChanged" };
    await harness.behavior.callRpc("registerNativeCapability", capability);
    await harness.behavior.callRpc("setAssignment", { bundleId: CAPABILITY_ID, kind: "project", targetId: "fixture-project", enabled: true });
    const search = await harness.behavior.callAgentTool("catalog_search", { query: "fixture" }, { projectId: "fixture-project", threadId: "fixture-thread" });
    expect(JSON.parse(search as string).capabilities).toEqual([expect.objectContaining({ kind: "native", id: `native:${CAPABILITY_ID}`, pluginId: "fixture-native", toolIds: ["fixture_action"] })]);
    const elsewhere = await harness.behavior.callAgentTool("catalog_search", { query: "fixture" }, { projectId: "other-project", threadId: "other-thread" });
    expect(JSON.parse(elsewhere as string).capabilities).toEqual([]);
    expect(notifications).toEqual([{ bundleId: CAPABILITY_ID }]);
    const read = await harness.behavior.callAgentTool("catalog_read", { skillId: `native:${CAPABILITY_ID}`, path: "SKILL.md" }, { projectId: "fixture-project", threadId: "fixture-thread" });
    expect(JSON.parse(read as string).capability.toolIds).toEqual(["fixture_action"]);
    await expect(harness.behavior.callRpc("setAssignment", { bundleId: CAPABILITY_ID, kind: "agent-profile", targetId: "a1", enabled: true })).rejects.toThrow(/globally or to projects/u);
    await harness.lifecycle.dispose();
  });
});
