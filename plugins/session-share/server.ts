import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, type ShareMode, type ShareStatus, type TunnelMode } from "./contract.js";
import {
  createGuestServer,
  type GuestMessage,
  type GuestNavigation,
  type GuestServerHandle,
  type GuestProxyRequest,
  type GuestProxyResponse,
} from "./guest-server.js";
import { generateAccessCode } from "./access-code.js";
import { executableAvailable } from "./executable.js";
import { hostContract } from "./host-contract.js";
import {
  renderSharedMarkdown,
} from "./markdown.js";
import { startCloudflareTunnel, type TunnelHandle } from "./tunnel.js";
import {
  SHARE_MIGRATIONS,
  createShareStore,
  type PersistentShare,
} from "./share-store.js";
import { preparedPreviewSchema, PREVIEW_MAX_BYTES } from "./preview-contract.js";
import { guestListOutputSchema, guestCaptureOutputSchema } from "./guest-review-contract.js";

interface ActiveShare {
  status: ShareStatus;
  expiryTimer: NodeJS.Timeout | null;
}

interface TunnelState {
  handle: TunnelHandle | null;
  ready: boolean;
  retryCount: number;
}

const pinpointRemoveOutputSchema = z.object({ ok: z.boolean() });

const pinpointLiveTargetOutputSchema = z.object({
  url: z.string().nullable(),
});

const pinpointPublicReviewControllerOutputSchema = z.object({
  script: z.string(),
});
const pinpointPublicReviewStylesOutputSchema = z.object({ css: z.string() });
const pinpointScreenshotOutputSchema = z.object({
  shot: z.object({ mime: z.string(), data: z.string() }).nullable(),
});
export const pinpointPickPayloadSchema = z.looseObject({
  url: z.string(),
  pathname: z.string().optional(),
  title: z.string().optional(),
  selector: z.string().optional(),
  elementPath: z.string().optional(),
  tag: z.string().optional(),
  cssClasses: z.array(z.string()).optional(),
  componentName: z.string().nullish(),
  nearbyText: z.string().optional(),
  selectedText: z.string().nullish(),
  rect: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .nullish(),
  x: z.number().optional(),
  y: z.number().optional(),
  anchorOffsetX: z.number().optional(),
  anchorOffsetY: z.number().optional(),
  screenshotExpected: z.boolean().optional(),
  comment: z.string().max(4_000).optional(),
  clientId: z.string().nullish(),
  computedStyles: z.string().nullish(),
  accessibility: z.string().nullish(),
  nearbyElements: z.string().nullish(),
  intent: z.enum(["fix", "change", "question", "approve"]).nullish(),
  severity: z.enum(["blocking", "important", "suggestion"]).nullish(),
  kind: z
    .enum(["feedback", "placement", "rearrange", "text-edit"])
    .nullish(),
  textOld: z.string().nullish(),
  textNew: z.string().nullish(),
}).superRefine((pick, context) => {
  if (pick.kind === "text-edit" && (typeof pick.textOld !== "string" || typeof pick.textNew !== "string")) {
    context.addIssue({ code: "custom", message: "Text edits require the original and replacement text." });
  }
});

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Viewer port must be an integer between 1 and 65535.");
  }
  return port;
}

function threadTitle(thread: {
  title?: string | null;
  titleFallback?: string | null;
}): string {
  return thread.title?.trim() || thread.titleFallback?.trim() || "Shared session";
}

function sharePath(shareId: string): string {
  return `/s/${encodeURIComponent(shareId)}/`;
}

function normalizeTunnelConfiguration(configuration: {
  cloudflaredPath: string;
  customHostname: string;
  tunnelToken?: string;
}): {
  cloudflaredPath: string;
  customHostname: string;
  tunnelToken: string;
} {
  return {
    cloudflaredPath: configuration.cloudflaredPath.trim() || "cloudflared",
    customHostname: configuration.customHostname
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, ""),
    tunnelToken: configuration.tunnelToken?.trim() ?? "",
  };
}

export function approvedNavigationUrl(
  approvedTargetUrl: string,
  nextUrl: string,
): URL {
  const approvedOrigin = new URL(approvedTargetUrl).origin;
  const target = new URL(nextUrl);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password ||
    !/^(?:[a-z0-9._-]+|\[[a-f0-9:.]+\])$/i.test(target.hostname) || target.origin !== approvedOrigin) {
    throw new Error("Shared navigation left the approved origin.");
  }
  return target;
}

export function hostFetchUrl(target: URL): URL {
  const fetchTarget = new URL(target);
  const sharedPort = fetchTarget.hostname.match(
    /^[a-z0-9-]+--([1-9]\d{0,4})\.getbb\.app$/i,
  )?.[1];
  if (
    fetchTarget.protocol === "https:" &&
    sharedPort &&
    Number(sharedPort) <= 65_535
  ) {
    fetchTarget.protocol = "http:";
    fetchTarget.hostname = "127.0.0.1";
    fetchTarget.port = sharedPort;
  } else if (
    fetchTarget.hostname === "localhost" ||
    fetchTarget.hostname === "0.0.0.0"
  ) {
    fetchTarget.hostname = "127.0.0.1";
  }
  return fetchTarget;
}

