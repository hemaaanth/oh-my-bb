import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

const installedDestinations = ["catalog", "project-environments", "agent-profiles"].map((id) => ({ id, enabled: true, status: "running" }));

const projects = [{
  id: "proj_cdp", kind: "standard" as const, name: "CDP", gitRemoteUrl: "https://github.com/example/cdp.git",
  createdAt: 1, updatedAt: 1, sources: [],
}, {
  id: "proj_site", kind: "standard" as const, name: "Site", gitRemoteUrl: "https://github.com/example/site.git",
  createdAt: 1, updatedAt: 1, sources: [],
}];

function legacyRpc({ method }: { method: string }) {
  if (method === "assignmentStatus") return { state: "uninitialized", transfer: null, destinationRevision: null, conflicts: 0 };
  if (method === "legacyWorkspaceSnapshot") return { workspaces: [] };
  if (method === "legacySnapshot") return { profiles: [], projects: [] };
  if (method === "legacyAssignments") return { assignments: [] };
  if (method === "listProfiles") return [];
  if (method === "remapLegacyProjectGroups" || method === "refreshProjectGroups" || method === "refreshAvailability") return { ok: true };
  throw new Error(`Unexpected RPC: ${method}`);
}

describe("projects configuration", () => {
  it("owns project groups and effective shared assignments", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const bundleId = "22222222-2222-4222-8222-222222222222";
    const credentialId = "33333333-3333-4333-8333-333333333333";
    const { bb, harness } = createFakePluginHost({
      pluginId: "projects",
      sdk: {
        subscribe: () => () => {},
        projects: { list: async () => projects },
        plugins: { list: async () => ({ plugins: installedDestinations }), callRpc: async (input) => legacyRpc(input) },
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("initializeFreshV1", { confirmation: "no-legacy-assignments" });

    const work = await harness.behavior.callRpc("saveGroup", { name: "Work", color: "blue" }) as { id: string };
    const personal = (await harness.behavior.callRpc("groupsSnapshot", null) as { groups: Array<{ id: string; name: string }> }).groups.find((group) => group.name === "Personal")!;
    await harness.behavior.callRpc("setGroupOrder", { groupIds: [work.id, personal.id] });
    await harness.behavior.callRpc("setProjectGroup", { projectId: "proj_cdp", groupId: work.id });
    await harness.behavior.callRpc("updateProject", { projectId: "proj_cdp", icon: "◈", credentialId });
    await expect(harness.behavior.callRpc("setGlobalAgent", { targetId: agentId, enabled: true })).rejects.toThrow("membership-retired");
    await harness.behavior.callRpc("setProjectBundle", { projectId: "proj_cdp", targetId: bundleId, enabled: true });

    await expect(harness.behavior.callRpc("projectContext", { projectId: "proj_cdp" })).resolves.toEqual({
      projectId: "proj_cdp", groupId: work.id, credentialId, agentIds: [], bundleIds: [bundleId],
    });
    const groups = await harness.behavior.callRpc("groupsSnapshot", null) as { groups: Array<{ name: string; projectIds: string[] }> };
    expect(groups.groups.map((group) => group.name)).toEqual(["Work", "Personal"]);
    expect(groups.groups).toContainEqual(expect.objectContaining({ name: "Work", projectIds: ["proj_cdp"] }));
    await harness.lifecycle.dispose();
  });

  it("imports existing sidebar, credential, and Catalog relationships once", async () => {
    const credentialId = "44444444-4444-4444-8444-444444444444";
    const bundleId = "55555555-5555-4555-8555-555555555555";
    const { bb, harness } = createFakePluginHost({ pluginId: "projects", sdk: { subscribe: () => () => {}, projects: { list: async () => projects }, plugins: { list: async () => ({ plugins: installedDestinations }), callRpc: async (input) => legacyRpc(input) } } });
    await plugin(bb);
    const result = await harness.behavior.callRpc("importLegacy", {
      groups: [{ id: "ws_work", name: "Work", color: "blue", isDefault: false, projectIds: ["proj_cdp"] }],
      credentialBindings: [{ projectId: "proj_cdp", credentialId }],
      catalogAssignments: [
        { bundleId, kind: "project", targetId: "proj_cdp" },
        { bundleId: "66666666-6666-4666-8666-666666666666", kind: "agent-profile", targetId: "77777777-7777-4777-8777-777777777777" },
      ],
    });
    expect(result).toEqual(expect.objectContaining({ credentials: 1, bundles: 2 }));
    await harness.behavior.callRpc("importLegacyFromSourcesV1", null);
    await expect(harness.behavior.callRpc("projectContext", { projectId: "proj_cdp" })).resolves.toEqual(expect.objectContaining({
      credentialId,
      bundleIds: expect.arrayContaining([bundleId, "66666666-6666-4666-8666-666666666666"]),
    }));
    await expect(harness.behavior.callRpc("globalContext", null)).resolves.toEqual(expect.objectContaining({
      bundleIds: ["66666666-6666-4666-8666-666666666666"],
    }));
    await harness.lifecycle.dispose();
  });

  it("imports canonical project data only on the explicit owner action", async () => {
    const credentialId = "99999999-9999-4999-8999-999999999999";
    const bundleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const callRpc = async ({ method }: { method: string }) => {
      if (method === "assignmentStatus") return { state: "uninitialized", transfer: null, destinationRevision: null, conflicts: 0 };
      if (method === "legacyWorkspaceSnapshot") return { workspaces: [{ id: "ws_work", name: "Work", color: "blue", isDefault: false, projectIds: ["proj_cdp"] }] };
      if (method === "legacySnapshot") return { profiles: [], projects: [{ id: "proj_cdp", profileId: credentialId }] };
      if (method === "legacyAssignments") return { assignments: [{ bundleId, kind: "project", targetId: "proj_cdp" }] };
      if (method === "listProfiles") return [{ id: agentId, name: "Analyst", slug: "analyst", isDefault: true }];
      if (method === "remapLegacyProjectGroups" || method === "refreshProjectGroups" || method === "refreshAvailability") return { ok: true };
      throw new Error(`Unexpected RPC: ${method}`);
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "projects",
      sdk: { subscribe: () => () => {}, projects: { list: async () => projects }, plugins: { list: async () => ({ plugins: installedDestinations }), callRpc } },
    });
    await plugin(bb);
    await harness.behavior.callRpc("importLegacyFromSourcesV1", null);

    await expect(harness.behavior.callRpc("projectContext", { projectId: "proj_cdp" })).resolves.toEqual(expect.objectContaining({
      credentialId,
      agentIds: [],
      bundleIds: [bundleId],
    }));
    await harness.lifecycle.dispose();
  });

  it("rejects obsolete agent membership changes without contacting Agents", async () => {
    const agentId = "88888888-8888-4888-8888-888888888888";
    const callRpc = async ({ method }: { method: string }) => {
      if (method === "listProfiles") return [{ id: agentId, name: "Default", slug: "default", isDefault: true }];
      return legacyRpc({ method });
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "projects",
      sdk: { subscribe: () => () => {}, projects: { list: async () => projects }, plugins: { list: async () => ({ plugins: installedDestinations }), callRpc } },
    });
    await plugin(bb);
    await harness.behavior.callRpc("importLegacyFromSourcesV1", null);

    await expect(harness.behavior.callRpc("setGlobalAgent", { targetId: agentId, enabled: false }))
      .rejects.toThrow("membership-retired");
    await harness.lifecycle.dispose();
  });

  it("rejects incomplete, unknown, and duplicate group orders", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "projects",
      sdk: {
        subscribe: () => () => {},
        projects: { list: async () => projects },
        plugins: { callRpc: async (input) => legacyRpc(input) },
      },
    });
    await plugin(bb);
    const work = await harness.behavior.callRpc("saveGroup", {
      name: "Work",
      color: "blue",
    }) as { id: string };
    const before = await harness.behavior.callRpc("groupsSnapshot", null) as {
      groups: Array<{ id: string }>;
    };
    const ids = before.groups.map((group) => group.id);

    await expect(
      harness.behavior.callRpc("setGroupOrder", { groupIds: [ids[0]!] }),
    ).rejects.toThrow("every project group exactly once");
    await expect(
      harness.behavior.callRpc("setGroupOrder", {
        groupIds: [ids[0]!, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      }),
    ).rejects.toThrow("every project group exactly once");
    await expect(
      harness.behavior.callRpc("setGroupOrder", {
        groupIds: [work.id, work.id],
      }),
    ).rejects.toThrow("rpc input validation failed");
    await expect(harness.behavior.callRpc("groupsSnapshot", null)).resolves.toEqual(before);
    await harness.lifecycle.dispose();
  });

  it("stores an editable routing profile without exposing generation secrets", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "projects",
      sdk: {
        subscribe: () => () => {},
        projects: { list: async () => projects },
        plugins: { callRpc: async (input) => legacyRpc(input) },
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("updateRoutingProfile", {
      projectId: "proj_cdp",
      description: "Transforms customer data into analytics-ready models.",
      keywords: ["customer data", "dbt"],
      aliases: ["CDP"],
      repositories: ["example/cdp"],
    });
    const snapshot = await harness.behavior.callRpc("routingProfiles", null) as {
      configured: boolean;
      projects: Array<{ id: string; profile: { source: string; description: string } }>;
    };
    expect(snapshot.configured).toBe(false);
    expect(snapshot.projects.find((project) => project.id === "proj_cdp")?.profile).toEqual(expect.objectContaining({
      source: "manual",
      description: "Transforms customer data into analytics-ready models.",
    }));
    await harness.lifecycle.dispose();
  });

  it("suggests a project from an exact repository mention and needs Jev otherwise", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "projects",
      sdk: {
        subscribe: () => () => {},
        projects: { list: async () => projects },
        plugins: { callRpc: async (input) => legacyRpc(input) },
      },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("suggestProject", { prompt: "Fix the build in github.com/example/site" })).resolves.toEqual(expect.objectContaining({
      suggestion: expect.objectContaining({ id: "proj_site", probability: 1 }),
      confidence: 1,
      autoApply: true,
    }));
    await expect(harness.behavior.callRpc("suggestProject", { prompt: "Write a short poem about autumn" })).rejects.toThrow("Jev API key missing");
    await harness.lifecycle.dispose();
  });
});

