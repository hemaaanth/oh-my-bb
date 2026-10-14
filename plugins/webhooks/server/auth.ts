// Request authentication. Three modes:
//   standard-webhooks  HMAC-SHA256 per https://www.standardwebhooks.com, as PostHog signs it.
//                      Signed content is `${webhook-id}.${webhook-timestamp}.${raw body}`.
//                      The header is a space-separated list of `v1,<base64>` entries.
//   slack              HMAC-SHA256 per https://docs.slack.dev/authentication/verifying-requests-from-slack.
//                      Signed content is `v0:${x-slack-request-timestamp}:${raw body}`, keyed with the
//                      app's signing secret as UTF-8. The header is `v0=<hex>`.
//   bearer             `Authorization: Bearer <token>`. Only a SHA-256 of the token is stored.
// Nothing here logs. Callers get a reason code, never the secret or the body.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_PREFIX = "whsec_";
const TOKEN_PREFIX = "whtok_";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_KEY_BYTES = 24;
const MIN_TOKEN_LENGTH = 32;
const MAX_SIGNATURES = 10;
const MAX_WEBHOOK_ID = 256;
const SLACK_SECRET = /^[\x21-\x7e]{32,256}$/;
/** Bot, user, and app-level tokens. People paste these by mistake instead of the signing secret. */
const SLACK_API_TOKEN = /^(?:xox[a-z]|xapp)-/;

export type AuthFailure = "missing" | "malformed" | "stale" | "mismatch";
export type AuthResult = { ok: true; webhookId: string | null } | { ok: false; reason: AuthFailure };

export class SecretInputError extends Error {}

/** A new Standard Webhooks secret: `whsec_` and 32 random bytes in base64. */
export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

/** A new bearer token: `whtok_` and 32 random bytes in base64url. */
export function generateBearerToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The HMAC key of a Standard Webhooks secret. Throws SecretInputError when the secret is unusable. */
export function decodeSigningSecret(secret: string): Buffer {
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  if (!BASE64.test(body)) throw new SecretInputError("A signing secret is base64, optionally prefixed with whsec_.");
  const key = Buffer.from(body, "base64");
  if (key.length < MIN_KEY_BYTES) throw new SecretInputError(`A signing secret must decode to at least ${MIN_KEY_BYTES} bytes.`);
  return key;
}

/** Checks a caller-supplied bearer token. Throws SecretInputError when it is too weak. */
export function checkBearerToken(token: string): string {
  if (token.length < MIN_TOKEN_LENGTH || token.length > 512 || /\s/.test(token)) {
    throw new SecretInputError(`A bearer token is ${MIN_TOKEN_LENGTH} to 512 characters with no spaces.`);
  }
  return token;
}

/** Checks a Slack app's signing secret. Slack issues it, so the plugin never generates one. */
export function checkSlackSigningSecret(secret: string): string {
  if (SLACK_API_TOKEN.test(secret)) throw new SecretInputError("That is a Slack API token. Paste the Signing Secret from the Slack app's Basic Information page.");
  if (!SLACK_SECRET.test(secret)) throw new SecretInputError("A Slack signing secret is 32 to 256 characters with no spaces. Copy it from the Slack app's Basic Information page.");
  return secret;
}

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** The `webhook-signature` header value for one delivery attempt. */
export function signStandardWebhook(input: { secret: string; id: string; timestamp: number; body: Uint8Array | string }): string {
  return `v1,${hmac(decodeSigningSecret(input.secret), input.id, String(input.timestamp), toBytes(input.body)).toString("base64")}`;
}

/** The `x-slack-signature` header value for one request. */
export function signSlackRequest(input: { secret: string; timestamp: number; body: Uint8Array | string }): string {
  return `v0=${slackHmac(input.secret, String(input.timestamp), toBytes(input.body)).toString("hex")}`;
}

type Headers = { get(name: string): string | null | undefined };

export function verifyStandardWebhook(input: {
  key: Buffer;
  headers: Headers;
  body: Uint8Array;
  nowSeconds: number;
  toleranceSeconds: number;
}): AuthResult {
  const id = input.headers.get("webhook-id");
  const timestamp = input.headers.get("webhook-timestamp");
  const signature = input.headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing" };
  if (id.length > MAX_WEBHOOK_ID || !/^[\x21-\x7e]+$/.test(id) || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed" };
  if (Math.abs(input.nowSeconds - Number(timestamp)) > input.toleranceSeconds) return { ok: false, reason: "stale" };

  const expected = hmac(input.key, id, timestamp, input.body);
  const entries = signature.trim().split(/\s+/).slice(0, MAX_SIGNATURES);
  let sawV1 = false;
  for (const entry of entries) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    sawV1 = true;
    const given = Buffer.from(entry.slice(comma + 1), "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, webhookId: id };
  }
  return { ok: false, reason: sawV1 ? "mismatch" : "malformed" };
}

export function verifySlack(input: { secret: string; headers: Headers; body: Uint8Array; nowSeconds: number; toleranceSeconds: number }): AuthResult {
  const timestamp = input.headers.get("x-slack-request-timestamp");
  const signature = input.headers.get("x-slack-signature")?.trim();
  if (!timestamp || !signature) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: "malformed" };
  if (Math.abs(input.nowSeconds - Number(timestamp)) > input.toleranceSeconds) return { ok: false, reason: "stale" };
  const expected = slackHmac(input.secret, timestamp, input.body);
  const given = Buffer.from(signature.slice(3), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true, webhookId: null } : { ok: false, reason: "mismatch" };
}

export function verifyBearer(input: { tokenHash: string; headers: Headers }): AuthResult {
  const header = input.headers.get("authorization");
  if (!header) return { ok: false, reason: "missing" };
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  if (!match) return { ok: false, reason: "malformed" };
  const given = Buffer.from(hashToken(match[1]!), "hex");
  const expected = Buffer.from(input.tokenHash, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true, webhookId: null } : { ok: false, reason: "mismatch" };
}

function hmac(key: Buffer, id: string, timestamp: string, body: Uint8Array): Buffer {
  return createHmac("sha256", key).update(`${id}.${timestamp}.`, "utf8").update(body).digest();
}

function slackHmac(secret: string, timestamp: string, body: Uint8Array): Buffer {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`v0:${timestamp}:`, "utf8").update(body).digest();
}

const toBytes = (body: Uint8Array | string) => (typeof body === "string" ? Buffer.from(body, "utf8") : body);
