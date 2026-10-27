import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import manifest from "../package.json";
import { agentModelId } from "./provider-ids";
import { snapshot } from "./profiles";
import { createAgentDms } from "./dms";
import { Store } from "./channels/store";
import { createProfiles } from "./profiles";
import type { Profile } from "./contract";

const input = (name: string) => ({
  name, slug: name.toLowerCase(), kind: "thin" as const,
  description: "", avatar: "🤖", modelMode: "level" as const, level: "medium" as const,
  providerId: "openai-codex", model: "openai-codex/gpt-6-sol",
  reasoningLevel: "medium" as const, serviceTier: "default", permissionMode: "full" as const,
  instructions: "", skillIds: [], mcpServerIds: [], runProjectId: null,
  runInCheckout: false, isDefault: false,
});

async function setup() {
  const threads = new Map<string, MessageDispatchHookContext["thread"]>();
  const metadata = new Map<string, Record<string, unknown>>();
  const models = new Map<string, string | undefined>();
  const queued = new Set<string>();
  const overrides = new Set<string>();
  let sequence = 0;
  let uncertain = false;
  const dispatched: unknown[] = [];
  const ran = new Set<string>();
  const available = new Set<string>();
  const spawn = vi.fn(async (args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) => {
    const id = `dm-${++sequence}`;
    const thread = makeThreadResponse({ id, projectId: args.projectId,
      providerId: args.providerId, environmentId: "env-1",
      parentThreadId: null, status: "pending" });
    threads.set(id, thread);
    models.set(id, args.model);
    queued.add(id);
    metadata.set(id, args.pluginMetadata ?? {});
    // BB runs the dispatch hook on the first input before spawn returns.
    dispatched.push(await host.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
      thread: { ...thread, originPluginId: "agent-profiles" },
      requestedExecution: { providerId: args.providerId!, model: args.model! },
    })));
    if (uncertain) throw new Error("connection dropped after creation");
    return thread;
  });
  const dropQueued = vi.fn(async ({ threadId }: { threadId: string; queuedMessageId: string }) => { queued.delete(threadId); });
  // A model override counts as the thread's execution model, like in BB.
  const update = vi.fn(async ({ threadId, model }: { threadId: string; model?: string | null }) => {
    if (model) { models.set(threadId, model); overrides.add(threadId); }
    return { ok: true } as never;
  });
  const unarchive = vi.fn(async ({ threadId }: { threadId: string }) => {
    const thread = threads.get(threadId)!;
    threads.set(threadId, { ...thread, archivedAt: null });
    return { ok: true } as never;
  });
  const host = createFakePluginHost({
    pluginId: "agent-profiles",
    experimental_declaredIconNames: Object.keys(manifest.bb.branding.experimental_icons),
    sdk: {
    plugins: { callRpc: async ({ method, input }) => method === "projectContext"
      ? { projectId: (input as { projectId: string }).projectId, credentialId: null, groupId: null,
          agentIds: [...available], bundleIds: [] } as never
      : { ok: true } as never },
    system: { config: async () => ({ primaryHostId: "host-1" }) as never },
    projects: {
      create: async () => ({ id: "agents-home-project" }) as never,
      get: async ({ projectId }) => ({ id: projectId, name: projectId, kind: "repository" }) as never,
    },
    environments: { list: async () => [
      { id: "checkout-1", projectId: "code-project", hostId: "host-1" },
    ] as never },
    hosts: { list: async () => [
      { id: "host-1", status: "connected", machineProviderId: null },
    ] as never },
    threads: {
      spawn,
      list: async ({ archived, limit = 100, offset = 0 } = {}) =>
        [...threads.values()].filter((thread) => (thread.archivedAt !== null) === archived && thread.deletedAt === null)
          .slice(offset, offset + limit) as never,
      get: async ({ threadId }) => {
        const thread = threads.get(threadId);
        if (!thread) throw new Error("Thread not found");
        return thread;
      },
      getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
      // BB also resolves a pending thread's model from its queued start message.
      defaultExecutionOptions: async ({ threadId }) => !ran.has(threadId) && !queued.has(threadId) && !overrides.has(threadId) ? null : ({
        model: models.get(threadId), permissionMode: "full",
        reasoningLevel: "medium", serviceTier: "default", source: "explicit",
      }) as never,
      unarchive,
      update,
      queuedMessages: { list: async ({ threadId }) => (queued.has(threadId) ? [{ id: `queued-${threadId}` }] : []) as never, delete: dropQueued },
    },
    },
  });
  await plugin(host.bb);
  const save = (name: string) => host.harness.behavior.callRpc("saveProfile", input(name)) as Promise<Profile>;
  const open = (profileId: string) => host.harness.behavior.callRpc("ensureAgentDm", { profileId }) as Promise<{ threadId: string }>;
  return { ...host, available, threads, metadata, spawn, unarchive, dropQueued, update, dispatched, models,
    ran, queued, overrides, run(threadId: string, model?: string) { ran.add(threadId); if (model) models.set(threadId, model); }, save, open, setUncertain(value: boolean) { uncertain = value; } };
}

