import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { CatalogStore } from "./store.js";

describe("Catalog project availability", () => {
  it("reads and writes skill-set availability through Projects", async () => {
    const globalBundles = new Set<string>();
    const projectBundles = new Map<string, Set<string>>();
    const calls: Array<{ method: string; input: unknown }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "catalog",
      sdk: {
        system: { config: async () => ({ primaryHostId: null, dataDir: "/tmp/bb-test" }) as never },
        hosts: { list: async () => [] },
        threads: { list: async () => [], get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: null }) },
        projects: {
          list: async () => [{ id: "proj_one", kind: "standard" as const, name: "One", gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] }],
        },
        plugins: {
          callRpc: async ({ method, input }: { method: string; input: unknown }) => {
            calls.push({ method, input });
            if (method === "assignmentStatusV1") return { kind: "bundles", state: "source-owned", transfer: null, reverseGeneration: null };
            if (method === "bundleAssignmentSnapshot") {
              return {
                globalBundleIds: [...globalBundles],
                projects: [...projectBundles].map(([projectId, bundleIds]) => ({ projectId, bundleIds: [...bundleIds] })),
              };
            }
            if (method === "setGlobalBundle") {
              const change = input as { targetId: string; enabled: boolean };
              if (change.enabled) globalBundles.add(change.targetId); else globalBundles.delete(change.targetId);
              return { ok: true };
            }
            if (method === "setProjectBundle") {
              const change = input as { projectId: string; targetId: string; enabled: boolean };
              const ids = projectBundles.get(change.projectId) ?? new Set<string>();
              if (change.enabled) ids.add(change.targetId); else ids.delete(change.targetId);
              projectBundles.set(change.projectId, ids);
              return { ok: true };
            }
            if (method === "globalContext") return { agentIds: [], bundleIds: [...globalBundles] };
            if (method === "projectContext") {
              const projectId = (input as { projectId: string }).projectId;
              return { projectId, credentialId: null, groupId: null, agentIds: [], bundleIds: [...globalBundles, ...(projectBundles.get(projectId) ?? [])] };
            }
            if (method === "projectContexts") {
              const projectIds = (input as { projectIds: string[] }).projectIds;
              return { projects: projectIds.map((projectId) => ({
                projectId, credentialId: null, groupId: null, agentIds: [], bundleIds: [...globalBundles, ...(projectBundles.get(projectId) ?? [])],
              })) };
            }
            if (method === "removeBundle") return { ok: true };
            throw new Error(`Unexpected Projects RPC: ${method}`);
          },
        },
      },
    });
    await plugin(bb);

    const started = await harness.behavior.callRpc("startMaterialize", {
      hostId: "host_remote",
      homePath: "/home/tester",
      projectId: null,
      workspacePath: null,
    }) as { jobId: string };
    expect(started.jobId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect.poll(() => harness.behavior.callRpc("materializationStatus", {
      jobId: started.jobId,
    })).toMatchObject({ state: "complete" });

    const store = new CatalogStore(bb.storage.database());
    const source = store.saveSource({ name: "Sandbox choices", repositoryUrl: "https://example.invalid/skills.git", gitRef: "main", subdirectory: "", updatePolicy: "automatic", enabled: true });
    store.saveRelease(source.id, "abc", [{ skillId: "review", name: "review", description: "Review", relativePath: "review", digest: "digest", files: [] }], true);
    const skillId = store.listApprovedSkills()[0]!.id;
    await harness.behavior.callRpc("setSandboxSkills", { hostId: "host_remote", skillIds: [skillId] });
    expect(await bb.storage.kv.get("sandbox-skills:host_remote")).toEqual([skillId]);
    expect(globalBundles.size).toBe(0);
    expect(projectBundles.size).toBe(0);
    await harness.behavior.callRpc("setSandboxSkills", { hostId: "host_remote", skillIds: [] });
    expect(await bb.storage.kv.get("sandbox-skills:host_remote")).toEqual([]);
    await expect(harness.behavior.callRpc("setSandboxSkills", { hostId: "host_remote", skillIds: ["missing"] })).rejects.toThrow("unavailable skill");
    // Keep the original assignment assertions independent of this fixture.
    store.deleteSource(source.id);

    await harness.behavior.callRpc("saveSource", {
      name: "Engineering",
      repositoryUrl: "https://example.com/skills.git",
      gitRef: "main",
      subdirectory: "skills",
      updatePolicy: "automatic",
      enabled: true,
    });
    const sourceId = (await harness.behavior.callRpc("snapshot", null) as { sources: Array<{ id: string }> }).sources[0]!.id;
    store.saveRelease(sourceId, "engineering-revision", [{
      skillId: "review",
      name: "review",
      description: "Review a change without placing the full description in every agent prompt.",
      relativePath: "review",
      digest: "review-digest",
      files: [],
    }], true);
    const [{ id: bundleId }] = (await harness.behavior.callRpc("listBundles", null) as { bundles: Array<{ id: string }> }).bundles;

    await harness.behavior.callRpc("setAssignment", { bundleId, kind: "project", targetId: "proj_one", enabled: true });
    await harness.behavior.callRpc("setAssignment", { bundleId, kind: "global", targetId: "*", enabled: true });
    const snapshot = await harness.behavior.callRpc("snapshot", null) as { assignments: Array<{ bundleId: string; kind: string; targetId: string }> };
    expect(snapshot.assignments).toEqual(expect.arrayContaining([
      { bundleId, kind: "global", targetId: "*" },
      { bundleId, kind: "project", targetId: "proj_one" },
    ]));
    expect(calls).toContainEqual({ method: "setProjectBundle", input: { projectId: "proj_one", targetId: bundleId, enabled: true } });
    const search = await harness.behavior.callAgentTool("catalog_search", { query: "review" }, { projectId: "proj_one", threadId: "fixture-thread" });
    expect(JSON.parse(search as string).capabilities.map((capability: { name: string }) => capability.name)).toEqual(["review"]);

    await harness.behavior.callRpc("deleteSource", { id: sourceId });
    expect(calls).toContainEqual({ method: "removeBundle", input: { bundleId } });

    await harness.lifecycle.dispose();
  });
});
