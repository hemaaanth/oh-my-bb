import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost as createSdkFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import type { ThreadResponse } from "@get-bb/plugin-sdk";
import plugin from "./server";
import { snapshot } from "./server/profiles";
import { agentModelId } from "./server/provider-ids";
import type { Profile } from "./server/contract";

const reasoningEfforts = ["low", "medium", "high"].map((reasoningEffort) => ({
  reasoningEffort,
  description: reasoningEffort,
}));

function providerModels({ providerId }: { providerId?: string }) {
  const codexPrefix = providerId === "acp-omp" || providerId === "hempi" ? "openai-codex/" : "";
  const claudePrefix = providerId === "acp-omp" ? "anthropic/" : "";
  const models = providerId === "claude-code"
    ? [
        "claude-fable-5-1",
        "claude-opus-5-5[1m]",
        "claude-sonnet-5",
        "claude-haiku-4-5",
      ]
    : [
        `${codexPrefix}gpt-6-astra`,
        `${codexPrefix}gpt-6-sol`,
        `${codexPrefix}gpt-5.6-terra`,
        `${codexPrefix}gpt-6-luna`,
        `${claudePrefix}claude-fable-5-1`,
        `${claudePrefix}claude-opus-5-5`,
        `${claudePrefix}claude-sonnet-5`,
        `${claudePrefix}claude-haiku-4-5`,
      ];
  return {
    models: models.map((model, index) => ({
      id: model,
      model,
      displayName: model,
      description: model,
      supportedReasoningEfforts: reasoningEfforts,
      defaultReasoningEffort: "medium",
      isDefault: index === 1,
    })),
    selectedOnlyModels: [],
    providers: [],
    permissionCeiling: "full",
    modelLoadError: null,
  } as never;
}

function createFakePluginHost(
  options: Parameters<typeof createSdkFakePluginHost>[0] = {},
) {
  return createSdkFakePluginHost({
    ...options,
    sdk: {
      ...options.sdk,
      providers: {
        models: providerModels,
        ...options.sdk?.providers,
      },
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, providerId: "codex" }),
        defaultExecutionOptions: async () => ({
          providerId: "codex",
          model: "gpt-6-sol",
          permissionMode: "auto" as const,
          reasoningLevel: "medium" as const,
          serviceTier: "default" as const,
          source: "client/turn/requested" as const,
        }),
        ...options.sdk?.threads,
      },
    },
  });
}

function projectPlugins() {
  const companionThreads: string[] = [];
  return {
    companionThreads,
    callRpc: async ({ method, input }: { method: string; input: unknown }) => {
      if (method === "registerReviewThread") {
        if (input && typeof input === "object" && "threadId" in input && typeof input.threadId === "string") companionThreads.push(input.threadId);
        return { ok: true };
      }
      throw new Error(`Unexpected plugin RPC: ${method}`);
    },
  };
}
const LEGACY_SCHEMA = `CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      service_tier TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      mcp_server_ids TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE profile_revisions (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, revision)
    );
    CREATE TABLE thread_bindings (
      thread_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      parent_thread_id TEXT,
      environment_id TEXT,
      created_at TEXT NOT NULL
    );`;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

async function createCliHarness() {
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
    sdk: {
      plugins: projectPlugins(),
      system: {
        config: async () => ({ primaryHostId: "host-primary" }) as never,
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: projectId === "proj-fixed" ? "Fixed Project" : projectId,
          kind: "standard",
        }) as never,
      },
      hosts: {
        get: async ({ hostId }: { hostId: string }) => ({
          id: hostId,
          name: hostId === "host-deck" ? "deckmaster" : hostId,
          status: "connected",
          machineProviderId: hostId === "host-primary" ? null : "manual",
        }) as never,
        list: async () => [
          { id: "host-primary", name: "Primary", status: "connected", machineProviderId: null },
          { id: "host-deck", name: "deckmaster", status: "connected", machineProviderId: "manual" },
        ] as never,
      },
      threads: {
        get: async ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "project-1",
          environmentId: "environment-1",
          status: threadId === "cli-child" ? "active" : "idle",
          visibility: threadId === "cli-child" ? "hidden" : "visible",
        }),
        defaultExecutionOptions: async () => ({
          model: "gpt-6-astra",
          permissionMode: "full" as const,
          reasoningLevel: "high" as const,
          serviceTier: "default" as const,
          source: "client/turn/requested" as const,
        }),
        spawn: async () => makeThreadResponse({
          id: "cli-child",
          projectId: "project-1",
          environmentId: "environment-1",
          status: "active",
          visibility: "hidden",
        }),
        send: async () => undefined,
        stop: async () => ({ ok: true as const }),
        update: async ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "project-1",
          environmentId: "environment-1",
          visibility: "visible",
        }),
      },
    },
  });
  await plugin(host.bb);
  return host;
}

// Built-in agents are thin, so home and memory tests save their own full agent.
async function saveHomeAgent(
  harness: FakePluginHarness,
  isDefault = false,
) {
  return await harness.behavior.callRpc("saveProfile", {
    name: "Home Agent",
    slug: "home-agent",
    description: "Keeps a mission and memory",
    providerId: "codex",
    model: "gpt-5.6-sol",
    reasoningLevel: "high",
    serviceTier: "default",
    permissionMode: "auto",
    instructions: "Work from your home documents.",
    skillIds: [],
    mcpServerIds: [],
    isDefault,
  }) as { id: string; slug: string; description: string };
}

