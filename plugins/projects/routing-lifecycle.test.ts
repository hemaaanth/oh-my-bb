import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { ProjectsStore } from "./store.js";
import { routingEvidenceFingerprint } from "./routing-profile.js";

// Drive the real service loops with the test clock, including Node promise timers.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, value: unknown, { signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(value); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }),
}));

const projects = Array.from({ length: 22 }, (_, index) => ({
  id: `synthetic-${index}`, kind: "standard" as const, name: `Synthetic ${index}`,
  gitRemoteUrl: `https://github.com/example/synthetic-${index}.git`,
  createdAt: 1, updatedAt: 1, sources: [],
}));
const generated = {
  description: "Explicitly regenerated synthetic description", keywords: ["new keyword"],
  aliases: ["new alias"], repositories: ["example/new"], notFor: ["new exclusion"],
};

async function fixture() {
  let projectChanged = () => {};
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { response_format: { json_schema: { name: string } } };
    const content = request.response_format.json_schema.name === "project_routing_learning"
      ? { learnedFor: ["Explicitly learned synthetic guidance"], learnedNotFor: ["Explicit learned exclusion"] }
      : generated;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  vi.stubGlobal("fetch", fetch);
  const host = createFakePluginHost({
    pluginId: "projects", settings: { openRouterApiKey: "synthetic-key" },
    sdk: {
      subscribe: (subscription) => {
        if (subscription.event === "project:changed") projectChanged = () => subscription.callback({
          type: "changed", entity: "project", id: projects[0]!.id,
          changes: ["project-created", "project-updated", "project-sources-changed"],
        });
        return () => {};
      },
      projects: {
        list: async () => projects,
        fileContent: async ({ path }) => ({ content: path === "package.json" ? '{"name":"synthetic"}' : "Synthetic README", contentEncoding: "utf8" }),
      },
    },
  });
  await plugin(host.bb);
  const store = new ProjectsStore(host.bb.storage.database());
  for (const [index, project] of projects.entries()) {
    if (index === 21) continue;
    store.saveRoutingProfile(project.id, {
      description: `Preserved description ${index}`, keywords: [`saved keyword ${index}`],
      aliases: [`saved alias ${index}`], repositories: [`historical/repository-${index}`], notFor: [`saved exclusion ${index}`],
      source: index === 20 ? "manual" : "generated",
      fingerprint: index === 20 ? null : routingEvidenceFingerprint({
        name: project.name, gitRemoteUrl: project.gitRemoteUrl, packageJson: '{"name":"synthetic"}',
        readme: "Synthetic README", mappedSources: ["GitHub · historical/opaque"], taskTitles: ["Historical task"],
      }),
    });
    store.saveRoutingLearning(project.id, { learnedFor: [`saved guidance ${index}`], learnedNotFor: [`saved learned exclusion ${index}`], fingerprint: `saved-learning-${index}` });
  }
  const rows = () => host.bb.storage.database().prepare("SELECT * FROM project_configuration ORDER BY project_id").all();
  return { ...host, store, rows, fetch, projectChanged: () => projectChanged() };
}

