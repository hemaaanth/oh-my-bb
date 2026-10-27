import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../src/server.js";
const values = { projectEnvironments: true, catalog: true, agents: true, projects: true };
const input = { schemaVersion: 1, sourceGeneration: "synthetic-existing-baseline", sourceSemanticDigest: "d".repeat(64), values };
it("keeps fresh installs off and preserves imported existing behavior after reload", async () => {
  let fake = createFakePluginHost({ pluginId: "sandboxes" });
  await plugin(fake.bb);
  expect(await fake.harness.behavior.callRpc("integrations", null)).toEqual({ projectEnvironments: false, catalog: false, agents: false, projects: false });
  await expect(fake.harness.behavior.callRpc("importIntegrations", input, { experimental_caller: { kind: "plugin", pluginId: "fixture" } })).rejects.toThrow("Owner client required");
  await fake.harness.behavior.callRpc("importIntegrations", input);
  fake = await fake.harness.lifecycle.reload(plugin);
  expect(await fake.harness.behavior.callRpc("integrations", null)).toEqual(values);
  const previous = await fake.bb.storage.kv.get("integrations:v1");
  await fake.harness.behavior.callRpc("importIntegrations", input);
  expect(await fake.bb.storage.kv.get("integrations:v1")).toEqual(previous);
  await expect(fake.harness.behavior.callRpc("importIntegrations", { ...input, sourceSemanticDigest: "e".repeat(64) })).rejects.toThrow("mismatch");
  await fake.harness.dispose();
});
it("does not overwrite a saved explicit false during the existing-install import", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  await fake.bb.storage.kv.set("integrations:v1", { catalog: false });
  await plugin(fake.bb);
  expect(await fake.harness.behavior.callRpc("importIntegrations", input)).toEqual({ ...values, catalog: false });
  await fake.harness.dispose();
});

it("serializes concurrent named-flag revocations and preserves the import receipt across reload", async () => {
  let fake = createFakePluginHost({ pluginId: "sandboxes" });
  try {
    await plugin(fake.bb);
    await fake.harness.behavior.callRpc("importIntegrations", input);
    const imported = await fake.bb.storage.kv.get("integrations:v1");
    await Promise.all([
      fake.harness.behavior.callRpc("updateIntegrations", { name: "projectEnvironments", enabled: false }),
      fake.harness.behavior.callRpc("updateIntegrations", { name: "catalog", enabled: false }),
    ]);
    fake = await fake.harness.lifecycle.reload(plugin);
    expect(await fake.harness.behavior.callRpc("integrations", null)).toEqual({ ...values, projectEnvironments: false, catalog: false });
    expect(await fake.bb.storage.kv.get("integrations:v1")).toEqual({ ...(imported as object), projectEnvironments: false, catalog: false });
    await fake.harness.behavior.callRpc("importIntegrations", input);
    expect(await fake.harness.behavior.callRpc("integrations", null)).toEqual({ ...values, projectEnvironments: false, catalog: false });
  } finally { await fake.harness.dispose(); }
});

it("saves only the named explicit false so an authorized later import can fill untouched fields", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  try {
    await plugin(fake.bb);
    await fake.harness.behavior.callRpc("updateIntegrations", { name: "agents", enabled: false });
    expect(await fake.harness.behavior.callRpc("importIntegrations", input)).toEqual({ ...values, agents: false });
  } finally { await fake.harness.dispose(); }
});

it("rejects stale whole-map writes, invalid flags and non-owner patches without changing consent", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  try {
    await plugin(fake.bb);
    await fake.harness.behavior.callRpc("importIntegrations", input);
    for (const patch of [values, { name: "browser", enabled: true }, { name: "catalog", enabled: "false" }, { name: "catalog", enabled: false, projectEnvironments: true }]) {
      await expect(fake.harness.behavior.callRpc("updateIntegrations", patch)).rejects.toThrow();
    }
    await expect(fake.harness.behavior.callRpc("updateIntegrations", { name: "catalog", enabled: false }, { experimental_caller: { kind: "plugin", pluginId: "fixture" } })).rejects.toThrow();
    expect(await fake.harness.behavior.callRpc("integrations", null)).toEqual(values);
  } finally { await fake.harness.dispose(); }
});
