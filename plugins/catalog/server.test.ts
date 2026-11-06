import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { fakeExecutor, signIn } from "./test-support/executor-fake.js";

afterEach(() => { vi.unstubAllGlobals(); });

const CAPABILITY_ID = "2f576f36-0d16-4f76-9a21-b66bcb47e100";

function catalogHost(environments: Record<string, string> = {}) {
  const written: string[] = [];
  const globalBundles = new Set<string>();
  const projectBundles = new Map<string, Set<string>>();
  const calls: Array<{ method: string; input: unknown }> = [];
  const bundleIds = (projectId: string) => [...globalBundles, ...(projectBundles.get(projectId) ?? [])];
  const host = createFakePluginHost({
    pluginId: "catalog",
    settings: { executorUrl: "https://executor.test", executorApiKey: "exp_test" },
    sdk: {
      system: { config: async () => ({ primaryHostId: null, dataDir: "/tmp/bb-test", serverUrl: "http://127.0.0.1:38886", serverAccess: { effectiveUrl: null } }) as never },
      hosts: { list: async () => [] },
      files: {
        mkdir: async () => undefined as never,
        remove: async () => undefined as never,
        read: async () => { throw new Error("missing"); },
        write: async ({ path }: { path: string }) => { written.push(path); return { outcome: "written", sha256: "x", sizeBytes: 1 } as never; },
      },
      threads: { list: async () => [], get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: environments[threadId] ?? null }) },
      environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: environmentId.replace("env_", "host_") }) as never },
      projects: {
        list: async () => ["one", "two"].map((name) => ({ id: `proj_${name}`, kind: "standard" as const, name, gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] })),
      },
      plugins: {
        callRpc: async ({ method, input }: { method: string; input: unknown }) => {
          calls.push({ method, input });
          if (method === "bundleAssignmentSnapshot") {
            return { globalBundleIds: [...globalBundles], projects: [...projectBundles].map(([projectId, ids]) => ({ projectId, bundleIds: [...ids] })) };
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
            return { projectId, credentialId: null, groupId: null, agentIds: [], bundleIds: bundleIds(projectId) };
          }
          if (method === "projectContexts") {
            return { projects: (input as { projectIds: string[] }).projectIds.map((projectId) => ({ projectId, credentialId: null, groupId: null, agentIds: [], bundleIds: bundleIds(projectId) })) };
          }
          throw new Error(`Unexpected Projects RPC: ${method}`);
        },
      },
    },
  });
  return { ...host, calls, written };
}

type Found = { capabilities: Array<{ id: string; name: string; sourceName?: string }> };
const search = async (harness: ReturnType<typeof catalogHost>["harness"], projectId: string, threadId = "thr", query = "") =>
  JSON.parse(await harness.behavior.callAgentTool("catalog_search", { query }, { projectId, threadId }) as string) as Found;

