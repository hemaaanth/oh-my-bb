// New in the gateway: plan decision 8.2. `bb gateway import-pool` copies the
// core Account Pooler's account metadata and secret files into the gateway's
// own store, preserving account ids (the Pooler keeps its own copies; this
// is a copy, not a move). Reads the Pooler's own kv row directly out of the
// shared bb.db (see AccountStore.list()/ACCOUNTS_KEY in upstreams/store.ts
// for the row this mirrors) and its secret files from its own data
// directory (see AccountStore.initialize()/writeSecret() for the layout).
// Never logs secret contents.
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  accountSchema,
  accountSecretSchema,
  type Account,
  type AccountSecret,
} from "./contracts.js";
import type { AccountStore } from "./upstreams/store.js";

const ACCOUNT_POOL_PLUGIN_ID = "account-pool";
const ACCOUNTS_KV_KEY = "accounts:v1";
const poolAccountsSchema = z.array(accountSchema);

export interface ImportPoolResult {
  importedAccountIds: string[];
  skippedExistingIds: string[];
}

export interface ImportAccountPoolOptions {
  dataDir: string;
  accounts: AccountStore;
  /** bb does not serve `better-sqlite3` to plugins; pass the server's class (`bb.storage.database().constructor`). */
  Database: typeof Database;
}

export async function importAccountPool(
  options: ImportAccountPoolOptions,
): Promise<ImportPoolResult> {
  const poolAccounts = readPoolAccounts(options.dataDir, options.Database);
  const existingIds = new Set(
    (await options.accounts.list()).map((account) => account.id),
  );
  const secretsDir = path.join(
    options.dataDir,
    "plugins",
    ACCOUNT_POOL_PLUGIN_ID,
    "secrets",
    "accounts",
  );
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const account of poolAccounts) {
    if (existingIds.has(account.id)) {
      skipped.push(account.id);
      continue;
    }
    const secret = await readPoolSecret(secretsDir, account.id);
    await options.accounts.importAccount(account, secret);
    imported.push(account.id);
  }
  return { importedAccountIds: imported, skippedExistingIds: skipped };
}

function readPoolAccounts(dataDir: string, Sqlite: typeof Database): Account[] {
  const dbPath = path.join(dataDir, "bb.db");
  let db: Database.Database;
  try {
    db = new Sqlite(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(
      `Could not open the Account Pooler plugin database ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const row = db
      .prepare("SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?")
      .get(ACCOUNT_POOL_PLUGIN_ID, ACCOUNTS_KV_KEY) as
      | { value: string }
      | undefined;
    if (row === undefined) return [];
    return poolAccountsSchema.parse(JSON.parse(row.value));
  } finally {
    db.close();
  }
}

async function readPoolSecret(
  secretsDir: string,
  id: string,
): Promise<AccountSecret> {
  z.string().uuid().parse(id);
  const filePath = path.join(secretsDir, `account-${id}.json`);
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  return accountSecretSchema.parse(parsed);
}
