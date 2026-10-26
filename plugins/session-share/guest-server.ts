import { z } from "zod";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  LANDING_PAGE_HTML,
  renderGuestPage,
  renderUnavailablePage,
} from "./guest-page.js";
import {
  darkFavicon,
  favicon,
  renderOpenGraphImage,
} from "./social-assets.js";
import type { ShareStatus } from "./contract.js";
import { PREVIEW_ERROR_HEADERS, preparedPreviewSchema, PREVIEW_MAX_BYTES } from "./preview-contract.js";
import type { GuestRow } from "./guest-review-contract.js";

const COOKIE_NAME = "bb_session_share";
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_TTL_MS = 4 * 60 * 60 * 1_000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1_000;
const MAX_ATTEMPTS = 12;
const unlockBodySchema = z.object({ accessCode: z.string().catch("") });
const navigationBodySchema = z.object({ url: z.string().url() }).strict();
const feedbackBodySchema = z.object({
  comment: z.string().max(4_000).optional(),
  messageId: z.string().nullable().optional(),
  selectedText: z.string().nullable().optional(),
  pinpoint: z.record(z.string(), z.unknown()).optional(),
  intent: z
    .object({
      id: z.string(),
      action: z.enum(["reply", "delete"]),
      text: z.string().max(4_000).optional(),
    }).strict()
    .optional(),
});
const screenshotUploadSchema = z.object({
  clientId: z.string().min(1).max(128),
  kind: z.enum(["element", "viewport"]),
  mime: z.enum(["image/png", "image/webp", "image/jpeg"]),
  screenshot: z.string().min(1).max(2 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  url: z.string().url(),
}).strict();

interface GuestCaptureResult {
  captureId: string;
  pageUrl: string;
  screenshotUpload: { token: string; expiresAt: number } | null;
}

interface ScreenshotReceipt {
  token: string;
  expiresAt: number;
  pageUrl: string;
  kinds: Set<string>;
}

const SHARE_PATH_PATTERN = /^\/s\/([^/]+)(?:\/(.*))?$/;

export interface GuestMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  html: string;
  createdAt: number;
}

export interface GuestNavigation {
  url: string;
  revision: number;
}

type GuestShare = Omit<ShareStatus, "accessCode" | "localUrl">;

export interface GuestState {
  share: GuestShare;
  thread: { status: string };
  messages: GuestMessage[];
  maxSeq: number;
  pinpointRows: GuestRow[];
  navigation: GuestNavigation | null;
  proxyError: string | null;
}

interface GuestFeedback {
  comment: string;
  messageId: string | null;
  selectedText: string | null;
  pinpointPayload: Record<string, unknown> | null;
  pinpointIntent: {
    id: string;
    action: "reply" | "delete";
    text?: string;
  } | null;
}

export interface GuestProxyRequest {
  route:
    | "proxy"
    | "picker-lib.js"
    | "pinpoint-controller.js"
    | "pinpoint-styles.css";
  targetUrl: string | null;
  publicOrigin: string;
  publicProxyBase: string;
}

export interface GuestProxyResponse {
  status: number;
  contentType: string;
  body: Buffer;
  isolationVersion?: 1;
  headers?: Record<string, string>;
}

export interface GuestShareRegistration {
  id: string;
  projectName: string;
  accessCode?: string;
  accessCredentials?: GuestAccessCredentials;
  expiresAt: number | null;
  reviewEnabled: boolean;
  previewUrl?: string | null;
  getState(participantRef: string): Promise<GuestState>;
  submitFeedback(input: GuestFeedback, participantRef: string): Promise<GuestCaptureResult | void>;
  uploadScreenshot?(input: { token: string; kind: "element" | "viewport"; mime: "image/png" | "image/webp" | "image/jpeg"; screenshot: string }): Promise<void>;
  navigate?(url: string): Promise<GuestNavigation>;
  loadScreenshot?(input: {
    id: string;
    kind: "element" | "viewport";
  }, participantRef: string): Promise<{ mime: string; data: string } | null>;
  proxyRequest?(request: GuestProxyRequest): Promise<GuestProxyResponse>;
}

interface GuestServerOptions {
  port: number;
  log(message: string): void;
}

interface RegisteredGuestShare extends GuestShareRegistration {
  accessCodeSalt: Buffer;
  accessCodeHash: Buffer;
  openGraphImage: Buffer;
}

interface GuestSession {
  shareId: string;
  csrfToken: string;
  proxyToken: string;
  expiresAt: number;
  participantRef: string;
  screenshotReceipts: Map<string, ScreenshotReceipt>;
}

