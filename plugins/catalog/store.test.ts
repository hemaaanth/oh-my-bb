import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogStore, migrations } from "./store.js";
import { syncCatalogSource } from "./sync.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "bb-catalog-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeStore() {
  const db = new Database(":memory:");
  for (const migration of migrations) db.exec(migration);
  db.pragma("foreign_keys = ON");
  return new CatalogStore(db);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Catalog", () => {
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

  it("imports folded metadata and binary assets from a Git source", async () => {
    const repository = temporaryDirectory();
    mkdirSync(join(repository, "skills", "example"), { recursive: true });
    writeFileSync(join(repository, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: >-\n  A useful skill from an\n  upstream repository.\n---\n\nUse it.\n");
    writeFileSync(join(repository, "skills", "example", "asset.bin"), Buffer.from([0, 255, 1, 2]));
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "-c", "user.name=Catalog Test", "-c", "user.email=catalog@example.invalid", "commit", "--quiet", "-m", "initial"]);

    const store = makeStore();
    const source = store.saveSource({ name: "Upstream", repositoryUrl: repository, gitRef: "HEAD", subdirectory: "skills", updatePolicy: "automatic", enabled: true });
    await syncCatalogSource(store, source);

    const [skill] = store.listApprovedSkills();
    expect(skill?.description).toBe("A useful skill from an upstream repository.");
    expect(skill?.files.find((file) => file.path === "asset.bin")?.contentEncoding).toBe("base64");
  });

  it("combines global, project, environment, and agent bundle assignments", () => {
    const store = makeStore();
    const source = store.saveSource({ name: "Local", repositoryUrl: "https://example.invalid/skills.git", gitRef: "main", subdirectory: "", updatePolicy: "automatic", enabled: true });
    store.saveRelease(source.id, "abc123", [{
      skillId: "review", name: "review", description: "Review code", relativePath: "review", digest: "digest",
      files: [{ path: "SKILL.md", content: "---\nname: review\ndescription: Review code\n---\n", contentEncoding: "utf8" }],
    }], true);
    const skillId = store.listApprovedSkills()[0]!.id;
    const bundle = store.saveBundle({ name: "Engineering", description: "", skillIds: [skillId] });
    store.setAssignment(bundle.id, "agent-profile", "agent-1", true);
    expect(store.effectiveSkills({ projectId: "other", agentProfileId: "agent-1" }).map((skill) => skill.id)).toEqual([skillId]);
    expect(store.effectiveSkills({ projectId: "other", agentProfileId: "agent-2" })).toEqual([]);
    expect(store.machineSkills()).toEqual([]);
    expect(store.workspaceSkills({ projectId: "other" })).toEqual([]);
  });

  it("gives every source an assignable package that follows per-skill switches", () => {
    const store = makeStore();
    const source = store.saveSource({ name: "Local", repositoryUrl: "https://example.invalid/skills.git", gitRef: "main", subdirectory: "", updatePolicy: "automatic", enabled: true });
    store.saveRelease(source.id, "abc123", [
      { skillId: "review", name: "review", description: "Review code", relativePath: "review", digest: "one", files: [] },
      { skillId: "teach", name: "teach", description: "Teach a topic", relativePath: "teach", digest: "two", files: [] },
    ], true);

    const pkg = store.listBundles().find((bundle) => bundle.sourceId === source.id);
    expect(pkg?.name).toBe("Local");
    expect(pkg?.skillIds).toHaveLength(2);

    store.setSkillEnabled(`${source.id}:teach`, false);
    expect(store.requireBundle(pkg!.id).skillIds).toEqual([`${source.id}:review`]);
    expect(store.listApprovedSkills().map((skill) => skill.name)).toEqual(["review"]);
    expect(store.listApprovedSkills({ includeDisabled: true }).map((skill) => [skill.name, skill.enabled])).toEqual([["review", true], ["teach", false]]);

    store.setAssignment(pkg!.id, "project", "proj-1", true);
    expect(store.effectiveSkills({ projectId: "proj-1" }).map((skill) => skill.name)).toEqual(["review"]);
    expect(store.machineSkills()).toEqual([]);
    expect(store.workspaceSkills({ projectId: "proj-1" }).map((skill) => skill.name)).toEqual(["review"]);
    expect(store.workspaceSkills({ projectId: "proj-2" })).toEqual([]);

    store.setAssignment(pkg!.id, "global", "*", true);
    expect(store.machineSkills().map((skill) => skill.name)).toEqual(["review"]);
    expect(store.workspaceSkills({ projectId: "proj-1" })).toEqual([]);
    store.setAssignment(pkg!.id, "global", "*", false);

    store.deleteSource(source.id);
    expect(store.listBundles()).toEqual([]);
  });
});
