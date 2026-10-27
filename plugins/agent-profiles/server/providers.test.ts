import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { Profile } from "./contract";
import { snapshot } from "./profiles";
import { AGENTS_PROVIDER_ID, agentModelId } from "./provider-ids";
import plugin from "../server";
import manifest from "../package.json";

const profileInput = {
  name: "Deckmaster",
  slug: "deckmaster",
  kind: "thin",
  avatar: "🪄",
  description: "Builds decks",
  modelMode: "pinned",
  level: "high",
  providerId: "openai-codex",
  model: "openai-codex/gpt-6.1-sol",
  reasoningLevel: "high",
  serviceTier: "default",
  permissionMode: "full",
  instructions: "Work on the requested deck.",
  skillIds: [],
  mcpServerIds: [],
  isDefault: false,
};

async function setup(parentPermissionMode: Profile["permissionMode"] = "full") {
  const available = new Set<string>();
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
    experimental_declaredIconNames: Object.keys(manifest.bb.branding.experimental_icons),
    sdk: {
      plugins: {
        callRpc: async ({ method, input }) => {
          if (method === "setGlobalAgent" && input && typeof input === "object" &&
            !Array.isArray(input) && typeof input.targetId === "string")
            available.add(input.targetId);
          if (method === "projectContext") return {
            projectId: "project-1", credentialId: null, groupId: null,
            agentIds: [...available], bundleIds: [],
          };
          if (method === "agentAssignments") return { global: true, projectIds: [] };
          return { ok: true };
        },
      },
      system: { config: async () => ({ primaryHostId: "host-1" }) as never },
      providers: {
        models: async () => ({ models: [
          "anthropic/claude-opus-5-5",
          "openai-codex/gpt-6-astra",
          "openai-codex/gpt-6.1-sol",
          "openai-codex/gpt-5.6-terra",
          "openai-codex/gpt-6-luna",
        ].map((model, index) => ({
          id: model, model, displayName: model, description: "",
          supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
          defaultReasoningEffort: "medium", isDefault: index === 0,
        })) }) as never,
      },
      threads: {
        list: async () => [] as never,
        get: async ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "project-1",
          providerId: threadId === "plain" ? "hempi" : ["dm", "task"].includes(threadId) ? "agents" : "claude-code",
          environmentId: "environment-1",
        }),
        defaultExecutionOptions: async () => ({
          model: "claude-opus-5-5", permissionMode: parentPermissionMode,
          reasoningLevel: "high", serviceTier: "default", source: "client/turn/requested",
        }) as never,
        spawn: async ({ providerId }) => makeThreadResponse({
          id: "child", projectId: "project-1", providerId,
          environmentId: "environment-1",
        }),
      },
    },
  });
  await plugin(host.bb);
  return host;
}

const commandContext = {
  threadId: "plain", projectId: "project-1", model: "openai-codex/gpt-6-sol",
  permissionMode: "full" as const, settings: {},
};