interface AttemptBucket {
  count: number;
  resetsAt: number;
}

export interface GuestServerHandle {
  localUrl: string;
  addShare(
    registration: GuestShareRegistration,
  ): Promise<GuestAccessCredentials>;
  removeShare(shareId: string): void;
  close(): Promise<void>;
}

export interface GuestAccessCredentials {
  salt: Buffer;
  hash: Buffer;
}

const scryptAsync = promisify(scrypt) as (
  accessCode: string,
  salt: Buffer,
  keyLength: number,
) => Promise<Buffer>;

function scryptBuffer(accessCode: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(accessCode, salt, 32);
}

async function hashAccessCode(
  accessCode: string,
): Promise<GuestAccessCredentials> {
  const salt = randomBytes(16);
  return { salt, hash: await scryptBuffer(accessCode, salt) };
}

async function verifyAccessCode(
  accessCode: string,
  salt: Buffer,
  expected: Buffer,
): Promise<boolean> {
  const actual = await scryptBuffer(accessCode, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  if (!response.hasHeader("content-security-policy")) {
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  }
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  setCommonHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
  method: string | undefined = "GET",
): void {
  setCommonHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(html));
  response.end(method === "HEAD" ? undefined : html);
}

function sendPng(
  response: ServerResponse,
  body: Buffer,
  method: string | undefined = "GET",
): void {
  setCommonHeaders(response);
  response.statusCode = 200;
  response.setHeader("content-type", "image/png");
  response.setHeader("content-length", body.byteLength);
  response.end(method === "HEAD" ? undefined : body);
}

function isPublicRead(request: IncomingMessage): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

export function formatExpiryLabel(
  expiresAt: number | null,
  now = Date.now(),
): string {
  if (expiresAt === null) return "Shared until revoked";
  const remainingMinutes = Math.max(
    0,
    Math.ceil((expiresAt - now) / 60_000),
  );
  if (remainingMinutes < 1) return "Session expires in less than a minute";
  if (remainingMinutes < 60) {
    return `Session expires in ${remainingMinutes} min`;
  }
  const hours = Math.round((remainingMinutes / 60) * 2) / 2;
  return `Session expires in ${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)} hr`;
}

function requestCookie(request: IncomingMessage): string | null {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === COOKIE_NAME) return decodeURIComponent(value.join("="));
  }
  return null;
}

async function readBody(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8")) as unknown;
}

function clientAddress(request: IncomingMessage): string {
  const cloudflareAddress = request.headers["cf-connecting-ip"];
  return typeof cloudflareAddress === "string"
    ? cloudflareAddress
    : request.socket.remoteAddress ?? "unknown";
}

function requestPublicOrigin(request: IncomingMessage): string {
  const protocol =
    request.headers["x-forwarded-proto"]?.toString().split(",", 1)[0] ??
    "http";
  const host =
    request.headers["x-forwarded-host"]?.toString().split(",", 1)[0] ??
    request.headers.host ??
    "127.0.0.1";
  return `${protocol}://${host}`;
}

