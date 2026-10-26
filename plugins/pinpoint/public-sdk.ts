import { useEffect } from "react";
import { GUEST_PREVIEW_ISOLATION_VERSION } from "./lib/protocol";
import { guestRowSchema, type GuestPermissions } from "./lib/guest-review";

export interface PluginThreadPanelProps {
  threadId: string;
  params?: unknown;
}

export interface PublicConfig {
  isolationVersion: typeof GUEST_PREVIEW_ISOLATION_VERSION;
  permissions: GuestPermissions;
  threadId: string;
  target: string;
  proxyBase: string;
  stateUrl: string;
  navigationUrl: string;
  feedbackUrl: string;
  screenshotUrl: string;
  screenshotUploadUrl: string;
  csrf: string;
}

let config: PublicConfig | null = null;
let lastNavigationUrl = "";
const realtimeListeners = new Set<(payload: unknown) => void>();

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid public Pinpoint input.");
  return input as Record<string, unknown>;
}
export function configurePublicPinpoint(next: PublicConfig): void {
  if (next.isolationVersion !== GUEST_PREVIEW_ISOLATION_VERSION || !next.screenshotUploadUrl ||
      !next.permissions || !["capture", "reply", "delete"].every((key) =>
        typeof next.permissions[key as keyof GuestPermissions] === "boolean")) {
    throw new Error("This review server needs the Pinpoint isolated-preview update.");
  }
  if (config?.navigationUrl !== next.navigationUrl) {
    lastNavigationUrl = next.target;
  }
  config = next;
}

