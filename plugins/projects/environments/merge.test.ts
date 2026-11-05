import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";
import { ProjectsStore } from "../store.js";

async function fixture() {
  const host = createFakePluginHost({ pluginId: "projects", sdk: { subscribe: () => () => {}, projects: { list: async () => [] }, plugins: { list: async () => ({ plugins: [] }) } } });
  await plugin(host.bb);
  const store = new ProjectsStore(host.bb.storage.database());
  store.markMigration("suite-v1");
  return { ...host, store, db: host.bb.storage.database() };
}
const fields = { name: "Synthetic development", environmentName: "development", environmentId: "synthetic-env", account: "example.1password.com", serviceAccountName: "Synthetic", confirmShared: false };

describe("Projects owns application environments", () => {
  it("creates the environment and project binding atomically without preparing or contacting a machine", async () => {
    const h = await fixture();
    try {
      const saved = await h.harness.behavior.callRpc("saveProjectEnvironment", { projectId: "project-a", expectedProfileId: null, expectedUpdatedAt: null, ...fields }) as { id: string; updatedAt: string };
      expect(h.store.getConfiguration("project-a").credentialId).toBe(saved.id);
      expect(h.db.prepare("SELECT name FROM runtime_profiles WHERE id=?").get(saved.id)).toEqual({ name: fields.name });
      expect(h.db.prepare("SELECT * FROM machine_preparations").all()).toEqual([]);
      expect(h.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
      await expect(h.harness.behavior.callRpc("saveProjectEnvironment", { projectId: "project-a", expectedProfileId: null, expectedUpdatedAt: null, ...fields, name: "Stale" })).rejects.toThrow("changed");
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM runtime_profiles").get()).toEqual({ n: 1 });
      await expect(h.harness.behavior.callRpc("setProjectEnvironmentToken", { projectId: "project-a", expectedProfileId: "wrong-environment", expectedUpdatedAt: saved.updatedAt, token: "synthetic-only", confirmShared: false })).rejects.toThrow("changed");
    } finally { await h.harness.lifecycle.dispose(); }
  });

  it("preserves unknown capabilities, descriptions and setup bytes through a metadata edit; refuses stale and unconfirmed shared edits", async () => {
    const h = await fixture();
    try {
      const saved = await h.harness.behavior.callRpc("saveProjectEnvironment", { projectId: "project-a", expectedProfileId: null, expectedUpdatedAt: null, ...fields }) as { id: string; updatedAt: string };
      h.db.prepare("UPDATE runtime_profiles SET description=?,capabilities=?,setup_script=?,instructions=?,updated_at='old' WHERE id=?").run("retained description", '["unknown-future-capability"]', "private retained setup\n", "retained instructions", saved.id);
      h.store.updateProject("project-b", { credentialId: saved.id });
      const before = h.db.prepare("SELECT * FROM runtime_profiles").all();
      const input = { projectId: "project-a", expectedProfileId: saved.id, expectedUpdatedAt: "old", ...fields, name: "Changed" };
      await expect(h.harness.behavior.callRpc("saveProjectEnvironment", input)).rejects.toThrow("shared");
      expect(h.db.prepare("SELECT * FROM runtime_profiles").all()).toEqual(before);
      await h.harness.behavior.callRpc("saveProjectEnvironment", { ...input, confirmShared: true });
      expect(h.db.prepare("SELECT description,capabilities,setup_script,instructions FROM runtime_profiles").get()).toEqual({ description: "retained description", capabilities: '["unknown-future-capability"]', setup_script: "private retained setup\n", instructions: "retained instructions" });
      await expect(h.harness.behavior.callRpc("saveProjectEnvironment", { ...input, confirmShared: true })).rejects.toThrow("changed");
      expect(h.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await h.harness.lifecycle.dispose(); }
  });

  it("rejects foreign preparation and CLI requests before any SDK or storage work", async () => {
    const h = await fixture();
    try {
      const caller = { experimental_caller: { kind: "plugin" as const, pluginId: "foreign" } };
      await expect(h.harness.behavior.callRpc("environment_startPrepare", { projectId: "project-a", hostId: "host", workspacePath: "/work", strict: false }, caller)).rejects.toThrow("Use Projects");
      await expect(h.harness.behavior.callRpc("environment_cli", { argv: ["prepare"] }, caller)).rejects.toThrow("Use bb project-env");
      expect(h.db.prepare("SELECT * FROM machine_preparations").all()).toEqual([]);
      expect(h.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
    } finally { await h.harness.lifecycle.dispose(); }
  });
});
