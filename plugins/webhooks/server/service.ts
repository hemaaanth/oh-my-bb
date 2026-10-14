// Endpoint management shared by RPC, the CLI, and the UI.
// A secret leaves this module only in the return value of create, rotate,
// or an update that changes the auth mode, and only when the plugin generated it.
// Slack issues its own signing secret, so a slack endpoint always imports one.
import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DELIVER_PATH, endpointConfigSchema, type AuthMode, type DeliveryView, type EndpointConfig, type EndpointView } from "../contract.js";
import { AUTOMATIONS_PLUGIN_ID, TargetError, automationSummary, checkTargets } from "./actions.js";
import {
  SecretInputError,
  checkBearerToken,
  checkSlackSigningSecret,
  decodeSigningSecret,
  generateBearerToken,
  generateSigningSecret,
  hashToken,
  signSlackRequest,
  signStandardWebhook,
} from "./auth.js";
import type { Deliverer } from "./deliver.js";
import { newEndpointId, type EndpointRecord, type Store } from "./store.js";

/** A problem the caller can fix. Its message is safe to show. */
export class InputError extends Error {}

export const deliveryPathOf = (endpointId: string) => `${DELIVER_PATH}?endpoint=${endpointId}`;

type Issued = { stored: string; hint: string; reveal: string | null };

function issueSecret(mode: AuthMode, imported: string | undefined): Issued {
  try {
    if (mode === "standard-webhooks") {
      const secret = imported?.trim() || generateSigningSecret();
      decodeSigningSecret(secret);
      return { stored: secret, hint: secret.slice(-4), reveal: imported ? null : secret };
    }
    if (mode === "slack") {
      if (!imported?.trim()) throw new InputError("A slack endpoint needs the Slack app's Signing Secret (Basic Information page). Pass it as the secret. The plugin cannot generate one.");
      const secret = checkSlackSigningSecret(imported.trim());
      return { stored: secret, hint: secret.slice(-4), reveal: null };
    }
    const token = imported ? checkBearerToken(imported.trim()) : generateBearerToken();
    return { stored: hashToken(token), hint: token.slice(-4), reveal: imported ? null : token };
  } catch (error) {
    if (error instanceof SecretInputError) throw new InputError(error.message);
    throw error;
  }
}