describe("agent profiles", () => {
  it("retains channel-owned thread IDs after a conversation is replaced", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles", sdk: { plugins: projectPlugins() },
    });
    await plugin(bb);
    const db = bb.storage.database();
    db.prepare("INSERT INTO conversations (id, agent_id, key, thread_id, json) VALUES (?, ?, ?, ?, ?)")
      .run("conversation", "agent", "channel", "channel-thread", "{}");
    db.prepare("DELETE FROM conversations WHERE thread_id = ?").run("channel-thread");
    const snapshot = await harness.behavior.callRpc("agentsSidebar", null) as {
      excludedThreadIds: string[];
    };
    expect(snapshot.excludedThreadIds).toContain("channel-thread");
    await harness.lifecycle.dispose();
  });

  it("returns permission modes from the current provider capability shape", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins: projectPlugins(),
        providers: {
          list: async () => [{
            id: "codex",
            pluginId: "provider-codex",
            displayName: "Codex",
            available: true,
            logoUrl: null,
            composerActions: [],
            maintenance: { health: true, installation: true, usage: true },
            capabilities: {
              modelCatalogScope: "host",
              permissionModes: ["accept-edits", "auto", "full"],
              supportsFork: true,
              supportsNativeUserQuestion: false,
              supportsServiceTier: true,
              supportsSessionRewind: true,
              supportsThreadArchive: true,
              supportsThreadRename: true,
            },
          }] as never,
        },
      },
    });
    await plugin(bb);

    await expect(harness.behavior.callRpc("providers", null)).resolves.toEqual([{
      id: "codex",
      displayName: "Codex",
      supportsServiceTier: true,
      permissionModes: ["accept-edits", "auto", "full"],
    }]);
    await harness.lifecycle.dispose();
  });

  it("seeds the built-in agents and spawns one by role", async () => {
    const plugins = projectPlugins();
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
        threads: {
          defaultExecutionOptions: async () => ({
            model: "gpt-6-astra",
            permissionMode: "full" as const,
            reasoningLevel: "high" as const,
            serviceTier: "default" as const,
            source: "client/turn/requested" as const,
          }),
          spawn: async () =>
            makeThreadResponse({
              id: "pinpoint-child",
              projectId: "project-1",
              environmentId: "environment-1",
            }),
        },
        plugins,
      },
    });
    await plugin(bb);

    const profiles = (await harness.behavior.callRpc(
      "listProfiles",
      null,
    )) as Array<{
      id: string;
      slug: string;
      providerId: string;
      model: string;
      reasoningLevel: string;
      permissionMode: string;
      isDefault: boolean;
    }>;

    await harness.behavior.callRpc("spawnBuiltInProfile", {
      profile: "text-edit",
      projectId: "project-1",
      environment: { type: "reuse", environmentId: "environment-1" },
      parentThreadId: "parent-1",
      title: "Pinpoint text edit",
      prompt: "Make the exact copy change.",
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          providerId: "agents",
          model: agentModelId(profiles.find((profile) => profile.slug === "pinpoint-copy")!.id),
          parentThreadId: "parent-1",
          title: "@pinpoint-copy · Pinpoint text edit",
        }),
      ],
    ]);
    const textEdit = profiles.find((profile) => profile.slug === "pinpoint-copy")!;
    const thinConfiguration = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "pinpoint-child", title: null, parentThreadId: "parent-1", sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: { id: "environment-1", name: "main", path: "/work", workspaceProvisionType: "unmanaged", branchName: "main" },
      host: { id: "host-primary", name: "Local" },
      provider: { id: "agents", model: agentModelId(profiles.find((profile) => profile.slug === "pinpoint-copy")!.id) },
      origin: { kind: null, pluginId: "agent-profiles" },
    });
    expect(thinConfiguration.tools).not.toContain("agent_document_read");
    expect(await harness.behavior.callRpc("agentDetail", { id: textEdit.id }))
      .toMatchObject({ profile: { kind: "thin", homeReady: false }, home: { ready: false } });
    for (const tool of ["agent_document_read", "agent_persona_update"] as const) {
      await expect(harness.behavior.callAgentTool(
        tool,
        tool === "agent_document_read"
          ? { file: "PERSONA.md" }
          : { text: "Not stored", version: "0".repeat(64) },
        { threadId: "pinpoint-child", projectId: "project-1" },
      )).rejects.toThrow("This agent has no mission or persona");
    }

    await harness.lifecycle.dispose();
  });

  it("versions an agent profile and keeps its model identity independent of the caller", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
        threads: {
          spawn: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "environment-1" }),
        },
        plugins: projectPlugins(),
      },
    });
    await plugin(bb);

    const first = await harness.behavior.callRpc("saveProfile", {
      name: "Reviewer",
      slug: "reviewer",
      description: "Reviews changes",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "auto",
      instructions: "Review the change and report concrete risks.",
      skillIds: ["code-review"],
      mcpServerIds: ["github"],
      isDefault: true,
    }) as { id: string; revision: number };
    const update = {
      id: first.id,
      name: "Reviewer",
      slug: "reviewer",
      description: "Reviews changes",
      modelMode: "level",
      level: "xhigh",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
      permissionMode: "auto",
      instructions: "Review the change and report concrete risks.",
      skillIds: ["code-review"],
      mcpServerIds: ["github"],
      isDefault: true,
      expectedRevision: first.revision,
    } as const;
    const second = await harness.behavior.callRpc("saveProfile", update) as { revision: number };
    await expect(harness.behavior.callRpc("saveProfile", update))
      .rejects.toThrow("This profile changed. Reload it before saving your edits.");

    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect(await harness.behavior.callRpc("profileHistory", { id: first.id })).toHaveLength(2);

    await harness.behavior.callRpc("spawnProfile", {
      profileId: first.id,
      projectId: "project-1",
      environment: { type: "project-default" },
      title: "Review auth",
      prompt: "Review this branch.",
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([[expect.objectContaining({
      providerId: "agents",
      model: agentModelId(first.id),
      pluginMetadata: { role: "task", profileId: first.id, schemaVersion: 1 },
      reasoningLevel: "high",
      serviceTier: "fast",
      title: "@reviewer · Review auth",
      parentThreadId: undefined,
      input: [
        expect.objectContaining({ visibility: "agent-only", text: expect.stringContaining("revision 2") }),
        expect.objectContaining({ text: "Review this branch." }),
      ],
    })]]);
    expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.spawn"))).not.toContain("Preferred built-in skills");

    await harness.lifecycle.dispose();
  });


  it("does not make a built-in or saved non-default profile BB's default", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "agent-profiles", sdk: { plugins: projectPlugins() } });
    await plugin(bb);

    await harness.behavior.callRpc("saveProfile", {
      name: "CDP Analyst",
      slug: "cdp-analyst",
      description: "Answers read-only analytics questions",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "accept-edits",
      instructions: "Operate read-only.",
      skillIds: ["flint-chart"],
      mcpServerIds: [],
      isDefault: false,
    });

    const configured = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "thread-1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: { id: "environment-1", name: "main", path: "/work", workspaceProvisionType: "unmanaged", branchName: "main" },
      host: { id: "host-1", name: "Local" },
      provider: { id: "codex", model: "gpt-5.6-sol" },
      origin: { kind: null, pluginId: null },
    });

    expect(configured.instructions).not.toContain("default agent profile");
    expect(configured.instructions).toContain("Agents is available for @mention delegation.");
    expect(
      await harness.behavior.callRpc("catalogContextForThread", {
        threadId: "thread-1",
      }),
    ).toEqual({ profileId: null, bound: false });

    await harness.lifecycle.dispose();
  });

  it("keeps mentioned agents joined through removal, rejoin, promotion, and parent deletion", async () => {
    let childStatus: ThreadResponse["status"] = "idle";
    let childVisibility: ThreadResponse["visibility"] = "hidden";
    let childProvider = "agents";
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
        threads: {
          get: async ({ threadId }) => makeThreadResponse({
            id: threadId,
            projectId: "project-1",
            environmentId: "environment-1",
            status: threadId === "child-1" ? childStatus : "idle",
            visibility: threadId === "child-1" ? childVisibility : "visible",
            providerId: threadId === "child-1" ? childProvider : "codex",
            model: threadId === "child-1" ? agentModelId(profile.id) : "gpt-6-astra",
          }),
          defaultExecutionOptions: async () => ({
            model: "gpt-6-astra",
            permissionMode: "full" as const,
            reasoningLevel: "high" as const,
            serviceTier: "default" as const,
            source: "client/turn/requested" as const,
          }),
          spawn: async () => makeThreadResponse({
            id: "child-1",
            projectId: "project-1",
            environmentId: "environment-1",
            status: childStatus,
            visibility: childVisibility,
          }),
          send: async () => undefined,
          stop: async () => ({ ok: true as const }),
          update: async ({ threadId, visibility }) => {
            if (visibility) childVisibility = visibility;
            return makeThreadResponse({
              id: threadId,
              projectId: "project-1",
              environmentId: "environment-1",
              status: childStatus,
              visibility: childVisibility,
            });
          },
        },
        plugins: projectPlugins(),
      },
    });
    await plugin(bb);
    expect(
      harness.inspection.registrations.agentTools.find(
        ({ name }) => name === "delegate_agent_profile",
      )?.presentation,
    ).toEqual({
      label: {
        pending: "Delegating to agent profile",
        completed: "Delegated to agent profile",
      },
      icon: { glyph: "UserRoundPlus" },
    });

    const profile = await harness.behavior.callRpc("saveProfile", {
      name: "Researcher",
      slug: "researcher",
      description: "Investigates focused questions",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "auto",
      instructions: `Investigate carefully and cite concrete evidence.\n${"x".repeat(31_000)}`,
      skillIds: ["research"],
      mcpServerIds: [],
      isDefault: true,
    }) as { id: string };

    const configured = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "parent-1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: { id: "environment-1", name: "main", path: "/work", workspaceProvisionType: "unmanaged", branchName: "main" },
      host: { id: "host-1", name: "Sandbox" },
      provider: { id: "acp-omp", model: "openai/gpt-5.6-sol" },
      origin: { kind: null, pluginId: null },
    });
    expect(configured.instructions).toContain("uses @researcher as BB's default agent profile");
    expect(configured.tools.map(({ name }) => name)).toContain("delegate_agent_profile");
    expect(await harness.behavior.callRpc("catalogContextForThread", { threadId: "parent-1" }))
      .toEqual({ profileId: profile.id, bound: false });

    const delegated = await harness.behavior.callAgentTool("delegate_agent_profile", {
      profileId: profile.id,
      task: "Compare the two implementation options.",
      why: "The researcher profile is suited to evidence gathering.",
      title: "Compare options",
    }, { threadId: "parent-1", projectId: "project-1" });
    expect(JSON.parse(delegated as string)).toMatchObject({
      status: "spawned",
      threadId: "child-1",
      profile: "@researcher",
    });
    expect(await harness.behavior.callRpc("catalogContextForThread", { threadId: "child-1" }))
      .toEqual({ profileId: profile.id, bound: true });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([[expect.objectContaining({
      parentThreadId: "parent-1",
      visibility: "visible",
      environment: { type: "reuse", environmentId: "environment-1" },
      providerId: "agents",
      model: agentModelId(profile.id),
      permissionMode: "full",
      pluginMetadata: { role: "task", profileId: profile.id, schemaVersion: 1 },
      title: "@researcher · Compare options",
      input: expect.arrayContaining([
        expect.objectContaining({ visibility: "agent-only", text: expect.stringContaining("@researcher") }),
        expect.objectContaining({ text: expect.stringContaining("Delegation rationale") }),
      ]),
    })]]);
    await expect(harness.behavior.callRpc("threadMembers", {
      threadId: "parent-1",
    })).resolves.toEqual([
      expect.objectContaining({
        profileId: profile.id,
        slug: "researcher",
        childThreadId: "child-1",
        status: "idle",
        visibility: "hidden",
      }),
    ]);

    const joinedConfiguration = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "parent-1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: { id: "environment-1", name: "main", path: "/work", workspaceProvisionType: "unmanaged", branchName: "main" },
      host: { id: "host-1", name: "Sandbox" },
      provider: { id: "acp-omp", model: "openai/gpt-5.6-sol" },
      origin: { kind: null, pluginId: null },
    });
    expect(joinedConfiguration.instructions!.length).toBeLessThanOrEqual(4_096);
    expect(joinedConfiguration.instructions).toMatch(
      new RegExp(`^Agents joined to this thread: @researcher \\(profileId ${profile.id}\\)\\.`),
    );
    expect(joinedConfiguration.instructions).toContain(
      "call delegate_agent_profile for it with mode continue",
    );
    expect(joinedConfiguration.instructions).toContain(
      "… (truncated, use agent_document_read)",
    );

    childStatus = "active";
    await harness.behavior.callRpc("removeThreadMember", {
      threadId: "parent-1",
      profileId: profile.id,
    });
    expect(harness.inspection.sdk.callsTo("threads.stop").at(-1)?.[0]).toEqual({
      threadId: "child-1",
    });
    await expect(harness.behavior.callRpc("threadMembers", {
      threadId: "parent-1",
    })).resolves.toEqual([]);

    const continued = JSON.parse(await harness.behavior.callAgentTool("delegate_agent_profile", {
      profileId: profile.id,
      task: "Now compare the operational risks.",
      why: "This follows the same comparison.",
      mode: "continue",
    }, { threadId: "parent-1", projectId: "project-1" }) as string);
    expect(continued).toMatchObject({ status: "continued", threadId: "child-1" });
    expect(continued.directive).toBe('::agent-profile-delegation{threadId="child-1"}');
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.send").at(-1)?.[0]).toEqual(expect.objectContaining({
      threadId: "child-1",
      input: [expect.objectContaining({ text: "Now compare the operational risks." })],
    }));
    childProvider = `agent-${profile.id}`;
    const spawnsBeforeLegacy = harness.inspection.sdk.callsTo("threads.spawn").length;
    for (const mode of ["auto", "continue"] as const) {
      await expect(harness.behavior.callAgentTool("delegate_agent_profile", {
        profileId: profile.id, task: "Continue legacy work.", why: "Follow up.", mode,
      }, { threadId: "parent-1", projectId: "project-1" })).rejects.toThrow(/history-only.*mode fresh/);
    }
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(spawnsBeforeLegacy);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    childProvider = "agents";
    await expect(harness.behavior.callRpc("threadMembers", {
      threadId: "parent-1",
    })).resolves.toHaveLength(1);

    await harness.behavior.callRpc("promoteDelegation", {
      childThreadId: "child-1",
      parentThreadId: "parent-1",
    });
    expect(harness.inspection.sdk.callsTo("threads.update").at(-1)?.[0])
      .toEqual({ threadId: "child-1", visibility: "visible" });
    await expect(harness.behavior.callRpc("threadMembers", {
      threadId: "parent-1",
    })).resolves.toEqual([
      expect.objectContaining({ childThreadId: "child-1", visibility: "visible" }),
    ]);

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "parent-1" }),
    });
    await expect(harness.behavior.callRpc("threadMembers", {
      threadId: "parent-1",
    })).resolves.toEqual([]);

    await harness.lifecycle.dispose();
  });

  it("uses explicit delegation context and preserves saved defaults when task context is omitted", async () => {
    const deletedProjects = new Set<string>();
    let deckmasterOnline = true;
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
        projects: {
          get: async ({ projectId }: { projectId: string }) => {
            if (projectId !== "proj-fixed" || deletedProjects.has(projectId))
              throw new Error(`Project not found: ${projectId}`);
            return { id: projectId, name: "cdp_dbt", kind: "standard" } as never;
          },
        },
        environments: {
          list: async ({ projectId, environmentProviderId }: { projectId?: string; environmentProviderId?: string } = {}) =>
            // A sandbox checkout, a checkout on a disconnected machine, then the server's own checkout.
            (projectId === "proj-fixed" && environmentProviderId === "project-checkout"
              ? [
                { id: "env-sandbox", projectId, hostId: "host-sandbox" },
                { id: "env-gone", projectId, hostId: "host-gone" },
                { id: "env-checkout", projectId, hostId: "host-primary" },
              ]
              : []) as never,
        },
        hosts: {
          get: async ({ hostId }: { hostId: string }) => {
            const hosts = [
              { id: "host-sandbox", name: "Sandbox", status: "connected", machineProviderId: "sandboxes" },
              { id: "host-gone", name: "Gone", status: "disconnected", machineProviderId: null },
              { id: "host-primary", name: "Primary", status: "connected", machineProviderId: null },
              { id: "host-deck", name: "deckmaster", status: deckmasterOnline ? "connected" : "disconnected", machineProviderId: "manual" },
            ];
            const host = hosts.find((candidate) => candidate.id === hostId);
            if (!host) throw new Error(`Host not found: ${hostId}`);
            return host as never;
          },
          list: async () => [
            { id: "host-sandbox", name: "Sandbox", status: "connected", machineProviderId: "sandboxes" },
            { id: "host-gone", name: "Gone", status: "disconnected", machineProviderId: null },
            { id: "host-primary", name: "Primary", status: "connected", machineProviderId: null },
            { id: "host-deck", name: "deckmaster", status: deckmasterOnline ? "connected" : "disconnected", machineProviderId: "manual" },
          ] as never,
        },
        threads: {
          get: async ({ threadId }) => makeThreadResponse({
            id: threadId,
            projectId: threadId === "fixed-child" ? "proj-fixed" : "project-1",
            environmentId: threadId === "fixed-child" ? "env-fixed" : "environment-1",
            providerId: "codex",
          }),
          defaultExecutionOptions: async () => ({
            model: "gpt-6-astra",
            permissionMode: "full" as const,
            reasoningLevel: "high" as const,
            serviceTier: "default" as const,
            source: "client/turn/requested" as const,
          }),
          spawn: async () => makeThreadResponse({
            id: "fixed-child",
            projectId: "proj-fixed",
            environmentId: "env-fixed",
            visibility: "hidden",
          }),
        },
        plugins: projectPlugins(),
      },
    });
    await plugin(bb);
    const input = {
      name: "Modeler",
      slug: "modeler",
      description: "Models warehouse data",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
      instructions: "Model carefully.",
      skillIds: [],
      mcpServerIds: [],
      isDefault: false,
    } as const;
    await expect(harness.behavior.callRpc("saveProfile", {
      ...input,
      runProjectId: "proj-missing",
    })).rejects.toThrow("@modeler runs in project proj-missing, which does not exist.");
    const caller = await harness.behavior.callRpc("saveProfile", input) as {
      id: string;
      runProjectId: string | null;
    };
    expect(caller.runProjectId).toBeNull();
    const profile = await harness.behavior.callRpc("saveProfile", {
      ...input,
      id: caller.id,
      runProjectId: "proj-fixed",
    }) as { id: string };

    await harness.behavior.callAgentTool("delegate_agent_profile", {
      profileId: profile.id,
      task: "Summarize the staging models.",
      why: "The modeler runs in the dbt project.",
    }, { threadId: "parent-1", projectId: "project-1" });
    expect(harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({
      projectId: "project-1",
      environment: { type: "reuse", environmentId: "environment-1" },
      parentThreadId: "parent-1",
      providerId: "agents",
      model: agentModelId(profile.id),
    });
    await expect(harness.behavior.callRpc("threadMembers", {
      threadId: "parent-1",
    })).resolves.toEqual([
      expect.objectContaining({ profileId: profile.id, childThreadId: "fixed-child" }),
    ]);


    await harness.behavior.callRpc("saveProfile", {
      ...input,
      id: caller.id,
      runProjectId: "proj-fixed",
      runInCheckout: true,
    });
    await harness.behavior.callRpc("spawnProfile", {
      profileId: profile.id, title: "Default checkout", prompt: "Edit the live files.",
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({
      projectId: "proj-fixed",
      environment: { type: "reuse", environmentId: "env-checkout" },
    });

    await harness.behavior.callRpc("saveProfile", {
      ...input,
      id: caller.id,
      runProjectId: "proj-fixed",
      runHostId: "host-sandbox",
      runInCheckout: true,
    });
    await harness.behavior.callRpc("spawnProfile", {
      profileId: profile.id, title: "Default sandbox checkout", prompt: "Use the sandbox checkout.",
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({
      projectId: "proj-fixed",
      environment: { type: "reuse", environmentId: "env-sandbox" },
    });

    await harness.behavior.callRpc("saveProfile", {
      ...input,
      id: caller.id,
      runProjectId: "proj-fixed",
      runHostId: "host-deck",
      runInCheckout: true,
    });
    await harness.behavior.callRpc("spawnProfile", {
      profileId: profile.id, title: "Default machine", prompt: "Use the saved machine checkout.",
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({
      projectId: "proj-fixed",
      environment: {
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "existing", hostId: "host-deck" },
        inputs: {},
      },
    });

    deckmasterOnline = false;
    const onlineSpawns = harness.inspection.sdk.callsTo("threads.spawn").length;
    await expect(harness.behavior.callRpc("spawnProfile", {
      profileId: profile.id, title: "Offline default", prompt: "Do not fall back.",
    }))
      .rejects.toThrow("@modeler runs on machine deckmaster, which is offline.");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(onlineSpawns);

    deletedProjects.add("proj-fixed");
    const spawns = harness.inspection.sdk.callsTo("threads.spawn").length;
    await expect(harness.behavior.callRpc("spawnProfile", {
      profileId: profile.id, title: "Missing default", prompt: "Do not fall back.",
    }))
      .rejects.toThrow("@modeler runs in project proj-fixed, which does not exist.");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(spawns);
    await harness.lifecycle.dispose();
  });

  it("promotes the replacement default without changing historical membership", async () => {
    const plugins = projectPlugins();
    const { bb, harness } = createFakePluginHost({ pluginId: "agent-profiles", sdk: { plugins } });
    await plugin(bb);
    const base = {
      description: "", providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium" as const,
      serviceTier: "default" as const, permissionMode: "auto" as const, instructions: "", skillIds: [], mcpServerIds: [],
    };
    const first = await harness.behavior.callRpc("saveProfile", { ...base, name: "Alpha", slug: "alpha", isDefault: true }) as { id: string };
    const replacement = await harness.behavior.callRpc("saveProfile", { ...base, name: "Beta", slug: "beta", isDefault: false }) as { id: string };

    await harness.behavior.callRpc("deleteProfile", { id: first.id });
    await expect(
      harness.behavior.callRpc("deleteProfile", { id: first.id }),
    ).resolves.toEqual({ ok: true });

    expect((await harness.behavior.callRpc("listProfiles", null) as Array<{ id: string; isDefault: boolean }>))
      .toContainEqual(expect.objectContaining({ id: replacement.id, isDefault: true }));
    await harness.lifecycle.dispose();
  });
  it("migrates existing profiles without rebuilding the foreign-key parent", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: { plugins: projectPlugins(), threads: { list: async () => [] } },
    });
    const db = bb.storage.database();
    bb.storage.migrate(db, [LEGACY_SCHEMA]);
    const id = "11111111-1111-4111-8111-111111111111";
    const createdAt = "2026-09-01T00:00:00.000Z";
    const oldSnapshot = {
      id,
      name: "Existing Agent",
      slug: "existing-agent",
      description: "Existing data",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
      instructions: "Keep this revision.",
      skillIds: [],
      mcpServerIds: [],
      isDefault: false,
    };
    db.prepare(`INSERT INTO profiles (
      id, slug, name, description, provider_id, model, reasoning_level, service_tier,
      permission_mode, instructions, skill_ids, mcp_server_ids, is_default, revision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      oldSnapshot.slug,
      oldSnapshot.name,
      oldSnapshot.description,
      oldSnapshot.providerId,
      oldSnapshot.model,
      oldSnapshot.reasoningLevel,
      oldSnapshot.serviceTier,
      oldSnapshot.permissionMode,
      oldSnapshot.instructions,
      "[]",
      "[]",
      0,
      1,
      createdAt,
      createdAt,
    );
    db.prepare(
      "INSERT INTO profile_revisions(profile_id, revision, snapshot, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, 1, JSON.stringify(oldSnapshot), createdAt);

    await plugin(bb);

    const columns = new Set(
      (db.pragma("table_info(profiles)") as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    expect([...columns]).toEqual(expect.arrayContaining([
      "avatar",
      "home_host_id",
      "home_ready",
      "retired",
      "limits",
      "last_wake_at",
      "interval_minutes",
      "runtime_error",
      "model_mode",
      "level",
      "kind",
      "memory_key",
    ]));
    expect(
      db.prepare(
        `SELECT name, avatar, home_host_id AS homeHostId, home_ready AS homeReady,
          retired, limits, last_wake_at AS lastWakeAt,
          interval_minutes AS intervalMinutes, runtime_error AS runtimeError,
          model_mode AS modelMode, level, kind
         FROM profiles WHERE id = ?`,
      ).get(id),
    ).toEqual({
      name: "Existing Agent",
      avatar: "🤖",
      homeHostId: null,
      homeReady: 0,
      retired: 0,
      limits: null,
      lastWakeAt: null,
      intervalMinutes: null,
      runtimeError: null,
      modelMode: "level",
      level: "high",
      kind: "full",
    });
    const migrated = (await harness.behavior.callRpc("listProfiles", null) as Profile[])
      .find((profile) => profile.id === id)!;
    expect(migrated.memoryKey).toBe("agent-existing-agent");
    const renamed = await harness.behavior.callRpc("saveProfile", {
      ...snapshot(migrated), slug: "renamed-agent", name: "Renamed Agent",
    }) as Profile;
    expect(renamed).toMatchObject({ id, slug: "renamed-agent", memoryKey: migrated.memoryKey });
    expect(agentModelId(renamed.id)).toBe(agentModelId(migrated.id));
    const { id: _oldId, ...freshInput } = snapshot(renamed);
    const fresh = await harness.behavior.callRpc("saveProfile", {
      ...freshInput, slug: "fresh-agent", name: "Fresh Agent",
    }) as Profile;
    expect(fresh.memoryKey).toBe(`agent-${fresh.id}`);
    expect(fresh.memoryKey).not.toBe(renamed.memoryKey);
    const migratedRevision = db.prepare(
      "SELECT snapshot FROM profile_revisions WHERE profile_id = ? AND revision = 1",
    ).get(id) as { snapshot: string };
    expect(JSON.parse(migratedRevision.snapshot)).toEqual({
      ...oldSnapshot,
      modelMode: "level",
      level: "high",
      kind: "full",
    });
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_revisions'",
      ).get(),
    ).toEqual({ name: "document_revisions" });
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'revisions_by_scope'",
      ).get(),
    ).toEqual({ name: "revisions_by_scope" });
    const channelTables = new Set(
      (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all() as Array<{ name: string }>).map(({ name }) => name),
    );
    expect([...channelTables]).toEqual(expect.arrayContaining([
      "conversations",
      "jobs",
      "rooms",
      "room_messages",
      "room_runs",
      "reactions",
      "attachments",
      "draft_uploads",
      "channel_context",
      "channel_notifications",
      "routing_usage",
      "delegations",
      "thread_members",
    ]));
    expect(
      db.pragma("table_info(routing_usage)"),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "purpose",
        notnull: 1,
        dflt_value: "'route'",
      }),
    ]));
    const foreignKeys = [
      "conversations",
      "jobs",
      "rooms",
      "room_messages",
      "room_runs",
      "reactions",
      "attachments",
      "draft_uploads",
      "channel_context",
      "channel_notifications",
      "routing_usage",
      "delegations",
    ].flatMap((table) => db.pragma(`foreign_key_list(${table})`) as unknown[]);
    expect(foreignKeys).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    await harness.lifecycle.dispose();
  });
  it("backfills the existing text-edit agent as thin without changing its pinned model", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: { plugins: projectPlugins(), threads: { list: async () => [] } },
    });
    const db = bb.storage.database();
    bb.storage.migrate(db, [LEGACY_SCHEMA]);
    const id = "22222222-2222-4222-8222-222222222222";
    const snapshot = {
      name: "Text Edit Agent",
      slug: "text-edit-agent",
      description: "Makes exact copy edits",
      providerId: "acp-omp",
      model: "wafer-serverless/DeepSeek-V4-Flash-0731-Fast",
      reasoningLevel: "low",
      serviceTier: "default",
      permissionMode: "full",
      instructions: "Edit text.",
      skillIds: [],
      mcpServerIds: [],
      isDefault: false,
    };
    const timestamp = "2026-09-01T00:00:00.000Z";
    db.prepare(`INSERT INTO profiles
      (id, slug, name, description, provider_id, model, reasoning_level, service_tier,
       permission_mode, instructions, skill_ids, mcp_server_ids, is_default, revision,
       created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, snapshot.slug, snapshot.name, snapshot.description,
        snapshot.providerId, snapshot.model, snapshot.reasoningLevel,
        snapshot.serviceTier, snapshot.permissionMode, snapshot.instructions,
        "[]", "[]", 0, 1, timestamp, timestamp);
    db.prepare(
      "INSERT INTO profile_revisions(profile_id, revision, snapshot, created_at) VALUES (?, 1, ?, ?)",
    ).run(id, JSON.stringify(snapshot), timestamp);
    await plugin(bb);
    const profiles = await harness.behavior.callRpc("listProfiles", null) as Array<{
      id: string; kind: string; modelMode: string; providerId: string; model: string;
    }>;
    expect(profiles.find((profile) => profile.id === id)).toMatchObject({
      kind: "thin",
      modelMode: "pinned",
      providerId: "acp-omp",
      model: "wafer-serverless/DeepSeek-V4-Flash-0731-Fast",
    });
    const history = await harness.behavior.callRpc("profileHistory", { id }) as Array<{
      snapshot: { kind: string };
    }>;
    expect(history[0]?.snapshot.kind).toBe("thin");
    await harness.lifecycle.dispose();
  });

  it("backfills every existing model tier and pins unknown models", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: { plugins: projectPlugins(), threads: { list: async () => [] } },
    });
    const db = bb.storage.database();
    bb.storage.migrate(db, [LEGACY_SCHEMA]);
    const cases = [
      ["astra", "gpt-6-astra", "low", "level", "xhigh"],
      ["fable", "claude-fable-5-1", "medium", "level", "xhigh"],
      ["sol-high", "gpt-6-sol", "high", "level", "high"],
      ["sol-medium", "gpt-6-sol", "medium", "level", "medium"],
      ["opus-high", "claude-opus-5-5", "xhigh", "level", "high"],
      ["opus-medium", "claude-opus-5-5", "low", "level", "medium"],
      ["terra", "gpt-5.6-terra", "high", "level", "low"],
      ["sonnet", "claude-sonnet-5", "low", "level", "low"],
      ["luna", "gpt-6-luna", "medium", "level", "xlow"],
      ["haiku", "claude-haiku-4-5", "low", "level", "xlow"],
      ["unknown", "wafer-serverless/DeepSeek-V4", "low", "pinned", "medium"],
    ] as const;
    const insert = db.prepare(`INSERT INTO profiles (
      id, slug, name, description, provider_id, model, reasoning_level,
      service_tier, permission_mode, instructions, skill_ids, mcp_server_ids,
      is_default, revision, created_at, updated_at
    ) VALUES (?, ?, ?, '', 'acp-omp', ?, ?, 'default', 'auto', '', '[]', '[]', 0, 1, ?, ?)`);
    const createdAt = "2026-09-01T00:00:00.000Z";
    cases.forEach(([slug, model, reasoningLevel], index) => {
      insert.run(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, slug, slug, model, reasoningLevel, createdAt, createdAt);
    });

    await plugin(bb);

    const rows = db.prepare(
      "SELECT slug, model_mode AS modelMode, level, run_project_id AS runProjectId FROM profiles WHERE id LIKE '00000000-0000-4000-8000-%' ORDER BY rowid",
    ).all();
    expect(rows).toEqual(cases.map(([slug, _model, _reasoning, modelMode, level]) => ({
      slug,
      modelMode,
      level,
      runProjectId: null,
    })));
    await harness.lifecycle.dispose();
  });

  it("creates an agent home lazily and never rewrites initialized files", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins: projectPlugins(),
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
      },
    });
    await plugin(bb);
    const profile = await saveHomeAgent(harness);
    const root = join(dirname(bb.storage.database().name), "homes");
    await expect(readdir(root)).rejects.toThrow();

    const first = await harness.behavior.callRpc("agentDocument", {
      id: profile.id,
      file: "MISSION.md",
    }) as { text: string; version: string };
    expect(first).toEqual({
      text: `# Mission\n\n${profile.description}\n`,
      version: sha256(`# Mission\n\n${profile.description}\n`),
    });
    const home = join(root, profile.id);
    expect((await readdir(home)).sort()).toEqual([
      "AGENTS.md",
      "MISSION.md",
      "files",
    ]);
    await writeFile(join(home, "AGENTS.md"), "Owner customization\n");

    await expect(harness.behavior.callRpc("agentDocument", {
      id: profile.id,
      file: "MISSION.md",
    })).resolves.toEqual(first);
    expect(await readFile(join(home, "AGENTS.md"), "utf8"))
      .toBe("Owner customization\n");
    await expect(harness.behavior.callRpc("agentDetail", { id: profile.id }))
      .resolves.toMatchObject({
        profile: { id: profile.id, homeReady: true },
        home: { path: home, hostId: "host-primary", ready: true },
      });
    await harness.lifecycle.dispose();
  });

  it("uses sha256 compare-and-swap and records document revisions", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins: projectPlugins(),
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
      },
    });
    await plugin(bb);
    const profile = await saveHomeAgent(harness);
    await harness.behavior.callRpc("agentDocument", {
      id: profile.id,
      file: "MISSION.md",
    });
    const initialPersona = "Work from your home documents.";
    await expect(harness.behavior.callRpc("agentDocument", {
      id: profile.id,
      file: "PERSONA.md",
    })).resolves.toEqual({ text: initialPersona, version: sha256(initialPersona) });
    const saved = await harness.behavior.callRpc("saveAgentDocument", {
      id: profile.id,
      file: "PERSONA.md",
      text: "Check facts twice.\n",
      version: sha256(initialPersona),
    }) as { text: string; version: string };
    expect(saved).toEqual({
      text: "Check facts twice.",
      version: sha256("Check facts twice."),
    });
    await expect(harness.behavior.callRpc("saveAgentDocument", {
      id: profile.id,
      file: "PERSONA.md",
      text: "A stale edit.\n",
      version: sha256(initialPersona),
    })).rejects.toThrow(
      "This document changed. Reload it before saving your edits.",
    );
    const history = await harness.behavior.callRpc("documentHistory", {
      id: profile.id,
      file: "PERSONA.md",
    }) as Array<{ text: string; actor: string }>;
    expect(history).toEqual([
      expect.objectContaining({ text: "Check facts twice.", actor: "You" }),
      expect.objectContaining({ text: initialPersona, actor: "Profile settings" }),
    ]);
    const detail = await harness.behavior.callRpc("agentDetail", {
      id: profile.id,
    }) as { profile: { instructions: string; revision: number }; home: { path: string } };
    expect(detail.profile).toMatchObject({ instructions: "Check facts twice.", revision: 2 });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "profiles-changed",
      payload: { reason: "saved", profileId: profile.id },
    });
    await expect(readdir(detail.home.path)).resolves.not.toContain("PERSONA.md");
    await harness.lifecycle.dispose();
  });

  it("bounds default instructions when the mission is 100 KB", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins: projectPlugins(),
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
      },
    });
    await plugin(bb);
    const profile = await saveHomeAgent(harness, true);
    await harness.behavior.callRpc("agentDocument", {
      id: profile.id,
      file: "MISSION.md",
    });
    const detail = await harness.behavior.callRpc("agentDetail", {
      id: profile.id,
    }) as { home: { path: string } };
    const line = "Durable mission line\n";
    const largeMission = line.repeat(Math.ceil(100_000 / line.length))
      .slice(0, 100_000);
    await writeFile(join(detail.home.path, "MISSION.md"), largeMission);

    const configured = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "default-thread", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: { id: "environment-1", name: "main", path: "/work", workspaceProvisionType: "unmanaged", branchName: "main" },
      host: { id: "host-primary", name: "Local" },
      provider: { id: "codex", model: "gpt-5.6-sol" },
      origin: { kind: null, pluginId: null },
    });
    const instructions = configured.instructions ?? "";
    expect(instructions.length).toBeLessThanOrEqual(4_096);
    expect(instructions).toContain(
      "uses @home-agent as BB's default agent profile",
    );
    expect(instructions).toContain("Durable mission line");
    expect(instructions).toContain(
      "… (truncated, use agent_document_read)",
    );
    expect(configured.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "agent_document_read",
        "agent_persona_update",
      ]),
    );

    await writeFile(join(detail.home.path, "MISSION.md"), line.repeat(10_000));
    const fallback = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "default-thread", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: { id: "environment-1", name: "main", path: "/work", workspaceProvisionType: "unmanaged", branchName: "main" },
      host: { id: "host-primary", name: "Local" },
      provider: { id: "codex", model: "gpt-5.6-sol" },
      origin: { kind: null, pluginId: null },
    });
    expect(fallback.instructions).toContain(
      `# Mission\n\n${profile.description}`,
    );
    await harness.lifecycle.dispose();
  });

  it("puts persona and mission in the spawn preamble", async () => {
    const plugins = projectPlugins();
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins,
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
        threads: {
          spawn: async () =>
            makeThreadResponse({
              id: "document-child",
              projectId: "project-1",
              environmentId: "environment-1",
            }),
        },
      },
    });
    await plugin(bb);
    const profile = await harness.behavior.callRpc("saveProfile", {
      name: "Documented Agent",
      slug: "documented-agent",
      description: "Works from persistent documents",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
      instructions: "PERSONA: verify every claim.",
      skillIds: [],
      mcpServerIds: [],
      isDefault: false,
    }) as { id: string; revision: number };
    const mission = await harness.behavior.callRpc("agentDocument", {
      id: profile.id,
      file: "MISSION.md",
    }) as { version: string };
    await harness.behavior.callRpc("saveAgentDocument", {
      id: profile.id,
      file: "MISSION.md",
      text: "MISSION: ship the bounded change.",
      version: mission.version,
    });

    await harness.behavior.callRpc("spawnProfile", {
      profileId: profile.id,
      projectId: "project-1",
      environment: { type: "project-default" },
      title: "Use persistent context",
      prompt: "Implement the task.",
    });
    const spawn = harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0] as {
      input: Array<{ text?: string; visibility?: string }>;
    };
    const preamble = spawn.input[0]!;
    expect(preamble.visibility).toBe("agent-only");
    expect(preamble.text).toContain("PERSONA: verify every claim.");
    expect(preamble.text).toContain("MISSION: ship the bounded change.");
    expect(preamble.text).not.toContain("## Memory");
    expect(preamble.text).toContain(`revision ${profile.revision}`);
    expect(preamble.text!.length).toBeLessThanOrEqual(100_000);
    await harness.lifecycle.dispose();
  });

  it("delegates @mentions from new and existing threads without binding a direct chat", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins: projectPlugins(),
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
      },
    });
    await plugin(bb);
    const profile = await harness.behavior.callRpc("saveProfile", {
      name: "Deck Agent",
      slug: "deck-agent",
      description: "Builds decks",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
      instructions: "PERSONA: keep copy verbatim.",
      skillIds: [],
      mcpServerIds: [],
      isDefault: false,
    }) as { id: string };
    const provider = harness.inspection.registrations.mentionProviders
      .find(({ id }) => id === "agent-profile")!;

    const [fromNew] = await provider.search({ trigger: "@", query: "deck", projectId: null, threadId: null });
    expect(fromNew).toMatchObject({ id: profile.id, title: "@deck-agent" });
    const [fromParent] = await provider.search({ trigger: "@", query: "deck", projectId: null, threadId: "parent-1" });
    expect(fromParent?.id).toBe(profile.id);
    expect((await provider.resolve(profile.id)).context).toContain("delegate_agent_profile");

    const hook = harness.inspection.registrations.hooks["message.dispatch"]!;
    const blocks = [{
      type: "text" as const,
      text: "@deck-agent tighten page 3",
      mentions: [{
        start: 0,
        end: 11,
        resource: { kind: "plugin" as const, pluginId: "agent-profiles", itemId: `agent-profile:${profile.id}`, label: "@deck-agent", icon: null },
      }],
    }];
    expect(await hook(makeMessageDispatchHookContext({
      thread: { id: "child-thread", parentThreadId: "parent-1" },
      attempt: "start-turn",
      input: { blocks },
    }))).toEqual({ action: "proceed" });
    expect(await hook(makeMessageDispatchHookContext({
      thread: { id: "new-parent", parentThreadId: null },
      attempt: "start-turn",
      input: { blocks },
    }))).toEqual({ action: "proceed" });
    expect(await harness.behavior.callRpc("catalogContextForThread", { threadId: "new-parent" }))
      .toMatchObject({ bound: false });
    expect(await harness.behavior.callRpc("catalogContextForThread", { threadId: "child-thread" }))
      .toMatchObject({ bound: false });
    await harness.lifecycle.dispose();
  });

  it("lets a delegated agent update its persona with CAS", async () => {
    const plugins = projectPlugins();
    const { bb, harness } = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins,
        system: {
          config: async () => ({ primaryHostId: "host-primary" }) as never,
        },
        threads: {
          defaultExecutionOptions: async () => ({
            model: "gpt-5.6-sol",
            permissionMode: "auto" as const,
            reasoningLevel: "high" as const,
            serviceTier: "default" as const,
            source: "client/turn/requested" as const,
          }),
          spawn: async () =>
            makeThreadResponse({
              id: "delegated-memory-child",
              projectId: "project-1",
              environmentId: "environment-1",
            }),
        },
      },
    });
    await plugin(bb);
    const profile = await harness.behavior.callRpc("saveProfile", {
      name: "Memory Agent",
      slug: "memory-agent",
      description: "Maintains durable memory",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
      instructions: "Keep memory precise.",
      skillIds: [],
      mcpServerIds: [],
      isDefault: false,
    }) as { id: string };
    await harness.behavior.callRpc("spawnProfile", {
      profileId: profile.id,
      projectId: "project-1",
      parentThreadId: "parent-thread",
      environment: { type: "project-default" },
      title: "Remember a decision",
      prompt: "Record the durable decision.",
    });
    const configured = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "delegated-memory-child", title: null, parentThreadId: "parent-thread", sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
      environment: { id: "environment-1", name: "main", path: "/work", workspaceProvisionType: "unmanaged", branchName: "main" },
      host: { id: "host-primary", name: "Local" },
      provider: { id: "agents", model: agentModelId(profile.id) },
      origin: { kind: null, pluginId: "agent-profiles" },
    });
    expect(configured.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "delegate_agent_profile",
        "agent_document_read",
        "agent_persona_update",
      ]),
    );


    const current = JSON.parse(await harness.behavior.callAgentTool(
      "agent_document_read",
      { file: "PERSONA.md" },
      { threadId: "delegated-memory-child", projectId: "project-1" },
    ) as string) as { file: string; text: string; version: string };
    expect(current).toMatchObject({ file: "PERSONA.md", text: "Keep memory precise." });
    const updated = JSON.parse(await harness.behavior.callAgentTool(
      "agent_persona_update",
      { text: "Keep memory precise. Confirm migrations stay append-only.\n", version: current.version },
      { threadId: "delegated-memory-child", projectId: "project-1" },
    ) as string) as { version: string; note: string };
    expect(updated.version).toBe(sha256("Keep memory precise. Confirm migrations stay append-only."));
    expect(updated.note).toContain("Tell them what you changed");
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "agent-document-changed",
      payload: { agentId: profile.id, file: "PERSONA.md" },
    });
    await expect(harness.behavior.callAgentTool(
      "agent_persona_update",
      { text: "Stale replacement.\n", version: current.version },
      { threadId: "delegated-memory-child", projectId: "project-1" },
    )).rejects.toThrow(
      "This document changed. Reload it before saving your edits.",
    );
    const history = await harness.behavior.callRpc("documentHistory", {
      id: profile.id,
      file: "PERSONA.md",
    }) as Array<{ text: string; actor: string }>;
    expect(history.slice(0, 2)).toEqual([
      expect.objectContaining({
        text: "Keep memory precise. Confirm migrations stay append-only.",
        actor: "@memory-agent",
      }),
      expect.objectContaining({ text: "Keep memory precise.", actor: "Profile settings" }),
    ]);
    const detail = await harness.behavior.callRpc("agentDetail", {
      id: profile.id,
    }) as { profile: { instructions: string } };
    expect(detail.profile.instructions).toBe("Keep memory precise. Confirm migrations stay append-only.");
    await harness.lifecycle.dispose();
  });

  it("round trips version three exports without overwriting an existing mission", async () => {
    const source = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins: projectPlugins(),
        system: {
          config: async () => ({ primaryHostId: "host-source" }) as never,
        },
      },
    });
    await plugin(source.bb);
    const profile = await source.harness.behavior.callRpc("saveProfile", {
      name: "Exporter",
      slug: "exporter",
      description: "Exports a mission",
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
      instructions: "Preserve this profile.",
      skillIds: [],
      mcpServerIds: [],
      isDefault: false,
    }) as { id: string };
    const mission = await source.harness.behavior.callRpc("agentDocument", {
      id: profile.id,
      file: "MISSION.md",
    }) as { version: string };
    await source.harness.behavior.callRpc("saveAgentDocument", {
      id: profile.id,
      file: "MISSION.md",
      text: "# Mission\n\nShip reliable exports.\n",
      version: mission.version,
    });
    const exported = await source.harness.behavior.callRpc(
      "exportProfiles",
      null,
    ) as {
      schemaVersion: 4;
      profiles: Array<{ slug: string; kind: string; mission?: string }>;
    };
    expect(exported.schemaVersion).toBe(4);
    expect(exported.profiles.find(({ slug }) => slug === "exporter")?.mission)
      .toBe("# Mission\n\nShip reliable exports.\n");
    expect(exported.profiles.find(({ slug }) => slug === "exporter")?.kind)
      .toBe("full");

    const target = createFakePluginHost({
      pluginId: "agent-profiles",
      sdk: {
        plugins: projectPlugins(),
        system: {
          config: async () => ({ primaryHostId: "host-target" }) as never,
        },
      },
    });
    await plugin(target.bb);
    await target.harness.behavior.callRpc("importProfiles", exported);
    const imported = (
      await target.harness.behavior.callRpc("listProfiles", null) as Array<{
        id: string;
        slug: string;
      }>
    ).find(({ slug }) => slug === "exporter")!;
    const importedMission = await target.harness.behavior.callRpc(
      "agentDocument",
      { id: imported.id, file: "MISSION.md" },
    ) as { text: string; version: string };
    expect(importedMission.text).toBe("# Mission\n\nShip reliable exports.\n");

    await target.harness.behavior.callRpc("saveAgentDocument", {
      id: imported.id,
      file: "MISSION.md",
      text: "# Mission\n\nKeep the local owner edit.\n",
      version: importedMission.version,
    });
    await target.harness.behavior.callRpc("importProfiles", exported);
    await expect(target.harness.behavior.callRpc("agentDocument", {
      id: imported.id,
      file: "MISSION.md",
    })).resolves.toMatchObject({
      text: "# Mission\n\nKeep the local owner edit.\n",
    });
    await Promise.all([
      source.harness.lifecycle.dispose(),
      target.harness.lifecycle.dispose(),
    ]);
  });
});

