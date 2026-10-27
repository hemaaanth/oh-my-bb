import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { loadSandboxSettings } from "../src/settings-preferences.js";
import { setImmediate as tick } from "node:timers/promises";

it("moves behavior once, preserves native auth identity and keeps destination false/empty", async () => {
  let fake = createFakePluginHost({ pluginId: "sandboxes", settings: { sshEnabled: true, copyGitHubCliAuth: false, defaultSizeTier: "XL", browserExitNode: "old-fixture-route", gitToken: "synthetic-secret", freestyleApiKey: "synthetic-provider-key" } });
  await fake.bb.storage.kv.set("preferences:v1", { values: { sshEnabled: false, browserExitNode: "" }, revision: 2 });
  let settings = await loadSandboxSettings(fake.bb);
  expect(settings.view()).toMatchObject({ migrationPending: true, revision: 2, values: { sshEnabled: false, copyGitHubCliAuth: false, defaultSizeTier: "XL", browserExitNode: "" } });
  const before = await settings.get();
  const receipt = await fake.bb.storage.kv.get("preferences:v1");
  fake = await fake.harness.lifecycle.reload(async bb => { settings = await loadSandboxSettings(bb); });
  expect(settings.view().migrationPending).toBe(false);
  expect(await settings.get()).toEqual(before);
  expect(await fake.bb.storage.kv.get("preferences:v1")).toEqual(receipt);
  const descriptors = fake.harness.inspection.registrations.settingsDescriptors;
  expect(descriptors).not.toHaveProperty("sshEnabled");
  expect(descriptors).not.toHaveProperty("defaultSizeTier");
  expect(descriptors.gitToken).toMatchObject({ secret: true });
  expect(descriptors.freestyleApiKey).toMatchObject({ secret: true });
  expect(fake.harness.inspection.sdk.calls).toEqual([]);
  await fake.harness.dispose();
});

it("rejects stale saves, keeps no-op state identical and never executes setup on save", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const settings = await loadSandboxSettings(fake.bb);
  const before = await fake.bb.storage.kv.get("preferences:v1");
  await settings.update({ expectedRevision: 0, values: {} });
  expect(await fake.bb.storage.kv.get("preferences:v1")).toEqual(before);
  await settings.update({ expectedRevision: 0, values: { idleSleepAfter: "Never", copyGitHubCliAuth: false } });
  await expect(settings.update({ expectedRevision: 0, values: { copyGitHubCliAuth: true } })).rejects.toThrow("changed");
  expect(settings.view().values.copyGitHubCliAuth).toBe(false);
  expect(fake.harness.inspection.sdk.calls).toEqual([]);
  await fake.harness.dispose();
});

it("preserves successive old native writes during the finishing-reload generation", async () => {
  const fake = createFakePluginHost({ pluginId: "sandboxes" });
  const settings = await loadSandboxSettings(fake.bb);
  await Promise.all([
    fake.harness.behavior.setSettings({ defaultSizeTier: "L" }),
    fake.harness.behavior.setSettings({ defaultSizeTier: "XL", copyGitHubCliAuth: false }),
  ]);
  await tick();
  expect(settings.view().values).toMatchObject({ defaultSizeTier: "XL", copyGitHubCliAuth: false });
  await fake.harness.dispose();
});
