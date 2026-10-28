import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server";

const read = rpcContract.getIntegrations.output;
const enabled = { agentsIntegration: true, projectsIntegration: false, tasksIntegration: true };

describe("Oh My BB integration preferences", () => {
  it("imports saved native flag IDs once without changing sidebar state and removes native editors after reload", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "status-sidebar", settings: enabled });
    await plugin(bb);
    await harness.behavior.callRpc("setSnoozed", { threadId: "fixture-thread", untilAt: Date.now() + 60_000 });
    await harness.behavior.callRpc("setThreadOrder", { workspaceId: "fixture-order", threadIds: ["fixture-second", "fixture-first"] });
    const snoozed = await harness.behavior.callRpc("listSnoozed", null);
    expect(read.parse(await harness.behavior.callRpc("getIntegrations", null))).toEqual({ values: enabled, migrationPending: true });
    const next = await harness.lifecycle.reload(plugin);
    try {
      expect(read.parse(await next.harness.behavior.callRpc("getIntegrations", null))).toEqual({ values: enabled, migrationPending: false });
      expect(await next.harness.behavior.callRpc("listSnoozed", null)).toEqual(snoozed);
      expect(await next.harness.behavior.callRpc("listThreadOrder", { workspaceId: "fixture-order" })).toEqual({ threadIds: ["fixture-second", "fixture-first"] });
      await expect(next.harness.behavior.setSettings({ agentsIntegration: false })).rejects.toThrow(/unknown setting/i);
      expect(next.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await next.harness.lifecycle.dispose(); }
  });

  it("retains custom writes and native edits made before the finishing reload without clobbering unrelated flags", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "status-sidebar", settings: enabled });
    await plugin(bb);
    await harness.behavior.callRpc("setIntegrations", { agentsIntegration: false });
    await harness.behavior.setSettings({ projectsIntegration: true });
    await vi.waitFor(async () => expect(read.parse(await harness.behavior.callRpc("getIntegrations", null)).values).toEqual({ agentsIntegration: false, projectsIntegration: true, tasksIntegration: true }));
    const next = await harness.lifecycle.reload(plugin);
    try {
      expect(read.parse(await next.harness.behavior.callRpc("getIntegrations", null)).values).toEqual({ agentsIntegration: false, projectsIntegration: true, tasksIntegration: true });
      expect(next.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await next.harness.lifecycle.dispose(); }
  });

  it("serializes disjoint updates and keeps the accepted values on a failed storage write", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "status-sidebar" });
    await plugin(bb);
    await Promise.all([
      harness.behavior.callRpc("setIntegrations", { agentsIntegration: true }),
      harness.behavior.callRpc("setIntegrations", { tasksIntegration: true }),
    ]);
    const saved = read.parse(await harness.behavior.callRpc("getIntegrations", null));
    const write = vi.spyOn(bb.storage.kv, "set").mockRejectedValueOnce(new Error("Fixture storage failure"));
    try {
      await expect(harness.behavior.callRpc("setIntegrations", { agentsIntegration: false })).rejects.toThrow("Fixture storage failure");
      expect(read.parse(await harness.behavior.callRpc("getIntegrations", null))).toEqual(saved);
      await expect(harness.behavior.callRpc("setIntegrations", { tasksIntegration: "yes" })).rejects.toThrow();
      await harness.behavior.callRpc("setIntegrations", { projectsIntegration: true });
      expect(read.parse(await harness.behavior.callRpc("getIntegrations", null)).values).toEqual({ agentsIntegration: true, projectsIntegration: true, tasksIntegration: true });
      expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { write.mockRestore(); await harness.lifecycle.dispose(); }
  });
});
