// SQLite access for endpoints and deliveries. The `secret` column holds the
// signing secret (standard-webhooks) or the SHA-256 of the token (bearer).
// No function here returns it to a caller outside the server.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuthMode, DeliveryView, EndpointConfig } from "../contract.js";

/** Stored config. `enabled` lives in its own column so a toggle never rewrites the config. */
export type StoredConfig = Omit<EndpointConfig, "enabled">;
export type EndpointRecord = {
  id: string;
  name: string;
  enabled: boolean;
  authMode: AuthMode;
  config: StoredConfig;
  secret: string;
  secretHint: string;
  secretUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
};
export type DeliveryStatus = DeliveryView["status"];
export type DeliveryResult = { threadId?: string; automationRunId?: string; automationRunStatus?: string };

/** What a claim found. `new` and `retry` mean: run the action now. */
export type Claim =
  | { kind: "new" | "retry"; deliveryId: string; attempts: number }
  | { kind: "duplicate"; deliveryId: string }
  | { kind: "busy"; deliveryId: string }
  | { kind: "limited" };

type EndpointRow = { id: string; name: string; enabled: number; auth_mode: AuthMode; config_json: string; secret: string; secret_hint: string; secret_updated_at: string; created_at: string; updated_at: string };
type DeliveryRow = { id: string; endpoint_id: string; dedupe_key: string | null; status: DeliveryStatus; attempts: number; duplicates: number; action_type: string; result_json: string | null; error: string | null; received_at: string; updated_at: string };

export const RETENTION_DAYS = 30;
export const RETAINED_PER_ENDPOINT = 500;

export const newEndpointId = () => `wh_${randomBytes(12).toString("hex")}`;
export const newDeliveryId = () => `whd_${randomBytes(12).toString("hex")}`;

