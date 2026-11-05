import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import compatibility from "./server.js";

it("keeps the old ID as a stateless one-way adapter and checks the actual caller", async () => {
  const calls: unknown[] = [];
  const h = createFakePluginHost({ pluginId: "project-environments", sdk: { plugins: { callRpc: async request => { calls.push(request); return { jobId: "713148eb-b424-4c50-a398-6b2144802ef0" }; } } } });
  compatibility(h.bb as unknown as Parameters<typeof compatibility>[0]);
  const input = { projectId: "project-a", hostId: "host", workspacePath: "/work", strict: false };
  try {
    await expect(h.harness.behavior.callRpc("startPrepare", input, { experimental_caller: { kind: "plugin", pluginId: "foreign" } })).rejects.toThrow("Use Projects");
    expect(calls).toEqual([]);
    await h.harness.behavior.callRpc("startPrepare", input, { experimental_caller: { kind: "plugin", pluginId: "sandboxes" } });
    expect(calls).toMatchObject([{ pluginId: "projects", method: "environment_startPrepare", input }]);
    expect(h.harness.inspection.registrations.services).toEqual([]);
  } finally { await h.harness.lifecycle.dispose(); }
});
