// POST /deliver?endpoint=<id>. The one public-facing route.
// Order: find endpoint → check content type and size → authenticate → parse →
// check shape → claim (dedupe and rate limit) → run the action.
// Nothing before authentication touches the database or runs an action.
// Slack endpoints differ in four ways, all from Slack's delivery rules:
//   - They also accept form bodies (slash commands, interactivity).
//   - A signed `url_verification` body gets its challenge back and runs nothing.
//   - They answer 200 once the delivery is claimed and run the action after, because
//     Slack needs a 2xx within three seconds. A failed action is recorded, not retried.
//   - Permanent 4xx answers carry `x-slack-no-retry: 1`.
// Logs carry endpoint ids, delivery ids, and reason codes only: never secrets, headers, or body values.
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANGED_CHANNEL, DELIVER_ROUTE, ENDPOINT_ID, LIMITS } from "../contract.js";
import { runAction } from "./actions.js";
import { decodeSigningSecret, verifyBearer, verifySlack, verifyStandardWebhook, type AuthFailure, type AuthResult } from "./auth.js";
import { extractFields, parseFormPayload, parsePayload, type FieldValues, type ParseResult } from "./shape.js";
import type { EndpointRecord, Store } from "./store.js";

/** A processing claim older than this is treated as crashed and may be retried. */
export const STALE_PROCESSING_MS = 5 * 60_000;
const WARN_INTERVAL_MS = 60_000;
const ERROR_MAX = 240;

const baseHeaders = { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" };
export const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...headers } });

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;
const FORM_TYPE = /^application\/x-www-form-urlencoded\s*(?:;|$)/i;
/** Answers a Slack retry cannot change. */
const SLACK_NO_RETRY = new Set([400, 413, 415, 422]);
/** Slack's certificate check for distributed apps. It carries no event and may be unsigned. */
const SLACK_SSL_CHECK = /(?:^|&)ssl_check=1(?:&|$)/;

/** In-memory, per endpoint. Reset when the plugin reloads. */
export type RejectionStats = { count: number; lastReason: AuthFailure | "too-large" | null; lastWarnAt: number };