const toEndpoint = (row: EndpointRow): EndpointRecord => ({
  id: row.id,
  name: row.name,
  enabled: row.enabled === 1,
  authMode: row.auth_mode,
  config: JSON.parse(row.config_json) as StoredConfig,
  secret: row.secret,
  secretHint: row.secret_hint,
  secretUpdatedAt: row.secret_updated_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toDeliveryView = (row: DeliveryRow): DeliveryView => {
  const result = row.result_json ? (JSON.parse(row.result_json) as DeliveryResult) : {};
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    status: row.status,
    attempts: row.attempts,
    duplicates: row.duplicates,
    actionType: row.action_type,
    threadId: result.threadId ?? null,
    automationRunId: result.automationRunId ?? null,
    automationRunStatus: result.automationRunStatus ?? null,
    error: row.error,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
};

export function createStore(db: Database.Database) {
  const endpointRow = db.prepare<[string], EndpointRow>("SELECT * FROM endpoints WHERE id = ?");
  const endpointRows = db.prepare<[], EndpointRow>("SELECT * FROM endpoints ORDER BY created_at, id");
  const insertEndpoint = db.prepare(
    "INSERT INTO endpoints (id, name, enabled, auth_mode, config_json, secret, secret_hint, secret_updated_at, created_at, updated_at) VALUES (@id, @name, @enabled, @authMode, @config, @secret, @hint, @now, @now, @now)",
  );
  const updateConfig = db.prepare("UPDATE endpoints SET name = @name, enabled = @enabled, auth_mode = @authMode, config_json = @config, updated_at = @now WHERE id = @id");
  const updateSecret = db.prepare("UPDATE endpoints SET secret = @secret, secret_hint = @hint, secret_updated_at = @now, updated_at = @now WHERE id = @id");
  const updateEnabled = db.prepare("UPDATE endpoints SET enabled = ?, updated_at = ? WHERE id = ?");
  const deleteEndpointRow = db.prepare("DELETE FROM endpoints WHERE id = ?");
  const deleteEndpointDeliveries = db.prepare("DELETE FROM deliveries WHERE endpoint_id = ?");

  const deliveryByKey = db.prepare<[string, string], DeliveryRow>("SELECT * FROM deliveries WHERE endpoint_id = ? AND dedupe_key = ?");
  const deliveryRows = db.prepare<[string, number], DeliveryRow>("SELECT * FROM deliveries WHERE endpoint_id = ? ORDER BY received_at DESC, id DESC LIMIT ?");
  const latestDelivery = db.prepare<[string], DeliveryRow>("SELECT * FROM deliveries WHERE endpoint_id = ? ORDER BY received_at DESC, id DESC LIMIT 1");
  const insertDelivery = db.prepare(
    "INSERT INTO deliveries (id, endpoint_id, dedupe_key, status, action_type, error, received_at, updated_at) VALUES (@id, @endpointId, @dedupeKey, @status, @actionType, @error, @now, @now)",
  );
  const countDuplicate = db.prepare("UPDATE deliveries SET duplicates = duplicates + 1, updated_at = ? WHERE id = ?");
  const reclaim = db.prepare("UPDATE deliveries SET status = 'processing', attempts = attempts + 1, error = NULL, action_type = ?, updated_at = ? WHERE id = ?");
  const finishDelivery = db.prepare("UPDATE deliveries SET status = @status, result_json = @result, error = @error, updated_at = @now WHERE id = @id");
  const pruneOld = db.prepare("DELETE FROM deliveries WHERE received_at < ? AND status <> 'processing'");
  const pruneOverflow = db.prepare(
    `DELETE FROM deliveries WHERE endpoint_id = ? AND id IN (
       SELECT id FROM deliveries WHERE endpoint_id = ? ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?
     )`,
  );

  const claimTx = db.transaction(
    (input: { endpointId: string; dedupeKey: string; actionType: string; now: string; staleBefore: string; allow: () => boolean }): Claim => {
      const existing = deliveryByKey.get(input.endpointId, input.dedupeKey);
      if (existing?.status === "succeeded") {
        countDuplicate.run(input.now, existing.id);
        return { kind: "duplicate", deliveryId: existing.id };
      }
      if (existing?.status === "processing" && existing.updated_at >= input.staleBefore) return { kind: "busy", deliveryId: existing.id };
      if (!input.allow()) return { kind: "limited" };
      if (existing) {
        reclaim.run(input.actionType, input.now, existing.id);
        return { kind: "retry", deliveryId: existing.id, attempts: existing.attempts + 1 };
      }
      const id = newDeliveryId();
      insertDelivery.run({ id, endpointId: input.endpointId, dedupeKey: input.dedupeKey, status: "processing", actionType: input.actionType, error: null, now: input.now });
      return { kind: "new", deliveryId: id, attempts: 1 };
    },
  );

  return {
    endpoint: (id: string) => {
      const row = endpointRow.get(id);
      return row ? toEndpoint(row) : null;
    },
    endpoints: () => endpointRows.all().map(toEndpoint),
    createEndpoint(input: { id: string; config: EndpointConfig; secret: string; secretHint: string; now: string }) {
      const { enabled, ...config } = input.config;
      insertEndpoint.run({ id: input.id, name: config.name, enabled: enabled ? 1 : 0, authMode: config.authMode, config: JSON.stringify(config), secret: input.secret, hint: input.secretHint, now: input.now });
    },
    updateEndpoint(id: string, input: { config: EndpointConfig; now: string }) {
      const { enabled, ...config } = input.config;
      updateConfig.run({ id, name: config.name, enabled: enabled ? 1 : 0, authMode: config.authMode, config: JSON.stringify(config), now: input.now });
    },
    setSecret(id: string, input: { secret: string; secretHint: string; now: string }) {
      updateSecret.run({ id, secret: input.secret, hint: input.secretHint, now: input.now });
    },
    setEnabled(id: string, enabled: boolean, now: string) {
      return updateEnabled.run(enabled ? 1 : 0, now, id).changes > 0;
    },
    deleteEndpoint: db.transaction((id: string) => {
      deleteEndpointDeliveries.run(id);
      return deleteEndpointRow.run(id).changes > 0;
    }),
    /** Classifies and records one delivery in a single transaction. `allow` is the rate limit; it runs only when the action would run. */
    claim: (input: Parameters<typeof claimTx>[0]) => claimTx(input),
    finish(id: string, input: { status: "succeeded" | "failed"; result: DeliveryResult | null; error: string | null; now: string }) {
      finishDelivery.run({ id, status: input.status, result: input.result ? JSON.stringify(input.result) : null, error: input.error, now: input.now });
    },
    /** A body that authenticated but failed the endpoint's shape. It has no dedupe key, so a fixed retry is processed. */
    recordRejected(input: { endpointId: string; actionType: string; error: string; now: string }) {
      const id = newDeliveryId();
      insertDelivery.run({ id, endpointId: input.endpointId, dedupeKey: null, status: "rejected", actionType: input.actionType, error: input.error, now: input.now });
      return id;
    },
    deliveries: (endpointId: string, limit: number) => deliveryRows.all(endpointId, limit).map(toDeliveryView),
    lastDelivery: (endpointId: string) => {
      const row = latestDelivery.get(endpointId);
      return row ? { status: row.status, receivedAt: row.received_at } : null;
    },
    /** Drops deliveries older than the retention window and all but the newest per endpoint. */
    prune: db.transaction((now: Date) => {
      const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
      let removed = pruneOld.run(cutoff).changes;
      for (const row of endpointRows.all()) removed += pruneOverflow.run(row.id, row.id, RETAINED_PER_ENDPOINT).changes;
      return removed;
    }),
  };
}
export type Store = ReturnType<typeof createStore>;