async function feedback(body: unknown): Promise<Record<string, unknown>> {
  if (!config) throw new Error("Public Pinpoint is not configured.");
  const response = await fetch(config.feedbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-share-csrf": config.csrf,
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(
      typeof result.error === "string" ? result.error : "Pinpoint action failed.",
    );
  return result;
}

function capturePayload(input: Record<string, unknown>) {
  const box = input.boundingBox as
    | { x: number; y: number; width: number; height: number }
    | null;
  return {
    url: input.url,
    pathname: input.pathname,
    title: input.title,
    selector: input.selector,
    elementPath: input.elementPath,
    tag: input.element,
    cssClasses:
      typeof input.cssClasses === "string"
        ? input.cssClasses.split(/\s+/).filter(Boolean)
        : [],
    componentName: input.reactComponents,
    nearbyText: input.nearbyText,
    selectedText: input.selectedText,
    x: input.x,
    y: input.y,
    anchorOffsetX: input.anchorOffsetX,
    anchorOffsetY: input.anchorOffsetY,
    screenshotExpected: input.screenshotExpected,
    rect: box
      ? { x: box.x, y: box.y, w: box.width, h: box.height }
      : null,
    clientId: input.clientId,
    computedStyles: input.computedStyles,
    accessibility: input.accessibility,
    nearbyElements: input.nearbyElements,
    intent: input.intent,
    severity: input.severity,
    kind: input.kind,
    textOld: input.textOld,
    textNew: input.textNew,
    comment: input.comment,
  };
}

const rpc = {
  async call(method: string, input: unknown): Promise<unknown> {
    if (!config) throw new Error("Public Pinpoint is not configured.");
    if (method === "config") {
      return {
        defaultUrl: config.target,
        relayMode: "thread",
        autoDispatch: false,
        clasiLearning: false,
        proxyBase: config.proxyBase,
      };
    }
    if (method === "list") {
      const response = await fetch(config.stateUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load Pinpoint history.");
      const state: unknown = await response.json();
      const rows =
        state && typeof state === "object" && "pinpointRows" in state
          ? state.pinpointRows
          : null;
      return { rows: Array.isArray(rows) ? rows.map((row) => guestRowSchema.parse(row)) : [] };
    }
    if (method === "capture") {
      if (!config.permissions.capture) throw new Error("Capturing feedback is disabled for this review.");
      const result = await feedback({ pinpoint: capturePayload(record(input)) });
      const capture = record(result.capture);
      if (typeof capture.captureId !== "string" || !capture.captureId) throw new Error("The review server did not confirm this capture.");
      return { row: null, dispatched: false, captureId: capture.captureId };
    }
    if (method === "uploadScreenshot") {
      const shot = record(input);
      if (shot.threadId !== config.threadId || typeof shot.url !== "string" ||
          new URL(shot.url).origin !== new URL(config.target).origin) {
        throw new Error("Screenshot is outside this shared preview.");
      }
      const response = await fetch(config.screenshotUploadUrl, {
        method: "POST", headers: { "content-type": "application/json", "x-share-csrf": config.csrf },
        body: JSON.stringify({
          clientId: shot.clientId, kind: shot.kind, mime: shot.mime,
          screenshot: shot.screenshot, url: shot.url,
        }),
      });
      if (!response.ok) throw new Error("Shared screenshot was not saved.");
      return { ok: true };
    }
    if (method === "remove") {
      if (!config.permissions.delete) throw new Error("Deleting feedback is disabled for this review.");
      await feedback({ intent: { id: record(input).id, action: "delete" } });
      return { ok: true };
    }
    if (method === "update") {
      const update = record(input);
      if (update.learning === true || update.action === "retry-learning") {
        throw new Error("Shared feedback cannot authorize Clasi learning. Review it in BB.");
      }
      if (update.action !== "feedback" || !config.permissions.reply) {
        throw new Error("Shared feedback cannot perform owner review or agent actions.");
      }
      await feedback({
        intent: {
          id: update.id,
          action: "reply",
          text: update.note,
        },
      });
      return { row: null };
    }
    if (method === "screenshot") {
      const shot = record(input);
      const id = typeof shot.id === "string" ? shot.id : "";
      const kind = typeof shot.kind === "string" ? shot.kind : "";
      const response = await fetch(
        `${config.screenshotUrl}?id=${encodeURIComponent(id)}&kind=${encodeURIComponent(kind)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return { shot: null };
      return response.json();
    }
    if (method === "setLiveTarget") {
      const navigation = record(input);
      if (typeof navigation.url !== "string") {
        throw new Error("Shared navigation URL is missing.");
      }
      if (navigation.url === lastNavigationUrl) return { ok: true };
      const response = await fetch(config.navigationUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-share-csrf": config.csrf,
        },
        body: JSON.stringify({ url: navigation.url }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "Could not synchronize shared navigation.",
        );
      }
      lastNavigationUrl = navigation.url;
      return result;
    }
    if (method === "clearLiveTarget") return { ok: true };
    throw new Error(`Unsupported public Pinpoint method: ${method}`);
  },
};

export function useRpc<T>(): typeof rpc {
  return rpc;
}

export function publishPublicPinpointState(input: unknown): void {
  try {
    if (!config) return;
    const state = record(input);
    const share = record(state.share);
    const navigation =
      state.navigation && typeof state.navigation === "object"
        ? record(state.navigation)
        : null;
    if (typeof navigation?.url === "string") {
      lastNavigationUrl = navigation.url;
    }
    const payload = {
      threadId: config.threadId,
      pinpointRows: Array.isArray(state.pinpointRows) ? state.pinpointRows : [],
      ...(navigation
        ? { navigation: { ...navigation, shareId: share.id } }
        : {}),
    };
    for (const listener of realtimeListeners) listener(payload);
  } catch {
    /* the outer guest page owns reconnect and expiry state */
  }
}

export function useRealtime(
  _channel: string,
  callback: (payload: unknown) => void,
) {
  useEffect(() => {
    realtimeListeners.add(callback);
    return () => {
      realtimeListeners.delete(callback);
    };
  }, [callback]);
}

export function definePluginApp<T>(registration: T): T {
  return registration;
}