export function createDeliverer(bb: BbPluginApi, store: Store) {
  const rejections = new Map<string, RejectionStats>();
  const windows = new Map<string, number[]>();

  const noteRejection = (endpointId: string, reason: RejectionStats["lastReason"]) => {
    const stats = rejections.get(endpointId) ?? { count: 0, lastReason: null, lastWarnAt: 0 };
    stats.count += 1;
    stats.lastReason = reason;
    const now = Date.now();
    if (now - stats.lastWarnAt >= WARN_INTERVAL_MS) {
      stats.lastWarnAt = now;
      bb.log.warn(`rejected request endpoint=${endpointId} reason=${reason} rejectedSinceLoad=${stats.count}`);
    }
    rejections.set(endpointId, stats);
  };

  /** Sliding one-minute window. Counts only deliveries that would run an action. */
  const allow = (endpoint: EndpointRecord) => () => {
    const now = Date.now();
    const recent = (windows.get(endpoint.id) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= endpoint.config.rateLimitPerMinute) {
      windows.set(endpoint.id, recent);
      return false;
    }
    recent.push(now);
    windows.set(endpoint.id, recent);
    return true;
  };

  const changed = (endpointId: string) => bb.realtime.publish(CHANGED_CHANNEL, { endpointId });
  /** Slack actions still running after their 200. Awaited by `settled` on dispose. */
  const running = new Set<Promise<void>>();

  async function handle(request: Request, endpointId: string): Promise<Response> {
    const endpoint = ENDPOINT_ID.test(endpointId) ? store.endpoint(endpointId) : null;
    if (!endpoint || !endpoint.enabled) return reply(404, { ok: false, error: "not found" });
    const slack = endpoint.authMode === "slack";
    const refuse = (status: number, body: unknown) => reply(status, body, slack && SLACK_NO_RETRY.has(status) ? { "x-slack-no-retry": "1" } : {});

    const contentType = request.headers.get("content-type") ?? "";
    const form = slack && FORM_TYPE.test(contentType);
    if (!form && !JSON_TYPE.test(contentType)) {
      return refuse(415, { ok: false, error: slack ? "content-type must be application/json or application/x-www-form-urlencoded" : "content-type must be application/json" });
    }
    const limit = endpoint.config.maxBodyBytes;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > limit) {
      noteRejection(endpoint.id, "too-large");
      return refuse(413, { ok: false, error: "body too large" });
    }
    const body = await readLimited(request, limit);
    if (!body) {
      noteRejection(endpoint.id, "too-large");
      return refuse(413, { ok: false, error: "body too large" });
    }
    // Slack expects a plain 200. Nothing is stored and no action runs.
    if (form && SLACK_SSL_CHECK.test(Buffer.from(body).toString("latin1"))) return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });

    const auth = authenticate(endpoint, request.headers, body);
    if (!auth.ok) {
      noteRejection(endpoint.id, auth.reason);
      return reply(401, { ok: false, error: "unauthorized" });
    }

    const now = new Date().toISOString();
    const parsed: ParseResult & { interactive?: boolean } = form ? parseFormPayload(body) : parsePayload(body);
    if (!parsed.ok) {
      store.recordRejected({ endpointId: endpoint.id, actionType: endpoint.config.action.type, error: parsed.problem, now });
      changed(endpoint.id);
      return refuse(400, { ok: false, error: parsed.problem });
    }
    if (slack && !form && parsed.payload.type === "url_verification") {
      const challenge = parsed.payload.challenge;
      if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > LIMITS.slackChallenge) return refuse(400, { ok: false, error: "invalid challenge" });
      bb.log.info(`answered slack url_verification endpoint=${endpoint.id}`);
      return reply(200, { challenge });
    }
    const extracted = extractFields(parsed.payload, endpoint.config.fields);
    if (!extracted.ok) {
      const summary = extracted.issues.map((issue) => `${issue.field} ${issue.problem}`).join("; ");
      store.recordRejected({ endpointId: endpoint.id, actionType: endpoint.config.action.type, error: truncate(summary), now });
      changed(endpoint.id);
      return refuse(422, { ok: false, error: "payload does not match the endpoint shape", issues: extracted.issues });
    }

    const dedupeHash = dedupeHashOf(endpoint, auth.webhookId, extracted.values, body);
    if (!dedupeHash) return refuse(400, { ok: false, error: "missing webhook-id" });

    const claim = store.claim({
      endpointId: endpoint.id,
      dedupeKey: dedupeHash,
      actionType: endpoint.config.action.type,
      now,
      staleBefore: new Date(Date.now() - STALE_PROCESSING_MS).toISOString(),
      allow: allow(endpoint),
    });
    switch (claim.kind) {
      case "duplicate":
        changed(endpoint.id);
        return reply(200, { ok: true, duplicate: true, deliveryId: claim.deliveryId });
      case "busy":
        // Slack was already answered 200 for the first attempt. A 409 would only count as a failure.
        if (slack) return reply(200, { ok: true, duplicate: true, deliveryId: claim.deliveryId });
        return reply(409, { ok: false, error: "this delivery is already being processed", deliveryId: claim.deliveryId });
      case "limited":
        return reply(429, { ok: false, error: "rate limited" }, { "retry-after": "60" });
    }
    changed(endpoint.id);

    const work = execute(endpoint, claim, dedupeHash, extracted.values, now);
    if (slack) {
      const tracked = work.then(
        () => undefined,
        () => bb.log.warn(`could not record a slack delivery endpoint=${endpoint.id} delivery=${claim.deliveryId}`),
      );
      running.add(tracked);
      void tracked.finally(() => running.delete(tracked));
      return slackAck(parsed.payload, form, parsed.interactive === true, claim.deliveryId);
    }
    if (await work) return reply(200, { ok: true, duplicate: false, deliveryId: claim.deliveryId });
    // A 5xx tells the sender to retry. The retry reclaims this delivery.
    return reply(502, { ok: false, error: "action failed", deliveryId: claim.deliveryId });
  }

  /** Runs the action and records the result. True when it succeeded. */
  async function execute(endpoint: EndpointRecord, claim: { deliveryId: string; attempts: number }, dedupeHash: string, values: FieldValues, receivedAt: string): Promise<boolean> {
    try {
      const result = await runAction(bb, {
        endpointId: endpoint.id,
        action: endpoint.config.action,
        dedupeHash,
        context: { endpointName: endpoint.name, deliveryId: claim.deliveryId, receivedAt, values },
      });
      store.finish(claim.deliveryId, { status: "succeeded", result, error: null, now: new Date().toISOString() });
      bb.log.info(`delivered endpoint=${endpoint.id} delivery=${claim.deliveryId} action=${endpoint.config.action.type} attempt=${claim.attempts}`);
      return true;
    } catch (error) {
      const message = truncate(redact(errorMessage(error), values));
      store.finish(claim.deliveryId, { status: "failed", result: null, error: message, now: new Date().toISOString() });
      bb.log.warn(`action failed endpoint=${endpoint.id} delivery=${claim.deliveryId} action=${endpoint.config.action.type} attempt=${claim.attempts}: ${message}`);
      return false;
    } finally {
      changed(endpoint.id);
    }
  }

  function register() {
    bb.http.route("POST", DELIVER_ROUTE, (c) => handle(c.req.raw, c.req.query("endpoint") ?? ""), { auth: "none" });
  }

  return {
    register,
    handle,
    rejections: (endpointId: string) => rejections.get(endpointId) ?? null,
    /** Resolves when every Slack action that was still running has finished, or after `timeoutMs`. */
    settled: async (timeoutMs: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
      await Promise.race([Promise.all([...running]), timeout]);
      clearTimeout(timer);
    },
    forget: (endpointId: string) => {
      rejections.delete(endpointId);
      windows.delete(endpointId);
    },
  };
}
export type Deliverer = ReturnType<typeof createDeliverer>;