describe("agents CLI", () => {
  it("reads a document by unique agent name", async () => {
    const { harness } = await createCliHarness();
    await saveHomeAgent(harness);

    const result = await harness.behavior.runCli([
      "persona",
      "Home Agent",
    ]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "Work from your home documents.",
      stderr: "",
    });
    await harness.lifecycle.dispose();
  });

  it("writes by UUID and rejects a stale document version", async () => {
    const { harness } = await createCliHarness();
    const profile = await saveHomeAgent(harness);
    const read = await harness.behavior.runCli([
      "persona",
      profile.id,
      "--json",
    ]);
    const current = JSON.parse(read.stdout) as { version: string };

    const saved = await harness.behavior.runCli([
      "persona",
      profile.id,
      "--text",
      "Current persona.\n",
      "--version",
      current.version,
      "--json",
    ]);
    expect(saved.exitCode).toBe(0);
    expect(JSON.parse(saved.stdout)).toEqual({
      text: "Current persona.",
      version: sha256("Current persona."),
    });

    const stale = await harness.behavior.runCli([
      "persona",
      profile.id,
      "--text",
      "Stale persona.\n",
      "--version",
      current.version,
      "--json",
    ]);
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr).toContain(
      "This document changed. Reload it before saving your edits.",
    );
    expect(JSON.parse(stale.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "operation_failed",
        message: "This document changed. Reload it before saving your edits.",
      },
    });

    const history = await harness.behavior.runCli([
      "history",
      profile.id,
      "PERSONA.md",
      "--json",
    ]);
    expect(JSON.parse(history.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Current persona.",
          actor: "You",
        }),
      ]),
    );
    await harness.lifecycle.dispose();
  });

  it("returns structured show output for an @slug selector", async () => {
    const { harness } = await createCliHarness();

    const result = await harness.behavior.runCli([
      "show",
      "@pinpoint-fix",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      profile: {
        slug: "pinpoint-fix",
        name: "Pinpoint Fixes",
        runProjectId: null,
        runHostId: null,
        modelMode: "level",
        level: "medium",
      },
      home: {
        hostId: null,
        ready: false,
      },
    });
    await harness.lifecycle.dispose();
  });


  it("pins checkout runs to a resolved machine and shows that machine", async () => {
    const { harness } = await createCliHarness();
    const set = await harness.behavior.runCli([
      "runs-in",
      "@pinpoint-fix",
      "proj-fixed",
      "--checkout",
      "--machine",
      "deckmaster",
    ]);
    expect(set).toMatchObject({ exitCode: 0, stderr: "" });
    expect(set.stdout).toContain(
      "Fixed Project (proj-fixed), project checkout on machine deckmaster (host-deck)",
    );

    const shown = await harness.behavior.runCli([
      "show",
      "@pinpoint-fix",
      "--json",
    ]);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      profile: {
        runProjectId: "proj-fixed",
        runHostId: "host-deck",
        runInCheckout: true,
      },
    });

    const invalid = await harness.behavior.runCli([
      "runs-in",
      "@pinpoint-fix",
      "proj-fixed",
      "--machine",
      "deckmaster",
    ]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("--machine requires a fixed project and --checkout");
    await harness.lifecycle.dispose();
  });
  it("asks an agent in a hidden thread and toggles its sidebar entry", async () => {
    const { harness } = await createCliHarness();
    await harness.behavior.runCli(["runs-in", "@pinpoint-fix", "proj-fixed"]);
    const asked = await harness.behavior.runCli([
      "ask",
      "@pinpoint-fix",
      "--text",
      "Fix the title",
      "--json",
    ]);
    expect(asked).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(asked.stdout)).toMatchObject({ threadId: "cli-child" });
    expect(harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toEqual(expect.objectContaining({
      projectId: "proj-fixed",
      title: "@pinpoint-fix · Fix the title",
      visibility: "hidden",
    }));

    const hidden = await harness.behavior.runCli(["sidebar", "@pinpoint-fix", "off", "--json"]);
    expect(JSON.parse(hidden.stdout)).toMatchObject({ showInSidebar: false });
    const shown = await harness.behavior.runCli(["sidebar", "@pinpoint-fix", "on", "--json"]);
    expect(JSON.parse(shown.stdout)).toMatchObject({ showInSidebar: true });
    const invalid = await harness.behavior.runCli(["sidebar", "@pinpoint-fix", "maybe"]);
    expect(invalid.exitCode).not.toBe(0);
    await harness.lifecycle.dispose();
  });
  it("sets model levels and exact pins", async () => {
    const { harness } = await createCliHarness();
    const leveled = await harness.behavior.runCli([
      "level",
      "@pinpoint-fix",
      "xhigh",
      "--json",
    ]);
    expect(leveled.exitCode).toBe(0);
    expect(JSON.parse(leveled.stdout)).toMatchObject({
      slug: "pinpoint-fix",
      modelMode: "level",
      level: "xhigh",
    });

    const pinned = await harness.behavior.runCli([
      "pin",
      "@pinpoint-fix",
      "--provider",
      "claude-code",
      "--model",
      "claude-opus-5-5[1m]",
      "--reasoning",
      "high",
      "--json",
    ]);
    expect(pinned.exitCode).toBe(0);
    expect(JSON.parse(pinned.stdout)).toMatchObject({
      slug: "pinpoint-fix",
      modelMode: "pinned",
      level: "xhigh",
      providerId: "claude-code",
      model: "claude-opus-5-5[1m]",
      reasoningLevel: "high",
    });
    await harness.lifecycle.dispose();
  });

  it("lists, promotes, and removes normal-thread members", async () => {
    const { harness } = await createCliHarness();
    const profile = (
      await harness.behavior.callRpc("listProfiles", null) as Array<{
        id: string;
        slug: string;
      }>
    ).find(({ slug }) => slug === "pinpoint-fix")!;
    await harness.behavior.callAgentTool("delegate_agent_profile", {
      profileId: profile.id,
      task: "Review this focused change.",
      why: "The profile owns visual review work.",
      mode: "fresh",
    }, { threadId: "cli-parent", projectId: "project-1" });

    const members = await harness.behavior.runCli([
      "thread",
      "members",
      "cli-parent",
      "--json",
    ]);
    expect(members.exitCode).toBe(0);
    expect(JSON.parse(members.stdout)).toEqual([
      expect.objectContaining({
        profileId: profile.id,
        slug: profile.slug,
        childThreadId: "cli-child",
        visibility: "hidden",
      }),
    ]);

    const promoted = await harness.behavior.runCli([
      "thread",
      "promote",
      "cli-child",
      "--json",
    ]);
    expect(promoted.exitCode).toBe(0);
    expect(JSON.parse(promoted.stdout)).toEqual({
      childThreadId: "cli-child",
      parentThreadId: "cli-parent",
      promoted: true,
    });
    expect(harness.inspection.sdk.callsTo("threads.update").at(-1)?.[0])
      .toEqual({ threadId: "cli-child", visibility: "visible" });

    const removed = await harness.behavior.runCli([
      "thread",
      "remove",
      "cli-parent",
      `@${profile.slug}`,
      "--json",
    ]);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({
      threadId: "cli-parent",
      profileId: profile.id,
      removed: true,
    });
    expect(harness.inspection.sdk.callsTo("threads.stop").at(-1)?.[0])
      .toEqual({ threadId: "cli-child" });

    const empty = await harness.behavior.runCli([
      "thread",
      "members",
      "cli-parent",
      "--json",
    ]);
    expect(JSON.parse(empty.stdout)).toEqual([]);
    await harness.lifecycle.dispose();
  });
});