describe("simplified project integrations", () => {
  it("retains agent history but refuses obsolete writes and never calls Agents or Tasks even with old flags enabled", async () => {
    const host = createFakePluginHost({ pluginId: "projects", sdk: {
      subscribe: () => () => {}, projects: { list: async () => projects },
      plugins: {list: async () => ({plugins: [{id:"agent-profiles",enabled:true,status:"running"}]}), callRpc: async () => {throw new Error("No sibling access expected");}},
    }});
    await plugin(host.bb);
    const db=host.bb.storage.database(); const { ProjectsStore } = await import("./store.js"); const store=new ProjectsStore(db);
    store.markMigration("suite-v1"); store.toggleGlobalReference("agent", "historical-agent", true);
    await host.harness.behavior.callRpc("updatePreferences", {agentsIntegration:true,tasksIntegration:true,catalogIntegration:false,sidebarIntegration:false});
    const before=db.prepare("SELECT * FROM global_agents").all();
    for (const [method,input] of [
      ["setProjectAgent",{projectId:"proj_cdp",targetId:"x",enabled:true}], ["setGlobalAgent",{targetId:"x",enabled:true}],
      ["removeAgent",{agentId:"historical-agent"}], ["assignmentOptionsV1",{kind:"agentPreferences"}],
    ] as const) await expect(host.harness.behavior.callRpc(method,input)).rejects.toThrow("membership-retired");
    expect(db.prepare("SELECT * FROM global_agents").all()).toEqual(before);
    expect(await host.harness.behavior.callRpc("organizationSnapshot",null)).toMatchObject({projects:expect.any(Array)});
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    await host.harness.lifecycle.dispose();
  });
  it("accepts hex colours and refreshes an installed sidebar even when the old notification toggle is false", async () => {
    const host=createFakePluginHost({pluginId:"projects", sdk:{subscribe:()=>()=>{}, projects:{list:async()=>[]}, plugins:{list:async()=>({plugins:[{id:"status-sidebar",enabled:true,status:"running"}]}),callRpc:async()=>({ok:true})}}});
    await plugin(host.bb);
    const group=await host.harness.behavior.callRpc("saveGroup",{name:"Custom",color:"#123abc"});
    expect(group).toMatchObject({color:"#123abc"});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toContainEqual([expect.objectContaining({pluginId:"status-sidebar",method:"refreshProjectGroups"})]);
    await host.harness.lifecycle.dispose();
  });
});
