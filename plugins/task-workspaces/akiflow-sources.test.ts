import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./migrations";
import plugin from "./server";

const hostOptions = { pluginId: "task-workspaces", experimental_declaredIconNames: ["tasks"], settings: { akiflowRefreshToken: "fixture-refresh" } };
afterEach(() => vi.unstubAllGlobals());

function mockAkiflow() {
  const state = {
    labels: [
      { id: "folder", title: "Work", type: "folder", parent_id: null },
      { id: "alpha", title: "Alpha", type: "project", parent_id: "folder" },
      { id: "beta", title: "Beta", type: "project", parent_id: "folder" },
    ],
    tasks: [
      { id: "task-alpha", title: "Alpha task", listId: "alpha" },
      { id: "task-beta", title: "Beta task", listId: "beta" },
      { id: "task-inbox", title: "Inbox task", listId: null },
    ],
    failLabels: false,
    taskGate: null as Promise<void> | null,
    taskStarted: () => {},
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://web.akiflow.com/oauth/refreshToken") return Response.json({ access_token: "fixture-access" });
    if (init?.method && init.method !== "GET") throw new Error("External writes forbidden in this fixture");
    if (url.startsWith("https://api.akiflow.com/v5/labels")) {
      if (state.failLabels) return new Response("Unavailable", { status: 503 });
      return Response.json({ data: state.labels, has_next_page: false });
    }
    if (url.startsWith("https://api.akiflow.com/v5/tasks")) {
      state.taskStarted();
      await state.taskGate;
      return Response.json({ data: state.tasks, has_next_page: false });
    }
    if (url.startsWith("https://api.akiflow.com/v5/tags")) return Response.json({ data: [], has_next_page: false });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { state, fetch };
}

it("migrates existing projects, Inbox, identifiers, mappings, ownership, and attached chats without network access", async () => {
  const network = vi.fn(() => { throw new Error("Network forbidden during migration"); });
  vi.stubGlobal("fetch", network);
  let host = createFakePluginHost(hostOptions);
  const db = host.bb.storage.database();
  // Schema shipped before Akiflow project selection. Keep this boundary fixed.
  db.pragma("foreign_keys = OFF");
  host.bb.storage.migrate(db, [...MIGRATIONS.slice(0, 23)]);
  db.pragma("foreign_keys = ON");
  db.prepare("UPDATE provider_settings SET enabled = 1 WHERE provider = 'akiflow'").run();
  db.prepare("INSERT INTO owners VALUES ('owner','Fixture owner',1,1,'2026-01-01')").run();
  const insertTask = db.prepare("INSERT INTO tasks (id,title,status,project_id,owner_id,agent_profile_id,list_position,created_at,updated_at) VALUES (?,?,'blocked','bb-project','owner','saved-profile',7,'2026-01-01','2026-01-01')");
  insertTask.run("alpha-local", "Saved project task");
  insertTask.run("inbox-local", "Saved Inbox task");
  const insertRef = db.prepare("INSERT INTO task_refs VALUES (?,'akiflow',?,?,NULL,?,'2026-01-01')");
  insertRef.run("alpha-local", "alpha-external", "Saved project task", JSON.stringify({ sourceKey: "akiflow:project:alpha", projectPath: "Work / Alpha" }));
  insertRef.run("inbox-local", "inbox-external", "Saved Inbox task", "{}");
  db.prepare("INSERT INTO akiflow_identifiers (number,external_id) VALUES (42,'alpha-external'),(57,'inbox-external')").run();
  db.prepare("INSERT INTO task_threads VALUES ('alpha-local','saved-thread','saved-environment',1,'2026-01-01')").run();
  db.prepare("INSERT INTO project_mappings VALUES ('akiflow:project:alpha','bb-project','2026-01-01'),('akiflow:project:empty','bb-project','2026-01-01')").run();
  await host.bb.storage.kv.set("akiflow-client-id", "d94215ce-e919-4f8d-b8b0-3d2be8818880");
  const snapshot = (database = db) => ["tasks", "task_refs", "owners", "task_threads", "project_mappings", "akiflow_identifiers", "provider_settings"].map(table => database.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  await plugin(host.bb);
  expect(await host.harness.behavior.callRpc("akiflowSources", null)).toMatchObject({ sources: [
    { key: "akiflow:project:empty", enabled: true },
    { key: "akiflow:inbox", name: "Inbox", enabled: true },
    { key: "akiflow:project:alpha", name: "Work / Alpha", enabled: true },
  ] });
  expect(snapshot()).toEqual(before);
  host = await host.harness.lifecycle.reload(plugin);
  expect(snapshot(host.bb.storage.database())).toEqual(before);
  expect(await host.bb.storage.kv.get("akiflow-client-id")).toBe("d94215ce-e919-4f8d-b8b0-3d2be8818880");
  expect(network).not.toHaveBeenCalled();
  await host.harness.lifecycle.dispose();
});

it("syncs only selected projects or Inbox, keeps linked tasks when deselected, and preserves choices on discovery failure and reload", async () => {
  const { state } = mockAkiflow();
  let host = createFakePluginHost(hostOptions);
  await plugin(host.bb);
  await host.harness.behavior.callRpc("setProviderEnabled", { provider: "akiflow", enabled: true });
  expect(await host.harness.behavior.callRpc("refreshAkiflowSources", null)).toEqual({ configured: true, sources: [
    { key: "akiflow:inbox", name: "Inbox", enabled: false },
    { key: "akiflow:project:alpha", name: "Work / Alpha", enabled: false },
    { key: "akiflow:project:beta", name: "Work / Beta", enabled: false },
  ] });
  await host.harness.behavior.callRpc("setAkiflowSourceEnabled", { key: "akiflow:project:alpha", enabled: true });
  await host.harness.behavior.runSchedule("sync");
  expect(await host.harness.behavior.callRpc("listTasks", null)).toMatchObject({ tasks: [{ title: "Alpha task", identifier: "AKI-1" }] });
  await host.harness.behavior.callRpc("setAkiflowSourceEnabled", { key: "akiflow:inbox", enabled: true });
  await host.harness.behavior.runSchedule("sync");
  const db = host.bb.storage.database();
  const alpha = db.prepare("SELECT task_id FROM task_refs WHERE external_id = 'task-alpha'").get() as { task_id: string };
  db.prepare("UPDATE provider_settings SET enabled = 1 WHERE provider = 'github'").run();
  db.prepare("INSERT INTO github_repositories VALUES ('example/fixture','https://github.com/example/fixture',1,'2026-01-01')").run();
  db.prepare("INSERT INTO task_refs VALUES (?,'github','github-linked','Alpha task','https://github.com/example/fixture/issues/7',?,'2026-01-01')")
    .run(alpha.task_id, JSON.stringify({ ownerRepo: "example/fixture", number: 7 }));
  db.prepare("INSERT INTO task_threads VALUES (?,'linked-chat','linked-environment',1,'2026-01-01')").run(alpha.task_id);
  await host.harness.behavior.callRpc("setAkiflowSourceEnabled", { key: "akiflow:project:alpha", enabled: false });
  expect(db.prepare("SELECT provider FROM task_refs WHERE task_id = ?").all(alpha.task_id)).toEqual([{ provider: "github" }]);
  expect(db.prepare("SELECT thread_id FROM task_threads WHERE task_id = ?").all(alpha.task_id)).toEqual([{ thread_id: "linked-chat" }]);
  await host.harness.behavior.callRpc("setAllAkiflowSourcesEnabled", { enabled: false });
  expect(db.prepare("SELECT id FROM tasks").all()).toEqual([{ id: alpha.task_id }]);
  await host.harness.behavior.callRpc("setAkiflowSourceEnabled", { key: "akiflow:project:alpha", enabled: true });
  await host.harness.behavior.runSchedule("sync");
  expect(db.prepare("SELECT number FROM akiflow_identifiers WHERE external_id = 'task-alpha'").get()).toEqual({ number: 1 });
  const saved = await host.harness.behavior.callRpc("akiflowSources", null);
  state.failLabels = true;
  await expect(host.harness.behavior.callRpc("refreshAkiflowSources", null)).rejects.toThrow("Unavailable");
  expect(await host.harness.behavior.callRpc("akiflowSources", null)).toEqual(saved);
  host = await host.harness.lifecycle.reload(plugin);
  expect(await host.harness.behavior.callRpc("akiflowSources", null)).toEqual(saved);
  await host.harness.lifecycle.dispose();
});

it("does not re-import a project disabled during an in-flight sync", async () => {
  const { state } = mockAkiflow();
  const { bb, harness } = createFakePluginHost(hostOptions);
  await plugin(bb);
  await harness.behavior.callRpc("setProviderEnabled", { provider: "akiflow", enabled: true });
  await harness.behavior.callRpc("refreshAkiflowSources", null);
  await harness.behavior.callRpc("setAkiflowSourceEnabled", { key: "akiflow:project:alpha", enabled: true });
  await harness.behavior.runSchedule("sync");
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  state.taskStarted = started.resolve;
  state.taskGate = gate.promise;
  const syncing = harness.behavior.runSchedule("sync");
  await started.promise;
  await harness.behavior.callRpc("setAkiflowSourceEnabled", { key: "akiflow:project:alpha", enabled: false });
  gate.resolve();
  await syncing;
  expect(await harness.behavior.callRpc("listTasks", null)).toMatchObject({ tasks: [] });
  expect(bb.storage.database().prepare("SELECT number FROM akiflow_identifiers WHERE external_id = 'task-alpha'").get()).toEqual({ number: 1 });
  await harness.lifecycle.dispose();
});

it("offers only selected creation destinations and refuses an unchecked destination before contacting Akiflow", async () => {
  const { fetch } = mockAkiflow();
  const { bb, harness } = createFakePluginHost(hostOptions);
  await plugin(bb);
  await harness.behavior.callRpc("setProviderEnabled", { provider: "akiflow", enabled: true });
  await harness.behavior.callRpc("refreshAkiflowSources", null);
  await harness.behavior.callRpc("setAkiflowSourceEnabled", { key: "akiflow:project:alpha", enabled: true });
  expect(await harness.behavior.callRpc("createTaskOptions", null)).toMatchObject({ providers: [{ provider: "akiflow", destinations: [
    { id: "akiflow:project:alpha", label: "Work / Alpha" },
  ] }] });
  const requests = fetch.mock.calls.length;
  await expect(harness.behavior.callRpc("createTask", { provider: "akiflow", destinationId: "akiflow:project:beta", title: "Not selected", description: "", priority: null, ownerId: null })).rejects.toThrow("Select this Akiflow project or Inbox");
  expect(fetch.mock.calls.length).toBe(requests);
  await harness.lifecycle.dispose();
});
