import { describe, expect, it } from "vitest";
import {
  createFakePluginHost as createHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

// These fixtures exercise explicitly enabled integrations. Independence has its own fixture.
function createFakePluginHost(options: Parameters<typeof createHost>[0]) {
  return createHost({ ...options, settings: {
    agentsIntegration: true, projectsIntegration: true, tasksIntegration: true,
    ...options?.settings,
  } });
}

const personalGroupId = "00000000-0000-4000-8000-000000000001";
const workGroupId = "00000000-0000-4000-8000-000000000002";

function projectsSdk() {
  type Color = "amber" | "blue" | "violet" | "green" | "rose" | "gray";
  let groups: Array<{ id: string; name: string; color: Color; position: number; isDefault: boolean; projectIds: string[] }> = [
    { id: personalGroupId, name: "Personal", color: "amber" as const, position: 0, isDefault: true, projectIds: ["proj_personal"] },
    { id: workGroupId, name: "Work", color: "blue" as const, position: 1, isDefault: false, projectIds: [] },
  ];
  let next = 3;
  return {
    threads: {
      list: async () => [
        makeThreadResponse({ id: "thr_personal", projectId: "proj_personal" }),
        makeThreadResponse({ id: "thr_loose", projectId: "personal" }),
      ],
    },
    plugins: {
      callRpc: async ({ method, input }: { method: string; input: unknown }) => {
        if (method === "groupsSnapshot") return { groups };
        if (method === "saveGroup") {
          const change = input as { id?: string; name: string; color: Color };
          const existing = change.id ? groups.find((group) => group.id === change.id) : null;
          if (existing) Object.assign(existing, { name: change.name, color: change.color });
          else {
            const id = `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
            groups.push({ id, name: change.name, color: change.color, position: groups.length, isDefault: false, projectIds: [] });
          }
          return groups.find((group) => group.id === change.id) ?? groups.at(-1)!;
        }
        if (method === "setProjectGroup") {
          const change = input as { projectId: string; groupId: string };
          groups = groups.map((group) => ({ ...group, projectIds: group.id === change.groupId ? [...group.projectIds.filter((id) => id !== change.projectId), change.projectId] : group.projectIds.filter((id) => id !== change.projectId) }));
          return { ok: true };
        }
        if (method === "setProjectOrder") {
          const change = input as { groupId: string; projectIds: string[] };
          groups = groups.map((group) => group.id === change.groupId ? { ...group, projectIds: change.projectIds } : group);
          return { ok: true };
        }
        if (method === "setGroupOrder") {
          const order = (input as { groupIds: string[] }).groupIds;
          groups = [...groups].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
            .map((group, position) => ({ ...group, position }));
          return { ok: true };
        }
        if (method === "deleteGroup") {
          const id = (input as { id: string }).id;
          const removed = groups.find((group) => group.id === id)!;
          groups = groups.filter((group) => group.id !== id).map((group) => group.isDefault ? { ...group, projectIds: [...group.projectIds, ...removed.projectIds] } : group);
          return { ok: true };
        }
        throw new Error(`Unexpected Projects RPC: ${method}`);
      },
    },
  };
}

describe("Later persistence", () => {
  it("stores and clears Later state", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
    });
    await plugin(bb);

    await harness.behavior.callRpc("setLater", {
      threadId: "thr_1",
      later: true,
    });
    const listed = await harness.behavior.callRpc("listLater", null);
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]?.threadId).toBe("thr_1");

    await harness.behavior.callRpc("setLater", { threadId: "thr_1", later: false });
    expect(await harness.behavior.callRpc("listLater", null)).toEqual({ rows: [] });
    await harness.lifecycle.dispose();
  });
});

describe("agents sidebar bridge", () => {
  it("returns owned mappings, broadcasts updates, and opens the canonical DM", async () => {
    const snapshot = {
      agents: [{ id: "00000000-0000-4000-8000-000000000001", name: "Agent", avatar: "A", dmThreadId: "dm" }],
      excludedThreadIds: ["dm", "channel"],
    };
    const calls: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: { plugins: { callRpc: async ({ method }: { method: string }) => {
        calls.push(method);
        if (method === "agentsSidebar") return snapshot;
        if (method === "ensureAgentDm") return { threadId: "dm" };
        throw new Error("Unexpected RPC");
      } } },
    });
    await plugin(bb);
    expect(await harness.behavior.callRpc("listAgents", { fresh: false })).toEqual(snapshot);
    expect(await harness.behavior.callRpc("openAgent", { profileId: snapshot.agents[0]!.id }))
      .toEqual({ threadId: "dm" });
    expect(calls).toEqual(["agentsSidebar", "ensureAgentDm"]);
    expect(await harness.behavior.callRpc("listAgents", { fresh: true })).toEqual(snapshot);
    expect(calls).toEqual(["agentsSidebar", "ensureAgentDm", "agentsSidebar"]);
    await harness.behavior.callRpc("agentsChanged", { snapshot });
    expect(await harness.behavior.callRpc("listAgents", { fresh: false })).toEqual(snapshot);
    expect(calls).toEqual(["agentsSidebar", "ensureAgentDm", "agentsSidebar"]);
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "agents-changed", payload: snapshot,
    });
    await harness.lifecycle.dispose();
  });

  it("does not block Code when Agents is missing", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "status-sidebar",
      sdk: { plugins: { callRpc: async () => { throw new Error("unavailable"); } } } });
    await plugin(bb);
    expect(await harness.behavior.callRpc("listAgents", { fresh: false })).toBeNull();
    await harness.lifecycle.dispose();
  });
});

describe("channel summary bridge", () => {
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const room = (overrides: Partial<{ unread: boolean; updatedAt: number }> = {}) => ({
    id: "00000000-0000-4000-8000-0000000000aa",
    name: "ops",
    pinned: false,
    unread: false,
    active: false,
    memberCount: 2,
    updatedAt: 1,
    ...overrides,
  });

  it("returns null channels when Agents is unavailable", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        plugins: {
          callRpc: async () => {
            throw new Error("Plugin agent-profiles is not running");
          },
        },
      },
    });
    await plugin(bb);

    await expect(
      harness.behavior.callRpc("listChannels", null),
    ).resolves.toBeNull();
    await expect(
      harness.behavior.callRpc("channelsChanged", null),
    ).resolves.toEqual({ ok: true });
    await harness.lifecycle.dispose();
  });

  it("shares one Agents fetch across windows and pushes only visible changes", async () => {
    let rows = [room()];
    let fetches = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        plugins: {
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            if (pluginId !== "agent-profiles" || method !== "channelSummaries") {
              throw new Error(`Unexpected plugin RPC: ${pluginId}.${method}`);
            }
            fetches += 1;
            return rows;
          },
        },
      },
    });
    await plugin(bb);
    const signals = () =>
      harness.inspection.realtimeSignals.filter(({ channel }) => channel === "channels-changed");

    // Three windows mounting at once cost one Agents call.
    await Promise.all([
      harness.behavior.callRpc("listChannels", null),
      harness.behavior.callRpc("listChannels", null),
      harness.behavior.callRpc("listChannels", null),
    ]);
    expect(fetches).toBe(1);

    // A message that only bumps updatedAt changes nothing the sidebar shows.
    rows = [room({ updatedAt: 2 })];
    await harness.behavior.callRpc("channelsChanged", null);
    await flush();
    expect(fetches).toBe(2);
    expect(signals()).toEqual([]);

    // Unread is visible, so the rows travel in the signal itself.
    rows = [room({ unread: true, updatedAt: 3 })];
    await harness.behavior.callRpc("channelsChanged", null);
    await flush();
    expect(signals()).toEqual([
      { channel: "channels-changed", payload: { channels: rows } },
    ]);

    // Windows then read the refreshed rows without another Agents call.
    await expect(harness.behavior.callRpc("listChannels", null)).resolves.toEqual(rows);
    expect(fetches).toBe(3);
    await harness.lifecycle.dispose();
  });

  it("publishes rows Agents sends with the nudge without calling back", async () => {
    let fetches = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        plugins: {
          callRpc: async () => {
            fetches += 1;
            return [];
          },
        },
      },
    });
    await plugin(bb);
    const rows = [room({ unread: true })];

    await harness.behavior.callRpc("channelsChanged", { channels: rows });
    await harness.behavior.callRpc("channelsChanged", { channels: rows });
    await expect(harness.behavior.callRpc("listChannels", null)).resolves.toEqual(rows);
    expect(fetches).toBe(0);
    expect(
      harness.inspection.realtimeSignals.filter(({ channel }) => channel === "channels-changed"),
    ).toEqual([{ channel: "channels-changed", payload: { channels: rows } }]);
    await harness.lifecycle.dispose();
  });

  it("coalesces a burst of nudges into at most one follow-up fetch", async () => {
    let fetches = 0;
    let release: (() => void) | null = null;
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        plugins: {
          callRpc: async () => {
            fetches += 1;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return [room({ updatedAt: fetches })];
          },
        },
      },
    });
    await plugin(bb);

    for (let i = 0; i < 4; i += 1) {
      await harness.behavior.callRpc("channelsChanged", null);
    }
    expect(fetches).toBe(1);
    release!();
    await flush();
    expect(fetches).toBe(2);
    release!();
    await flush();
    expect(fetches).toBe(2);
    await harness.lifecycle.dispose();
  });
});

describe("thread order persistence", () => {
  it("stores a global order and forgets deleted threads", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: projectsSdk(),
    });
    await plugin(bb);

    await harness.behavior.callRpc("setThreadOrder", {
      threadIds: ["thr_b", "thr_a"],
    });
    expect(await harness.behavior.callRpc("listThreadOrder", null)).toEqual({
      threadIds: ["thr_b", "thr_a"],
    });

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_b" }),
    });
    expect(await harness.behavior.callRpc("listThreadOrder", null)).toEqual({
      threadIds: ["thr_a"],
    });
    await harness.lifecycle.dispose();
  });

  it("keeps the same thread in independent section and status orders", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: projectsSdk(),
    });
    await plugin(bb);

    await harness.behavior.callRpc("setThreadOrder", {
      workspaceId: personalGroupId,
      threadIds: ["thr_shared", "thr_personal"],
    });
    await harness.behavior.callRpc("setThreadOrder", {
      workspaceId: "__status_all__",
      threadIds: ["thr_other", "thr_shared"],
    });

    await expect(
      harness.behavior.callRpc("listThreadOrder", {
        workspaceId: personalGroupId,
      }),
    ).resolves.toEqual({ threadIds: ["thr_shared", "thr_personal"] });
    await expect(
      harness.behavior.callRpc("listThreadOrder", {
        workspaceId: "__status_all__",
      }),
    ).resolves.toEqual({ threadIds: ["thr_other", "thr_shared"] });
    await harness.lifecycle.dispose();
  });
});

describe("project order persistence", () => {
  it("stores a global project order and publishes its change", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: projectsSdk(),
    });
    await plugin(bb);

    await harness.behavior.callRpc("setProjectOrder", {
      projectIds: ["proj_b", "proj_a"],
      workspaceId: personalGroupId,
    });
    expect(await harness.behavior.callRpc("listProjectOrder", { workspaceId: personalGroupId })).toEqual({
      projectIds: ["proj_b", "proj_a"],
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "workspaces",
      payload: null,
    });
    await harness.lifecycle.dispose();
  });
});

describe("workspace persistence", () => {
  it("creates, renames, reorders, and deletes canonical project groups", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: projectsSdk(),
    });
    await plugin(bb);

    const created = await harness.behavior.callRpc("createWorkspace", { name: "Clients" });
    await harness.behavior.callRpc("renameWorkspace", { workspaceId: created.workspaceId, name: "Partners" });
    await harness.behavior.callRpc("setWorkspaceOrder", { workspaceIds: [workGroupId, created.workspaceId, personalGroupId] });
    expect((await harness.behavior.callRpc("listWorkspaces", null)).workspaces.map((workspace) => workspace.name)).toEqual([
      "Work", "Partners", "Personal",
    ]);
    await harness.behavior.callRpc("deleteWorkspace", { workspaceId: created.workspaceId });
    expect((await harness.behavior.callRpc("listWorkspaces", null)).workspaces.map((workspace) => workspace.name)).toEqual([
      "Work", "Personal",
    ]);
    await harness.lifecycle.dispose();
  });

  it("assigns projects and projectless threads while keeping orders scoped", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: projectsSdk(),
    });
    await plugin(bb);

    const initial = await harness.behavior.callRpc("listWorkspaces", null);
    expect(initial.workspaces.map((workspace) => workspace.name)).toEqual([
      "Personal",
      "Work",
    ]);

    await harness.behavior.callRpc("setProjectWorkspace", {
      projectId: "proj_personal",
      workspaceId: workGroupId,
    });
    await harness.behavior.callRpc("setThreadWorkspace", {
      threadId: "thr_loose",
      workspaceId: workGroupId,
    });

    await harness.behavior.callRpc("setThreadOrder", {
      workspaceId: personalGroupId,
      threadIds: ["thr_personal"],
    });
    await harness.behavior.callRpc("setThreadOrder", {
      workspaceId: workGroupId,
      threadIds: ["thr_work"],
    });
    await harness.behavior.callRpc("setProjectOrder", {
      workspaceId: workGroupId,
      projectIds: ["proj_personal"],
    });

    expect(
      await harness.behavior.callRpc("listThreadOrder", {
        workspaceId: personalGroupId,
      }),
    ).toEqual({ threadIds: ["thr_personal"] });
    expect(
      await harness.behavior.callRpc("listThreadOrder", {
        workspaceId: workGroupId,
      }),
    ).toEqual({ threadIds: ["thr_work"] });
    expect(
      await harness.behavior.callRpc("listProjectOrder", {
        workspaceId: workGroupId,
      }),
    ).toEqual({ projectIds: ["proj_personal"] });

    const configured = await harness.behavior.callRpc("listWorkspaces", null);
    expect(configured.workspaces).toContainEqual(
      expect.objectContaining({
        id: workGroupId,
        name: "Work",
        projectIds: ["proj_personal"],
        threadIds: ["thr_loose"],
      }),
    );

    await harness.behavior.callRpc("setThreadWorkspace", {
      threadId: "thr_personal_loose",
      workspaceId: personalGroupId,
    });
    expect(
      (await harness.behavior.callRpc("listWorkspaces", null)).workspaces.find(
        (workspace) => workspace.id === personalGroupId,
      )?.threadIds,
    ).toContain("thr_personal_loose");
    await harness.behavior.callRpc("clearThreadWorkspace", {
      threadId: "thr_personal_loose",
    });
    expect(
      (await harness.behavior.callRpc("listWorkspaces", null)).workspaces.flatMap(
        (workspace) => workspace.threadIds,
      ),
    ).not.toContain("thr_personal_loose");

    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "workspaces",
      payload: null,
    });
    await harness.lifecycle.dispose();
  });
});

describe("legacy workspace migration", () => {
  it("remaps saved thread order to imported project groups", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "status-sidebar", sdk: projectsSdk() });
    await plugin(bb);

    await harness.behavior.callRpc("setThreadOrder", { workspaceId: "ws_personal", threadIds: ["thr_legacy"] });
    await harness.behavior.callRpc("remapLegacyProjectGroups", {
      mappings: [{ legacyId: "ws_personal", groupId: personalGroupId }],
    });

    expect(await harness.behavior.callRpc("listThreadOrder", { workspaceId: personalGroupId })).toEqual({ threadIds: ["thr_legacy"] });
    await harness.lifecycle.dispose();
  });
});

describe("shortcut slots", () => {
  it("publishes the exact client-visible shortcut rows", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
    });
    await plugin(bb);

    await harness.behavior.callRpc("publishShortcutSlots", {
      publisherId: "11111111-1111-4111-8111-111111111111",
      focusEpoch: 100,
      sequence: 1,
      slots: [
        {
          threadId: "thr_question",
          title: "Needs an answer",
          status: "needs-input",
        },
        {
          threadId: "thr_working",
          title: "Working",
          status: "active",
        },
      ],
    });

    expect(await harness.behavior.callRpc("listShortcutSlots", null)).toEqual({
      slots: [
        {
          threadId: "thr_question",
          title: "Needs an answer",
          status: "needs-input",
        },
        {
          threadId: "thr_working",
          title: "Working",
          status: "active",
        },
      ],
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "shortcut-slots",
      payload: null,
    });
    await harness.lifecycle.dispose();
  });

  it("ignores late publications from a previously focused window", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
    });
    await plugin(bb);
    const first = "11111111-1111-4111-8111-111111111111";
    const active = "22222222-2222-4222-8222-222222222222";

    await harness.behavior.callRpc("publishShortcutSlots", {
      publisherId: first,
      focusEpoch: 100,
      sequence: 1,
      slots: [{ threadId: "old", title: "Old", status: "idle" }],
    });
    await harness.behavior.callRpc("publishShortcutSlots", {
      publisherId: active,
      focusEpoch: 200,
      sequence: 1,
      slots: [{ threadId: "active", title: "Active", status: "active" }],
    });
    await harness.behavior.callRpc("publishShortcutSlots", {
      publisherId: first,
      focusEpoch: 100,
      sequence: 2,
      slots: [{ threadId: "late", title: "Late", status: "idle" }],
    });

    await expect(
      harness.behavior.callRpc("listShortcutSlots", null),
    ).resolves.toEqual({
      slots: [{ threadId: "active", title: "Active", status: "active" }],
    });
    await harness.lifecycle.dispose();
  });
});

describe("task attachments", () => {
  it("combines both task plugins and delegates existing-thread attachment", async () => {
    const calls: Array<{ pluginId: string; method: string; input: unknown }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        plugins: {
          callRpc: async ({ pluginId, method, input }) => {
            calls.push({ pluginId, method, input });
            if (method === "listAttachmentCandidates") {
              return { tasks: [{
                id: "synced-1",
                identifier: "GH-1",
                title: "Synced task",
                status: "todo",
                attachedThreadId: null,
                attachedToCurrentThread: false,
              }] };
            }
            if (method === "attachExistingChat") return { threadId: "thr_1" };
            throw new Error(`Unexpected method ${method}`);
          },
        },
      },
    });
    await plugin(bb);

    const listed = await harness.behavior.callRpc("listAttachableTasks", {
      threadId: "thr_1",
      query: "task",
    });
    expect(listed.tasks.map((task) => task.identifier)).toEqual(["GH-1"]);

    await harness.behavior.callRpc("attachThreadToTask", {
      source: "task-workspaces",
      taskId: "synced-1",
      threadId: "thr_1",
    });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: "task-workspaces", method: "attachExistingChat" }),
    ]));
    await harness.lifecycle.dispose();
  });

  it("surfaces task plugin search failures", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        plugins: {
          callRpc: async () => {
            throw new Error("Task search unavailable");
          },
        },
      },
    });
    await plugin(bb);

    await expect(harness.behavior.callRpc("listAttachableTasks", {
      threadId: "thr_1",
      query: "task",
    })).rejects.toThrow("Task search unavailable");
    await harness.lifecycle.dispose();
  });
});

describe("sandbox statuses", () => {
  const host = (
    id: string,
    machineProviderId: string | null,
    status: "connected" | "disconnected",
    phase: string,
    teardown: { status: string } | null = null,
  ) => ({
    id,
    name: `${id} label`,
    status,
    machineProviderId,
    lifecycle: { phase, teardown },
  });

  it("projects native host lifecycle without hopping into the Sandboxes plugin", async () => {
    const calls: Array<{ pluginId: string; method: string }> = [];
    let listCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        hosts: {
          list: async () => {
            listCalls += 1;
            return [
              host("host_daytona", "sandbox-daytona", "connected", "active"),
              host("host_modal", "sandbox-modal", "disconnected", "suspended"),
              host("host_gone", "sandbox-e2b", "disconnected", "destroyed"),
              host("host_local", null, "connected", "active"),
              host("host_other", "fly-machine", "connected", "active"),
            ];
          },
        },
        plugins: {
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            calls.push({ pluginId, method });
            throw new Error(`Unexpected plugin RPC: ${pluginId}.${method}`);
          },
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("listSandboxStatuses", {
      threads: [
        { threadId: "thr_live", hostId: "host_daytona" },
        { threadId: "thr_idle", hostId: "host_modal" },
        { threadId: "thr_dead", hostId: "host_gone" },
        { threadId: "thr_local", hostId: "host_local" },
        { threadId: "thr_nonsandbox", hostId: "host_other" },
        { threadId: "thr_unknown", hostId: "host_missing" },
        { threadId: "thr_hostless", hostId: null },
      ],
    });

    expect(result.statuses).toEqual([
      expect.objectContaining({
        threadId: "thr_live",
        provider: "daytona",
        status: "live",
        label: "host_daytona label",
      }),
      expect.objectContaining({
        threadId: "thr_idle",
        provider: "modal",
        status: "idle",
      }),
      expect.objectContaining({
        threadId: "thr_dead",
        provider: "e2b",
        status: "unrecoverable",
      }),
    ]);
    expect(listCalls).toBe(1);
    expect(calls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("skips the host listing entirely for an empty batch", async () => {
    let listCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        hosts: {
          list: async () => {
            listCalls += 1;
            return [];
          },
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("listSandboxStatuses", {
      threads: [],
    });
    expect(result.statuses).toEqual([]);
    expect(listCalls).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("degrades to no statuses when the host listing fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "status-sidebar",
      sdk: {
        hosts: {
          list: async () => {
            throw new Error("hosts unavailable");
          },
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("listSandboxStatuses", {
      threads: [{ threadId: "thr_live", hostId: "host_daytona" }],
    });
    expect(result.statuses).toEqual([]);
    await harness.lifecycle.dispose();
  });
});
