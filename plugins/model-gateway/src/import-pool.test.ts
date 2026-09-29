import fs from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, AccountSecret } from "./contracts.js";
import { importAccountPool } from "./import-pool.js";
import { AccountStore } from "./upstreams/store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function poolAccount(id: string, label: string): Account {
  return {
    id,
    provider: "claude",
    kind: "api-key",
    label,
    email: null,
    accountUuid: null,
    subscriptionType: null,
    rateLimitTier: null,
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: null,
    lastUsedHostId: null,
  };
}

function seedPoolDb(dataDir: string, accounts: Account[]): void {
  const db = new Database(path.join(dataDir, "bb.db"));
  db.exec(
    `CREATE TABLE plugin_kv (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )`,
  );
  db.prepare(
    "INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
  ).run("account-pool", "accounts:v1", JSON.stringify(accounts), Date.now());
  db.close();
}

async function writePoolSecret(
  dataDir: string,
  id: string,
  secret: AccountSecret,
): Promise<void> {
  const dir = path.join(
    dataDir,
    "plugins",
    "account-pool",
    "secrets",
    "accounts",
  );
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(dir, `account-${id}.json`),
    JSON.stringify(secret),
    { mode: 0o600 },
  );
}

describe("importAccountPool", () => {
  it("copies new accounts and secrets, preserves ids, and skips ones the gateway already has", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-import-pool-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const newId = "11111111-1111-4111-8111-111111111111";
    const existingId = "22222222-2222-4222-8222-222222222222";
    seedPoolDb(dataDir, [
      poolAccount(newId, "pool-new"),
      poolAccount(existingId, "pool-existing"),
    ]);
    await writePoolSecret(dataDir, newId, {
      kind: "api-key",
      apiKey: "sk-pool-new",
    });
    await writePoolSecret(dataDir, existingId, {
      kind: "api-key",
      apiKey: "sk-pool-existing-copy",
    });

    const host = createFakePluginHost({ pluginId: "model-gateway", dataDir });
    cleanups.push(() => host.harness.lifecycle.dispose());
    const secretsDir = path.join(
      dataDir,
      "plugins",
      "model-gateway",
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(host.bb.storage.kv, secretsDir);
    await accounts.importAccount(poolAccount(existingId, "gateway-existing"), {
      kind: "api-key",
      apiKey: "sk-gateway-existing",
    });

    const result = await importAccountPool({ dataDir, accounts, Database });

    expect(result.importedAccountIds).toEqual([newId]);
    expect(result.skippedExistingIds).toEqual([existingId]);
    expect(await accounts.get(newId)).toMatchObject({ label: "pool-new" });
    expect(await accounts.readSecret(newId)).toEqual({
      kind: "api-key",
      apiKey: "sk-pool-new",
    });
    // The already-present account's own secret is untouched by the import.
    expect(await accounts.readSecret(existingId)).toEqual({
      kind: "api-key",
      apiKey: "sk-gateway-existing",
    });
    const stat = await fs.stat(path.join(secretsDir, `account-${newId}.json`));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("imports nothing when the Account Pooler has no stored accounts", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-import-pool-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    seedPoolDb(dataDir, []);
    const host = createFakePluginHost({ pluginId: "model-gateway", dataDir });
    cleanups.push(() => host.harness.lifecycle.dispose());
    const accounts = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "plugins", "model-gateway", "secrets", "accounts"),
    );

    const result = await importAccountPool({ dataDir, accounts, Database });

    expect(result).toEqual({ importedAccountIds: [], skippedExistingIds: [] });
  });

  it("raises a clear error when the Account Pooler's database is missing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-import-pool-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const host = createFakePluginHost({ pluginId: "model-gateway", dataDir });
    cleanups.push(() => host.harness.lifecycle.dispose());
    const accounts = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "plugins", "model-gateway", "secrets", "accounts"),
    );

    await expect(importAccountPool({ dataDir, accounts, Database })).rejects.toThrow(
      "Account Pooler plugin",
    );
  });
});