describe("Agents providers", () => {
  it("registers only Hempi and Agents; refreshes the catalog on profile identity changes", async () => {
    const { harness } = await setup();
    try {
      const registrations = () => harness.registrations.providerRegistrations;
      expect(registrations().map(({ id }) => id)).toEqual(["hempi", AGENTS_PROVIDER_ID]);
      const profile = await harness.behavior.callRpc("saveProfile", profileInput) as Profile;
      expect(registrations().map(({ id }) => id)).toEqual(["hempi", AGENTS_PROVIDER_ID]);
      const first = registrations().find(({ id }) => id === AGENTS_PROVIDER_ID)!;
      expect(first.models?.fallback).toContainEqual(expect.objectContaining({ id: agentModelId(profile.id), displayName: "Deckmaster" }));
      const renamed = await harness.behavior.callRpc("saveProfile", {
        ...snapshot(profile), name: "Deck Builder", expectedRevision: profile.revision,
      }) as Profile;
      expect(registrations().find(({ id }) => id === AGENTS_PROVIDER_ID)!.models?.fallback)
        .toContainEqual(expect.objectContaining({ id: agentModelId(profile.id), displayName: renamed.name }));
      expect(registrations().map(({ id }) => id)).toEqual(["hempi", AGENTS_PROVIDER_ID]);
      await harness.behavior.callRpc("deleteProfile", { id: renamed.id });
      const remaining = registrations().find(({ id }) => id === AGENTS_PROVIDER_ID)!.models?.fallback ?? [];
      expect(remaining.some(({ id }) => id === agentModelId(renamed.id))).toBe(false);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("binds only the agent's DM to its memory, by stable identity even after rename", async () => {
    const host = await setup();
    try {
      const profile = await host.harness.behavior.callRpc("saveProfile", { ...profileInput, kind: "full" }) as Profile;
      const db = host.bb.storage.database();
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO thread_bindings (thread_id, profile_id, revision, parent_thread_id, environment_id, created_at)
        VALUES (?, ?, ?, NULL, NULL, ?)`).run("task", profile.id, profile.revision, now);
      db.prepare(`INSERT INTO thread_bindings (thread_id, profile_id, revision, parent_thread_id, environment_id, created_at)
        VALUES (?, ?, ?, NULL, NULL, ?)`).run("dm", profile.id, profile.revision, now);
      db.prepare(`INSERT INTO agent_dms (profile_id, thread_id, creation_token, state, created_at, updated_at)
        VALUES (?, 'dm', 'token', 'ready', ?, ?)`).run(profile.id, now, now);
      const registration = host.harness.registrations.providerRegistrations.find(({ id }) => id === AGENTS_PROVIDER_ID)!;
      const dm = { ...commandContext, threadId: "dm", model: agentModelId(profile.id) };
      const task = { ...dm, threadId: "task" };
      expect(registration.deriveProviderOptions!(dm)).toMatchObject({ agentId: profile.id, memoryKey: profile.memoryKey });
      // Runs outside the DM never take the memory lock, so many can run at once.
      expect(registration.deriveProviderOptions!(task)).toMatchObject({ agentId: profile.id });
      expect(registration.deriveProviderOptions!(task).memoryKey).toBeUndefined();
      expect(() => registration.deriveProviderOptions!({ ...dm, model: "openai-codex/gpt-6-sol" })).toThrow();
      const renamed = await host.harness.behavior.callRpc("saveProfile", {
        ...snapshot(profile), slug: "new-deck", expectedRevision: profile.revision,
      }) as Profile;
      expect(registration.deriveProviderOptions!(dm)).toMatchObject({ agent: renamed.slug, memoryKey: profile.memoryKey });
      expect(await host.harness.behavior.resolveProviderEnv(AGENTS_PROVIDER_ID, { threadId: "task", hostId: "host-1" } as never))
        .toEqual([]);
      db.prepare(`INSERT INTO agent_inbox (profile_id, source, thread_id, place, request, reply, created_at)
        VALUES (?, 'task', 'task', 'Fix slide two', 'Fix slide two.', 'Fixed it.', 0)`).run(profile.id);
      const env = await host.harness.behavior.resolveProviderEnv(AGENTS_PROVIDER_ID, { threadId: "dm", hostId: "host-1" } as never);
      expect(env).toContainEqual(expect.objectContaining({ name: "AGENT_MEMORY_PROFILE", value: profile.memoryKey }));
      expect(env).toContainEqual(expect.objectContaining({ name: "AGENT_INBOX", value: expect.stringContaining("Fixed it.") }));
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it("keeps plain Hempi's long-memory toggle independent", async () => {
    let { harness } = await setup();
    try {
      const options = () => harness.registrations.providerRegistrations.find(({ id }) => id === "hempi")!.deriveProviderOptions!(commandContext);
      expect(options().longMemory).toBe(false);
      await harness.behavior.callRpc("setLongMemory", { threadId: "plain", enabled: true });
      ({ harness } = await harness.lifecycle.reload(plugin));
      expect(options().longMemory).toBe(true);
      await harness.behavior.callRpc("setLongMemory", { threadId: "plain", enabled: false });
      expect(options().longMemory).toBe(false);
    } finally { await harness.lifecycle.dispose(); }
  });

  it("uses stable agent model IDs for tasks and refuses unsupported saved pins", async () => {
    const { harness } = await setup();
    try {
      const valid = await harness.behavior.callRpc("saveProfile", profileInput) as Profile;
      await harness.behavior.callAgentTool("delegate_agent_profile", {
        profileId: valid.id, task: "Fix slide two.", why: "Deck work", mode: "fresh",
      }, { threadId: "parent", projectId: "project-1" });
      expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
        providerId: AGENTS_PROVIDER_ID, model: agentModelId(valid.id), permissionMode: "full",
      });
      const unsupported = await harness.behavior.callRpc("saveProfile", {
        ...profileInput, slug: "invalid", providerId: "claude-code", model: "claude-opus-5-5",
      }) as Profile;
      await expect(harness.behavior.callAgentTool("delegate_agent_profile", {
        profileId: unsupported.id, task: "Fix slide two.", why: "Deck work", mode: "fresh",
      }, { threadId: "parent", projectId: "project-1" })).rejects.toThrow("Unsupported Pi agent pin");
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    } finally { await harness.lifecycle.dispose(); }
  });
});