function parseConfig(input: unknown): EndpointConfig {
  const parsed = endpointConfigSchema.safeParse(input);
  if (!parsed.success) throw new InputError(`Invalid endpoint config:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function createService(deps: {
  bb: BbPluginApi;
  store: Store;
  deliverer: Deliverer;
  publicBaseUrl: string | null;
  /** The path senders use. The webhook listener's `/webhook/<id>` when it runs, else the BB route. */
  publicPathOf?: (endpointId: string) => string;
  changed: (endpointId: string) => void;
}) {
  const { bb, store, deliverer } = deps;
  const publicPathOf = deps.publicPathOf ?? deliveryPathOf;

  const view = (record: EndpointRecord): EndpointView => {
    const rejected = deliverer.rejections(record.id);
    return {
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      authMode: record.authMode,
      secretHint: record.secretHint,
      secretUpdatedAt: record.secretUpdatedAt,
      maxBodyBytes: record.config.maxBodyBytes,
      rateLimitPerMinute: record.config.rateLimitPerMinute,
      fields: record.config.fields,
      dedupe: record.config.dedupe,
      action: record.config.action,
      deliveryPath: publicPathOf(record.id),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      rejectedSinceLoad: rejected?.count ?? 0,
      lastRejectedReason: rejected?.lastReason ?? null,
      lastDelivery: store.lastDelivery(record.id),
    };
  };

  const mustGet = (endpointId: string) => {
    const record = store.endpoint(endpointId);
    if (!record) throw new InputError(`No endpoint ${endpointId}.`);
    return record;
  };

  const targets = async (config: EndpointConfig) => {
    try {
      await checkTargets(bb, config.action);
    } catch (error) {
      if (error instanceof TargetError) throw new InputError(error.message);
      throw error;
    }
  };

  return {
    overview: () => ({ endpoints: store.endpoints().map(view), deliverPath: DELIVER_PATH, publicBaseUrl: deps.publicBaseUrl }),

    get(endpointId: string, limit = 20): { endpoint: EndpointView; deliveries: DeliveryView[] } {
      const record = mustGet(endpointId);
      return { endpoint: view(record), deliveries: store.deliveries(record.id, limit) };
    },

    async create(input: { config: unknown; secret?: string }) {
      const config = parseConfig(input.config);
      const issued = issueSecret(config.authMode, input.secret);
      await targets(config);
      const id = newEndpointId();
      store.createEndpoint({ id, config, secret: issued.stored, secretHint: issued.hint, now: new Date().toISOString() });
      bb.log.info(`created endpoint=${id} auth=${config.authMode} action=${config.action.type}`);
      deps.changed(id);
      return { endpoint: view(mustGet(id)), secret: issued.reveal };
    },

    async update(input: { endpointId: string; config: unknown; secret?: string }) {
      const existing = mustGet(input.endpointId);
      const config = parseConfig(input.config);
      const modeChanged = config.authMode !== existing.authMode;
      if (input.secret !== undefined && !modeChanged) throw new InputError("A secret is used only when authMode changes. Use rotate-secret to replace it.");
      // Check the secret before targets, so a bad secret fails without any lookups.
      const issued = modeChanged ? issueSecret(config.authMode, input.secret) : null;
      await targets(config);
      const now = new Date().toISOString();
      let reveal: string | null = null;
      if (issued) {
        store.setSecret(existing.id, { secret: issued.stored, secretHint: issued.hint, now });
        reveal = issued.reveal;
      }
      store.updateEndpoint(existing.id, { config, now });
      bb.log.info(`updated endpoint=${existing.id}${reveal ? " (new secret)" : ""}`);
      deps.changed(existing.id);
      return { endpoint: view(mustGet(existing.id)), secret: reveal };
    },

    setEnabled(endpointId: string, enabled: boolean) {
      const record = mustGet(endpointId);
      store.setEnabled(record.id, enabled, new Date().toISOString());
      deps.changed(record.id);
      return { endpoint: view(mustGet(record.id)) };
    },

    delete(endpointId: string) {
      const deleted = store.deleteEndpoint(endpointId);
      if (deleted) {
        deliverer.forget(endpointId);
        bb.log.info(`deleted endpoint=${endpointId}`);
        deps.changed(endpointId);
      }
      return { deleted };
    },

    rotateSecret(input: { endpointId: string; secret?: string }) {
      const record = mustGet(input.endpointId);
      const issued = issueSecret(record.authMode, input.secret);
      store.setSecret(record.id, { secret: issued.stored, secretHint: issued.hint, now: new Date().toISOString() });
      bb.log.info(`rotated secret endpoint=${record.id}`);
      deps.changed(record.id);
      return { endpoint: view(mustGet(record.id)), secret: issued.reveal };
    },

    deliveries: (endpointId: string, limit: number) => ({ deliveries: store.deliveries(mustGet(endpointId).id, limit) }),

    /** Signs `payload` like a sender would and posts it as JSON to this server's own route. */
    async test(input: { endpointId: string; payload: unknown }) {
      const record = mustGet(input.endpointId);
      if (record.authMode === "bearer") {
        throw new InputError("Test sends sign with the stored secret. A bearer endpoint stores only a hash of its token, so send a request with your token instead.");
      }
      const body = JSON.stringify(input.payload ?? {});
      const timestamp = Math.floor(Date.now() / 1000);
      let signature: Record<string, string>;
      if (record.authMode === "slack") {
        signature = { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": signSlackRequest({ secret: record.secret, timestamp, body }) };
      } else {
        const id = `msg_test_${randomBytes(9).toString("hex")}`;
        signature = { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": signStandardWebhook({ secret: record.secret, id, timestamp, body }) };
      }
      const response = await fetch(`${bb.server.loopbackBaseUrl}${deliveryPathOf(record.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...signature },
        body,
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Keep the text; a non-JSON reply came from something other than this plugin.
      }
      return { status: response.status, body: z.json().catch(null).parse(parsed) };
    },

    /** Projects, and automations in one project when the Automations plugin answers. */
    async targets(input: { projectId?: string }) {
      const projects = (await bb.sdk.projects.list()).map((project) => ({ id: project.id, name: project.name }));
      if (!input.projectId) return { projects, automations: { available: false, items: [], message: null } };
      try {
        const items = await bb.sdk.plugins.callRpc({
          pluginId: AUTOMATIONS_PLUGIN_ID,
          method: "automations_list",
          input: { projectId: input.projectId },
          outputSchema: z.array(automationSummary),
        });
        return {
          projects,
          automations: { available: true, items: items.filter((item) => !item.problem).map((item) => ({ id: item.id, name: item.name })), message: null },
        };
      } catch {
        return { projects, automations: { available: false, items: [], message: "The Automations plugin did not answer. Install and enable it to use automation actions." } };
      }
    },
  };
}
export type Service = ReturnType<typeof createService>;