describe("permanent agent DMs", () => {
  it("persists the model before deleting the queued start that supplied it", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      const { threadId } = await x.open(a.id);
      expect(x.ran.has(threadId)).toBe(false);
      expect(x.queued.has(threadId)).toBe(false);
      expect(await x.bb.sdk.threads.defaultExecutionOptions({ threadId })).toMatchObject({ model: agentModelId(a.id) });
      expect(x.update.mock.invocationCallOrder[0]).toBeLessThan(x.dropQueued.mock.invocationCallOrder[0]!);
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("lets a delegated task dispatch its first turn before the binding row exists", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      x.available.add(a.id);
      x.harness.sdk.stub("providers.models", async () => ({ models: [
        { model: "openai-codex/gpt-6-sol", displayName: "GPT 6 Sol",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium", isDefault: true },
      ] }) as never);
      const result = await x.harness.behavior.callRpc("spawnProfile", {
        profileId: a.id, projectId: "code-project", environment: { type: "project-default" }, title: "Review", prompt: "Review the plan.", parentThreadId: "parent-1",
      }) as { threadId: string };
      expect(x.spawn.mock.calls[0]![0]).toMatchObject({ providerId: "agents", model: agentModelId(a.id),
        pluginMetadata: { role: "task", profileId: a.id } });
      expect(x.dispatched).toEqual([expect.objectContaining({ action: "wait" })]);
      const hook = x.harness.inspection.registrations.hooks["message.dispatch"]!;
      expect(await hook(makeMessageDispatchHookContext({
        thread: { id: result.threadId, providerId: "agents", originPluginId: "agent-profiles" },
        requestedExecution: { providerId: "agents", model: agentModelId(a.id) },
      }))).toEqual({ action: "proceed" });
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("lets a channel conversation dispatch its first turn before the conversation row exists", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      x.metadata.set("channel-1", { role: "channel", profileId: a.id, schemaVersion: 1, agentId: a.id, conversationKey: "group:room-1" });
      const hook = x.harness.inspection.registrations.hooks["message.dispatch"]!;
      const dispatch = (model: string) => hook(makeMessageDispatchHookContext({
        thread: { id: "channel-1", providerId: "agents", originPluginId: "agent-profiles" },
        requestedExecution: { providerId: "agents", model },
      }));
      expect(await dispatch(agentModelId(a.id))).toMatchObject({ action: "wait", reason: "Registering agent conversation." });
      expect(await dispatch("openai-codex/gpt-6-sol")).toMatchObject({ action: "reject" });
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("coalesces concurrent empty opens, binds the first dispatch and retains a stable identity on rename", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      const b = await x.save("Beta");
      const [first, second] = await Promise.all([x.open(a.id), x.open(a.id)]);
      expect(first).toEqual(second);
      expect(x.spawn).toHaveBeenCalledTimes(1);
      expect(x.spawn.mock.calls[0]![0]).toMatchObject({ projectId: "agents-home-project",
        providerId: "agents", model: agentModelId(a.id), input: [{ type: "text", text: "Open Atlas" }],
        environment: { type: "host", hostId: "host-1", workspace: { type: "unmanaged" } },
        pluginMetadata: { role: "dm", profileId: a.id, schemaVersion: 1 } });
      expect(x.spawn.mock.calls[0]![0].sendAt).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
      expect(x.dispatched).toEqual([expect.objectContaining({ action: "wait", sendAt: expect.any(Number) })]);
      expect(x.dropQueued).toHaveBeenCalledWith({ threadId: first.threadId, queuedMessageId: `queued-${first.threadId}` });
      expect(x.update).toHaveBeenCalledExactlyOnceWith({ threadId: first.threadId, model: agentModelId(a.id) });
      expect(x.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
      const hook = x.harness.inspection.registrations.hooks["message.dispatch"]!;
      const dispatch = (model: string, threadId = first.threadId) => hook(makeMessageDispatchHookContext({
        thread: { id: threadId, providerId: "agents" },
        requestedExecution: { providerId: "agents", model },
      }));
      expect(await dispatch(agentModelId(a.id))).toEqual({ action: "proceed" });
      expect(await dispatch(agentModelId(b.id))).toMatchObject({ action: "reject" });
      expect(await dispatch("openai-codex/gpt-6-sol")).toMatchObject({ action: "reject" });
      expect(await dispatch(agentModelId(a.id), "raw-agent-thread")).toMatchObject({ action: "reject" });
      const registration = x.harness.registrations.providerRegistrations.find((entry) => entry.id === "agents")!;
      expect(() => registration.deriveProviderOptions!({ threadId: first.threadId, model: agentModelId(b.id) } as never)).toThrow();
      const renamed = await x.harness.behavior.callRpc("saveProfile", {
        ...snapshot(a), name: "Atlas New", slug: "atlas-new", expectedRevision: a.revision,
      }) as Profile;
      expect(renamed.memoryKey).toBe(a.memoryKey);
      expect(await x.open(a.id)).toEqual(first);
      x.run(first.threadId);
      expect(await x.open(a.id)).toEqual(first);
      x.run(first.threadId, agentModelId(b.id));
      await expect(x.open(a.id)).rejects.toThrow("identity does not match");
      x.run(first.threadId, agentModelId(a.id));
      expect(x.spawn).toHaveBeenCalledTimes(1);
      await expect(x.harness.behavior.callRpc("saveProfile", {
        ...snapshot(renamed), runProjectId: "project-pinned", expectedRevision: renamed.revision,
      })).rejects.toThrow("Runs in is locked");
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("allows pinning the existing project checkout to a machine after DM reservation", async () => {
    const x = await setup();
    try {
      const profile = await x.harness.behavior.callRpc("saveProfile", {
        ...input("Atlas"),
        runProjectId: "code-project",
        runInCheckout: true,
      }) as Profile;
      await x.open(profile.id);
      const pinned = await x.harness.behavior.callRpc("saveProfile", {
        ...snapshot(profile),
        runHostId: "host-deck",
        expectedRevision: profile.revision,
      }) as Profile;
      expect(pinned.runHostId).toBe("host-deck");
    } finally {
      await x.harness.lifecycle.dispose();
    }
  });

  it("pins the model on a DM opened before the fix, and gives hidden agents no DM", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      const { threadId } = await x.open(a.id);
      x.models.delete(threadId);
      x.ran.delete(threadId);
      x.overrides.delete(threadId);
      x.update.mockClear();
      expect(await x.open(a.id)).toEqual({ threadId });
      expect(x.update).toHaveBeenCalledExactlyOnceWith({ threadId, model: agentModelId(a.id) });
      const hidden = await x.harness.behavior.callRpc("saveProfile", {
        ...snapshot(a), name: "Quiet", slug: "quiet", showInSidebar: false, expectedRevision: a.revision,
      }) as Profile;
      await expect(x.open(hidden.id)).rejects.toThrow("Quiet is hidden");
      const registration = x.harness.registrations.providerRegistrations.filter((entry) => entry.id === "agents").at(-1);
      expect(registration?.models?.fallback ?? []).not.toContainEqual(expect.objectContaining({ id: agentModelId(a.id) }));
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("repairs an existing empty DM at startup without creating a thread or sending a message", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      const { threadId } = await x.open(a.id);
      x.models.delete(threadId);
      x.overrides.delete(threadId);
      x.update.mockClear();
      const db = x.bb.storage.database();
      const store = await Store.create(x.bb, db);
      const profiles = await createProfiles(x.bb, db, store);
      await createAgentDms(x.bb, db, profiles, store).restoreArchived();
      expect(await x.bb.sdk.threads.defaultExecutionOptions({ threadId })).toMatchObject({ model: agentModelId(a.id) });
      expect(x.update).toHaveBeenCalledExactlyOnceWith({ threadId, model: agentModelId(a.id) });
      expect(x.spawn).toHaveBeenCalledTimes(1);
      expect(x.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("keeps the placeholder and reservation recoverable when persisting the model fails", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      x.update.mockRejectedValue(new Error("model catalog offline"));
      await expect(x.open(a.id)).rejects.toThrow("model catalog offline");
      expect(x.queued.has("dm-1")).toBe(true);
      expect(x.dropQueued).not.toHaveBeenCalled();
      expect(x.bb.storage.database().prepare("SELECT state FROM agent_dms WHERE profile_id = ?").get(a.id)).toMatchObject({ state: "creating" });
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("honors pinned project policy and never substitutes a home workspace", async () => {
    const x = await setup();
    try {
      const profile = await x.harness.behavior.callRpc("saveProfile", {
        ...input("Pinned"), runProjectId: "code-project", runInCheckout: false,
      }) as Profile;
      await x.open(profile.id);
      expect(x.spawn.mock.calls[0]![0]).toMatchObject({ projectId: "code-project",
        environment: { type: "project-default" } });
      const checkout = await x.harness.behavior.callRpc("saveProfile", {
        ...input("Checkout"), runProjectId: "code-project", runInCheckout: true,
      }) as Profile;
      await x.open(checkout.id);
      expect(x.spawn.mock.calls[1]![0]).toMatchObject({ projectId: "code-project",
        environment: { type: "reuse", environmentId: "checkout-1" } });
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("uses the persisted spawn claim across independent allocator instances", async () => {
    const x = await setup();
    try {
      const profile = await x.save("Atlas");
      const db = x.bb.storage.database();
      const store = await Store.create(x.bb, db);
      const profiles = await createProfiles(x.bb, db, store);
      const first = createAgentDms(x.bb, db, profiles, store);
      const second = createAgentDms(x.bb, db, profiles, store);
      const outcomes = await Promise.allSettled([
        first.ensureAgentDm(profile.id), second.ensureAgentDm(profile.id),
      ]);
      expect(x.spawn).toHaveBeenCalledTimes(1);
      expect(outcomes.some((result) => result.status === "fulfilled")).toBe(true);
      expect(await x.open(profile.id)).toEqual({ threadId: "dm-1" });
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("reconciles uncertain spawn after restart by token, without spawning or prompting again", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      x.setUncertain(true);
      const first = await x.open(a.id);
      expect(x.spawn).toHaveBeenCalledTimes(1);
      expect(first.threadId).toBe("dm-1");
      const db = x.bb.storage.database();
      db.prepare("UPDATE agent_dms SET state = 'creating', thread_id = NULL WHERE profile_id = ?").run(a.id);
      const store = await Store.create(x.bb, db);
      const profiles = await createProfiles(x.bb, db, store);
      const restarted = createAgentDms(x.bb, db, profiles, store);
      expect(await restarted.ensureAgentDm(a.id)).toEqual(first);
      expect(x.spawn).toHaveBeenCalledTimes(1);
      expect(x.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally { await x.harness.lifecycle.dispose(); }
  });

  it("fails closed on unresolved spawns and missing DMs, and restores archived DMs", async () => {
    const x = await setup();
    try {
      const a = await x.save("Atlas");
      const first = await x.open(a.id);
      const db = x.bb.storage.database();
      x.threads.set(first.threadId, { ...x.threads.get(first.threadId)!, archivedAt: Date.now() });
      await x.harness.behavior.emitThreadEvent("thread.archived", { thread: x.threads.get(first.threadId)! });
      expect(x.unarchive).toHaveBeenCalledWith({ threadId: first.threadId });
      db.prepare("UPDATE agent_dms SET state = 'creating', thread_id = NULL WHERE profile_id = ?").run(a.id);
      x.threads.delete(first.threadId);
      const store = await Store.create(x.bb, db);
      const profiles = await createProfiles(x.bb, db, store);
      const restarted = createAgentDms(x.bb, db, profiles, store);
      await expect(restarted.ensureAgentDm(a.id)).rejects.toThrow("uncertain");
      expect(x.spawn).toHaveBeenCalledTimes(1);
      db.prepare("UPDATE agent_dms SET state = 'ready', thread_id = ? WHERE profile_id = ?").run(first.threadId, a.id);
      await expect(restarted.ensureAgentDm(a.id)).rejects.toThrow("missing or deleted");
      await expect(restarted.ensureAgentDm(a.id)).rejects.toThrow("missing or deleted");
      expect(x.spawn).toHaveBeenCalledTimes(1);
    } finally { await x.harness.lifecycle.dispose(); }
  });
});
