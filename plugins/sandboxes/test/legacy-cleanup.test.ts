import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { LegacySandboxCleanup } from "../src/legacy-cleanup.js";
import { sandboxMigrations, SandboxStore } from "../src/store.js";

function insertLegacy(
  db: Database.Database,
  input: { id: string; hostId: string; threadId: string | null },
): void {
  db.prepare(
    `INSERT INTO sandboxes (
       id, provider, provider_sandbox_id, project_id, project_name, host_id,
       project_source_id, thread_id, status, created_at, updated_at
     ) VALUES (?, 'daytona', ?, 'project_1', 'Project', ?, ?, ?, 'ready', ?, ?)`,
  ).run(
    input.id,
    `provider-${input.id}`,
    input.hostId,
    `source-${input.id}`,
    input.threadId,
    Date.now() - 60_000,
    Date.now() - 60_000,
  );
}

describe("legacy sandbox cleanup", () => {
  it("refuses manual deletion while an unarchived thread uses the host", async () => {
    const removeLegacy = vi.fn(async () => undefined);
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: {
          list: vi.fn(async () => [
            {
              id: "thread_live",
              environmentId: "environment_1",
              environmentHostId: "host_live",
              archivedAt: null,
              status: "idle",
              updatedAt: Date.now(),
            },
          ]),
        },
      },
    });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);
    insertLegacy(db, {
      id: "sandbox_live",
      hostId: "host_live",
      threadId: "thread_live",
    });
    const cleanup = new LegacySandboxCleanup(
      fake.bb,
      store,
      new Map([["daytona", { removeLegacy }]]),
    );

    await expect(
      cleanup.destroy("sandbox_live", { allowLiveThreads: false }),
    ).rejects.toThrow(/unarchived thread still uses host/u);
    expect(removeLegacy).not.toHaveBeenCalled();
    expect(store.getLegacySandbox("sandbox_live")?.status).toBe("ready");
    await fake.harness.dispose();
  });

  it("reaps provider, project source, host, and cleanup state on archive", async () => {
    const removeLegacy = vi.fn(async () => undefined);
    const deleteSource = vi.fn(async () => ({ ok: true as const }));
    const deleteHost = vi.fn(async () => ({ ok: true as const }));
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: { list: vi.fn(async () => []) },
        projects: { sources: { delete: deleteSource } },
        hosts: { delete: deleteHost },
      },
    });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);
    insertLegacy(db, {
      id: "sandbox_archived",
      hostId: "host_archived",
      threadId: "thread_archived",
    });
    const cleanup = new LegacySandboxCleanup(
      fake.bb,
      store,
      new Map([["daytona", { removeLegacy }]]),
    );

    await cleanup.handleFinishedThread("thread_archived");

    expect(removeLegacy).toHaveBeenCalledWith("provider-sandbox_archived");
    expect(deleteSource).toHaveBeenCalledWith({
      projectId: "project_1",
      sourceId: "source-sandbox_archived",
    });
    expect(deleteHost).toHaveBeenCalledWith({ hostId: "host_archived" });
    expect(store.getLegacySandbox("sandbox_archived")).toMatchObject({
      status: "destroyed",
      error: null,
    });
    expect(store.getLegacyCleanup("sandbox_archived")).toMatchObject({
      completedAt: expect.any(Number),
      providerSandboxDestroyedAt: expect.any(Number),
      hostDeletedAt: expect.any(Number),
      connectMachineRevokedAt: expect.any(Number),
    });
    await fake.harness.dispose();
  });

  it("discovers archived legacy rows after a plugin restart", async () => {
    const removeLegacy = vi.fn(async () => undefined);
    const fake = createFakePluginHost({
      pluginId: "sandboxes",
      sdk: {
        threads: {
          get: vi.fn(async () => ({
            id: "thread_old",
            archivedAt: Date.now() - 1_000,
            deletedAt: null,
          })),
          list: vi.fn(async () => []),
        },
        projects: {
          sources: { delete: vi.fn(async () => ({ ok: true as const })) },
        },
        hosts: { delete: vi.fn(async () => ({ ok: true as const })) },
      },
    });
    const db = fake.bb.storage.database();
    fake.bb.storage.migrate(db, [...sandboxMigrations]);
    const store = new SandboxStore(db);
    insertLegacy(db, {
      id: "sandbox_old",
      hostId: "host_old",
      threadId: "thread_old",
    });
    const cleanup = new LegacySandboxCleanup(
      fake.bb,
      store,
      new Map([["daytona", { removeLegacy }]]),
    );

    await cleanup.reconcile();
    await cleanup.cleanupDue();

    expect(store.getLegacySandbox("sandbox_old")?.status).toBe("destroyed");
    expect(removeLegacy).toHaveBeenCalledOnce();
    await fake.harness.dispose();
  });
});
