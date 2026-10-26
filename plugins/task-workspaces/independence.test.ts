import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

afterEach(() => vi.unstubAllGlobals());

it("retains saved task state and credentials across reload without startup probes", async () => {
  const fetch = vi.fn(() => { throw new Error("Network forbidden in this fixture"); });
  vi.stubGlobal("fetch", fetch);
  const { bb, harness } = createFakePluginHost({ pluginId: "task-workspaces", experimental_declaredIconNames: ["tasks"], settings: {
    githubToken: "fixture-github-secret", linearToken: "fixture-linear-secret", akiflowRefreshToken: "fixture-akiflow-secret", printApiKey: "fixture-print-secret", agentWrites: "workflow", allowWrites: false,
  } });
  await plugin(bb);
  const clientId = await bb.storage.kv.get<string>("akiflow-client-id");
  const db = bb.storage.database();
  db.prepare("UPDATE provider_settings SET enabled = 1").run();
  db.prepare("INSERT INTO owners (id,name,is_me,active,updated_at) VALUES ('owner-fixture','Fixture',1,1,'2026-01-01')").run();
  db.prepare("INSERT INTO tasks (id,title,status,project_id,owner_id,agent_profile_id,list_position,created_at,updated_at) VALUES ('task-fixture','Saved task','blocked','project-fixture','owner-fixture','profile-fixture',3,'2026-01-01','2026-01-01')").run();
  const ref = db.prepare("INSERT INTO task_refs (task_id,provider,external_id,title,metadata,updated_at) VALUES ('task-fixture',?,?, 'Saved task',?,'2026-01-01')");
  ref.run("linear", "issue-fixture", JSON.stringify({ identifier: "FIX-42", priority: 2, sourceKey: "linear:team:fixture" }));
  ref.run("akiflow", "akiflow-fixture", "{}");
  db.prepare("INSERT INTO akiflow_identifiers (number,external_id) VALUES (42,'akiflow-fixture')").run();
  db.prepare("INSERT INTO task_threads (task_id,thread_id,environment_id,attached_at) VALUES ('task-fixture','thread-fixture','environment-fixture','2026-01-01')").run();
  db.prepare("INSERT INTO project_mappings VALUES ('linear:team:fixture','project-fixture','2026-01-01')").run();
  db.prepare("INSERT INTO github_repositories VALUES ('example/fixture','https://github.com/example/fixture',1,'2026-01-01')").run();
  db.prepare("INSERT INTO linear_sources VALUES ('linear:team:fixture','team','fixture','Fixture team',NULL,1,'2026-01-01')").run();
  db.prepare("UPDATE akiflow_sources SET enabled = 1 WHERE source_key = 'akiflow:inbox'").run();
  await bb.storage.kv.set("sync-cursor:linear", "saved-cursor");
  const snapshot = (database = db) => ["tasks", "task_refs", "task_threads", "owners", "akiflow_identifiers", "project_mappings", "github_repositories", "linear_sources", "akiflow_sources", "provider_settings"].map((table) => database.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  const reloaded = await harness.lifecycle.reload(plugin);
  expect(snapshot(reloaded.bb.storage.database())).toEqual(before);
  expect(await reloaded.bb.storage.kv.get("sync-cursor:linear")).toBe("saved-cursor");
  expect(await reloaded.bb.storage.kv.get("akiflow-client-id")).toBe(clientId);
  expect(await reloaded.harness.behavior.callRpc("providerSettings", null)).toMatchObject({
    providers: [{ provider: "akiflow", enabled: true, configured: true }, { provider: "linear", enabled: true, configured: true }, { provider: "github", enabled: true, configured: true }],
  });
  expect(reloaded.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  await reloaded.harness.lifecycle.dispose();
});

it("starts and resumes native BB task threads even when legacy Agent choices are stored", async () => {
  const network = vi.fn(() => { throw new Error("Network forbidden in this fixture"); });
  vi.stubGlobal("fetch", network);
  const { bb, harness } = createFakePluginHost({
    pluginId: "task-workspaces", experimental_declaredIconNames: ["tasks"],
    sdk: {
      projects: { list: async () => [{ id: "project-fixture", name: "Fixture", kind: "personal", gitRemoteUrl: null, sources: [], createdAt: 0, updatedAt: 0 }] },
      threads: {
        spawn: async () => makeThreadResponse({ id: "thread-native", projectId: "project-fixture", environmentId: "environment-native", title: "Saved task" }),
        get: async () => makeThreadResponse({ id: "thread-native", projectId: "project-fixture", environmentId: "environment-native", title: "Saved task" }),
        unarchive: async () => {},
        send: async () => {},
      },
    },
  });
  await bb.storage.kv.set("agentsIntegration", true);
  await plugin(bb);
  const db = bb.storage.database();
  db.prepare("UPDATE provider_settings SET enabled = 1 WHERE provider = 'akiflow'").run();
  db.prepare("UPDATE akiflow_sources SET enabled = 1 WHERE source_key = 'akiflow:inbox'").run();
  db.prepare("INSERT INTO tasks (id,title,status,project_id,agent_profile_id,created_at,updated_at) VALUES ('task-fixture','Saved task','doing','project-fixture','saved-profile','2026-01-01','2026-01-01')").run();
  db.prepare("INSERT INTO task_refs VALUES ('task-fixture','akiflow','external-fixture','Saved task',NULL,'{}','2026-01-01')").run();
  db.prepare("INSERT INTO akiflow_identifiers (number,external_id) VALUES (42,'external-fixture')").run();
  const started = await harness.behavior.runCli(["attach", "AKI-42"]);
  expect(started.exitCode).toBe(0);
  expect(JSON.parse(started.stdout)).toMatchObject({ id: "task-fixture", threadId: "thread-native", environmentId: "environment-native", status: "doing" });
  expect(db.prepare("SELECT thread_id, environment_id FROM task_threads WHERE task_id = 'task-fixture'").all()).toEqual([{ thread_id: "thread-native", environment_id: "environment-native" }]);
  expect(db.prepare("SELECT agent_profile_id FROM tasks WHERE id = 'task-fixture'").get()).toEqual({ agent_profile_id: "saved-profile" });
  const resumed = await harness.behavior.runCli(["attach", "AKI-42"]);
  expect(resumed.exitCode).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ threadId: "thread-native", environmentId: "environment-native" });
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(harness.inspection.sdk.callsTo("threads.unarchive")).toEqual([[{ threadId: "thread-native" }]]);
  expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([[expect.objectContaining({ threadId: "thread-native" })]]);
  expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  await harness.lifecycle.dispose();
});