function authenticate(endpoint: EndpointRecord, headers: Headers, body: Uint8Array): AuthResult {
  const timing = { nowSeconds: Math.floor(Date.now() / 1000), toleranceSeconds: LIMITS.timestampToleranceSeconds };
  if (endpoint.authMode === "bearer") return verifyBearer({ tokenHash: endpoint.secret, headers });
  if (endpoint.authMode === "slack") return verifySlack({ secret: endpoint.secret, headers, body, ...timing });
  return verifyStandardWebhook({ key: decodeSigningSecret(endpoint.secret), headers, body, ...timing });
}

/**
 * Slack shows the body of a slash command's answer to the person who ran it, so it
 * gets a short private note. An interaction gets an empty body: any other body can
 * change or break the modal. The Events API ignores the body.
 */
function slackAck(payload: Record<string, unknown>, form: boolean, interactive: boolean, deliveryId: string): Response {
  if (interactive) return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  if (form && typeof payload.command === "string") return reply(200, { response_type: "ephemeral", text: `Received. Delivery ${deliveryId}.` });
  return reply(200, { ok: true, duplicate: false, deliveryId });
}

/** SHA-256 of the dedupe source and value. The raw id or field value is never stored. */
function dedupeHashOf(endpoint: EndpointRecord, webhookId: string | null, values: FieldValues, body: Uint8Array): string | null {
  const dedupe = endpoint.config.dedupe;
  let value: string;
  if (dedupe.source === "webhook-id") {
    if (!webhookId) return null;
    value = webhookId;
  } else if (dedupe.source === "field") {
    value = String(values[dedupe.field]);
  } else {
    value = createHash("sha256").update(body).digest("hex");
  }
  return createHash("sha256").update(`${dedupe.source}:${value}`, "utf8").digest("hex");
}

/** Reads at most `limit` bytes. Returns null as soon as the body is larger. */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Removes field values from an error message, so a failing action cannot echo the payload into storage or logs. */
function redact(message: string, values: FieldValues): string {
  let result = message;
  for (const value of Object.values(values)) {
    if (typeof value === "string" && value.length >= 4) result = result.split(value).join("[redacted]");
  }
  return result;
}

const truncate = (text: string) => (text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text);