export function formatPublicProxyError(
  error: unknown,
  targetUrl: string | null,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  let resource = "a preview resource";
  if (targetUrl) {
    try {
      resource = new URL(targetUrl).pathname.slice(0, 160) || "/";
    } catch {
      /* keep the generic resource label */
    }
  }
  const sizeMessage = detail.match(
    /Shared preview response (?:is [\d.]+ MiB; the limit is \d+ MiB|exceeded the \d+ MiB limit)\.?/i,
  )?.[0];
  if (sizeMessage) {
    return `Session Share could not load ${resource}. ${sizeMessage} Reduce that asset or raise the Session Share response limit.`;
  }
  if (detail.includes("fetch failed")) {
    let port = "";
    if (targetUrl) {
      try {
        const target = new URL(targetUrl);
        port =
          target.port ||
          target.hostname.match(/--([1-9]\d{0,4})(?:\.|$)/)?.[1] ||
          "";
      } catch {
        /* keep the port unknown */
      }
    }
    const portLabel = port ? ` on port ${port}` : "";
    return `Session Share could not reach ${resource}${portLabel}. Make sure the preview server is running, then reload this page.`;
  }
  if (detail.includes("Shared preview host is busy")) {
    return `Session Share could not load ${resource} because the preview host is busy. Reload the page to try again.`;
  }
  return `Session Share could not load ${resource}. Reload the page; if it fails again, check the Session Share plugin logs.`;
}

const previewHostBusyRetryDelaysMs = [50, 150, 500, 1_000] as const;

export async function retryPreviewHostBusy<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<unknown> = delay,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !String(error).includes("Shared preview host is busy") ||
        attempt >= previewHostBusyRetryDelaysMs.length
      ) {
        throw error;
      }
      await wait(previewHostBusyRetryDelaysMs[attempt]!);
    }
  }
}

