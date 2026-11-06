import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CatalogStore, migrations } from "./store.js";

const NATIVE = "2f576f36-0d16-4f76-9a21-b66bcb47e100";

function makeStore() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of migrations) db.exec(migration);
  return new CatalogStore(db);
}

const tables = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);

describe("Catalog store", () => {
  it("drops the generated Executor sets and their columns from databases that had them", () => {
    const db = new Database(":memory:");
    const drop = migrations.findIndex((migration) => migration.startsWith("DROP INDEX catalog_bundles_executor_integration"));
    for (const migration of migrations.slice(0, drop)) db.exec(migration);
    db.prepare(`INSERT INTO catalog_bundles (id, name, description, skill_ids, executor_connections, executor_integration, created_at, updated_at)
      VALUES ('generated', 'Argus (Executor)', '', '[]', '["argus.*"]', 'argus', 'now', 'now'), ('custom', 'Mine', '', '[]', '[]', NULL, 'now', 'now')`).run();
    db.exec(migrations[drop]!);
    expect(db.prepare("SELECT id FROM catalog_bundles").all()).toEqual([{ id: "custom" }]);
    expect((db.prepare("PRAGMA table_info(catalog_bundles)").all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("executor_connections");
  });

  it("drops Git sources, skill sets, and old assignments, and keeps native capabilities", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const v2 = migrations.findIndex((migration) => migration.includes("DROP TABLE catalog_skill_states"));
    for (const migration of migrations.slice(0, v2)) db.exec(migration);
    db.exec(`INSERT INTO catalog_sources (id, name, repository_url, git_ref, subdirectory, update_policy, enabled, created_at, updated_at)
        VALUES ('src', 'hstack', 'https://example.invalid/hstack.git', 'main', '', 'automatic', 1, 'now', 'now');
      INSERT INTO catalog_bundles (id, name, description, skill_ids, source_id, created_at, updated_at) VALUES
        ('pkg', 'hstack', '', '[]', 'src', 'now', 'now'),
        ('set', 'My set', '', '[]', NULL, 'now', 'now'),
        ('${NATIVE}', 'Native', '', '[]', NULL, 'now', 'now');
      INSERT INTO catalog_native_capabilities (bundle_id, plugin_id, tool_ids, skill_ids, setup_json, assignment_changed_rpc, updated_at)
        VALUES ('${NATIVE}', 'fixture-native', '["fixture_action"]', '[]', '[]', NULL, 'now');`);
    for (const migration of migrations.slice(v2)) db.exec(migration);

    for (const gone of ["catalog_releases", "catalog_release_skills", "catalog_skill_states", "catalog_assignments", "catalog_assignment_records"]) expect(tables(db)).not.toContain(gone);
    const store = new CatalogStore(db);
    expect(store.listBundles().map((bundle) => [bundle.id, bundle.nativeCapability?.pluginId])).toEqual([[NATIVE, "fixture-native"]]);
  });

  it("stores one grant per connection and replaces it on a new sign-in", () => {
    const store = makeStore();
    const grant = { connection: "gtm", origin: "https://executor.test", clientId: "client_1", redirectUri: "https://bb.test/cb", accessToken: "at_1", refreshToken: "rt_1", expiresAt: 1 };
    store.saveGrant(grant);
    store.saveGrant({ ...grant, connection: "ops" });
    store.saveGrant({ ...grant, accessToken: "at_2", refreshToken: null, expiresAt: 2 });
    expect(store.grants()).toEqual([{ ...grant, accessToken: "at_2", refreshToken: null, expiresAt: 2 }, { ...grant, connection: "ops" }]);
    store.deleteGrant("gtm");
    expect(store.grants().map((row) => row.connection)).toEqual(["ops"]);
  });

  it("saves a native capability once and reports only real changes", () => {
    const store = makeStore();
    const input = { id: NATIVE, pluginId: "fixture-native", name: "Fixture", description: "Synthetic", toolIds: ["fixture_action"], skillIds: [], setup: [], assignmentChangedRpc: null };
    expect(store.saveNativeCapability(input).changed).toBe(true);
    expect(store.saveNativeCapability(input).changed).toBe(false);
    expect(store.saveNativeCapability({ ...input, toolIds: ["other"] }).bundle.nativeCapability?.toolIds).toEqual(["other"]);
    expect(() => store.requireBundle("missing")).toThrow("Unknown native capability: missing");
  });
});
