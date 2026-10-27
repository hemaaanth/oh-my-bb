import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { Profile } from "./contract";

const seedKey = "built-in-profiles:v4";
const privateRoleKey = "built-in-profile-id:v3:pr-review";
const publicInput = {
  name: "Synthetic public agent", slug: "synthetic-public", kind: "thin" as const,
  description: "Disposable standalone test", avatar: "🤖", modelMode: "pinned" as const,
  providerId: "hempi", model: "openai-codex/gpt-6-sol", reasoningLevel: "medium",
  serviceTier: "default" as const, permissionMode: "full", instructions: "Synthetic public instructions",
  skillIds: [], mcpServerIds: [], runProjectId: null, runHostId: null, runInCheckout: false,
  showInSidebar: true, isDefault: false,
};
const spawnInput = { projectId: "synthetic-project", environment: { type: "reuse", environmentId: "synthetic-environment" }, title: "Synthetic task", prompt: "Offline fixture only" };
const hosts: FakePluginHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
async function create(seeded = false) {
  const host = createFakePluginHost({ pluginId: "agent-profiles", sdk: {
    providers: { models: async () => ({ models: [{ model: "openai-codex/gpt-6-sol", displayName: "Synthetic model", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium" }] }) },
    threads: { spawn: async () => makeThreadResponse({ id: "synthetic-child", projectId: "synthetic-project", environmentId: "synthetic-environment" }) },
    plugins: { callRpc: async ({ pluginId }) => { if (pluginId === "pr-review") return { ok: true }; throw new Error("Optional sibling absent"); } },
  } });
  hosts.push(host);
  await host.bb.storage.kv.set("agent-history-cutover:v1", true);
  if (seeded) await host.bb.storage.kv.set(seedKey, true);
  await plugin(host.bb);
  return host;
}
async function reload(host: FakePluginHost) {
  const next = await host.harness.lifecycle.reload(plugin);
  hosts[hosts.indexOf(host)] = next;
  return next;
}
function privateCalls(host: FakePluginHost) {
  return host.harness.inspection.sdk.callsTo("plugins.callRpc").filter(([input]) =>
    input !== null && typeof input === "object" && "pluginId" in input && input.pluginId === "pr-review");
}

describe("standalone built-in role boundary", () => {
  it("does not seed private skills and refuses an unavailable private role before spawning", async () => {
    const host = await create();
    const profiles = await host.harness.behavior.callRpc("listProfiles", null) as Profile[];
    expect(profiles.filter(profile => profile.slug === "pr-review" || profile.skillIds.includes("pr-review"))).toEqual([]);
    expect(await host.bb.storage.kv.get(privateRoleKey)).toBeUndefined();
    await expect(host.harness.behavior.callRpc("spawnBuiltInProfile", { ...spawnInput, profile: "pr-review" })).rejects.toThrow("unavailable");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(privateCalls(host)).toEqual([]);
  });

  it("launches and configures a public saved profile without the private companion", async () => {
    const host = await create();
    host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("No optional siblings installed"); });
    const profile = await host.harness.behavior.callRpc("saveProfile", publicInput) as Profile;
    const result = await host.harness.behavior.callRpc("spawnProfile", { ...spawnInput, profileId: profile.id });
    expect(result).toMatchObject({ threadId: "synthetic-child", profileId: profile.id });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ providerId: "agents", model: `agent/${profile.id}`, originPluginId: "agent-profiles" });
    const config = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "synthetic-child" } }));
    expect(config.skills).not.toContain("pr-review");
    expect(privateCalls(host)).toEqual([]);
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
  });

  it("preserves mapped renamed private profile and revision bytes, then keeps its callback", async () => {
    let host = await create(true);
    const retained = await host.harness.behavior.callRpc("saveProfile", { ...publicInput, name: "My retained reviewer", slug: "renamed-reviewer", instructions: "Retained private instructions, not a generic fallback.", skillIds: ["pr-review", "opaque-skill"] }) as Profile;
    await host.bb.storage.kv.set(privateRoleKey, retained.id);
    const db = host.bb.storage.database();
    const before = { row: db.prepare("SELECT * FROM profiles WHERE id = ?").get(retained.id), revisions: db.prepare("SELECT * FROM profile_revisions WHERE profile_id = ?").all(retained.id) };
    await host.bb.storage.kv.set(seedKey, false);
    host = await reload(host);
    const reloadedDb = host.bb.storage.database();
    expect({ row: reloadedDb.prepare("SELECT * FROM profiles WHERE id = ?").get(retained.id), revisions: reloadedDb.prepare("SELECT * FROM profile_revisions WHERE profile_id = ?").all(retained.id) }).toEqual(before);
    expect(await host.bb.storage.kv.get(privateRoleKey)).toBe(retained.id);
    await host.harness.behavior.callRpc("spawnBuiltInProfile", { ...spawnInput, profile: "pr-review" });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ title: "@pr-review · Synthetic task", pluginMetadata: { profileId: retained.id } });
    expect(privateCalls(host)).toEqual([[expect.objectContaining({ method: "registerReviewThread", input: { threadId: "synthetic-child" } })]]);
  });

  it("retains only the already-supported seeded exact legacy reconciliation", async () => {
    let host = await create(true);
    const retained = await host.harness.behavior.callRpc("saveProfile", { ...publicInput, name: "PR Review", slug: "pr-review", instructions: "Exact retained legacy payload", skillIds: ["opaque-legacy-skill"] }) as Profile;
    await host.bb.storage.kv.set(seedKey, false);
    await host.bb.storage.kv.set("built-in-profiles:v3", true);
    host = await reload(host);
    expect(await host.bb.storage.kv.get(privateRoleKey)).toBe(retained.id);
    expect((await host.harness.behavior.callRpc("listProfiles", null) as Profile[]).find(p => p.id === retained.id)).toEqual(retained);
  });

  it("does not adopt a same-name user profile without legacy evidence or create a replacement", async () => {
    let host = await create(true);
    const retained = await host.harness.behavior.callRpc("saveProfile", { ...publicInput, name: "PR Review", slug: "pr-review" }) as Profile;
    await host.bb.storage.kv.set(seedKey, false);
    host = await reload(host);
    expect(await host.bb.storage.kv.get(privateRoleKey)).toBeUndefined();
    expect((await host.harness.behavior.callRpc("listProfiles", null) as Profile[]).filter(p => p.slug.startsWith("pr-review"))).toEqual([retained]);
    await expect(host.harness.behavior.callRpc("spawnBuiltInProfile", { ...spawnInput, profile: "pr-review" })).rejects.toThrow("unavailable");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("does not resurrect a deleted mapped private profile", async () => {
    let host = await create(true);
    const retained = await host.harness.behavior.callRpc("saveProfile", publicInput) as Profile;
    await host.bb.storage.kv.set(privateRoleKey, retained.id);
    await host.harness.behavior.callRpc("deleteProfile", { id: retained.id });
    await host.bb.storage.kv.set(seedKey, false);
    host = await reload(host);
    expect(await host.bb.storage.kv.get(privateRoleKey)).toBe(retained.id);
    expect((await host.harness.behavior.callRpc("listProfiles", null) as Profile[]).find(p => p.id === retained.id || p.slug.startsWith("pr-review"))).toBeUndefined();
    await expect(host.harness.behavior.callRpc("spawnBuiltInProfile", { ...spawnInput, profile: "pr-review" })).rejects.toThrow("Unknown agent profile");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });
});