export default async function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, [...SHARE_MIGRATIONS]);
  const shareStore = createShareStore(database);
  const settings = bb.settings.define({
    tunnelToken: {
      type: "string",
      label: "Cloudflare tunnel token",
      description: "For named tunnels only.",
      secret: true,
    },
    customHostname: {
      type: "string",
      label: "Custom tunnel hostname",
      description: "Public hostname for your named tunnel.",
      default: "",
    },
    cloudflaredPath: {
      type: "string",
      label: "cloudflared executable",
      description: "Executable name or full path.",
      default: "cloudflared",
    },
    viewerPort: {
      type: "string",
      label: "Viewer port",
      description: "Local-only port for shared viewers.",
      default: "43127",
    },
  });

  const shares = new Map<string, ActiveShare>();
  const shareIdByThread = new Map<string, string>();
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  let guestServer: GuestServerHandle | null = null;
  const tunnelState: Record<TunnelMode, TunnelState> = {
    quick: { handle: null, ready: false, retryCount: 0 },
    custom: { handle: null, ready: false, retryCount: 0 },
  };
  let customInfrastructurePersistent = false;
  let transition: Promise<void> = Promise.resolve();

  async function conversation(
    threadId: string,
    renderMessage: (messageId: string, markdown: string) => Promise<string>,
  ): Promise<{
    messages: GuestMessage[];
    maxSeq: number;
  }> {
    const timeline = await bb.sdk.threads.timeline({
      threadId,
      includeNestedRows: "false",
      segmentLimit: "100",
    });
    const messages = await Promise.all(
      timeline.rows
        .filter((row) => row.kind === "conversation")
        .map(async (row): Promise<GuestMessage> => ({
          id: row.id,
          role: row.role,
          text: row.text,
          html: await renderMessage(row.id, row.text),
          createdAt: row.createdAt,
        })),
    );
    return { messages, maxSeq: timeline.maxSeq };
  }

  function assertGuestPreviewTarget(target: URL, viewerOrigin?: string): void {
    const loopback = new URL(bb.server.loopbackBaseUrl);
    const protectedOrigins = [loopback.origin, viewerOrigin, bb.server.experimental_appUrl ? new URL(bb.server.experimental_appUrl).origin : null];
    const fetched = hostFetchUrl(target);
    const port = fetched.port || (fetched.protocol === "https:" ? "443" : "80");
    const serverPort = loopback.port || (loopback.protocol === "https:" ? "443" : "80");
    if (protectedOrigins.includes(target.origin) || port === serverPort) {
      throw new Error("The BB server cannot be a shared preview target.");
    }
  }

  async function proxyPinpointRequest(
    approvedTargetUrl: string,
    hostId: string,
    request: GuestProxyRequest,
  ): Promise<GuestProxyResponse> {
    const signal = AbortSignal.timeout(15_000);
    if (request.route === "pinpoint-controller.js") {
      const controller = await bb.sdk.plugins.callRpc({
        pluginId: "pinpoint", method: "publicReviewController", input: null,
        outputSchema: pinpointPublicReviewControllerOutputSchema, signal,
      });
      return { status: 200, contentType: "text/javascript; charset=utf-8", body: Buffer.from(controller.script, "utf8") };
    }
    if (request.route === "pinpoint-styles.css") {
      const styles = await bb.sdk.plugins.callRpc({
        pluginId: "pinpoint", method: "publicReviewStyles", input: null,
        outputSchema: pinpointPublicReviewStylesOutputSchema, signal,
      });
      return { status: 200, contentType: "text/css; charset=utf-8", body: Buffer.from(styles.css, "utf8") };
    }
    if (!request.targetUrl) throw new Error("Pinpoint preview request is missing its target URL.");
    let target = approvedNavigationUrl(approvedTargetUrl, request.targetUrl);
    assertGuestPreviewTarget(target, request.publicOrigin);
    let status = 200;
    let contentType: string;
    let body: Buffer;
    if (request.route === "picker-lib.js") {
      const prepared = await bb.sdk.plugins.callRpc({
        pluginId: "pinpoint", method: "prepareGuestPickerLibrary", signal,
        input: { isolationVersion: 1, targetUrl: target.href, proxyBase: request.publicProxyBase },
        outputSchema: preparedPreviewSchema,
      });
      return { status: 200, isolationVersion: prepared.isolationVersion, headers: prepared.headers, contentType: prepared.contentType, body: Buffer.from(prepared.bodyBase64, "base64") };
    } else {
      let fetched: {
        status: number; contentType: string; location: string | null;
        bodyBase64: string; continuationToken: string | null;
      } | undefined;
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        assertGuestPreviewTarget(target, request.publicOrigin);
        fetched = await retryPreviewHostBusy(() => hostClient.call("fetch", {
          url: hostFetchUrl(target).href,
        }, { hostId, signal, timeoutMs: 15_000 }));
        if (fetched.status < 300 || fetched.status >= 400 || !fetched.location) break;
        if (fetched.continuationToken) await hostClient.call("discardResponse", { continuationToken: fetched.continuationToken }, { hostId, signal });
        if (redirectCount === 5) throw new Error("Pinpoint preview exceeded five redirects.");
        target = approvedNavigationUrl(approvedTargetUrl, new URL(fetched.location, target).href);
      }
      if (!fetched) throw new Error("Pinpoint preview fetch did not run.");
      const chunks = [Buffer.from(fetched.bodyBase64, "base64")];
      let bytes = chunks[0]!.length;
      let continuationToken = fetched.continuationToken;
      try {
        while (continuationToken) {
          if (bytes > PREVIEW_MAX_BYTES) throw new Error("Preview resource exceeds 32 MiB.");
          const chunk = await hostClient.call("fetchChunk", { continuationToken }, { hostId, signal });
          continuationToken = chunk.continuationToken;
          const decoded = Buffer.from(chunk.bodyBase64, "base64");
          bytes += decoded.length;
          chunks.push(decoded);
        }
        if (bytes > PREVIEW_MAX_BYTES) throw new Error("Preview resource exceeds 32 MiB.");
      } finally {
        if (continuationToken) void hostClient.call("discardResponse", { continuationToken }, { hostId, timeoutMs: 1_000 }).catch(() => undefined);
      }
      body = Buffer.concat(chunks, bytes);
      status = fetched.status;
      contentType = fetched.contentType;
    }
    const prepared = await bb.sdk.plugins.callRpc({
      pluginId: "pinpoint", method: "prepareGuestProxy", signal,
      input: { isolationVersion: 1, targetUrl: target.href, proxyBase: request.publicProxyBase, contentType, bodyBase64: body.toString("base64") },
      outputSchema: preparedPreviewSchema,
    });
    return { status, isolationVersion: prepared.isolationVersion, headers: prepared.headers, contentType: prepared.contentType, body: Buffer.from(prepared.bodyBase64, "base64") };
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    transition = transition
      .catch(() => undefined)
      .then(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      });
    return promise;
  }

  async function ensureGuestServer(port: number): Promise<GuestServerHandle> {
    if (guestServer) return guestServer;
    guestServer = await createGuestServer({
      port,
      log: (message) => bb.log.warn(message),
    });
    return guestServer;
  }

  function markTunnelReady(mode: TunnelMode): void {
    const state = tunnelState[mode];
    state.ready = true;
    state.retryCount = 0;
    for (const share of shares.values()) {
      if (share.status.tunnelMode !== mode || share.status.ready) continue;
      share.status.ready = true;
      bb.realtime.publish("session-share", {
        shareId: share.status.id,
        threadId: share.status.threadId,
        state: "ready",
      });
    }
  }

  async function ensureTunnel(
    mode: TunnelMode,
    configuration: {
      cloudflaredPath: string;
      customHostname: string;
      tunnelToken: string;
    },
    localUrl: string,
  ): Promise<TunnelHandle> {
    const state = tunnelState[mode];
    if (state.handle) return state.handle;
    const tunnel = await startCloudflareTunnel({
      cloudflaredPath: configuration.cloudflaredPath,
      localUrl,
      mode,
      ...(mode === "custom"
        ? {
            customHostname: configuration.customHostname,
            tunnelToken: configuration.tunnelToken,
          }
        : {}),
      log: (message) => bb.log.info(`[cloudflared:${mode}] ${message}`),
    });
    state.handle = tunnel;
    void tunnel.reachable.then(
      () => {
        if (state.handle === tunnel) markTunnelReady(mode);
      },
      (error) => {
        bb.log.warn(`${mode} tunnel URL is unavailable: ${String(error)}`);
        void serialize(() =>
          mode === "quick"
            ? recoverQuickTunnel(tunnel)
            : recoverCustomTunnel(tunnel),
        );
      },
    );
    void tunnel.closed.then(() => {
      void serialize(() =>
        mode === "quick"
          ? recoverQuickTunnel(tunnel)
          : recoverCustomTunnel(tunnel),
      );
    });
    return tunnel;
  }

  async function recoverQuickTunnel(failed: TunnelHandle): Promise<void> {
    const state = tunnelState.quick;
    if (state.handle !== failed) return;
    state.handle = null;
    state.ready = false;
    await failed.stop().catch(() => undefined);
    const quickShares = Array.from(shares.values()).filter(
      (share) => share.status.tunnelMode === "quick",
    );
    if (quickShares.length === 0 || !guestServer) return;
    if (state.retryCount >= 3) {
      bb.log.warn("Quick Tunnel DNS failed after three automatic retries.");
      return;
    }
    state.retryCount += 1;
    const replacement = await ensureTunnel(
      "quick",
      normalizeTunnelConfiguration(await settings.get()),
      guestServer.localUrl,
    );
    for (const share of quickShares) {
      share.status.publicUrl = `${replacement.publicUrl}${sharePath(share.status.id)}`;
      shareStore.updatePublicUrl(share.status.id, share.status.publicUrl);
      share.status.ready = false;
      bb.realtime.publish("session-share", {
        shareId: share.status.id,
        threadId: share.status.threadId,
        state: "preparing",
      });
    }
  }

  async function recoverCustomTunnel(failed: TunnelHandle): Promise<void> {
    const state = tunnelState.custom;
    if (state.handle !== failed) return;
    state.handle = null;
    state.ready = false;
    await failed.stop().catch(() => undefined);
    const customShares = Array.from(shares.values()).filter(
      (share) => share.status.tunnelMode === "custom",
    );
    for (const share of customShares) {
      share.status.ready = false;
      bb.realtime.publish("session-share", {
        shareId: share.status.id,
        threadId: share.status.threadId,
        state: "preparing",
      });
    }
    if (
      (!customInfrastructurePersistent && customShares.length === 0) ||
      !guestServer
    ) {
      return;
    }
    const tunnelConfiguration = normalizeTunnelConfiguration(
      await settings.get(),
    );
    const { customHostname, tunnelToken } = tunnelConfiguration;
    if (!customHostname || !tunnelToken) {
      customInfrastructurePersistent = false;
      await stopUnusedInfrastructure("custom");
      return;
    }
    while (state.retryCount < 3 && !state.handle) {
      state.retryCount += 1;
      try {
        await ensureTunnel(
          "custom",
          tunnelConfiguration,
          guestServer.localUrl,
        );
      } catch (error) {
        bb.log.warn(`could not restart custom tunnel: ${String(error)}`);
        await delay(1_000, undefined, { ref: false });
      }
    }
    if (!state.handle) {
      bb.log.warn("Custom tunnel failed after three automatic retries.");
    }
  }

  async function stopUnusedInfrastructure(mode: TunnelMode): Promise<void> {
    const modeStillUsed = Array.from(shares.values()).some(
      (share) => share.status.tunnelMode === mode,
    );
    const keepTunnelRunning =
      mode === "custom" && customInfrastructurePersistent;
    if (!modeStillUsed && !keepTunnelRunning) {
      const state = tunnelState[mode];
      const tunnel = state.handle;
      state.handle = null;
      state.ready = false;
      state.retryCount = 0;
      await tunnel?.stop().catch((error) =>
        bb.log.warn(`could not stop ${mode} tunnel: ${String(error)}`),
      );
    }
    if (
      shares.size === 0 &&
      guestServer &&
      !customInfrastructurePersistent
    ) {
      const server = guestServer;
      guestServer = null;
      await server.close().catch((error) =>
        bb.log.warn(`could not stop guest server: ${String(error)}`),
      );
    }
  }

  async function stopShare(shareId: string, reason: string): Promise<boolean> {
    const current = shares.get(shareId);
    const persisted = shareStore.get(shareId);
    if (!current && !persisted) return false;
    const threadId = current?.status.threadId ?? persisted!.threadId;
    if (current) {
      shares.delete(shareId);
      clearTimeout(current.expiryTimer ?? undefined);
      guestServer?.removeShare(shareId);
      await stopUnusedInfrastructure(current.status.tunnelMode);
    }
    if (shareIdByThread.get(threadId) === shareId) {
      shareIdByThread.delete(threadId);
    }
    shareStore.delete(shareId);
    bb.log.info(`stopped shared session ${shareId}: ${reason}`);
    bb.realtime.publish("session-share", {
      shareId,
      threadId,
      state: "stopped",
    });
    return true;
  }

  function armExpiry(shareId: string, expiresAt: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const share = shares.get(shareId);
      if (!share) return;
      if (Date.now() < expiresAt) {
        share.expiryTimer = armExpiry(shareId, expiresAt);
      } else {
        void serialize(() => stopShare(shareId, "expired"));
      }
    }, Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now())));
    timer.unref?.();
    return timer;
  }

  function persistentShareStatus(share: PersistentShare): ShareStatus {
    const active = shares.get(share.id)?.status;
    if (active) return active;
    return {
      id: share.id,
      threadId: share.threadId,
      title: share.title,
      mode: share.mode,
      tunnelMode: share.tunnelMode,
      publicUrl: share.publicUrl,
      localUrl: "",
      accessCode: share.accessCode,
      previewUrl: share.previewUrl,
      ready: false,
      startedAt: share.startedAt,
      expiresAt: share.expiresAt,
    };
  }

  function persistentShareIsCurrent(share: PersistentShare): boolean {
    return share.expiresAt === null || share.expiresAt > Date.now();
  }

  function currentThreadShare(threadId: string): ShareStatus | null {
    const persistedShare = shareStore.getByThread(threadId);
    return persistedShare && persistentShareIsCurrent(persistedShare)
      ? persistentShareStatus(persistedShare)
      : null;
  }

  function listKnownShares(): ShareStatus[] {
    return shareStore
      .list()
      .filter(persistentShareIsCurrent)
      .map(persistentShareStatus);
  }

  async function startShare(
    input: {
      threadId: string;
      durationMinutes: number;
      mode: ShareMode;
      tunnelMode: TunnelMode;
    },
    restored?: PersistentShare,
  ): Promise<ShareStatus> {
    if (restored && shares.has(restored.id)) {
      return shares.get(restored.id)!.status;
    }
    if (!restored) {
      const previousShare = shareStore.getByThread(input.threadId);
      if (previousShare) {
        await stopShare(previousShare.id, "replaced for thread");
      }
    }

    const configuration = await settings.get();
    const port = parsePort(configuration.viewerPort);
    const tunnelConfiguration = normalizeTunnelConfiguration(configuration);
    const { customHostname, tunnelToken } = tunnelConfiguration;
    if (input.tunnelMode === "custom" && (!customHostname || !tunnelToken)) {
      throw new Error(
        "Custom sharing requires customHostname and tunnelToken in the Session Share plugin settings.",
      );
    }

    let previewUrl: string | null = restored?.previewUrl ?? null;
    if (!restored && input.mode === "review") {
      const target = await bb.sdk.plugins.callRpc({
        pluginId: "pinpoint",
        method: "liveTarget",
        input: { threadId: input.threadId },
        outputSchema: pinpointLiveTargetOutputSchema,
      });
      previewUrl = target.url;
      if (!previewUrl) {
        throw new Error(
          "Open the live site in this thread's Pinpoint panel before creating a Review link.",
        );
      }
    }
    if (previewUrl) assertGuestPreviewTarget(approvedNavigationUrl(previewUrl, previewUrl));
    const thread = await bb.sdk.threads.get({ threadId: input.threadId });
    const [environment, project] = await Promise.all([
      thread.environmentId
        ? bb.sdk.environments.get({ environmentId: thread.environmentId })
        : Promise.resolve(null),
      bb.sdk.projects.get({ projectId: thread.projectId }),
    ]);
    const hostId = environment?.hostId ?? null;
    if (previewUrl && !hostId) {
      throw new Error("The Pinpoint target thread has no connected environment host.");
    }
    const server = await ensureGuestServer(port);
    const tunnel = await ensureTunnel(
      input.tunnelMode,
      tunnelConfiguration,
      server.localUrl,
    );
    if (input.tunnelMode === "custom") {
      customInfrastructurePersistent = true;
    }

    const startedAt = restored?.startedAt ?? Date.now();
    const expiresAt = restored
      ? restored.expiresAt
      : input.durationMinutes === 0
        ? null
        : startedAt + input.durationMinutes * 60_000;
    const reviewRef = restored?.reviewRef ?? (previewUrl ? `review_${randomBytes(32).toString("hex")}` : "");
    const shareId =
      restored?.id ?? `share_${randomBytes(18).toString("base64url")}`;
    const accessCode = restored?.accessCode ?? generateAccessCode();
    const path = sharePath(shareId);
    const status: ShareStatus = {
      id: shareId,
      threadId: input.threadId,
      title: threadTitle(thread),
      mode: input.mode,
      tunnelMode: input.tunnelMode,
      publicUrl: `${tunnel.publicUrl}${path}`,
      localUrl: `${server.localUrl}${path}`,
      accessCode,
      previewUrl,
      ready: tunnelState[input.tunnelMode].ready,
      startedAt,
      expiresAt,
    };
    let navigation: GuestNavigation | null = previewUrl
      ? { url: previewUrl, revision: 0 }
      : null;
    let pendingGuestNavigation = false;
    let proxyError: string | null = null;
    let proxyErrorExpiresAt = 0;
    const renderedMessageCache = new Map<
      string,
      { markdown: string; html: string }
    >();
    const renderMessage = async (
      messageId: string,
      markdown: string,
    ): Promise<string> => {
      const cached = renderedMessageCache.get(messageId);
      if (cached?.markdown === markdown) return cached.html;
      const html = renderSharedMarkdown(markdown);
      renderedMessageCache.set(messageId, { markdown, html });
      if (renderedMessageCache.size > 200) {
        renderedMessageCache.delete(renderedMessageCache.keys().next().value!);
      }
      return html;
    };
    const moveOwnerToNavigation = async (): Promise<boolean> => {
      if (!navigation) return false;
      try {
        const moved = await bb.sdk.plugins.callRpc({
          pluginId: "pinpoint",
          method: "navigateLiveTarget",
          input: {
            threadId: input.threadId,
            url: navigation.url,
            shareId,
            revision: navigation.revision,
          },
          outputSchema: pinpointRemoveOutputSchema,
        });
        pendingGuestNavigation = !moved.ok;
        return moved.ok;
      } catch (error) {
        pendingGuestNavigation = true;
        bb.log.warn(`could not move the owner Pinpoint panel: ${String(error)}`);
        return false;
      }
    };
    const syncOwnerNavigation = async (): Promise<void> => {
      if (!previewUrl) return;
      try {
        const liveTarget = await bb.sdk.plugins.callRpc({
          pluginId: "pinpoint",
          method: "liveTarget",
          input: { threadId: input.threadId },
          outputSchema: pinpointLiveTargetOutputSchema,
        });
        if (!liveTarget.url) return;
        if (pendingGuestNavigation) {
          await moveOwnerToNavigation();
          return;
        }
        const target = approvedNavigationUrl(previewUrl, liveTarget.url);
        if (navigation?.url === target.href) return;
        navigation = {
          url: target.href,
          revision: (navigation?.revision ?? 0) + 1,
        };
      } catch (error) {
        bb.log.debug(`could not synchronize owner navigation: ${String(error)}`);
      }
    };
    const guestScope = (participantRef: string) => {
      if (!previewUrl || !navigation) throw new Error("This share has no live Pinpoint capture.");
      if (!shares.has(shareId) || (status.expiresAt !== null && status.expiresAt <= Date.now())) throw new Error("This shared review is no longer active.");
      const url = new URL(navigation.url);
      url.hash = "";
      return { isolationVersion: 1 as const, threadId: input.threadId, url: url.href, reviewRef, participantRef };
    };
    const loadGuestRows = async (participantRef: string) => {
      if (!previewUrl) return [];
      const scope = guestScope(participantRef);
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "pinpoint", method: "listGuest", input: scope, outputSchema: guestListOutputSchema,
      });
      return result.rows.filter((row) => {
        if (!row.annotation.url) return false;
        let page: URL;
        try { page = new URL(row.annotation.url); } catch { return false; }
        page.hash = "";
        if (page.href !== scope.url) return false;
        row.guestCanDelete = row.guestCanDelete && row.authoredByGuest && row.guestPending;
        return true;
      });
    };


    const accessCredentials = await server.addShare({
      id: shareId,
      projectName: project.name,
      ...(restored
        ? { accessCredentials: restored.accessCredentials }
        : { accessCode }),
      expiresAt,
      reviewEnabled: input.mode === "review",
      previewUrl,
      getState(participantRef) {
        return serialize(async () => {
          await syncOwnerNavigation();
          const [latestThread, pinpointRows, conversationState] = await Promise.all([
            bb.sdk.threads.get({ threadId: input.threadId }),
            loadGuestRows(participantRef),
            previewUrl
              ? Promise.resolve({ messages: [], maxSeq: 0 })
              : conversation(input.threadId, renderMessage),
          ]);
          const {
            accessCode: _accessCode,
            localUrl: _localUrl,
            ...publicShare
          } = status;
          if (proxyErrorExpiresAt > 0 && Date.now() >= proxyErrorExpiresAt) {
            proxyError = null;
            proxyErrorExpiresAt = 0;
          }
          return {
            share: publicShare,
            thread: { status: latestThread.status },
            ...conversationState,
            pinpointRows,
            navigation: navigation ? { ...navigation } : null,
            proxyError,
          };
        });
      },
      navigate(url) {
        return serialize(async () => {
          if (!shares.has(shareId)) {
            throw new Error("This shared review is no longer active.");
          }
          if (!previewUrl || !navigation) {
            throw new Error("This share has no live Pinpoint capture.");
          }
          const target = approvedNavigationUrl(previewUrl, url);
          if (navigation.url === target.href) {
            if (pendingGuestNavigation) await moveOwnerToNavigation();
            return navigation;
          }
          proxyError = null;
          proxyErrorExpiresAt = 0;
          navigation = {
            url: target.href,
            revision: navigation.revision + 1,
          };
          pendingGuestNavigation = true;
          await moveOwnerToNavigation();
          return navigation;
        });
      },
      loadScreenshot({ id, kind }, participantRef) {
        return serialize(async () => {
          if (!(await loadGuestRows(participantRef)).some((row) => row.annotation.id === id)) {
            throw new Error("This Pinpoint screenshot does not belong to the shared review page.");
          }
          return (
            await bb.sdk.plugins.callRpc({
              pluginId: "pinpoint",
              method: "screenshotGuest",
              input: { ...guestScope(participantRef), id, kind },
              outputSchema: pinpointScreenshotOutputSchema,
            })
          ).shot;
        });
      },
      submitFeedback(feedback, participantRef) {
        return serialize(async () => {
          const scope = guestScope(participantRef);
          if (feedback.pinpointIntent) {
            const intent = feedback.pinpointIntent;
            const row = (await loadGuestRows(participantRef)).find((candidate) => candidate.annotation.id === intent.id);
            if (!row || (intent.action === "delete" && !row.guestCanDelete)) {
              throw new Error("This guest cannot change that annotation.");
            }
            await bb.sdk.plugins.callRpc({
              pluginId: "pinpoint",
              method: intent.action === "delete" ? "deleteGuest" : "replyGuest",
              input: { ...scope, id: intent.id, ...(intent.action === "reply" ? { text: intent.text ?? "" } : {}) },
              outputSchema: z.object({ ok: z.literal(true) }),
            });
            return;
          }
          if (!feedback.pinpointPayload) throw new Error("Pinpoint capture payload is missing.");
          const pick = pinpointPickPayloadSchema.parse(feedback.pinpointPayload);
          const page = approvedNavigationUrl(previewUrl!, pick.url);
          page.hash = "";
          if (page.href !== scope.url) throw new Error("Pinpoint capture left the shared review page.");
          const capture = await bb.sdk.plugins.callRpc({
            pluginId: "pinpoint",
            method: "captureGuest",
            input: {
              ...scope,
              comment: pick.comment ?? feedback.comment,
              pathname: page.pathname,
              title: pick.title ?? null,
              selector: pick.selector ?? null,
              elementPath: pick.elementPath ?? null,
              element: pick.tag ?? null,
              cssClasses: pick.cssClasses?.join(" ") ?? null,
              reactComponents: pick.componentName ?? null,
              nearbyText: pick.nearbyText ?? null,
              selectedText: pick.selectedText ?? null,
              x: pick.x ?? null,
              y: pick.y ?? null,
              anchorOffsetX: pick.anchorOffsetX ?? null,
              anchorOffsetY: pick.anchorOffsetY ?? null,
              screenshotExpected: pick.screenshotExpected ?? null,
              boundingBox: pick.rect
                ? {
                    x: pick.rect.x,
                    y: pick.rect.y,
                    width: pick.rect.w,
                    height: pick.rect.h,
                  }
                : null,
              clientId: pick.clientId ?? null,
              computedStyles: pick.computedStyles ?? null,
              accessibility: pick.accessibility ?? null,
              nearbyElements: pick.nearbyElements ?? null,
              intent: pick.intent ?? null,
              severity: pick.severity ?? null,
              kind: pick.kind ?? null,
              textOld: pick.textOld ?? null,
              textNew: pick.textNew ?? null,
            },
            outputSchema: guestCaptureOutputSchema,
          });
          return { ...capture, pageUrl: scope.url };
        });
      },
      async uploadScreenshot(input) {
        await bb.sdk.plugins.callRpc({
          pluginId: "pinpoint", method: "uploadGuestScreenshot",
          input: { isolationVersion: 1, ...input }, outputSchema: z.object({ ok: z.literal(true) }),
        });
      },
      ...(previewUrl
        ? {
            proxyRequest: async (request: GuestProxyRequest) => {
              if (!hostId) {
                throw new Error("The Pinpoint target host is unavailable.");
              }
              try {
                const proxyResponse = await proxyPinpointRequest(
                  previewUrl,
                  hostId,
                  request,
                );
                proxyError = null;
                proxyErrorExpiresAt = 0;
                return proxyResponse;
              } catch (error) {
                proxyError = formatPublicProxyError(error, request.targetUrl);
                proxyErrorExpiresAt = String(error).includes(
                  "Shared preview host is busy",
                )
                  ? Date.now() + 6_000
                  : 0;
                throw error;
              }
            },
          }
        : {}),
    });

    try {
      shareStore.save({
        id: shareId,
        threadId: input.threadId,
        title: status.title,
        mode: input.mode,
        tunnelMode: input.tunnelMode,
        publicUrl: status.publicUrl,
        accessCode,
        accessCredentials,
        previewUrl,
        startedAt,
        expiresAt,
        reviewRef,
      });
    } catch (error) {
      server.removeShare(shareId);
      throw error;
    }
    const expiryTimer = expiresAt === null ? null : armExpiry(shareId, expiresAt);
    shares.set(shareId, { status, expiryTimer });
    shareIdByThread.set(input.threadId, shareId);
    bb.log.info(`sharing thread ${status.threadId} at ${status.publicUrl}`);
    bb.realtime.publish("session-share", {
      shareId,
      threadId: status.threadId,
      state: "active",
    });
    return status;
  }

  async function stopAll(reason: string): Promise<void> {
    for (const share of shares.values()) {
      if (share.expiryTimer) clearTimeout(share.expiryTimer);
    }
    shares.clear();
    shareIdByThread.clear();
    const server = guestServer;
    const tunnels = Object.values(tunnelState)
      .map((state) => state.handle)
      .filter((value): value is TunnelHandle => value !== null);
    guestServer = null;
    for (const state of Object.values(tunnelState)) {
      state.handle = null;
      state.ready = false;
      state.retryCount = 0;
    }
    await Promise.allSettled([
      ...tunnels.map((tunnel) => tunnel.stop()),
      ...(server ? [server.close()] : []),
    ]);
    bb.log.info(`stopped session-share runtime: ${reason}`);
  }

  bb.rpc.register(rpcContract, {
    async status({ threadId }) {
      const configuration = await settings.get();
      const tunnelConfiguration = normalizeTunnelConfiguration(configuration);
      return {
        share: currentThreadShare(threadId),
        customHostname: configuration.customHostname.trim(),
        customConfigured: Boolean(
          tunnelConfiguration.customHostname &&
            tunnelConfiguration.tunnelToken,
        ),
        cloudflaredAvailable: await executableAvailable(
          tunnelConfiguration.cloudflaredPath,
        ),
        pinpointTargetUrl: currentThreadShare(threadId)?.previewUrl ?? null,
      };
    },
    async reviewTarget({ threadId }) {
      const target = await bb.sdk.plugins.callRpc({
        pluginId: "pinpoint",
        method: "liveTarget",
        input: { threadId },
        outputSchema: pinpointLiveTargetOutputSchema,
      });
      return { url: target.url };
    },
    // Lightweight per-thread lookup: no settings, executable probe or Pinpoint call.
    share({ threadId }) {
      return { share: currentThreadShare(threadId) };
    },
    start(input) {
      return serialize(async () => ({ share: await startShare(input) }));
    },
    list() {
      return {
        shares: listKnownShares(),
      };
    },
    revoke({ shareId }) {
      return serialize(async () => ({
        stopped: await stopShare(shareId, "owner revoked"),
      }));
    },
    stop({ threadId }) {
      return serialize(async () => {
        const shareId = shareStore.getByThread(threadId)?.id;
        return {
          stopped: shareId
            ? await stopShare(shareId, "owner stopped")
            : false,
        };
      });
    },
  });

  // ---- Agent-facing CLI (`bb session-share …`) --------------------------------
  // Exposes create/inspect/stop over the bb CLI so the Handsfree voice agent
  // (via run_plugin_command) and any script can set up a share hands-free. It
  // wraps the exact startShare/stopShare the UI uses; the thread id defaults to
  // the caller's current thread context when omitted.
  function describeShare(share: ShareStatus): string {
    const expiry =
      share.expiresAt === null
        ? "until revoked"
        : `expires in ~${Math.max(0, Math.round((share.expiresAt - Date.now()) / 60_000))} min`;
    return [
      `"${share.title}" (${share.mode} · ${share.tunnelMode})`,
      `  URL:  ${share.publicUrl}`,
      `  Code: ${share.accessCode}`,
      `  ${share.ready ? "Ready" : "Restoring…"} · ${expiry}`,
    ].join("\n");
  }

  bb.cli.register({
    name: "session-share",
    summary: "Create and manage shareable, password-protected links to a bb session",
    commands: [
      {
        name: "start",
        summary: "Start a share for a thread; prints its public URL and access code.",
        usage: "bb session-share start [<thread-id>] [--minutes N|0] [--mode view|review] [--tunnel quick|custom]",
      },
      { name: "list", summary: "List stored shares with their URLs and access codes.", usage: "bb session-share list" },
      { name: "status", summary: "Show the stored share for a thread, if any.", usage: "bb session-share status [<thread-id>]" },
      { name: "stop", summary: "Revoke the stored share for a thread.", usage: "bb session-share stop [<thread-id>]" },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      // Parse "--name value" flags out; the first bare token is the thread id.
      const flags: Record<string, string> = {};
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i += 1) {
        const token = rest[i];
        if (token.startsWith("--")) {
          flags[token.slice(2)] = rest[i + 1] ?? "";
          i += 1;
        } else {
          positionals.push(token);
        }
      }
      const help = [
        "Session Share: shareable, password-protected links to a bb session",
        "",
        "Usage:",
        "  bb session-share start [<thread-id>] [--minutes N|0] [--mode view|review] [--tunnel quick|custom]",
        "  bb session-share list",
        "  bb session-share status [<thread-id>]",
        "  bb session-share stop [<thread-id>]",
        "",
        "Thread id defaults to the current thread. Duration is 15–525600 minutes, or 0 for until revoked (default 60).",
      ].join("\n");
      try {
        if (!command || command === "help" || command === "--help" || command === "-h") {
          return { exitCode: 0, stdout: help };
        }
        if (command === "start") {
          const threadId = positionals[0] ?? ctx.threadId;
          if (!threadId) {
            return { exitCode: 1, stderr: "No thread id. Pass one: bb session-share start <thread-id>." };
          }
          const parsedMinutes = Number.parseInt(flags.minutes ?? "60", 10);
          const durationMinutes = Number.isFinite(parsedMinutes)
            ? parsedMinutes === 0
              ? 0
              : Math.min(525_600, Math.max(15, parsedMinutes))
            : 60;
          const mode: ShareMode = flags.mode === "review" ? "review" : "view";
          const tunnelMode: TunnelMode = flags.tunnel === "custom" ? "custom" : "quick";
          const share = await serialize(() => startShare({ threadId, durationMinutes, mode, tunnelMode }));
          return { exitCode: 0, stdout: `Share started.\n${describeShare(share)}` };
        }
        if (command === "list") {
          const all = listKnownShares();
          return { exitCode: 0, stdout: all.length ? all.map(describeShare).join("\n\n") : "No stored shares." };
        }
        if (command === "status") {
          const threadId = positionals[0] ?? ctx.threadId;
          if (!threadId) return { exitCode: 1, stderr: "No thread id." };
          const persisted = shareStore.getByThread(threadId);
          const status =
            persisted && persistentShareIsCurrent(persisted)
              ? persistentShareStatus(persisted)
              : null;
          return { exitCode: 0, stdout: status ? describeShare(status) : "No stored share for that thread." };
        }
        if (command === "stop") {
          const threadId = positionals[0] ?? ctx.threadId;
          if (!threadId) return { exitCode: 1, stderr: "No thread id." };
          const shareId = shareStore.getByThread(threadId)?.id;
          const stopped = shareId ? await serialize(() => stopShare(shareId, "stopped via CLI")) : false;
          return { exitCode: 0, stdout: stopped ? "Share revoked." : "No stored share for that thread." };
        }
        return { exitCode: 1, stderr: `Unknown command "${command}".\n\n${help}` };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  async function reconcilePersistentShares(): Promise<void> {
    const now = Date.now();
    for (const persisted of shareStore.list()) {
      if (persisted.expiresAt !== null && persisted.expiresAt <= now) {
        await stopShare(persisted.id, "expired while runtime was stopped");
        continue;
      }
      if (shares.has(persisted.id)) continue;
      try {
        await startShare(
          {
            threadId: persisted.threadId,
            durationMinutes: 0,
            mode: persisted.mode,
            tunnelMode: persisted.tunnelMode,
          },
          persisted,
        );
        bb.log.info(`restored shared session ${persisted.id}`);
      } catch (error) {
        bb.log.warn(
          `could not restore shared session ${persisted.id}: ${String(error)}`,
        );
      }
    }

    const configuration = await settings.get();
    const tunnelConfiguration = normalizeTunnelConfiguration(configuration);
    if (
      tunnelConfiguration.customHostname &&
      tunnelConfiguration.tunnelToken &&
      !tunnelState.custom.handle
    ) {
      const server = await ensureGuestServer(parsePort(configuration.viewerPort));
      await ensureTunnel("custom", tunnelConfiguration, server.localUrl);
      customInfrastructurePersistent = true;
    }
  }

  bb.background.service("restore-shares", {
    async start(signal) {
      while (!signal.aborted) {
        await serialize(reconcilePersistentShares).catch((error) =>
          bb.log.warn(`could not reconcile persistent shares: ${String(error)}`),
        );
        try {
          await delay(30_000, undefined, { signal, ref: false });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    },
  });

  bb.onDispose(async () => {
    await serialize(async () => stopAll("plugin disposed"));
  });
}