export async function createGuestServer(
  options: GuestServerOptions,
): Promise<GuestServerHandle> {
  const shares = new Map<string, RegisteredGuestShare>();
  const sessions = new Map<string, GuestSession>();
  const proxySessions = new Map<string, GuestSession>();
  const attempts = new Map<string, AttemptBucket>();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://session-share.local");
      if (/^\/s\/[^/]+\/(?:sandbox|preview)\//.test(url.pathname)) {
        for (const [name, value] of Object.entries(PREVIEW_ERROR_HEADERS)) response.setHeader(name, value);
      }
      if (isPublicRead(request) && url.pathname === "/favicon-32x32.png") {
        sendPng(response, favicon, request.method);
        return;
      }
      if (
        isPublicRead(request) &&
        url.pathname === "/favicon-32x32-dark.png"
      ) {
        sendPng(response, darkFavicon, request.method);
        return;
      }
      if (isPublicRead(request) && url.pathname === "/") {
        sendHtml(response, 200, LANDING_PAGE_HTML, request.method);
        return;
      }
      const pathMatch = url.pathname.match(SHARE_PATH_PATTERN);
      if (!pathMatch) {
        sendJson(response, 404, { error: "Not found." });
        return;
      }
      const shareId = decodeURIComponent(pathMatch[1]!);
      const route = pathMatch[2] ?? "";
      const share = shares.get(shareId);
      if (!share) {
        if (isPublicRead(request) && route === "") {
          sendHtml(response, 404, renderUnavailablePage(), request.method);
        } else {
          sendJson(response, 404, { error: "This shared session is unavailable." });
        }
        return;
      }

      const now = Date.now();
      if (share.expiresAt !== null && now >= share.expiresAt) {
        if (isPublicRead(request) && route === "") {
          sendHtml(response, 410, renderUnavailablePage(), request.method);
        } else {
          sendJson(response, 410, { error: "This shared session has expired." });
        }
        return;
      }
      if (request.method === "POST" && route.startsWith("api/")) {
        const origin = request.headers.origin;
        if (origin !== undefined && origin !== requestPublicOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin guest action is not allowed." });
          return;
        }
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          sendJson(response, 415, { error: "Guest actions require JSON." });
          return;
        }
      }
      if (isPublicRead(request) && route === "og.png") {
        sendPng(response, share.openGraphImage, request.method);
        return;
      }
      const token = requestCookie(request);
      let session = token ? sessions.get(token) : undefined;
      if (
        session &&
        (session.shareId !== shareId || session.expiresAt <= now)
      ) {
        sessions.delete(token!);
        proxySessions.delete(session.proxyToken);
        session = undefined;
      } else if (token && !session) {
        sessions.delete(token);
      }


      if (isPublicRead(request) && route === "") {
        setCommonHeaders(response);
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        const publicOrigin = requestPublicOrigin(request);
        const imageUrl = `${publicOrigin}/s/${encodeURIComponent(shareId)}/og.png`;
        const html = renderGuestPage(
          Boolean(session),
          share.reviewEnabled,
          imageUrl,
        );
        response.setHeader("content-length", Buffer.byteLength(html));
        response.end(request.method === "HEAD" ? undefined : html);
        return;
      }
      const publicAssetRoute =
        route === "pinpoint-controller.js" || route === "pinpoint-styles.css"
          ? route
          : null;
      if (request.method === "GET" && publicAssetRoute && share.proxyRequest) {
        const publicOrigin = requestPublicOrigin(request);
        const asset = await share.proxyRequest({
          route: publicAssetRoute,
          targetUrl: null,
          publicOrigin,
          publicProxyBase: `${publicOrigin}/s/${encodeURIComponent(shareId)}/proxy`,
        });
        response.statusCode = asset.status;
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", asset.contentType);
        response.setHeader("x-content-type-options", "nosniff");
        response.end(asset.body);
        return;
      }

      if (request.method === "POST" && route === "api/unlock") {
        const attemptKey = `${shareId}:${clientAddress(request)}`;
        const currentBucket = attempts.get(attemptKey);
        const bucket =
          currentBucket && currentBucket.resetsAt > now
            ? currentBucket
            : { count: 0, resetsAt: now + ATTEMPT_WINDOW_MS };
        if (bucket.count >= MAX_ATTEMPTS) {
          sendJson(response, 429, { error: "Too many attempts. Try again later." });
          return;
        }
        bucket.count += 1;
        attempts.set(attemptKey, bucket);
        const body = unlockBodySchema.parse(await readJson(request));
        const accessCode = body.accessCode;
        if (
          !(await verifyAccessCode(
            accessCode,
            share.accessCodeSalt,
            share.accessCodeHash,
          ))
        ) {
          sendJson(response, 401, { error: "Incorrect access code." });
          return;
        }
        if (shares.get(shareId) !== share || (share.expiresAt !== null && Date.now() >= share.expiresAt)) {
          sendJson(response, 410, { error: "This shared session is unavailable." });
          return;
        }
        for (const [expiredToken, expiredSession] of sessions) {
          if (expiredSession.expiresAt > now) continue;
          sessions.delete(expiredToken);
          proxySessions.delete(expiredSession.proxyToken);
        }
        for (const [key, expiredBucket] of attempts) {
          if (expiredBucket.resetsAt <= now) attempts.delete(key);
        }
        attempts.delete(attemptKey);
        const token = randomBytes(32).toString("base64url");
        const sessionExpiresAt = Math.min(
          share.expiresAt ?? Number.POSITIVE_INFINITY,
          now + SESSION_TTL_MS,
        );
        const session: GuestSession = {
          shareId,
          csrfToken: randomBytes(24).toString("base64url"),
          proxyToken: randomBytes(32).toString("base64url"),
          expiresAt: sessionExpiresAt,
          participantRef: randomBytes(32).toString("hex"),
          screenshotReceipts: new Map(),
        };
        sessions.set(token, session);
        proxySessions.set(session.proxyToken, session);
        response.setHeader(
          "set-cookie",
          `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/s/${encodeURIComponent(shareId)}/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((sessionExpiresAt - now) / 1_000))}`,
        );
        sendJson(response, 200, { ok: true });
        return;
      }

      const bootstrap = route.match(/^sandbox\/([A-Za-z0-9_-]+)\/proxy$/);
      const resource = route.match(/^preview\/([A-Za-z0-9_-]+)(\/.*)$/);
      if (bootstrap || resource) {
        const proxyToken = (bootstrap ?? resource)![1]!;
        const proxySession = proxySessions.get(proxyToken);
        if (!proxySession || proxySession.shareId !== shareId || proxySession.expiresAt <= now) {
          if (proxySession) proxySessions.delete(proxyToken);
          sendJson(response, 401, { error: "Shared preview access expired." });
          return;
        }
        if (!share.reviewEnabled || !share.proxyRequest || !share.previewUrl) {
          sendJson(response, 404, { error: "Shared preview is unavailable." });
          return;
        }
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          sendJson(response, 405, { error: "Shared previews allow only GET resources." });
          return;
        }
        const publicOrigin = requestPublicOrigin(request);
        const publicProxyBase = `${publicOrigin}/s/${encodeURIComponent(shareId)}/preview/${proxyToken}`;
        const origin = new URL(share.previewUrl).origin;
        const target = bootstrap
          ? new URL(url.searchParams.get("u") ?? share.previewUrl)
          : new URL(resource![2]! + url.search, origin);
        if (!/^https?:$/.test(target.protocol) || target.origin !== origin || target.username || target.password || target.origin === publicOrigin) {
          sendJson(response, 403, { error: "Shared preview left its approved origin." });
          return;
        }
        if (bootstrap) {
          response.statusCode = 302;
          response.setHeader("location", publicProxyBase + target.pathname + target.search + target.hash);
          response.end();
          return;
        }
        const proxyResponse = await share.proxyRequest({
          route: resource![2] === "/.pinpoint/picker-lib.js" ? "picker-lib.js" : "proxy",
          targetUrl: target.href,
          publicOrigin,
          publicProxyBase,
        });
        if (proxyResponse.isolationVersion !== 1 || proxyResponse.body.length > PREVIEW_MAX_BYTES) {
          throw new Error("Pinpoint returned an incompatible preview isolation contract.");
        }
        const headers = preparedPreviewSchema.shape.headers.parse(proxyResponse.headers);
        response.statusCode = proxyResponse.status;
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
        response.setHeader("content-type", proxyResponse.contentType);
        response.end(proxyResponse.body);
        return;
      }

      if (!session) {
        sendJson(response, 401, { error: "Access code required." });
        return;
      }
      if (
        request.method === "POST" &&
        route === "api/navigation" &&
        share.navigate
      ) {
        if (!share.reviewEnabled) {
          sendJson(response, 403, {
            error: "Navigation is disabled for this link.",
          });
          return;
        }
        const csrf = request.headers["x-share-csrf"];
        if (typeof csrf !== "string" || csrf !== session.csrfToken) {
          sendJson(response, 403, { error: "Invalid navigation session." });
          return;
        }
        const body = navigationBodySchema.parse(await readJson(request));
        sendJson(response, 200, {
          navigation: await share.navigate(body.url),
        });
        return;
      }
      if (
        request.method === "GET" &&
        route === "api/pinpoint-screenshot" &&
        share.loadScreenshot
      ) {
        const id = url.searchParams.get("id") ?? "";
        const kind = url.searchParams.get("kind");
        if (!id || (kind !== "element" && kind !== "viewport")) {
          sendJson(response, 400, { error: "Invalid screenshot request." });
          return;
        }
        sendJson(response, 200, {
          shot: await share.loadScreenshot({ id, kind }, session.participantRef),
        });
        return;
      }

      if (request.method === "GET" && route === "api/state") {
        const state = await share.getState(session.participantRef);
        sendJson(response, 200, {
          ...state,
          expiresIn: formatExpiryLabel(state.share.expiresAt, now),
          csrfToken: session.csrfToken,
          proxyToken: session.proxyToken,
        });
        return;
      }

      if (request.method === "POST" && route === "api/preview-screenshot-upload") {
        if (!share.reviewEnabled || !share.uploadScreenshot || request.headers["x-share-csrf"] !== session.csrfToken) {
          sendJson(response, 403, { error: "Invalid screenshot session." });
          return;
        }
        const body = screenshotUploadSchema.parse(JSON.parse((await readBody(request, 2 * 1024 * 1024 + 4_096)).toString("utf8")));
        const receipt = session.screenshotReceipts.get(body.clientId);
        if (receipt && receipt.expiresAt <= Date.now()) session.screenshotReceipts.delete(body.clientId);
        const pageUrl = new URL(body.url);
        pageUrl.hash = "";
        if (session.expiresAt <= Date.now() || shares.get(shareId) !== share || !receipt || receipt.expiresAt <= Date.now() || receipt.pageUrl !== pageUrl.href) {
          sendJson(response, 403, { error: "Screenshot capture authorization expired or does not match this session and page." });
          return;
        }
        if (receipt.kinds.has(body.kind)) {
          sendJson(response, 409, { error: "This screenshot has already been uploaded." });
          return;
        }
        receipt.kinds.add(body.kind);
        try {
          await share.uploadScreenshot({ token: receipt.token, kind: body.kind, mime: body.mime, screenshot: body.screenshot });
        } catch (error) {
          receipt.kinds.delete(body.kind);
          throw error;
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && route === "api/feedback") {
        if (!share.reviewEnabled) {
          sendJson(response, 403, {
            error: "Pinpoint feedback is disabled for this link.",
          });
          return;
        }
        const csrf = request.headers["x-share-csrf"];
        if (typeof csrf !== "string" || csrf !== session.csrfToken) {
          sendJson(response, 403, { error: "Invalid feedback session." });
          return;
        }
        const body = feedbackBodySchema.parse(await readJson(request));
        const pinpointPayload = body.pinpoint ?? null;
        const pinpointComment =
          pinpointPayload && typeof pinpointPayload.comment === "string"
            ? pinpointPayload.comment
            : "";
        const comment = (body.comment ?? pinpointComment).trim();
        if ((!comment && !body.intent && pinpointPayload?.kind !== "text-edit") || comment.length > 4_000) {
          sendJson(response, 400, {
            error: "Feedback must be between 1 and 4,000 characters.",
          });
          return;
        }
        if (session.expiresAt <= Date.now() || shares.get(shareId) !== share) {
          sendJson(response, 401, { error: "Guest access expired." });
          return;
        }
        const capture = await share.submitFeedback({
          comment,
          messageId: body.messageId ?? null,
          selectedText: body.selectedText?.slice(0, 4_000) ?? null,
          pinpointPayload,
          pinpointIntent: body.intent ?? null,
        }, session.participantRef);
        if (capture?.screenshotUpload) {
          for (const [id, receipt] of session.screenshotReceipts) {
            if (receipt.expiresAt <= Date.now()) session.screenshotReceipts.delete(id);
          }
          const pageUrl = new URL(capture.pageUrl);
          pageUrl.hash = "";
          session.screenshotReceipts.set(capture.captureId, {
            token: capture.screenshotUpload.token,
            expiresAt: Math.min(capture.screenshotUpload.expiresAt, Date.now() + 60_000, session.expiresAt),
            pageUrl: pageUrl.href,
            kinds: new Set(),
          });
        }
        sendJson(response, 200, { ok: true, ...(capture ? { capture: { captureId: capture.captureId } } : {}) });
        return;
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError) {
        sendJson(response, 400, { error: "Invalid guest request." });
        return;
      }
      options.log(
        `guest request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      sendJson(response, 500, {
        error: "The shared session could not process that request.",
      });
    }
  });

  const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
  server.once("listening", resolve);
  server.once("error", reject);
  server.listen(options.port, "127.0.0.1");
  await listening;

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("session viewer did not bind a TCP port");
  }

  return {
    localUrl: `http://127.0.0.1:${address.port}`,
    async addShare(registration) {
      const credentials =
        registration.accessCredentials ??
        (registration.accessCode
          ? await hashAccessCode(registration.accessCode)
          : null);
      if (!credentials) {
        throw new Error("Shared session access credentials are missing");
      }
      shares.set(registration.id, {
        ...registration,
        accessCodeSalt: credentials.salt,
        accessCodeHash: credentials.hash,
        openGraphImage: renderOpenGraphImage(registration.projectName),
      });
      return credentials;
    },
    removeShare(shareId) {
      shares.delete(shareId);
      for (const [token, session] of sessions) {
        if (session.shareId !== shareId) continue;
        sessions.delete(token);
        proxySessions.delete(session.proxyToken);
      }
      for (const key of attempts.keys()) {
        if (key.startsWith(`${shareId}:`)) attempts.delete(key);
      }
    },
    async close() {
      shares.clear();
      sessions.clear();
      proxySessions.clear();
      attempts.clear();
      server.closeAllConnections();
      const { promise, resolve: closed } = Promise.withResolvers<void>();
      server.close(() => closed());
      await promise;
    },
  };
}