async function runBackgroundWindow(host: Awaited<ReturnType<typeof createFakePluginHost>>) {
  const running = host.harness.inspection.registrations.services.map(({ name }) => host.harness.behavior.runService(name));
  try { await vi.advanceTimersByTimeAsync((6 * 60 + 31) * 60_000); }
  finally {
    for (const service of running) service.controller.abort();
    await Promise.all(running.map(({ done }) => done));
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("explicit routing profile generation", () => {
  it("preserves generated, manual and missing profiles across service startup, periodic time and reload with no evidence scans or model calls", async () => {
    const host = await fixture();
    let active = host;
    const before = host.rows();
    try {
      expect(await host.harness.behavior.callRpc("preferences", null)).toMatchObject({ tasksIntegration: false });
      await runBackgroundWindow(host);
      expect(host.rows()).toEqual(before);
      expect(host.fetch).not.toHaveBeenCalled();
      expect(host.harness.inspection.sdk.callsTo("projects.fileContent")).toEqual([]);
      expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
      const reloaded = await host.harness.lifecycle.reload(plugin);
      active = { ...host, ...reloaded };
      await runBackgroundWindow(reloaded);
      expect(reloaded.bb.storage.database().prepare("SELECT * FROM project_configuration ORDER BY project_id").all()).toEqual(before);
      expect(host.fetch).not.toHaveBeenCalled();
      expect(reloaded.harness.inspection.sdk.callsTo("projects.fileContent")).toEqual([]);
      expect(reloaded.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await active.harness.lifecycle.dispose(); }
  });

  it("does not turn project notifications, key changes or model preference changes into paid refreshes", async () => {
    const host = await fixture();
    const before = host.rows();
    try {
      host.projectChanged();
      await vi.advanceTimersByTimeAsync(2_000);
      await host.harness.behavior.setSettings({ openRouterApiKey: "synthetic-replacement" });
      await vi.advanceTimersByTimeAsync(2_000);
      await host.harness.behavior.callRpc("updatePreferences", { routingModel: "synthetic/new-model" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(host.rows()).toEqual(before);
      expect(host.fetch).not.toHaveBeenCalled();
      expect(host.harness.inspection.sdk.callsTo("projects.fileContent")).toEqual([]);
      expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it.each([
    ["generateRoutingProfile", { projectId: projects[0]!.id }],
    ["generateMissingRoutingProfiles", null],
  ] as const)("rejects plugin-origin %s before project reads, evidence, model calls or writes", async (method, input) => {
    const host = await fixture();
    try {
      await host.harness.behavior.callRpc("updatePreferences", { tasksIntegration: true });
      const before = host.rows();
      await expect(host.harness.behavior.callRpc(method, input, {
        experimental_caller: { kind: "plugin", pluginId: "task-workspaces" },
      })).rejects.toThrow("owner-client-required");
      expect(host.rows()).toEqual(before);
      expect(host.fetch).not.toHaveBeenCalled();
      expect(host.harness.inspection.sdk.callsTo("projects.list")).toEqual([]);
      expect(host.harness.inspection.sdk.callsTo("projects.fileContent")).toEqual([]);
      expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it("retains explicit backfill and regenerate behavior without rewriting manual or learned fields implicitly", async () => {
    const host = await fixture();
    const manualBefore = host.store.getConfiguration(projects[20]!.id);
    const learnedBefore = host.store.getConfiguration(projects[0]!.id).routingProfile;
    try {
      expect(await host.harness.behavior.callRpc("generateMissingRoutingProfiles", null)).toEqual({ generated: 21, skipped: 1, failed: 0 });
      expect(host.fetch).toHaveBeenCalledTimes(21);
      expect(host.store.getConfiguration(projects[20]!.id)).toEqual(manualBefore);
      expect(host.store.getConfiguration(projects[0]!.id).routingProfile).toMatchObject({
        ...generated, repositories: ["example/synthetic-0", "example/new"], source: "generated",
        learnedFor: learnedBefore.learnedFor, learnedNotFor: learnedBefore.learnedNotFor,
        learnedAt: learnedBefore.learnedAt, learnedFingerprint: learnedBefore.learnedFingerprint,
      });
      const count = host.fetch.mock.calls.length;
      await host.harness.behavior.callRpc("generateRoutingProfile", { projectId: projects[0]!.id });
      expect(host.fetch).toHaveBeenCalledTimes(count + 1);
      expect(host.store.getConfiguration(projects[0]!.id).routingProfile.description).toBe(generated.description);
      expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it("records routing traces without queued learning and learns only on the explicit command", async () => {
    const host = await fixture();
    const prompt = "Fix github.com/example/synthetic-0";
    try {
      host.harness.sdk.stub("threads.timeline", async () => ({
        rows: [{ kind: "conversation", role: "user", text: prompt, createdAt: new Date().toISOString() }],
        timelinePage: { hasOlderRows: false, olderCursor: null },
      }));
      await host.harness.behavior.callRpc("suggestProject", { prompt });
      const thread = makeThreadResponse({
        id: "synthetic-thread", projectId: projects[0]!.id, createdAt: Date.now(),
        parentThreadId: null, sourceThreadId: null, originPluginId: null, originKind: null,
      });
      await host.harness.behavior.emitThreadEvent("thread.created", { thread });
      await host.harness.behavior.emitThreadEvent("thread.active", { thread });
      await vi.advanceTimersByTimeAsync(0);
      expect(await host.bb.storage.kv.get("routing-traces")).toMatchObject({
        version: 1, traces: [{ threadId: thread.id, finalProjectId: projects[0]!.id, outcome: "hit" }],
      });
      const before = host.rows();
      const fileReads = host.harness.inspection.sdk.callsTo("projects.fileContent").length;
      await vi.advanceTimersByTimeAsync(61_000);
      expect(host.rows()).toEqual(before);
      expect(host.fetch).not.toHaveBeenCalled();
      expect(host.harness.inspection.sdk.callsTo("projects.fileContent")).toHaveLength(fileReads);
      const learned = await host.harness.behavior.runCli(["learn"]);
      expect(learned.exitCode).toBe(0);
      expect(JSON.parse(learned.stdout!)).toEqual({ learned: 1, skipped: 21, failed: 0 });
      expect(host.fetch).toHaveBeenCalledTimes(1);
      expect(host.store.getConfiguration(projects[0]!.id).routingProfile).toMatchObject({
        description: "Preserved description 0", keywords: ["saved keyword 0"],
        learnedFor: ["Explicitly learned synthetic guidance"], learnedNotFor: ["Explicit learned exclusion"],
      });
      expect(host.store.getConfiguration(projects[20]!.id).routingProfile.description).toBe("Preserved description 20");
    } finally { await host.harness.lifecycle.dispose(); }
  });
});
