import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import type { Profile } from "./contract";

const hosts: FakePluginHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
const input = { name: "Portable", slug: "portable", kind: "thin", description: "Synthetic profile", modelMode: "pinned", providerId: "hempi", model: "openai-codex/gpt-6-sol", reasoningLevel: "medium", serviceTier: "default", permissionMode: "full", instructions: "Synthetic only", skillIds: [], mcpServerIds: [], isDefault: false };
async function fixture() {
  let sequence = 0;
  const sourceCalls: string[] = [];
  const host = createFakePluginHost({ pluginId: "agent-profiles", sdk: {
    projects: { get: async ({ projectId }) => {
      if (projectId === "missing" || projectId === "inaccessible") throw new Error("Native project access refused");
      return { id: projectId, name: projectId, kind: "repository" } as never;
    } },
    environments: { get: async ({ environmentId }) => ({ id: environmentId, projectId: "explicit-project", hostId: "host-explicit" }) as never },
    plugins: { callRpc: async ({ method }) => { sourceCalls.push(method); if (method === "projectContext") return { agentIds: [] }; return { ok: true }; } },
    providers: { models: async () => ({ models: [{ model: "openai-codex/gpt-6-sol", id: "openai-codex/gpt-6-sol", displayName: "Synthetic model", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Synthetic" }], defaultReasoningEffort: "medium" }] }) as never },
    threads: { spawn: async (args) => {
      if (args.projectId === "missing" || args.projectId === "inaccessible") throw new Error("Native project access refused");
      if (args.projectId === "capability-denied") throw new Error("Independent application access refused");
      return makeThreadResponse({ id: `task-${++sequence}`, projectId: args.projectId, environmentId: `env-${args.projectId}`, providerId: "agents" });
    } },
  } });
  hosts.push(host);
  await host.bb.storage.kv.set("built-in-profiles:v4", true);
  await host.bb.storage.kv.set("agent-history-cutover:v1", true);
  await host.bb.storage.kv.set("sandbox-agents:sandbox-a", []);
  await plugin(host.bb);
  return { ...host, sourceCalls };
}

describe("portable profile identity", () => {
  it("launches the same profile in two native projects despite empty legacy sandbox selection", async () => {
    const f = await fixture();
    const profile = await f.harness.behavior.callRpc("saveProfile", input) as Profile;
    for (const projectId of ["project-a", "project-b"]) {
      const result = await f.harness.behavior.callRpc("spawnProfile", { profileId: profile.id, projectId, environment: { type: "host", hostId: "sandbox-a", workspace: { type: "unmanaged", path: "/synthetic" } }, title: "Synthetic", prompt: "Synthetic task" });
      expect(result).toMatchObject({ profileId: profile.id, environmentId: `env-${projectId}` });
      expect(await f.harness.behavior.callRpc("profilesForProject", { projectId })).toMatchObject([{ id: profile.id }]);
    }
    expect(f.sourceCalls).toEqual([]);
    expect(await f.bb.storage.kv.get("sandbox-agents:sandbox-a")).toEqual([]);
  });
  it("honors explicit task context without overwriting a saved launch default", async () => {
    const f = await fixture();
    const profile = await f.harness.behavior.callRpc("saveProfile", { ...input, runProjectId: "saved-project" }) as Profile;
    f.harness.sdk.stub("plugins.callRpc", async () => ({ agentIds: [profile.id] }));
    await f.harness.behavior.callRpc("spawnProfile", { profileId: profile.id, projectId: "explicit-project", environment: { type: "reuse", environmentId: "explicit-environment" }, title: "Explicit", prompt: "Synthetic task" });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({ projectId: "explicit-project", environment: { type: "reuse", environmentId: "explicit-environment" } });
    await f.harness.behavior.callRpc("spawnProfile", { profileId: profile.id, title: "Default", prompt: "Synthetic task" });
    expect(f.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0]).toMatchObject({ projectId: "saved-project", environment: { type: "project-default" } });
    expect(await f.harness.behavior.callRpc("listProfiles", null)).toMatchObject([{ id: profile.id, runProjectId: "saved-project", revision: profile.revision, memoryKey: profile.memoryKey }]);
  });
  it("keeps native target and independent application refusal authoritative", async () => {
    const f = await fixture(); const profile = await f.harness.behavior.callRpc("saveProfile", input) as Profile;
    for (const projectId of ["missing", "inaccessible", "capability-denied"]) await expect(f.harness.behavior.callRpc("spawnProfile", { profileId: profile.id, projectId, environment: { type: "project-default" }, title: "Denied", prompt: "Synthetic task" })).rejects.toThrow(/refused/);
    await expect(f.harness.behavior.callRpc("spawnProfile", { profileId: "11111111-1111-4111-8111-111111111111", projectId: "project-a", environment: { type: "project-default" }, title: "Invalid", prompt: "Synthetic task" })).rejects.toThrow("Unknown agent profile");
    expect(f.sourceCalls).toEqual([]);
  });
  it("saves, imports, seeds, and promotes defaults without Projects or membership writes", async () => {
    const f = await fixture();
    f.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Projects unavailable"); });
    const first = await f.harness.behavior.callRpc("saveProfile", { ...input, isDefault: true }) as Profile;
    await f.harness.behavior.callRpc("importProfiles", { schemaVersion: 4, profiles: [{ ...input, name: "Imported", slug: "imported" }] });
    await f.harness.behavior.callRpc("deleteProfile", { id: first.id });
    expect(await f.harness.behavior.callRpc("listProfiles", null)).toMatchObject([{ slug: "imported", isDefault: true }]);
    await f.bb.storage.kv.set("built-in-profiles:v4", false);
    const reloaded = await f.harness.lifecycle.reload(plugin);
    hosts[hosts.length - 1] = reloaded;
    expect(await reloaded.bb.storage.kv.get("built-in-profiles:v4")).toBe(true);
    expect(reloaded.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    expect(reloaded.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(reloaded.harness.experimental_hostRpcCalls).toEqual([]);
  });
  it("reports retained-only, keeps sandbox history readable, and denies obsolete mutations", async () => {
    const f = await fixture();
    expect(await f.harness.behavior.callRpc("assignmentStatus", null)).toEqual({ schemaVersion: 1, kind: "agentPreferences", state: "retained-only" });
    expect(await f.harness.behavior.callRpc("getSandboxAgents", { hostId: "sandbox-a" })).toMatchObject({ state: "retained-only", agentIds: [] });
    await expect(f.harness.behavior.callRpc("setSandboxAgents", { hostId: "sandbox-a", agentIds: [] })).rejects.toThrow("membership-retired");
    await expect(f.harness.behavior.callRpc("setAgentAvailability", { agentId: "11111111-1111-4111-8111-111111111111", projectId: null, enabled: true })).rejects.toThrow("membership-retired");
    await expect(f.harness.behavior.callRpc("refreshAvailability", null)).rejects.toThrow("membership-retired");
  });
  it("discovers and configures a default profile without consulting legacy project or sandbox selections", async () => {
    const f = await fixture();
    const profile = await f.harness.behavior.callRpc("saveProfile", { ...input, isDefault: true }) as Profile;
    const mention = f.harness.inspection.registrations.mentionProviders.find(({ id }) => id === "agent-profile")!;
    expect(await mention.search({ trigger: "@", query: "portable", projectId: "project-a", threadId: "parent" })).toContainEqual(expect.objectContaining({ id: profile.id }));
    const configuration = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ host: { id: "sandbox-a", name: "Synthetic sandbox" } }));
    expect(configuration.instructions).toContain(profile.instructions);
    expect(f.sourceCalls).toEqual([]);
  });
  it.each(["staged", "active", "reverse-frozen"])("blocks portable release over unexpected C1 %s data without changing its rows", async (state) => {
    const f = await fixture(); const db = f.bb.storage.database();
    db.prepare("INSERT INTO agent_assignment_authority (id,state,format_version,identity_json) VALUES (1,?,1,?)").run(state, JSON.stringify({ generation: "unexpected/synthetic" }));
    const before = db.prepare("SELECT * FROM agent_assignment_authority").get();
    await expect(f.harness.behavior.callRpc("assignmentStatus", null)).rejects.toThrow("membership-recovery-required");
    await expect(f.harness.lifecycle.reload(plugin)).rejects.toThrow("membership-recovery-required");
    expect(db.prepare("SELECT * FROM agent_assignment_authority").get()).toEqual(before);
    expect(f.sourceCalls).toEqual([]);
  });
  it("reads actual legacy metadata lazily and never replaces an unavailable source with empty history", async () => {
    const f = await fixture(); const profile = await f.harness.behavior.callRpc("saveProfile", input) as Profile;
    f.harness.sdk.stub("projects.list", async () => [{ id: "known-project", name: "Known", kind: "standard" }] as never);
    f.harness.sdk.stub("plugins.callRpc", async () => ({ global: false, projectIds: ["known-project", "deleted-project"] }));
    expect(await f.harness.behavior.callRpc("agentAvailability", { agentId: profile.id })).toMatchObject({ state: "retained-only", global: false, projectIds: ["known-project", "deleted-project"] });
    f.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Legacy source offline"); });
    await expect(f.harness.behavior.callRpc("agentAvailability", { agentId: profile.id })).rejects.toThrow("Legacy source offline");
    await f.bb.storage.kv.set("sandbox-agents:sandbox-a", ["opaque/unknown"]);
    expect(await f.harness.behavior.callRpc("getSandboxAgents", { hostId: "sandbox-a" })).toMatchObject({ agentIds: ["opaque/unknown"] });
    await f.bb.storage.kv.set("sandbox-agents:sandbox-a", { malformed: true });
    await expect(f.harness.behavior.callRpc("getSandboxAgents", { hostId: "sandbox-a" })).rejects.toThrow();
    expect(await f.harness.behavior.callRpc("profilesForProject", { projectId: "project-a" })).toMatchObject([{ id: profile.id }]);
  });
});