describe("Catalog skills from Executor", () => {
  const executorWithSkills = () => fakeExecutor({
    connections: ["gtm", "shared"],
    skills: {
      gtm: [
        { app: "hstack", appName: "hstack", name: "build", description: "Build a change", files: { "SKILL.md": "# build\n", "references/steps.md": "1. Build\n" } },
        // Executor's own docs are reached through executor_docs, not projected as skills.
        { app: "executor", appName: "Executor", name: "code-mode", description: "How to call tools" },
      ],
      shared: [{ app: "docs", appName: "Docs", name: "review", description: "Review a change" }],
    },
  });

  it("finds and reads the skills of a thread's connections only", async () => {
    const executor = executorWithSkills();
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await signIn(harness, executor, "gtm", "shared");
    await harness.behavior.runCli(["executor", "use", "gtm", "--project", "one"]);
    await harness.behavior.runCli(["executor", "use", "shared", "--global"]);

    expect((await search(harness, "proj_one")).capabilities.map((found) => found.id)).toEqual(["hstack/build", "docs/review"]);
    expect((await search(harness, "proj_two")).capabilities.map((found) => found.id)).toEqual(["docs/review"]);
    expect((await search(harness, "proj_one", "thr", "review")).capabilities.map((found) => found.name)).toEqual(["review"]);

    const read = async (skillId: string, path?: string, projectId = "proj_one") =>
      JSON.parse(await harness.behavior.callAgentTool("catalog_read", { skillId, ...(path ? { path } : {}) }, { projectId, threadId: "thr" }) as string);
    expect(await read("hstack/build")).toMatchObject({ content: "# build\n", provenance: { app: "hstack", connection: "gtm", revision: "r1" } });
    expect((await read("hstack/build", "references/steps.md")).content).toBe("1. Build\n");
    await expect(read("hstack/build", "../secrets")).rejects.toBeInstanceOf(Error);
    await expect(read("hstack/build", undefined, "proj_two")).rejects.toThrow("That skill is not available in this thread");
    await expect(read("executor/code-mode")).rejects.toThrow("That skill is not available in this thread");

    const overview = await harness.behavior.callRpc("catalogOverview", null, { experimental_caller: { kind: "client" } });
    expect(overview.skills.map((skill: { id: string }) => skill.id)).toEqual(["hstack/build", "docs/review"]);
    expect(overview.skillsError).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("reports a connection that cannot be read instead of hiding the others", async () => {
    const executor = executorWithSkills();
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness } = catalogHost();
    await plugin(bb);
    await signIn(harness, executor, "shared");
    await harness.behavior.runCli(["executor", "use", "gtm", "shared", "--global"]);

    const overview = await harness.behavior.callRpc("catalogOverview", null, { experimental_caller: { kind: "client" } });
    expect(overview.skills.map((skill: { id: string }) => skill.id)).toEqual(["docs/review"]);
    expect(overview.skillsError).toMatch(/^gtm: BB is not signed in to Executor connection gtm/u);
    await harness.lifecycle.dispose();
  });

  it("lets a sandbox host pick its own skills from the mapped connections", async () => {
    const executor = executorWithSkills();
    vi.stubGlobal("fetch", executor.fetcher);
    const { bb, harness, calls, written } = catalogHost({ "thr-sandbox": "env_remote" });
    await plugin(bb);
    await signIn(harness, executor, "gtm", "shared");
    await harness.behavior.runCli(["executor", "use", "gtm", "shared", "--global"]);

    expect(await harness.behavior.callRpc("getSandboxSkills", { hostId: "host_remote" })).toEqual({ skillIds: null });
    await harness.behavior.callRpc("setSandboxSkills", { hostId: "host_remote", skillIds: ["docs/review"] });
    expect(await bb.storage.kv.get("sandbox-skills:host_remote")).toEqual(["docs/review"]);
    expect(await harness.behavior.callRpc("getSandboxSkills", { hostId: "host_remote" })).toEqual({ skillIds: ["docs/review"] });
    await expect(harness.behavior.callRpc("setSandboxSkills", { hostId: "host_remote", skillIds: ["missing/skill"] })).rejects.toThrow("unavailable skill");

    expect((await search(harness, "proj_one", "thr-sandbox")).capabilities.map((found) => found.id)).toEqual(["docs/review"]);
    expect((await search(harness, "proj_one", "thr-local")).capabilities.map((found) => found.id)).toEqual(["hstack/build", "docs/review"]);
    // Sandbox choices never touch Projects assignments.
    expect(calls.some((call) => call.method.startsWith("set"))).toBe(false);

    const started = await harness.behavior.callRpc("startMaterialize", { hostId: "host_remote", homePath: "/home/tester", projectId: null, workspacePath: null }) as { jobId: string };
    expect(started.jobId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect.poll(() => harness.behavior.callRpc("materializationStatus", { jobId: started.jobId })).toMatchObject({ state: "complete", result: { skillCount: 1 } });
    // Only the chosen skill reaches the sandbox's skill roots.
    expect(written.filter((path) => path.endsWith("/SKILL.md"))).toEqual(["/home/tester/.agents/skills/catalog-docs-review/SKILL.md", "/home/tester/.claude/skills/catalog-docs-review/SKILL.md"]);
    expect(await harness.behavior.callRpc("materializationStatus", { jobId: "00000000-0000-4000-8000-000000000000" })).toEqual({ state: "failed", error: "Materialization job is no longer available" });
    await harness.lifecycle.dispose();
  });
});

describe("Catalog native capability availability", () => {
  it("reads and writes availability through Projects", async () => {
    vi.stubGlobal("fetch", fakeExecutor().fetcher);
    const { bb, harness, calls } = catalogHost();
    await plugin(bb);
    await harness.behavior.callRpc("registerNativeCapability", {
      id: CAPABILITY_ID, pluginId: "fixture-native", name: "Fixture", description: "Synthetic capability.",
      toolIds: ["fixture_action"], skillIds: [], setup: [], assignmentChangedRpc: null,
    });
    expect((await harness.behavior.callRpc("listBundles", null)).bundles.map((bundle: { id: string }) => bundle.id)).toEqual([CAPABILITY_ID]);

    await harness.behavior.callRpc("setAssignment", { bundleId: CAPABILITY_ID, kind: "project", targetId: "proj_one", enabled: true });
    await harness.behavior.callRpc("setAssignment", { bundleId: CAPABILITY_ID, kind: "global", targetId: "*", enabled: true });
    expect((await harness.behavior.callRpc("snapshot", null)).assignments).toEqual(expect.arrayContaining([
      { bundleId: CAPABILITY_ID, kind: "global", targetId: "*" },
      { bundleId: CAPABILITY_ID, kind: "project", targetId: "proj_one" },
    ]));
    expect(calls).toContainEqual({ method: "setProjectBundle", input: { projectId: "proj_one", targetId: CAPABILITY_ID, enabled: true } });
    expect((await search(harness, "proj_two")).capabilities.map((found) => found.name)).toEqual(["Fixture"]);

    await harness.behavior.callRpc("setAssignment", { bundleId: CAPABILITY_ID, kind: "global", targetId: "*", enabled: false });
    expect((await search(harness, "proj_two")).capabilities).toEqual([]);
    await expect(harness.behavior.callRpc("setAssignment", { bundleId: "00000000-0000-4000-8000-000000000000", kind: "global", targetId: "*", enabled: true })).rejects.toThrow("Unknown native capability");
    expect(await harness.behavior.callRpc("legacyAssignments", null)).toEqual({ assignments: [] });
    await harness.lifecycle.dispose();
  });
});
