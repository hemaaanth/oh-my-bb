// bb-plugin-pinpoint — the Pinpoint panel (registered lazily by ./app).
//
// A browser in the thread's right panel. Load any URL through the plugin's
// same-origin proxy, flip on "Pick", click an element in the live page, and
// hand it to the agent as reviewable feedback. The panel is also the
// approve / re-feedback surface for whatever the agent marks ready.
import {
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// zod/mini (tree-shakable) rather than classic zod: these few boundary
// schemas were pulling the whole classic build into the app bundle. The
// English locale keeps rejection messages identical to classic zod's.
import * as z from "zod/mini";
import { en as zodEnglish } from "zod/locales";
import {
  useRealtime,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { PinpointAnnotation, rpcContract } from "./server";
import { Icon, type IconName } from "./components/ui/icon";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import * as sessions from "./lib/session-registry";
import type { PinpointSession } from "./lib/session-registry";
import { decideProtocolAction } from "./lib/protocol";
import {
  annotationIntents,
  annotationKinds,
  annotationSeverities,
  intentOf,
  severityOf,
  type AnnotationIntent,
  type AnnotationSeverity,
} from "./lib/afs-vocabulary";
import type { ResolutionScope } from "./lib/afs";
import { annotationConversation } from "./lib/annotation-conversation";
import { replyPlaceholderFor } from "./lib/reply-policy";
import { normalizeBrowserUrl, samePage } from "./lib/browser-url";
import { LIVE_TARGET_HEARTBEAT_MS } from "./lib/live-target";
import type { GuestRow, GuestPermissions, GuestFeedback } from "./lib/guest-review";

interface PinpointConfig {
  defaultUrl: string;
  relayMode: "thread" | "review-chat";
  autoDispatch: boolean;
  clasiLearning: boolean;
  proxyBase: string;
}
type Status = PinpointAnnotation["workflowState"];

// Flat view the UI works in, projected from the AFS row. `status` is the
// six-state UI workflow (white = open/dispatched = agent's inbox, yellow =
// ready/waiting-input = your inbox, grey = approved/dismissed = closed).
export interface ViewRow {
  id: string;
  status: Status;
  comment: string;
  summary: string | null;
  selector: string | null;
  x: number;
  y: number;
  anchorOffsetX: number | null;
  anchorOffsetY: number | null;
  selectedText: string | null;
  tag: string | null;
  pathname: string | null;
  url: string;
  authoredByAgent: boolean;
  authoredByGuest: boolean;
  guestPending: boolean;
  guestCanDelete: boolean;
  guestFeedback: GuestFeedback | null;
  /** Read-time defaults (fix / suggestion) — rows never store an absence. */
  intent: AnnotationIntent;
  severity: AnnotationSeverity;
  /** "text-edit" rows carry the old → new copy the reviewer typed in-page. */
  kind: PinpointAnnotation["annotation"]["kind"];
  textOld: string | null;
  textNew: string | null;
  thread: { id?: string; role: "human" | "agent"; content: string; guest?: boolean; ownerEdited?: boolean }[];
  /** Scope classification recorded at resolve time (declared or inferred). */
  scope: ResolutionScope | null;
  /** Agent-asserted diff receipt (already capped server-side). */
  receipt: string | null;
  /** The receipt never mentions this pin's data-pp anchor. */
  receiptAnchorWarning: boolean;
  /** One proposed design/copy learning awaiting the user's explicit opt-in. */
  proposedLearning: {
    topic: "design" | "copy";
    logicalKey: string;
    text: string;
  } | null;
  /** The user approved WITH the learning opt-in. */
  learningConsented: boolean;
  /** Clasi write outcome — the card NEVER shows saved without this. */
  learningWrite:
    | { state: "saved"; at: number }
    | { state: "failed"; error: string }
    | null;
  createdAt: number;
  /** Last dispatch failure, so the panel can show it + offer a retry. */
  lastError: string | null;
  /** Stored screenshot kinds (presence only; pixels are fetched lazily). */
  screenshots: PinpointAnnotation["screenshots"];
}
function view(r: PinpointAnnotation | GuestRow): ViewRow {
  const a = r.annotation;
  const owner = "routing" in r ? r : null;
  const context = owner?.annotation.pinpoint;
  const authoredByGuest = "authoredByGuest" in r ? r.authoredByGuest : context?.guestReview !== undefined;
  const conversation = annotationConversation({
    comment: a.comment,
    authorRole: a.pinpoint.authorRole,
    authoredByGuest,
    ownerEdited: context?.guestOriginal !== undefined || a.pinpoint.ownerEdited === true,
    thread: a.thread.map((m) => ({
      role: m.role, content: m.content, ...(m.guest ? { guest: true } : {}),
      ...("id" in m && typeof m.id === "string" ? { id: m.id } : {}),
      ownerEdited: ("guestOriginalContent" in m && m.guestOriginalContent !== undefined) || ("ownerEdited" in m && m.ownerEdited === true),
    })),
  });
  return {
    id: a.id,
    status: r.workflowState,
    comment: a.comment,
    summary: r.summary,
    selector: a.pinpoint.selector,
    x: a.x,
    y: a.y,
    anchorOffsetX: a.pinpoint.anchorOffset?.x ?? null,
    anchorOffsetY: a.pinpoint.anchorOffset?.y ?? null,
    selectedText: a.selectedText ?? null,
    tag: a.element ?? null,
    pathname: a.pinpoint.pathname,
    url: a.url ?? "",
    authoredByAgent: conversation.authoredByAgent,
    authoredByGuest,
    guestPending: r.guestPending === true,
    guestCanDelete: "guestCanDelete" in r && r.guestCanDelete,
    guestFeedback: owner?.guestFeedback ?? null,
    intent: intentOf(owner?.annotation ?? {}),
    severity: severityOf(owner?.annotation ?? {}),
    kind: a.kind,
    textOld: a.textOld ?? null,
    textNew: a.textNew ?? null,
    thread: conversation.messages,
    scope: context?.scope ?? null,
    receipt: context?.receipt ?? null,
    receiptAnchorWarning: context?.receiptAnchorWarning === true,
    proposedLearning: context?.proposedLearning ?? null,
    learningConsented: context?.learningConsent != null,
    learningWrite: context?.learningWrite ?? null,
    createdAt: r.createdAt,
    lastError: owner?.routing.lastError ?? null,
    screenshots: r.screenshots,
  };
}

// The picker runs inside the proxied page and talks to us over postMessage —
// a boundary, so validate it with a schema rather than trusting its shape.
// Loose on purpose: after a plugin update a live/parked iframe can still run
// a newer or older picker than this panel, so unknown extra fields must not
// fail the whole pick, and anything beyond the core is optional.
z.config(zodEnglish());
const pickPayloadSchema = z.looseObject({
  url: z.string(),
  pathname: z.optional(z.string()),
  title: z.optional(z.string()),
  selector: z.optional(z.string()),
  elementPath: z.optional(z.string()),
  tag: z.optional(z.string()),
  cssClasses: z.optional(z.array(z.string())),
  componentName: z.nullish(z.string()),
  nearbyText: z.optional(z.string()),
  selectedText: z.optional(z.string()),
  rect: z.nullish(
    z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  ),
  x: z.optional(z.number()),
  y: z.optional(z.number()),
  anchorOffsetX: z.optional(z.number()),
  anchorOffsetY: z.optional(z.number()),
  screenshotExpected: z.optional(z.boolean()),
  comment: z.optional(z.string()),
  // Capture enrichment (all optional — a pre-enrichment picker omits them).
  clientId: z.nullish(z.string()),
  computedStyles: z.nullish(z.string()),
  accessibility: z.nullish(z.string()),
  nearbyElements: z.nullish(z.string()),
  // `catch` so an unknown future value degrades to the default instead of
  // failing the whole pick message.
  intent: z.catch(z.nullish(z.enum(annotationIntents)), null),
  severity: z.catch(z.nullish(z.enum(annotationSeverities)), null),
  // Direct text edit (all optional — a pre-text-edit picker omits them).
  kind: z.catch(z.nullish(z.enum(annotationKinds)), null),
  textOld: z.nullish(z.string()),
  textNew: z.nullish(z.string()),
});
type PickPayload = z.infer<typeof pickPayloadSchema>;
const screenshotUploadMessageSchema = z.object({
  source: z.literal("bb-pinpoint"), type: z.literal("screenshot-upload"),
  clientId: z.string(), kind: z.enum(["element", "viewport"]),
  mime: z.enum(["image/webp", "image/png", "image/jpeg"]),
  screenshot: z.string().check(z.maxLength(2 * 1024 * 1024)), url: z.string(),
});
type PreviewShot = z.infer<typeof screenshotUploadMessageSchema>;
type PendingPreviewAction =
  | { kind: "capture"; payload: PickPayload }
  | { kind: "approve" | "dismiss" | "reply"; id: string; text: string }
  | { kind: "approve-guest"; id: string; feedback: GuestFeedback };
type PendingScreenshot = {
  threadId: string; url: string; expiresAt: number; shot?: PreviewShot;
  capture: Promise<string | null> | null; uploading: boolean;
};
const pickerMessageSchema = z.discriminatedUnion("type", [
  screenshotUploadMessageSchema,
  z.object({
    source: z.literal("bb-pinpoint"),
    type: z.literal("ready"),
    url: z.optional(z.string()),
    // Absent on pre-versioning pickers — treated as a protocol mismatch.
    protocol: z.optional(z.number()),
  }),
  z.object({
    source: z.literal("bb-pinpoint"),
    type: z.literal("navigate"),
    url: z.string(),
  }),
  z.object({ source: z.literal("bb-pinpoint"), type: z.literal("cancel") }),
  z.object({ source: z.literal("bb-pinpoint"), type: z.literal("toggle") }),
  z.object({ source: z.literal("bb-pinpoint"), type: z.literal("eye") }),
  z.object({ source: z.literal("bb-pinpoint"), type: z.literal("screenshot") }),
  z.object({
    source: z.literal("bb-pinpoint"),
    type: z.literal("pick"),
    payload: pickPayloadSchema,
  }),
  z.object({
    source: z.literal("bb-pinpoint"),
    type: z.literal("blocked"),
    reason: z.string(),
  }),
  z.object({
    source: z.literal("bb-pinpoint"),
    type: z.literal("intent"),
    id: z.string(),
    action: z.enum(["reply", "delete", "approve", "dismiss", "edit-guest", "approve-guest"]),
    text: z.optional(z.string()),
  }),
]);
const navigationSignalSchema = z.looseObject({
  threadId: z.string(),
  pinpointRows: z.optional(z.array(z.unknown())),
  navigation: z.optional(
    z.object({
      url: z.string(),
      shareId: z.string(),
      revision: z.int().check(z.nonnegative()),
    }),
  ),
});

const STATUS_META: Record<Status, { dot: string; label: string }> = {
  open: { dot: "#737373", label: "Open" },
  dispatched: { dot: "#1d4ed8", label: "Working" },
  "waiting-input": { dot: "#b45309", label: "Needs your input" },
  ready: { dot: "#b45309", label: "Review" },
  approved: { dot: "#15803d", label: "Approved" },
  dismissed: { dot: "#52525b", label: "Archived" },
};


// The floating button is anchored to an edge, not a fixed pixel spot, so it
// tracks that edge as the viewport resizes instead of drifting inward. `off`
// is the distance along the edge from the nearer end (`side`); the gap to the
// edge itself is a fixed margin.
const FAB_SIZE = 44;
const FAB_MARGIN = 20;
type FabEdge = "top" | "right" | "bottom" | "left";
type FabAnchor = { edge: FabEdge; side: "start" | "end"; off: number };
const DEFAULT_FAB_ANCHOR: FabAnchor = { edge: "bottom", side: "end", off: 20 };

function clampRange(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

function anchorToXy(a: FabAnchor, w: number, h: number): { x: number; y: number } {
  const maxX = w - FAB_SIZE - FAB_MARGIN;
  const maxY = h - FAB_SIZE - FAB_MARGIN;
  if (a.edge === "top" || a.edge === "bottom") {
    const y = a.edge === "top" ? FAB_MARGIN : h - FAB_SIZE - FAB_MARGIN;
    const x = a.side === "end" ? w - FAB_SIZE - a.off : a.off;
    return { x: clampRange(x, FAB_MARGIN, maxX), y: Math.max(FAB_MARGIN, y) };
  }
  const x = a.edge === "left" ? FAB_MARGIN : w - FAB_SIZE - FAB_MARGIN;
  const y = a.side === "end" ? h - FAB_SIZE - a.off : a.off;
  return { x: Math.max(FAB_MARGIN, x), y: clampRange(y, FAB_MARGIN, maxY) };
}

function xyToAnchor(x: number, y: number, w: number, h: number): FabAnchor {
  const cx = x + FAB_SIZE / 2;
  const cy = y + FAB_SIZE / 2;
  const d = { left: cx, right: w - cx, top: cy, bottom: h - cy };
  const nearest = Math.min(d.left, d.right, d.top, d.bottom);
  if (nearest === d.left || nearest === d.right) {
    const edge: FabEdge = nearest === d.left ? "left" : "right";
    const side = cy <= h / 2 ? "start" : "end";
    const off = side === "start" ? y : h - FAB_SIZE - y;
    return { edge, side, off: Math.max(FAB_MARGIN, off) };
  }
  const edge: FabEdge = nearest === d.top ? "top" : "bottom";
  const side = cx <= w / 2 ? "start" : "end";
  const off = side === "start" ? x : w - FAB_SIZE - x;
  return { edge, side, off: Math.max(FAB_MARGIN, off) };
}

function readFabAnchor(): FabAnchor {
  try {
    const raw = localStorage.getItem("pinpoint.fab.anchor");
    if (raw) {
      const p: unknown = JSON.parse(raw);
      if (
        p &&
        typeof p === "object" &&
        "edge" in p &&
        "side" in p &&
        "off" in p &&
        typeof p.off === "number" &&
        (p.edge === "top" ||
          p.edge === "right" ||
          p.edge === "bottom" ||
          p.edge === "left") &&
        (p.side === "start" || p.side === "end")
      )
        return { edge: p.edge, side: p.side, off: p.off };
    }
  } catch {
    /* ignore malformed */
  }
  return DEFAULT_FAB_ANCHOR;
}

const CONFIRM_TEXT_EDITS_KEY = "pinpoint.text-edits.confirm";
const SHOW_ELEMENT_OUTLINE_KEY = "pinpoint.element-outline.enabled";

function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function writeBooleanPreference(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* preference persistence is best effort */
  }
}

function readScreenshotPreference(): boolean {
  try {
    return localStorage.getItem("pinpoint.screenshots.enabled") !== "false";
  } catch {
    return true;
  }
}

export function PinpointPanel({
  threadId,
  params,
  showBrowserChrome = true,
  onOpenSetup,
  reviewPermissions,
}: PluginThreadPanelProps & {
  showBrowserChrome?: boolean;
  onOpenSetup?: () => void;
  reviewPermissions?: GuestPermissions;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const requestedUrl = useMemo(() => {
    const raw =
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      "url" in params
        ? params.url
        : undefined;
    return typeof raw === "string" && raw ? normalizeBrowserUrl(raw) : null;
  }, [params]);
  const [cfg, setCfg] = useState<PinpointConfig | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const requestRemove = useCallback((id: string) => {
    deleteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDeleteId(id);
  }, []);
  const [pendingPreview, setPendingPreview] = useState<PendingPreviewAction | null>(null);
  const pendingPreviewRef = useRef<PendingPreviewAction | null>(null);
  const [sendingPreview, setSendingPreview] = useState(false);
  const previewCancelRef = useRef<HTMLButtonElement | null>(null);
  const previewTriggerRef = useRef<HTMLElement | null>(null);
  const [editGuestId, setEditGuestId] = useState<string | null>(null);
  const clearGuestEditRequest = useCallback(() => setEditGuestId(null), []);
  const pendingScreenshots = useRef(new Map<string, PendingScreenshot>());
  const clearPreviewRequest = useCallback(() => {
    const pending = pendingPreviewRef.current;
    if (pending?.kind === "capture" && pending.payload.clientId) {
      const request = pendingScreenshots.current.get(pending.payload.clientId);
      if (!request?.capture) pendingScreenshots.current.delete(pending.payload.clientId);
    }
    pendingPreviewRef.current = null;
    setPendingPreview(null);
  }, []);
  const requestPreviewAction = useCallback((action: PendingPreviewAction) => {
    if (pendingPreviewRef.current || deleteId) return;
    if (action.kind === "capture" && action.payload.clientId && action.payload.screenshotExpected !== false) {
      const requests = pendingScreenshots.current;
      for (const [id, request] of requests) if (request.expiresAt < Date.now()) requests.delete(id);
      if (requests.size >= 8) requests.delete(requests.keys().next().value!);
      requests.set(action.payload.clientId, { threadId, url: action.payload.url, expiresAt: Date.now() + 60_000, capture: null, uploading: false });
    }
    previewTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pendingPreviewRef.current = action;
    setPendingPreview(action);
  }, [deleteId, threadId]);
  const [draftUrl, setDraftUrl] = useState("");
  const [url, setUrl] = useState("");
  // The page actually showing in the iframe. Diverges from `url` when the user
  // navigates by clicking links inside the proxied page; drives per-page
  // annotation scoping and the address bar without remounting the frame.
  const [currentUrl, setCurrentUrl] = useState("");
  // Bumped to force a session to be torn down and recreated (the Reload
  // button) even though `threadId`/`url` didn't change.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [picking, setPicking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  // Transient delivery warnings (agent busy, send failed) returned by the
  // update RPC — shown briefly so a reply is never silently dropped.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 8000);
  }, []);
  const [pinned, setPinned] = useState(false);
  const [rows, setRows] = useState<(PinpointAnnotation | GuestRow)[]>([]);
  const vrows = useMemo(() => rows.map(view), [rows]);
  const [frameReady, setFrameReady] = useState(false);
  const [frameEpoch, setFrameEpoch] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // The session currently attached to this panel — kept alive in
  // lib/session-registry across unmounts instead of being torn down, so
  // switching threads or navigating back to a page already visited reuses
  // the live iframe instead of refetching/reinitializing it.
  const sessionRef = useRef<PinpointSession | null>(null);
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentH, setContentH] = useState(0);
  const [browserW, setBrowserW] = useState(0);
  const browserRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    grabX: number;
    grabY: number;
    moved: boolean;
  } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<null | "guest" | "open" | "review" | "closed">(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [captureScreenshots, setCaptureScreenshots] = useState(
    readScreenshotPreference,
  );
  const [confirmTextEdits, setConfirmTextEdits] = useState(() =>
    readBooleanPreference(CONFIRM_TEXT_EDITS_KEY, false),
  );
  const [showElementOutline, setShowElementOutline] = useState(() =>
    readBooleanPreference(SHOW_ELEMENT_OUTLINE_KEY, false),
  );
  const toggleScreenshots = useCallback(() => {
    setCaptureScreenshots((enabled) => {
      const next = !enabled;
      try {
        localStorage.setItem("pinpoint.screenshots.enabled", String(next));
      } catch {
        /* preference persistence is best effort */
      }
      return next;
    });
  }, []);
  const toggleConfirmTextEdits = useCallback(() => {
    setConfirmTextEdits((enabled) => {
      const next = !enabled;
      writeBooleanPreference(CONFIRM_TEXT_EDITS_KEY, next);
      return next;
    });
  }, []);
  const toggleElementOutline = useCallback(() => {
    setShowElementOutline((enabled) => {
      const next = !enabled;
      writeBooleanPreference(SHOW_ELEMENT_OUTLINE_KEY, next);
      return next;
    });
  }, []);
  const [shake, setShake] = useState<{ bucket: string; n: number } | null>(
    null,
  );
  const [showDone, setShowDone] = useState(false);
  const [flyaways, setFlyaways] = useState<
    { id: number; bucket: "guest" | "open" | "review" | "closed"; delta: number }[]
  >([]);
  const flyIdRef = useRef(0);
  const prevCountsRef = useRef<{
    url: string;
    guest: number;
    open: number;
    review: number;
    closed: number;
  } | null>(null);
  const [cardShown, setCardShown] = useState(false);
  useEffect(() => {
    if (!panelOpen) {
      setCardShown(false);
      setSettingsOpen(false);
      return;
    }
    const id = requestAnimationFrame(() => setCardShown(true));
    return () => cancelAnimationFrame(id);
  }, [panelOpen]);
  const fabAnchorRef = useRef<FabAnchor>(readFabAnchor());
  const [fabPos, setFabPos] = useState<{ x: number; y: number } | null>(null);
  const liveTargetTransitionRef = useRef<Promise<unknown>>(Promise.resolve());
  const remoteNavigationRef = useRef({ shareId: "", revision: -1 });

  const refresh = useCallback(() => {
    void rpc.call("list", { threadId }).then((r) => setRows(r.rows));
  }, [rpc, threadId]);
  const submitPick = useCallback(
    (pick: PickPayload) => {
      return rpc
        .call("capture", {
          threadId,
          comment: pick.comment ?? "",
          url: pick.url,
          pathname: pick.pathname ?? null,
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
        })
        .then((result) => { refresh(); return result; });
    },
    [refresh, rpc, threadId],
  );
  const uploadQueuedScreenshot = useCallback((clientId: string) => {
    const request = pendingScreenshots.current.get(clientId);
    if (!request?.capture || !request.shot || request.uploading) return;
    request.uploading = true;
    const shot = request.shot;
    void request.capture.then(async (id) => {
      if (!id) return;
      await rpc.call("uploadScreenshot", {
        threadId: request.threadId, clientId: id, kind: shot.kind, mime: shot.mime,
        screenshot: shot.screenshot, url: request.url,
      });
      refresh();
    }).catch((cause: unknown) => showNotice(`Screenshot was not saved: ${String(cause)}`))
      .finally(() => pendingScreenshots.current.delete(clientId));
  }, [refresh, rpc, showNotice]);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("config", null).then((c) => {
      if (cancelled) return;
      const last = sessions.getLastSession(threadId);
      const initialUrl = requestedUrl || last?.url || c.defaultUrl;
      const initialCurrentUrl = requestedUrl || last?.currentUrl || c.defaultUrl;
      setCfg(c);
      if (remoteNavigationRef.current.revision >= 0) return;
      setUrl(initialUrl);
      setDraftUrl(initialCurrentUrl);
      setCurrentUrl(initialCurrentUrl);
    });
    refresh();
    return () => {
      cancelled = true;
    };
  }, [rpc, refresh, requestedUrl, threadId]);

  useEffect(() => {
    if (!currentUrl) return;
    const registrationId = crypto.randomUUID();
    const observed = { ...remoteNavigationRef.current };
    const enqueue = (operation: () => Promise<unknown>) => {
      liveTargetTransitionRef.current = liveTargetTransitionRef.current
        .catch(() => undefined)
        .then(operation);
    };
    const publish = () =>
      enqueue(() =>
        rpc.call("setLiveTarget", {
          threadId,
          url: currentUrl,
          registrationId,
          observedShareId: observed.shareId || null,
          observedRevision:
            observed.revision >= 0 ? observed.revision : null,
        }),
      );
    publish();
    const heartbeat = window.setInterval(publish, LIVE_TARGET_HEARTBEAT_MS);
    return () => {
      window.clearInterval(heartbeat);
      enqueue(() => rpc.call("clearLiveTarget", { threadId, registrationId }));
    };
  }, [currentUrl, rpc, threadId]);

  useRealtime("pinpoint", (payload) => {
    // Integration updates never carry preview-origin authority.
    if (payload && typeof payload === "object" && "integrationsChanged" in payload) {
      void rpc.call("config", null).then(setCfg);
      return;
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      !("threadId" in payload) ||
      payload.threadId !== threadId
    ) {
      return;
    }
    const signal = navigationSignalSchema.safeParse(payload);
    if (signal.success && signal.data.navigation) {
      const next = normalizeBrowserUrl(signal.data.navigation.url);
      const previous = remoteNavigationRef.current;
      if (
        next &&
        (previous.shareId !== signal.data.navigation.shareId ||
          previous.revision < signal.data.navigation.revision)
      ) {
        remoteNavigationRef.current = {
          shareId: signal.data.navigation.shareId,
          revision: signal.data.navigation.revision,
        };
        if (next !== currentUrl) {
          setDraftUrl(next);
          setCurrentUrl(next);
          setUrl(next);
        }
      }
    }
    if (signal.success && signal.data.pinpointRows) {
      setRows(signal.data.pinpointRows as (PinpointAnnotation | GuestRow)[]);
    } else {
      refresh();
    }
  });

  // Toggle comment mode as one coherent state: the floating toolbar and the
  // element picker are either both open or both closed.
  const toggleComment = useCallback(() => {
    // Keyboard toggles can leave a stray text selection painted across the pill —
    // clear it so the control bar never shows a highlight.
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    setPanelOpen((open) => !open);
  }, []);

  // Opening the toolbar always arms the picker; closing it always makes the
  // embedded page passive again.
  useEffect(() => {
    setPicking(panelOpen);
    const win = frameRef.current?.contentWindow;
    win?.postMessage({ __pinpoint: true, cmd: "setPick", active: panelOpen }, "*");
    // The embedded picker only captures toolbar-scoped shortcuts while open.
    win?.postMessage({ __pinpoint: true, cmd: "panel", open: panelOpen }, "*");
  }, [panelOpen, frameReady, frameEpoch]);

  useEffect(() => {
    const win = frameRef.current?.contentWindow;
    win?.postMessage(
      { __pinpoint: true, cmd: "screenshots", enabled: captureScreenshots },
      "*",
    );
  }, [frameReady, frameEpoch, captureScreenshots]);
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      {
        __pinpoint: true,
        cmd: "preferences",
        confirmTextEdits,
        showElementOutline,
        reviewPermissions: reviewPermissions ?? null,
      },
      "*",
    );
  }, [frameReady, frameEpoch, confirmTextEdits, showElementOutline, reviewPermissions]);


  // Our own back/forward history for the Pinpoint browser only. We never touch
  // the iframe's real session history: contentWindow.history.back() traverses
  // the tab's *joint* history and can navigate the whole bb app to another
  // thread. Instead we track visited pages (from the picker's ready message)
  // and reload the frame to the chosen entry.
  const navHistory = useRef<{ stack: string[]; index: number }>({
    stack: [],
    index: -1,
  });
  const recordVisit = useCallback((visited: string) => {
    const h = navHistory.current;
    if (h.stack[h.index] === visited) return;
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(visited);
    h.index = h.stack.length - 1;
  }, []);

  // Messages posted by the injected picker running in the proxied page.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // Backgrounded sessions' iframes are still live (parked in the
      // holding pen) and can still post messages — only react to the one
      // this panel currently has attached.
      const session = sessionRef.current;
      if (e.source !== session?.iframe.contentWindow || e.origin !== "null") return;
      const data = e.data;
      const parsed = pickerMessageSchema.safeParse(data);
      if (!parsed.success) {
        if (
          data &&
          typeof data === "object" &&
          "source" in data &&
          data.source === "bb-pinpoint"
        )
          setBlocked(
            `picker message rejected: ${parsed.error.message.slice(0, 200)}`,
          );
        return;
      }
      const m = parsed.data;
      const authToken =
        data &&
        typeof data === "object" &&
        "authToken" in data &&
        typeof data.authToken === "string"
          ? data.authToken
          : null;
      if (m.type === "ready") {
        if (
          !session.acceptNextPickerToken &&
          session.pickerAuthToken !== authToken
        ) {
          return;
        }
      } else if (
        m.type !== "blocked" &&
        (!authToken || authToken !== session.pickerAuthToken)
      ) {
        return;
      }
      if (m.type === "ready" || m.type === "navigate") {
        if (m.url) {
          const next = normalizeBrowserUrl(m.url);
          if (!next || new URL(next).origin !== new URL(session.url).origin) return;
        }
        const s = session;
        if (m.type === "ready") {
          // Protocol handshake: a live/parked iframe can still be running the
          // picker injected before a plugin update. Reload it once so it picks
          // up the current script; if it comes back stale again, block with a
          // notice instead of reload-looping.
          if (s) {
            const decision = decideProtocolAction(
              authToken ? m.protocol : undefined,
              s.protocolReloadAttempted,
            );
            if (decision === "reload" && cfg) {
              s.protocolReloadAttempted = true;
              setConnected(false);
              setFrameReady(false);
              setBlocked(null);
              sessions.reloadSession(
                s,
                s.currentUrl,
                `${cfg.proxyBase}?u=${encodeURIComponent(s.currentUrl)}&t=${encodeURIComponent(threadId)}`,
              );
              return;
            }
            if (decision === "block") {
              const reason =
                "Pinpoint was updated, but this page is still running an older picker. Use Reload to reconnect.";
              setConnected(false);
              setFrameReady(false);
              setBlocked(reason);
              s.connected = false;
              s.frameReady = false;
              s.blocked = reason;
              return;
            }
            s.protocolReloadAttempted = false;
            s.pickerAuthToken = authToken;
            s.acceptNextPickerToken = false;
          }
          setConnected(true);
          setBlocked(null);
          setFrameReady(true);
          setFrameEpoch((epoch) => epoch + 1);
          if (s) {
            s.connected = true;
            s.blocked = null;
            s.frameReady = true;
          }
        }
        // Follow in-page navigation so scoping + the address bar track the
        // page actually shown, without resetting the iframe src.
        if (m.url) {
          setCurrentUrl(m.url);
          setDraftUrl(m.url);
          recordVisit(m.url);
          if (s) s.currentUrl = m.url;
        }
      } else if (m.type === "toggle") {
        toggleComment();
      } else if (m.type === "eye") {
        setShowMarkers((v) => !v);
      } else if (m.type === "screenshot") {
        toggleScreenshots();
      } else if (m.type === "cancel") {
        setPicking(false);
        setPanelOpen(false);
      } else if (m.type === "blocked") {
        setConnected(false);
        setBlocked(m.reason);
        if (sessionRef.current) {
          sessionRef.current.connected = false;
          sessionRef.current.blocked = m.reason;
        }
      } else if (m.type === "pick") {
        if (reviewPermissions && !reviewPermissions.capture) return;
        if (!samePage(m.payload.url, session.currentUrl)) return;
        setPicking(false);
        requestPreviewAction({ kind: "capture", payload: m.payload });
      } else if (m.type === "screenshot-upload") {
        const request = pendingScreenshots.current.get(m.clientId);
        if (!request || request.expiresAt < Date.now() || !samePage(m.url, request.url) || request.shot) return;
        request.shot = m;
        uploadQueuedScreenshot(m.clientId);
      } else if (m.type === "intent") {
        const row = rows.find((entry) => entry.annotation.id === m.id &&
          (!("threadId" in entry) || entry.threadId === threadId) && samePage(entry.annotation.url ?? "", session.currentUrl));
        if (!row || pendingPreviewRef.current || deleteId) return;
        if (row.guestPending && m.action === "approve") return;
        if (reviewPermissions && (
          (m.action === "delete" && (!reviewPermissions.delete || !("guestCanDelete" in row) || !row.guestCanDelete)) ||
          (m.action === "reply" && !reviewPermissions.reply) ||
          (m.action !== "delete" && m.action !== "reply")
        )) return;
        if (m.action === "delete") requestRemove(m.id);
        else if (m.action === "edit-guest" || m.action === "approve-guest") {
          if (!row.guestPending || !("guestFeedback" in row) || !row.guestFeedback) return;
          if (m.action === "edit-guest") {
            setPanelOpen(true); setSettingsOpen(false); setTab("guest"); setEditGuestId(m.id);
          } else requestPreviewAction({ kind: "approve-guest", id: m.id, feedback: row.guestFeedback });
        } else if (m.action !== "reply" || m.text?.trim()) {
          requestPreviewAction({ kind: m.action, id: m.id, text: m.action === "reply" ? m.text! : row.annotation.comment });
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [
    cfg,
    recordVisit,
    refresh,
    rows,
    deleteId,
    requestPreviewAction,
    uploadQueuedScreenshot,
    requestRemove,
    rpc,
    showNotice,
    threadId,
    reviewPermissions,
    toggleComment,
    toggleScreenshots,
  ]);


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!["u", "i", "e"].includes(k)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      if (k === "i") {
        e.preventDefault();
        toggleComment();
      } else if (panelOpen && k === "u") {
        e.preventDefault();
        toggleScreenshots();
      } else if (panelOpen && k === "e") {
        e.preventDefault();
        setShowMarkers((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleComment, toggleScreenshots, panelOpen]);

  // Just points the panel at a URL — the session-attach effect below decides
  // whether that means reusing an already-live iframe or creating a fresh
  // one, and restores connected/frameReady/blocked accordingly.
  const loadUrl = useCallback((raw: string) => {
    const next = normalizeBrowserUrl(raw);
    if (!next) return;
    setDraftUrl(next);
    setUrl(next);
  }, []);
  const go = () => loadUrl(draftUrl);

  // Get-or-create the session for (threadId, url), attach its iframe into
  // this panel, and restore local state from it. Unmounting (thread switch,
  // panel close) detaches rather than destroying — the iframe keeps running
  // in the background so coming back to it is instant instead of a refetch.
  useEffect(() => {
    if (!cfg || !url) return;
    const host = frameHostRef.current;
    if (!host) return;
    const src = `${cfg.proxyBase}?u=${encodeURIComponent(url)}&t=${encodeURIComponent(threadId)}`;
    const existing = sessions.getSession(sessions.sessionKey(threadId, url));
    const session =
      existing ??
      sessions.createSession(threadId, url, src);
    if (existing && existing.currentUrl !== url) {
      sessions.reloadSession(existing, url, src);
    }
    const syncScreenshotPreference = () =>
      session.iframe.contentWindow?.postMessage(
        { __pinpoint: true, cmd: "screenshots", enabled: captureScreenshots },
        "*",
      );
    const handleFrameLoad = () => {
      session.pickerAuthToken = null;
      session.acceptNextPickerToken = true;
      syncScreenshotPreference();
    };
    // Some browsers reload a browsing context when its iframe is moved out of
    // the holding pen. Re-apply the preference after that document's picker
    // has installed its message listener.
    session.iframe.addEventListener("load", handleFrameLoad);
    sessions.attach(session, host);
    sessionRef.current = session;
    frameRef.current = session.iframe;
    setConnected(session.connected);
    setFrameReady(session.frameReady);
    setBlocked(session.blocked);
    setCurrentUrl(session.currentUrl);
    setDraftUrl(session.currentUrl);
    setPinned(session.pinned);
    recordVisit(session.currentUrl);
    // A cached iframe may already be ready, so a frameReady transition will
    // not necessarily fire when we swap sessions. Synchronize the remembered
    // preference at attachment time as well as when the toggle changes.
    syncScreenshotPreference();
    // Browsers may briefly suspend a parked browsing context while its iframe
    // is moved back into the visible host. Repeat after that attachment has
    // painted so the message cannot disappear in the move.
    const screenshotSyncFrame = requestAnimationFrame(
      syncScreenshotPreference,
    );
    return () => {
      cancelAnimationFrame(screenshotSyncFrame);
      session.iframe.removeEventListener("load", handleFrameLoad);
      sessions.detach(session);
      if (sessionRef.current === session) sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, threadId, url, reloadNonce]);

  // A count button with nothing in it shouldn't open an empty list — shake the
  // 0 instead (a subtle "no"). The bumped nonce restarts the CSS animation.
  const openTab = (bucket: "guest" | "open" | "review" | "closed", count: number) => {
    setSettingsOpen(false);
    if (count === 0) {
      setShake((s) => ({ bucket, n: (s?.n ?? 0) + 1 }));
      return;
    }
    setTab((t) => (t === bucket ? null : bucket));
  };

  const navBack = useCallback(() => {
    const h = navHistory.current;
    if (h.index <= 0) return;
    h.index -= 1;
    loadUrl(h.stack[h.index]);
  }, [loadUrl]);
  const navForward = useCallback(() => {
    const h = navHistory.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    loadUrl(h.stack[h.index]);
  }, [loadUrl]);

  // A "Open in Pinpoint" message action opens this panel with { url } — load
  // it. Track the last applied value so unrelated re-renders don't clobber
  // in-panel navigation, and repeat opens of the same link still reload.
  const appliedParamUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedUrl || appliedParamUrlRef.current === requestedUrl) return;
    appliedParamUrlRef.current = requestedUrl;
    loadUrl(requestedUrl);
  }, [requestedUrl, loadUrl]);


  // The ONE panel-side lifecycle mutation path: rpc update → warning notice →
  // refresh. Every card action and the in-page popup reply route through it.
  const act = async (
    id: string,
    action: "approve" | "dismiss" | "redispatch" | "retry-learning" | "feedback",
    opts?: { learning?: boolean; approvedLearning?: ViewRow["proposedLearning"]; note?: string },
  ) => {
    try {
      if (reviewPermissions && (action !== "feedback" || !reviewPermissions.reply || opts?.learning)) {
        throw new Error("This action is reserved for the BB owner.");
      }
      const res = await rpc.call("update", {
        id,
        action,
        // Explicit opt-in only (AE4): absent means "write nothing".
        ...(opts?.learning === true ? {
          learning: true,
          ...(opts.approvedLearning ? { approvedLearning: opts.approvedLearning } : {}),
        } : {}),
        ...(opts?.note !== undefined ? { note: opts.note } : {}),
      });
      if (res.warning) showNotice(res.warning);
      return true;
    } catch (e) {
      showNotice(
        e instanceof Error && e.message ? e.message : "Action failed. Try again.",
      );
      return false;
    } finally {
      refresh();
    }
  };
  const approveGuest = async (id: string, feedback: GuestFeedback) => {
    try {
      if (reviewPermissions) throw new Error("Only the BB owner can approve guest feedback.");
      const result = await rpc.call("approveGuestFeedback", { id, ...feedback });
      if (result.warning) showNotice(result.warning);
      return true;
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : "Guest feedback was not approved.");
      return false;
    } finally { refresh(); }
  };
  const confirmRemove = async (id: string) => {
    setDeleting(true);
    try {
      await rpc.call("remove", { id });
      setDeleteId(null);
    } catch (e) {
      showNotice(
        e instanceof Error && e.message ? e.message : "Action failed. Try again.",
      );
    } finally {
      setDeleting(false);
      refresh();
    }
  };
  const confirmPreviewAction = async () => {
    const pending = pendingPreviewRef.current;
    if (!pending || sendingPreview) return;
    setSendingPreview(true);
    try {
      if (pending.kind === "capture") {
        const result = submitPick(pending.payload);
        const clientId = pending.payload.clientId;
        const request = clientId ? pendingScreenshots.current.get(clientId) : undefined;
        if (request) {
          request.expiresAt = Date.now() + 60_000;
          request.capture = result.then((captured) => captured.captureId).catch(() => null);
        }
        await result;
        if (clientId) uploadQueuedScreenshot(clientId);
      } else if (pending.kind === "approve-guest") {
        if (!await approveGuest(pending.id, pending.feedback)) return;
      } else {
        const saved = await act(pending.id, pending.kind === "reply" ? "feedback" : pending.kind, pending.kind === "reply" ? { note: pending.text } : undefined);
        if (!saved) return;
      }
      clearPreviewRequest();
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : "Feedback was not sent.");
    } finally { setSendingPreview(false); }
  };
  useEffect(() => { clearPreviewRequest(); }, [clearPreviewRequest, threadId, url]);
  // Answer an agent question (waiting-input) from the panel card. The
  // feedback action reopens with the note appended and re-dispatches to the
  // routing row's assignedThreadId (the thread that asked) when it still
  // exists — same path as the in-page popup reply.
  const reply = (id: string, text: string) => act(id, "feedback", { note: text });

  // Push the current page's annotations into the iframe so the injected
  // script can draw the numbered markers.
  useEffect(() => {
    if (!frameReady) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    // Only active/for-review pins render as persistent numbered circles;
    // resolved (approved/dismissed) ones stay in the panel for history but
    // don't clutter the page. The eye toggle hides the active ones too, never
    // reveals the resolved ones.
    const active = vrows
      .filter(
        (a) =>
          samePage(a.url, currentUrl) &&
          a.status !== "approved" &&
          a.status !== "dismissed",
      )
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt);
    const items = showMarkers
      ? active.map((a, i) => ({
          id: a.id,
          index: i + 1,
          status: a.status,
          comment: a.comment,
          summary: a.summary,
          selectedText: a.selectedText,
          selector: a.selector,
          x: a.x,
          y: a.y,
          anchorOffsetX: a.anchorOffsetX,
          anchorOffsetY: a.anchorOffsetY,
          thread: a.thread,
          authoredByAgent: a.authoredByAgent,
          authoredByGuest: a.authoredByGuest,
          guestCanDelete: a.guestCanDelete,
          guestPending: a.guestPending,
        }))
      : [];
    win.postMessage({ __pinpoint: true, cmd: "annotations", items }, "*");
  }, [frameReady, frameEpoch, vrows, currentUrl, showMarkers]);

  // Locate a comment from its panel card. Active comments keep their numbered
  // marker; only resolved comments use an ephemeral pulse.
  const reveal = useCallback((row: ViewRow) => {
    frameRef.current?.contentWindow?.postMessage(
      {
        __pinpoint: true,
        cmd: "reveal",
        item: {
          id: row.id,
          selector: row.selector,
          x: row.x,
          y: row.y,
          anchorOffsetX: row.anchorOffsetX,
          anchorOffsetY: row.anchorOffsetY,
          comment: row.comment,
          summary: row.summary,
          status: row.status,
        },
      },
      "*",
    );
  }, []);

  useEffect(() => {
    if (!panelOpen)
      frameRef.current?.contentWindow?.postMessage(
        { __pinpoint: true, cmd: "clearReveal" },
        "*",
      );
  }, [panelOpen]);

  // Place the button from its edge anchor once the area is measured.
  useEffect(() => {
    if (fabPos) return;
    let raf = 0;
    const tryPlace = () => {
      const el = browserRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0)
        setFabPos(anchorToXy(fabAnchorRef.current, r.width, r.height));
      else raf = requestAnimationFrame(tryPlace);
    };
    tryPlace();
    return () => cancelAnimationFrame(raf);
  }, [fabPos]);

  // Re-derive position from the edge anchor on resize, so the button stays
  // glued to its edge (e.g. 20px off the bottom-right) instead of drifting in.
  useEffect(() => {
    const el = browserRef.current;
    if (!el) return;
    const reflow = () => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      setBrowserW(r.width);
      const next = anchorToXy(fabAnchorRef.current, r.width, r.height);
      setFabPos((p) => (p && p.x === next.x && p.y === next.y ? p : next));
    };
    reflow();
    const ro = new ResizeObserver(reflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure the expanded panel's natural height so the button can morph to it.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setContentH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fabPos, panelOpen, rows, showDone]);

  const onFabDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!browserRef.current || !fabPos) return;
    const r = browserRef.current.getBoundingClientRect();
    dragRef.current = {
      grabX: e.clientX - r.left - fabPos.x,
      grabY: e.clientY - r.top - fabPos.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onFabMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !browserRef.current || !fabPos) return;
    const r = browserRef.current.getBoundingClientRect();
    const x = Math.max(4, Math.min(e.clientX - r.left - dragRef.current.grabX, r.width - 48));
    const y = Math.max(4, Math.min(e.clientY - r.top - dragRef.current.grabY, r.height - 48));
    if (Math.abs(x - fabPos.x) + Math.abs(y - fabPos.y) > 3)
      dragRef.current.moved = true;
    setFabPos({ x, y });
  };
  const onFabUp = () => {
    const moved = dragRef.current?.moved;
    dragRef.current = null;
    if (moved && fabPos && browserRef.current) {
      // Snap to the nearest edge and persist the anchor.
      const r = browserRef.current.getBoundingClientRect();
      const anchor = xyToAnchor(fabPos.x, fabPos.y, r.width, r.height);
      fabAnchorRef.current = anchor;
      try {
        localStorage.setItem("pinpoint.fab.anchor", JSON.stringify(anchor));
      } catch {
        /* ignore */
      }
      setFabPos(anchorToXy(anchor, r.width, r.height));
    }
    if (!moved) toggleComment();
  };

  // Scope the panel + counts to the page in view, matching the markers, so
  // "3 open" means three on this page — not across every page you've visited.
  const pageRows = vrows.filter((r) => samePage(r.url, currentUrl));
  const guestList = pageRows.filter((r) => r.guestPending);
  const openList = pageRows.filter(
    (r) => !r.guestPending && (r.status === "open" || r.status === "dispatched" || r.status === "waiting-input"),
  );
  // Finished agent work only; guest requests and questions have separate stages.
  const reviewList = pageRows.filter((r) => !r.guestPending && r.status === "ready");
  const closedList = pageRows.filter(
    (r) => !r.guestPending && (r.status === "approved" || r.status === "dismissed"),
  );
  const tabList =
    tab === "guest" ? guestList : tab === "open" ? openList : tab === "review" ? reviewList : closedList;

  useEffect(() => {
    const cur = {
      url: currentUrl,
      guest: guestList.length,
      open: openList.length,
      review: reviewList.length,
      closed: closedList.length,
    };
    const prev = prevCountsRef.current;
    prevCountsRef.current = cur;
    // Only celebrate genuine transitions — skip the first render and page
    // switches (where counts change because the document changed, not because
    // an item moved between inboxes).
    if (!prev || prev.url !== cur.url) return;
    const spawned: {
      id: number;
      bucket: "guest" | "open" | "review" | "closed";
      delta: number;
    }[] = [];
    (["guest", "open", "review", "closed"] as const).forEach((b) => {
      const delta = cur[b] - prev[b];
      if (delta !== 0) {
        flyIdRef.current += 1;
        spawned.push({ id: flyIdRef.current, bucket: b, delta });
      }
    });
    if (spawned.length) setFlyaways((f) => [...f, ...spawned]);
  }, [guestList.length, openList.length, reviewList.length, closedList.length, currentUrl]);

  const flyFor = (bucket: "guest" | "open" | "review" | "closed", color: string) =>
    flyaways
      .filter((f) => f.bucket === bucket)
      .map((f) => (
        <span
          key={f.id}
          className={`pp-fly ${color}`}
          onAnimationEnd={() =>
            setFlyaways((x) => x.filter((y) => y.id !== f.id))
          }
        >
          {f.delta > 0 ? `+${f.delta}` : String(f.delta)}
        </span>
      ));

  const toolbarWidth = Math.min(352, Math.max(44, browserW - FAB_MARGIN * 2));
  const toolbarLeft = fabPos ? Math.max(FAB_MARGIN, Math.min(fabPos.x + 44 - toolbarWidth, browserW - toolbarWidth - FAB_MARGIN)) : 0;

  return (
    <div
      data-pinpoint-ui
      className="pinpoint-panel flex h-full flex-col bg-background text-foreground"
    >
      <style>
        {`.pinpoint-panel ::-webkit-scrollbar{width:10px;height:10px}
.pinpoint-panel ::-webkit-scrollbar-button{display:none!important;height:0!important;width:0!important}
.pinpoint-panel ::-webkit-scrollbar-track{background:transparent}
.pinpoint-panel ::-webkit-scrollbar-thumb{background:#525252;border-radius:999px;border:3px solid transparent;background-clip:content-box}
.pinpoint-panel ::-webkit-scrollbar-thumb:hover{background:#737373;background-clip:content-box}`}
      </style>
      {showBrowserChrome ? (
      // Matches BB's own browser bar: the panel's colour, no line under it, and a round address field.
      <header className="flex h-11 shrink-0 items-center gap-1 bg-sidebar py-1.5 pl-2 pr-4">
        <ChromeButton icon="ChevronLeft" label="Back" onClick={navBack} />
        <ChromeButton icon="ChevronRight" label="Forward" onClick={navForward} />
        <ChromeButton
          icon="RotateCcw"
          label="Reload"
          onClick={() => {
            const session = sessionRef.current;
            const target = normalizeBrowserUrl(
              session?.currentUrl || currentUrl || draftUrl || url,
            );
            if (!cfg || !target) return;
            setFrameReady(false);
            setConnected(false);
            setBlocked(null);
            setCurrentUrl(target);
            setDraftUrl(target);
            if (session) {
              // A manual reload re-arms the automatic protocol-mismatch
              // reload for this session.
              session.protocolReloadAttempted = false;
              sessions.reloadSession(
                session,
                target,
                `${cfg.proxyBase}?u=${encodeURIComponent(target)}&t=${encodeURIComponent(threadId)}`,
              );
            } else {
              setUrl(target);
              setReloadNonce((n) => n + 1);
            }
          }}
        />
        <ChromeButton
          icon={pinned ? "PinOff" : "Pin"}
          label={pinned ? "Unpin" : "Pin"}
          active={pinned}
          onClick={() => {
            const next = !pinned;
            sessions.setPinned(sessions.sessionKey(threadId, url), next);
            setPinned(next);
          }}
        />
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <div className="flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3">
            <span
              title={blocked ?? (connected ? "Capture live" : "Waiting for page…")}
              className={`size-2 shrink-0 rounded-full ${blocked ? "bg-red-700" : connected ? "bg-green-700" : "bg-neutral-600"}`}
            />
            <input
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="http://localhost:3000"
              aria-label="Address"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
              spellCheck={false}
            />
          </div>
        </form>
      </header>
      ) : null}

      {blocked ? (
        <div className="border-b border-border bg-red-950 px-3 py-1.5 text-xs leading-snug text-red-400">
          {blocked}
        </div>
      ) : null}

      {notice ? (
        <div className="border-b border-border bg-amber-950 px-3 py-1.5 text-xs leading-snug text-amber-500">
          {notice}
        </div>
      ) : null}

      <div ref={browserRef} className="relative min-h-0 flex-1">
        <div ref={frameHostRef} className="absolute inset-0 h-full w-full" />
        {fabPos ? (
          <div
            className="absolute z-30 select-none"
            style={{
              left: panelOpen ? toolbarLeft : fabPos.x,
              top: fabPos.y,
              width: panelOpen ? toolbarWidth : 44,
              height: 44,
              transition: dragRef.current
                ? "none"
                : "left .18s ease-out, top .18s ease-out",
            }}
          >
            <style>
              {`@keyframes pp-pop-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:none}}
@keyframes pp-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-2px)}45%{transform:translateX(2px)}70%{transform:translateX(-1.5px)}90%{transform:translateX(1px)}}
.pp-shake{display:inline-block;animation:pp-shake .22s ease-in-out}
@keyframes pp-fly{0%{opacity:0;transform:translate(-50%,5px) scale(.82)}20%{opacity:1;transform:translate(-50%,-3px) scale(1)}100%{opacity:0;transform:translate(-50%,-28px) scale(1)}}
@keyframes pp-fly-rm{0%{opacity:0}25%{opacity:1}100%{opacity:0}}
.pp-fly{position:absolute;left:50%;bottom:100%;margin-bottom:1px;transform:translate(-50%,0);pointer-events:none;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1;white-space:nowrap;animation:pp-fly .7s cubic-bezier(0.23,1,0.32,1) forwards}
@media (prefers-reduced-motion:reduce){.pp-fly{animation-name:pp-fly-rm;animation-duration:.5s}}
.pp-scroll{scrollbar-width:thin;scrollbar-color:#525252 transparent}
.pp-scroll::-webkit-scrollbar{width:10px}
.pp-scroll::-webkit-scrollbar-button{display:none;width:0;height:0}
.pp-scroll::-webkit-scrollbar-track{background:transparent}
.pp-scroll::-webkit-scrollbar-thumb{background:#525252;border-radius:999px;border:3px solid transparent;background-clip:content-box}
.pp-scroll::-webkit-scrollbar-thumb:hover{background:#737373;background-clip:content-box}
.pp-toolbar-button{user-select:none;-webkit-user-select:none}
.pp-toolbar-button:focus{outline:none!important}
.pp-toolbar-button:focus-visible{box-shadow:inset 0 0 0 2px #737373!important}`}
            </style>
            {panelOpen && settingsOpen ? (
              <div
                className="absolute bottom-[52px] right-0 flex w-[260px] flex-col gap-2 rounded-2xl border border-neutral-800 bg-neutral-900 p-2.5 text-neutral-100 shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
                style={{
                  transformOrigin: "bottom right",
                  animation:
                    "pp-pop-in .18s cubic-bezier(0.19,1,0.22,1) both",
                }}
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={confirmTextEdits}
                  onClick={toggleConfirmTextEdits}
                  className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500"
                >
                  <span className="min-w-0 flex-1 text-[12px] text-neutral-200">
                    Confirm text edits
                  </span>
                  <span
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${confirmTextEdits ? "bg-neutral-500" : "bg-neutral-800"}`}
                    aria-hidden
                  >
                    <span
                      className={`absolute top-0.5 size-4 rounded-full bg-neutral-100 transition-transform ${confirmTextEdits ? "translate-x-[18px]" : "translate-x-0.5"}`}
                    />
                  </span>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showElementOutline}
                  onClick={toggleElementOutline}
                  className="flex min-h-10 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500"
                >
                  <span className="min-w-0 flex-1 text-[12px] text-neutral-200">
                    Element outline
                  </span>
                  <span
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${showElementOutline ? "bg-neutral-500" : "bg-neutral-800"}`}
                    aria-hidden
                  >
                    <span
                      className={`absolute top-0.5 size-4 rounded-full bg-neutral-100 transition-transform ${showElementOutline ? "translate-x-[18px]" : "translate-x-0.5"}`}
                    />
                  </span>
                </button>
                {onOpenSetup ? <button type="button" onClick={onOpenSetup} className="min-h-10 rounded-md px-2 text-left text-[12px] text-neutral-300 hover:bg-neutral-800">Setup guide</button> : null}
              </div>
            ) : null}
            {/* list box, above the pill, for the selected counter */}
            {panelOpen && tab && !settingsOpen ? (
              <div
                className="pp-scroll absolute bottom-[52px] right-0 flex max-h-[min(70vh,560px)] w-[300px] flex-col overflow-y-auto rounded-2xl border border-neutral-800 bg-neutral-900 p-2 text-neutral-100 shadow-[0_8px_30px_rgba(0,0,0,0.45)] select-text"
                style={{
                  width: Math.min(300, Math.max(44, browserW - FAB_MARGIN * 2)),
                  transformOrigin: "bottom right",
                  animation:
                    "pp-pop-in .18s cubic-bezier(0.19,1,0.22,1) both",
                }}
              >
                {tabList.length === 0 ? (
                  <p className="px-1 py-4 text-center text-[12px] text-neutral-500">
                    {tab === "guest" ? "No guest feedback." : tab === "open"
                      ? "No open comments."
                      : tab === "review"
                        ? "Nothing awaiting review."
                        : "No resolved comments."}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {tabList.map((r) => (
                      <FeedbackRow
                        key={r.id}
                        row={r}
                        reviewPermissions={reviewPermissions}
                        onApproveGuest={(feedback) => approveGuest(r.id, feedback)}
                        editRequested={editGuestId === r.id}
                        onEditStarted={clearGuestEditRequest}
                        learningEnabled={cfg?.clasiLearning === true}
                        onApprove={(learning) =>
                          void act(r.id, "approve", { learning, approvedLearning: r.proposedLearning })
                        }
                        onRetryLearning={() =>
                          void act(r.id, "retry-learning")
                        }
                        onSend={() => void act(r.id, "redispatch")}
                        onReply={(text) => void reply(r.id, text)}
                        onDelete={() => requestRemove(r.id)}
                        onReveal={() => reveal(r)}
                        loadThumb={() =>
                          rpc
                            .call("screenshot", {
                              id: r.id,
                              kind: r.screenshots.includes("element")
                                ? "element"
                                : "viewport",
                            })
                            .then((res) => res.shot)
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
            {/* the pill — a circle that widens; height & radius stay constant */}
            <div
              {...(panelOpen
                ? {}
                : {
                    role: "button",
                    tabIndex: 0,
                    title: "Comment (I)",
                    "aria-label": "Pinpoint feedback",
                    "aria-keyshortcuts": "I",
                    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleComment();
                      }
                    },
                    onPointerDown: onFabDown,
                    onPointerMove: onFabMove,
                    onPointerUp: onFabUp,
                  })}
              className={`absolute bottom-0 right-0 flex h-11 select-none items-stretch overflow-hidden rounded-full border border-neutral-800 bg-neutral-900 text-neutral-100 shadow-[0_8px_30px_rgba(0,0,0,0.45)] ${panelOpen ? "" : "cursor-pointer touch-none"}`}
              style={{
                width: panelOpen ? toolbarWidth : 44,
                transition: "width .34s cubic-bezier(0.19,1,0.22,1)",
              }}
            >
              {/* collapsed: comment icon */}
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center [&_svg]:size-5"
                style={{
                  opacity: panelOpen ? 0 : 1,
                  transition: "opacity .12s ease-out",
                }}
              >
                <Icon name="ChatFeedback" aria-hidden />
              </div>
              {/* expanded controls and feedback queues */}
              <div
                className="absolute inset-0 flex items-stretch"
                style={{
                  opacity: panelOpen ? 1 : 0,
                  transition: "opacity .2s cubic-bezier(0.19,1,0.22,1)",
                  pointerEvents: panelOpen ? "auto" : "none",
                }}
              >
                <button
                  aria-label={showMarkers ? "Hide comment pins" : "Show comment pins"}
                  aria-keyshortcuts="E"
                  aria-pressed={showMarkers}
                  data-active={showMarkers}
                  title={`${showMarkers ? "Comment pins on" : "Comment pins off"} (E)`}
                  onClick={() => setShowMarkers((v) => !v)}
                  className={`pp-toolbar-button flex min-w-0 flex-1 items-center justify-center transition-colors hover:bg-neutral-800 [&_svg]:size-4 ${showMarkers ? "text-neutral-100" : "text-neutral-500"}`}
                >
                  <Icon name={showMarkers ? "Eye" : "EyeOff"} aria-hidden />
                </button>
                <button
                  aria-label={
                    captureScreenshots
                      ? "Disable automatic screenshots"
                      : "Enable automatic screenshots"
                  }
                  aria-keyshortcuts="U"
                  aria-pressed={captureScreenshots}
                  data-active={captureScreenshots}
                  title={`${captureScreenshots ? "Screenshots on" : "Screenshots off"} (U)`}
                  onClick={toggleScreenshots}
                  className={`pp-toolbar-button flex min-w-0 flex-1 items-center justify-center border-l border-neutral-800 transition-colors hover:bg-neutral-800 [&_svg]:size-4 ${captureScreenshots ? "text-neutral-100" : "text-neutral-500"}`}
                >
                  <Icon name={captureScreenshots ? "Camera" : "CameraOff"} aria-hidden />
                </button>
                <button
                  aria-label="User feedback"
                  aria-description="Open feedback being worked on or waiting for an answer"
                  aria-pressed={tab === "open"}
                  title="User feedback"
                  onClick={() => openTab("open", openList.length)}
                  className={`pp-toolbar-button relative flex min-w-0 flex-1 items-center justify-center border-l border-neutral-800 text-neutral-100 transition-colors hover:bg-neutral-800 [&_svg]:size-4 ${tab === "open" ? "bg-neutral-800" : ""}`}
                >
                  <Icon name="User" aria-hidden />
                  <span key={shake?.bucket === "open" ? `s${shake.n}` : "open"} className={`absolute right-1 top-0.5 text-[9px] font-semibold leading-none tabular-nums ${shake?.bucket === "open" ? "pp-shake" : ""}`}>{openList.length}</span>
                </button>
                <button
                  aria-label="Guest feedback"
                  aria-description="Guest comments waiting for your approval before processing"
                  aria-pressed={tab === "guest"}
                  title="Guest feedback"
                  onClick={() => openTab("guest", guestList.length)}
                  className={`pp-toolbar-button relative flex min-w-0 flex-1 items-center justify-center border-l border-neutral-800 transition-colors hover:bg-neutral-800 [&_svg]:size-4 ${tab === "guest" ? "bg-neutral-800" : ""} ${guestList.length ? "text-sky-400" : "text-neutral-500"}`}
                >
                  <Icon name="Guests" aria-hidden />
                  <span key={shake?.bucket === "guest" ? `s${shake.n}` : "guest"} className={`absolute right-1 top-0.5 text-[9px] font-semibold leading-none tabular-nums ${shake?.bucket === "guest" ? "pp-shake" : ""}`}>{guestList.length}</span>
                </button>
                <button
                  aria-label="Agent feedback"
                  aria-description="Finished agent work waiting for your review"
                  aria-pressed={tab === "review"}
                  title="Agent feedback"
                  onClick={() => openTab("review", reviewList.length)}
                  className={`pp-toolbar-button relative flex min-w-0 flex-1 items-center justify-center border-l border-neutral-800 text-amber-500 transition-colors hover:bg-neutral-800 [&_svg]:size-4 ${tab === "review" ? "bg-neutral-800" : ""}`}
                >
                  <Icon name="Agent" aria-hidden />
                  <span key={shake?.bucket === "review" ? `s${shake.n}` : "review"} className={`absolute right-1 top-0.5 text-[9px] font-semibold leading-none tabular-nums ${shake?.bucket === "review" ? "pp-shake" : ""}`}>{reviewList.length}</span>
                </button>
                <button
                  aria-label="Closed"
                  aria-description="Approved or dismissed feedback"
                  aria-pressed={tab === "closed"}
                  title="Closed"
                  onClick={() => openTab("closed", closedList.length)}
                  className={`pp-toolbar-button relative flex min-w-0 flex-1 items-center justify-center border-l border-neutral-800 text-neutral-500 transition-colors hover:bg-neutral-800 [&_svg]:size-4 ${tab === "closed" ? "bg-neutral-800 text-neutral-300" : ""}`}
                >
                  <Icon name="CheckCircle" aria-hidden />
                  <span key={shake?.bucket === "closed" ? `s${shake.n}` : "closed"} className={`absolute right-1 top-0.5 text-[9px] font-semibold leading-none tabular-nums ${shake?.bucket === "closed" ? "pp-shake" : ""}`}>{closedList.length}</span>
                </button>
                <button
                  aria-label="Pinpoint settings"
                  aria-pressed={settingsOpen}
                  title="Pinpoint settings"
                  onClick={() => {
                    setSettingsOpen((open) => !open);
                    setTab(null);
                  }}
                  className={`pp-toolbar-button flex min-w-0 flex-1 items-center justify-center border-l border-neutral-800 transition-colors hover:bg-neutral-800 [&_svg]:size-4 ${settingsOpen ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"}`}
                >
                  <Icon name="Settings" aria-hidden />
                </button>
                <button
                  aria-label="Close"
                  onClick={() => {
                    setPanelOpen(false);
                    setTab(null);
                    setSettingsOpen(false);
                  }}
                  className="pp-toolbar-button flex min-w-0 flex-1 items-center justify-center border-l border-neutral-800 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 [&_svg]:size-4"
                >
                  <Icon name="X" aria-hidden />
                </button>
              </div>
            </div>
            {panelOpen ? (
              <div
                className="pointer-events-none absolute right-0 bottom-0 flex h-11 items-center"
                style={{ width: toolbarWidth }}
                aria-hidden
              >
                <span className="min-w-0 flex-1" />
                <span className="min-w-0 flex-1" />
                <span className="relative min-w-0 flex-1">{flyFor("open", "text-white")}</span>
                <span className="relative min-w-0 flex-1">{flyFor("guest", "text-sky-400")}</span>
                <span className="relative min-w-0 flex-1">{flyFor("review", "text-amber-500")}</span>
                <span className="relative min-w-0 flex-1">{flyFor("closed", "text-neutral-400")}</span>
                <span className="min-w-0 flex-1" />
                <span className="min-w-0 flex-1" />
              </div>
            ) : null}
            {!panelOpen && (guestList.length > 0 || openList.length > 0 || reviewList.length > 0) ? (
              <div className="pointer-events-none absolute -right-1.5 -top-1.5 z-40 flex flex-col items-end">
                {guestList.length > 0 ? <span aria-label={`${guestList.length} guest feedback`} className="relative z-10 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-sky-800 px-1.5 text-[10px] font-bold leading-none tabular-nums text-white shadow-sm ring-2 ring-neutral-900">{guestList.length}</span> : null}
                {openList.length > 0 ? (
                  <span
                    aria-label={`${openList.length} unaddressed`}
                    className="relative z-10 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-700 px-1.5 text-[10px] font-bold leading-none tabular-nums text-white shadow-sm ring-2 ring-neutral-900"
                  >
                    {openList.length}
                  </span>
                ) : null}
                {reviewList.length > 0 ? (
                  <span
                    aria-label={`${reviewList.length} awaiting review`}
                    className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-700 px-1.5 text-[10px] font-bold leading-none tabular-nums text-white shadow-sm ring-2 ring-neutral-900 ${openList.length > 0 ? "-mt-1" : ""}`}
                  >
                    {reviewList.length}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <Dialog open={deleteId !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteId(null); }}>
        <DialogContent hideCloseButton onOpenAutoFocus={(event) => { event.preventDefault(); cancelDeleteRef.current?.focus(); }} onAfterCloseAutoFocus={() => deleteTriggerRef.current?.focus()}>
          <DialogHeader>
            <DialogTitle>Delete feedback?</DialogTitle>
            <DialogDescription>
              “{rows.find((row) => row.annotation.id === deleteId)?.annotation.comment.slice(0, 160) || deleteId}” and its screenshots will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row justify-end">
            <Button ref={cancelDeleteRef} autoFocus data-overlay-initial-focus variant="outline" disabled={deleting} onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="destructive" disabled={deleting || deleteId === null} onClick={() => { if (deleteId) void confirmRemove(deleteId); }}>{deleting ? "Deleting…" : "Delete"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={pendingPreview !== null} onOpenChange={(open) => { if (!open && !sendingPreview) clearPreviewRequest(); }}>
        <DialogContent hideCloseButton onOpenAutoFocus={(event) => { event.preventDefault(); previewCancelRef.current?.focus(); }} onAfterCloseAutoFocus={() => previewTriggerRef.current?.focus()}>
          <DialogHeader>
            <DialogTitle>{pendingPreview?.kind === "capture" ? "Send feedback?" : pendingPreview?.kind === "reply" ? "Send reply?" : pendingPreview?.kind === "approve-guest" ? "Approve guest feedback?" : pendingPreview?.kind === "approve" ? "Approve feedback?" : "Dismiss feedback?"}</DialogTitle>
            <DialogDescription>{pendingPreview?.kind === "approve" ? "Approve this fix only. No learning will be saved." : pendingPreview?.kind === "approve-guest" ? "Send this guest feedback to the agent for processing. This does not approve finished work or save learning." : "This request came from the preview page. Confirm it here in BB."}</DialogDescription>
          </DialogHeader>
          {pendingPreview ? <div className="max-h-[40dvh] space-y-2 overflow-y-auto break-words text-sm">
            <p className="break-all text-xs text-muted-foreground">{pendingPreview.kind === "capture" ? pendingPreview.payload.url : currentUrl}</p>
            {pendingPreview.kind === "approve-guest" ? <>
              {pendingPreview.feedback.capture ? <><p className="whitespace-pre-wrap">{pendingPreview.feedback.capture.comment}</p>{pendingPreview.feedback.capture.textNew !== null ? <pre className="whitespace-pre-wrap break-words">{pendingPreview.feedback.capture.textNew}</pre> : null}</> : null}
              {pendingPreview.feedback.messages.map((message) => <p key={message.id} className="whitespace-pre-wrap">{message.content}</p>)}
            </> : <p className="whitespace-pre-wrap">{pendingPreview.kind === "capture" ? pendingPreview.payload.comment : pendingPreview.text}</p>}
            {pendingPreview.kind === "capture" && pendingPreview.payload.kind === "text-edit" ? <div className="space-y-2"><p className="text-xs text-muted-foreground">Replace</p><pre className="whitespace-pre-wrap break-words">{pendingPreview.payload.textOld}</pre><p className="text-xs text-muted-foreground">With</p><pre className="whitespace-pre-wrap break-words">{pendingPreview.payload.textNew}</pre></div> : null}
          </div> : null}
          <DialogFooter className="flex-row justify-end">
            <Button ref={previewCancelRef} autoFocus data-overlay-initial-focus variant="outline" disabled={sendingPreview} onClick={clearPreviewRequest}>Cancel</Button>
            <Button disabled={sendingPreview} onClick={() => void confirmPreviewAction()}>{sendingPreview ? "Saving…" : pendingPreview?.kind === "approve" || pendingPreview?.kind === "approve-guest" ? "Approve" : pendingPreview?.kind === "dismiss" ? "Dismiss" : "Send"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function FeedbackRow({
  row,
  learningEnabled = false,
  reviewPermissions,
  onApproveGuest,
  editRequested = false,
  onEditStarted,
  onApprove,
  onRetryLearning,
  onSend,
  onReply,
  onDelete,
  onReveal,
  loadThumb,
}: {
  row: ViewRow;
  learningEnabled?: boolean;
  reviewPermissions?: GuestPermissions;
  onApproveGuest?: (feedback: GuestFeedback) => Promise<boolean>;
  editRequested?: boolean;
  onEditStarted?: () => void;
  onApprove: (learningOptIn: boolean) => void;
  onRetryLearning: () => void;
  onSend: () => void;
  onReply: (text: string) => void;
  onDelete: () => void;
  onReveal: () => void;
  loadThumb?: () => Promise<{ mime: string; data: string } | null>;
}) {
  const dim = !row.guestPending && (row.status === "approved" || row.status === "dismissed");
  const msgs = row.thread;
  const firstHumanIndex = msgs.findIndex((message) => message.role === "human");
  const [editingGuest, setEditingGuest] = useState(false);
  const [guestDraft, setGuestDraft] = useState(row.guestFeedback);
  const [approvingGuest, setApprovingGuest] = useState(false);
  const cardRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (editRequested) { setEditingGuest(true); onEditStarted?.(); }
  }, [editRequested, onEditStarted]);
  useEffect(() => {
    if (!editingGuest) setGuestDraft(row.guestFeedback);
  }, [row.guestFeedback?.revision, editingGuest]);
  useEffect(() => {
    if (editingGuest) cardRef.current?.querySelector<HTMLTextAreaElement>("[data-guest-editor]")?.focus();
  }, [editingGuest]);
  const cancelGuestEdit = () => { setGuestDraft(row.guestFeedback); setEditingGuest(false); };
  // Learning opt-in (R12): UNCHECKED by default — approving without ticking
  // it writes nothing anywhere (AE4).
  const [learnOptIn, setLearnOptIn] = useState(false);
  useEffect(() => setLearnOptIn(false), [row.proposedLearning?.text, row.proposedLearning?.topic, row.proposedLearning?.logicalKey, learningEnabled]);
  // Lazy screenshot thumbnail: fetched once per row when a stored screenshot
  // is advertised (presence rides the row; pixels ride this call).
  const hasShot = row.kind !== "text-edit" && row.screenshots.length > 0;
  const [thumb, setThumb] = useState<{ mime: string; data: string } | null>(
    null,
  );
  const thumbRef = useRef(loadThumb);
  thumbRef.current = loadThumb;
  useEffect(() => {
    if (!hasShot) return;
    let cancelled = false;
    void thumbRef.current?.()
      .then((shot) => {
        if (!cancelled && shot) setThumb(shot);
      })
      .catch(() => {
        /* attachment preview is best effort */
      });
    return () => {
      cancelled = true;
    };
  }, [row.id, hasShot]);
  return (
    <li
      ref={cardRef}
      className="group cursor-pointer rounded-lg bg-[#161616] p-2.5"
      onClick={onReveal}
      title="Scroll to this comment in the page"
    >
      {row.kind === "text-edit" &&
      (row.textOld !== null || row.textNew !== null) ? (
        <div className="mt-1.5 rounded-md bg-neutral-900 px-2 py-1.5">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-neutral-500">
            Text edit
          </span>
          <div className="mt-0.5 text-[12px] leading-snug">
            <span className="text-neutral-500 line-through">
              {row.textOld ?? ""}
            </span>
            <span className="mx-1 text-neutral-500">→</span>
            {editingGuest && guestDraft?.capture && row.kind === "text-edit" ? (
              <GuestTextEditor value={guestDraft.capture.textNew ?? ""} label="Edit proposed text" maxLength={500} onCancel={cancelGuestEdit}
                onChange={(value) => setGuestDraft({ ...guestDraft, capture: { ...guestDraft.capture!, textNew: value } })} />
            ) : <span className={dim ? "text-neutral-400" : "text-neutral-100"}>{row.textNew ?? ""}</span>}
          </div>
        </div>
      ) : null}
      {msgs.map((m, i) => {
        const pendingMessage = m.id ? guestDraft?.messages.find((message) => message.id === m.id) : null;
        const pendingCapture = !m.id ? guestDraft?.capture : null;
        return m.role === "agent" ? (
          <div
            key={i}
            className="mt-1.5 rounded-md bg-[#232323] px-2 py-1.5"
          >
            <span
              className={`text-[9px] font-semibold uppercase tracking-wider ${
                row.status === "waiting-input" && i === msgs.length - 1
                  ? "text-[#b45309]"
                  : "text-[#8a8a8a]"
              }`}
            >
              {row.status === "waiting-input" && i === msgs.length - 1
                ? "Agent asks"
                : "Agent"}
            </span>
            <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-snug text-[#c4c4c4]">
              {m.content}
            </p>
          </div>
        ) : (
          <div key={i} className="relative mt-1.5 px-2 py-1.5">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-[#8a8a8a]">
              {m.guest ? (m.ownerEdited ? "Guest · edited" : "Guest") : "You"}
            </span>
            {editingGuest && (pendingMessage || pendingCapture) ? (
              <GuestTextEditor value={pendingMessage?.content ?? pendingCapture!.comment} label={pendingMessage ? "Edit guest reply" : "Edit guest comment"} onCancel={cancelGuestEdit}
                onChange={(value) => {
                  if (!guestDraft) return;
                  setGuestDraft(pendingMessage
                    ? { ...guestDraft, messages: guestDraft.messages.map((message) => message.id === pendingMessage.id ? { ...message, content: value } : message) }
                    : { ...guestDraft, capture: { ...guestDraft.capture!, comment: value } });
                }} />
            ) : <p className={`mt-0.5 whitespace-pre-wrap text-[13px] leading-snug ${dim ? "text-neutral-400" : "text-[#f0f0f0]"}`}>
              {m.content || <span className="text-neutral-500">(no comment)</span>}
            </p>}
            {thumb && i === firstHumanIndex ? (
              <img
                src={`data:${thumb.mime};base64,${thumb.data}`}
                alt="Screenshot attached"
                title="Screenshot attached"
                className="absolute -right-1 -top-1 size-6 rounded-md bg-white object-cover shadow-sm outline outline-1 -outline-offset-1 outline-white/10"
              />
            ) : null}
          </div>
        );
      })}
      {!row.guestPending && row.status === "ready" && row.receipt ? (
        <ReceiptSection
          receipt={row.receipt}
          warning={row.receiptAnchorWarning}
        />
      ) : null}
      {!reviewPermissions && !row.guestPending && row.proposedLearning ? (
        <LearningSection
          row={row}
          enabled={learningEnabled}
          optIn={learnOptIn}
          onOptIn={setLearnOptIn}
          onRetry={onRetryLearning}
        />
      ) : null}
      {!reviewPermissions && row.guestPending ? (
        <div className="mt-2 flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
          <ActionButton icon="Trash2" label="Delete" onClick={onDelete} disabled={approvingGuest} />
          <button type="button" aria-label={editingGuest ? "Cancel edit" : "Edit"} title={editingGuest ? "Cancel edit" : "Edit"}
            disabled={approvingGuest} onClick={() => editingGuest ? cancelGuestEdit() : setEditingGuest(true)}
            className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl border border-[#262626] bg-[#171717] px-3 text-[12px] text-neutral-300 hover:bg-neutral-800 [&_svg]:size-3.5">
            <Icon name={editingGuest ? "X" : "Edit"} aria-hidden />{editingGuest ? "Cancel" : "Edit"}
          </button>
          <ActionButton icon="Check" label="Approve guest feedback" accent disabled={approvingGuest || !guestDraft || !onApproveGuest}
            onClick={() => {
              if (!guestDraft || !onApproveGuest || approvingGuest) return;
              setApprovingGuest(true);
              void onApproveGuest(guestDraft).then((ok) => { if (ok) setEditingGuest(false); }).finally(() => setApprovingGuest(false));
            }} />
        </div>
      ) : <ReplyBox
        onReply={onReply}
        onDelete={onDelete}
        allowReply={!reviewPermissions || reviewPermissions.reply}
        allowDelete={!reviewPermissions || (reviewPermissions.delete && row.guestCanDelete)}
        placeholder={replyPlaceholderFor(row.status)}
      >
        {!reviewPermissions && row.status === "ready" ? <ActionButton icon="Check" label="Approve" accent onClick={() => onApprove(learningEnabled && learnOptIn)} /> : null}
        {!reviewPermissions && row.status === "open" && row.lastError ? <ActionButton icon="RotateCcw" label="Retry send" onClick={onSend} /> : null}
      </ReplyBox>}
      {row.status === "open" && row.lastError ? (
        <div className="mt-1.5 rounded-md bg-red-950 px-2 py-1.5">
          <p className="text-[11px] leading-snug text-red-400">
            Couldn't reach the agent: {row.lastError}
          </p>
        </div>
      ) : null}
    </li>
  );
}

// Proposed learning beside Approve (R12). The proposal text renders VERBATIM
// — it is exactly what a consented approve sends to Clasi. The card never
// claims "saved" unless the server recorded a successful write.
function LearningSection({
  row,
  enabled,
  optIn,
  onOptIn,
  onRetry,
}: {
  row: ViewRow;
  enabled: boolean;
  optIn: boolean;
  onOptIn: (v: boolean) => void;
  onRetry: () => void;
}) {
  const learning = row.proposedLearning!;
  const write = row.learningWrite;
  return (
    <div
      className="mt-1.5 rounded-md border border-violet-800 bg-violet-950 px-2 py-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-violet-300">
          Proposed learning
        </span>
        <span className="rounded bg-violet-900 px-1 text-[9px] font-semibold uppercase tracking-wide text-violet-300">
          {learning.topic}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-neutral-500">
          {learning.logicalKey}
        </span>
      </div>
      <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-snug text-neutral-200">
        {learning.text}
      </p>
      {row.status === "ready" ? (
        <label className="mt-1.5 flex cursor-pointer items-start gap-1.5 text-[11px] leading-snug text-neutral-300">
          <input
            type="checkbox"
            disabled={!enabled}
            checked={optIn}
            onChange={(e) => onOptIn(e.target.checked)}
            aria-label={`Also save this ${learning.topic} learning to Clasi when approving`}
            className="mt-0.5 accent-violet-400"
          />
          <span>
            {enabled ? `Also save this ${learning.topic} learning to Clasi when I approve` : "Clasi learning is off. Enable it in Settings → Pinpoint → Oh My BB."}
          </span>
        </label>
      ) : write?.state === "saved" ? (
        <p className="mt-1 text-[10px] leading-snug text-emerald-500">
          Saved to Clasi.
        </p>
      ) : write?.state === "failed" ? (
        <div className="mt-1 flex items-start gap-1.5">
          <p className="min-w-0 flex-1 text-[10px] leading-snug text-red-400">
            Saving to Clasi failed: {write.error}
          </p>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            className="shrink-0 rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] font-medium text-neutral-200 transition-colors hover:bg-neutral-600"
          >
            Retry
          </button>
        </div>
      ) : row.status === "approved" && row.learningConsented ? (
        // Write outcome absent: usually in flight, but if the process died
        // between consent and the write, this state is terminal — the server's
        // retry-learning guard already permits retry here, so offer it.
        <div className="mt-1 flex items-start gap-1.5">
          <p className="min-w-0 flex-1 text-[10px] leading-snug text-neutral-400">
            Saving to Clasi… (stuck? Retry)
          </p>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            className="shrink-0 rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] font-medium text-neutral-200 transition-colors hover:bg-neutral-600"
          >
            Retry
          </button>
        </div>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-neutral-500">
          Not saved. Approving without the opt-in stores nothing.
        </p>
      )}
    </div>
  );
}

// Agent-asserted diff receipt on a ready card. The label says "unverified"
// because the server never checks the diff against the working tree — it only
// warns when an anchored pin's receipt omits its data-pp id.
const RECEIPT_PREVIEW_CHARS = 360;
function ReceiptSection({
  receipt,
  warning,
}: {
  receipt: string;
  warning: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const truncatable = receipt.length > RECEIPT_PREVIEW_CHARS;
  const text =
    expanded || !truncatable
      ? receipt
      : `${receipt.slice(0, RECEIPT_PREVIEW_CHARS)}…`;
  return (
    <div className="mt-1.5 rounded-md bg-neutral-900 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-neutral-500">
          Agent's diff (unverified)
        </span>
        {truncatable ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="ml-auto rounded px-1 text-[10px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : null}
      </div>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-neutral-400">
        {text}
      </pre>
      {warning ? (
        <p className="mt-1 text-[10px] leading-snug text-amber-500">
          This diff never mentions the pin's data-pp anchor. It may not touch
          the pinned element.
        </p>
      ) : null}
    </div>
  );
}

function GuestTextEditor({ value, onChange, label, onCancel, maxLength = 4_000 }: {
  value: string; onChange: (value: string) => void; label: string; onCancel: () => void; maxLength?: number;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "32px";
    const height = node.scrollHeight + 2;
    node.style.height = `${Math.min(160, Math.max(32, height))}px`;
    node.style.overflowY = height > 160 ? "auto" : "hidden";
  }, []);
  useEffect(resize, [resize, value]);
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== width) { width = node.clientWidth; resize(); }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [resize]);
  return <textarea ref={input} data-guest-editor aria-label={label} value={value} maxLength={maxLength} rows={1}
    onChange={(event) => onChange(event.target.value)}
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onCancel(); } }}
    className="mt-1 block max-h-40 w-full min-w-0 resize-none overflow-y-auto rounded-md border border-neutral-700 bg-[#171717] px-2 py-1.5 text-[13px] leading-snug text-neutral-100 outline-none focus:border-neutral-500" />;
}

// Follow-up stays available after guest approval. Sending appends the note,
// reopens if needed, and re-dispatches; guest replies remain held.
function ReplyBox({
  onReply,
  onDelete,
  placeholder,
  allowReply = true,
  allowDelete = true,
  children,
}: {
  onReply: (text: string) => void;
  onDelete: () => void;
  placeholder: string;
  allowReply?: boolean;
  allowDelete?: boolean;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resize = (input: HTMLTextAreaElement) => {
    input.style.height = "32px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(Math.max(contentHeight, 32), 128)}px`;
    input.style.overflowY = contentHeight > 128 ? "auto" : "hidden";
  };
  const [text, setText] = useState("");
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onReply(value);
    setText("");
    if (inputRef.current) {
      inputRef.current.style.height = "32px";
      inputRef.current.style.overflowY = "hidden";
    }
  };
  return (
    <div
      className="mt-2 flex select-none items-end gap-1.5"
      onClick={(event) => event.stopPropagation()}
    >
      {allowDelete ? <button
        type="button"
        onClick={onDelete}
        aria-label="Delete"
        title="Delete"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-[#262626] bg-[#171717] text-[#737373] transition-[background-color,color,transform] hover:bg-neutral-800 hover:text-red-400 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 [&_svg]:size-3.5"
      >
        <Icon name="Trash2" aria-hidden />
      </button> : null}
      {allowReply ? <><textarea
        ref={inputRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onInput={(event) => resize(event.currentTarget)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        aria-label="Reply"
        placeholder={placeholder}
        rows={1}
        className="min-h-8 max-h-32 min-w-0 flex-1 resize-none overflow-y-hidden rounded-2xl border border-[#262626] bg-[#171717] px-3 py-1.5 text-[12px] leading-[18px] text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-500"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        aria-label="Reply"
        title="Reply"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-[#262626] bg-[#171717] text-neutral-100 transition-[background-color,color,transform] hover:bg-neutral-800 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:text-neutral-600 [&_svg]:size-3.5"
      >
        <Icon name="ArrowRight" aria-hidden />
      </button></> : null}
      {children}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  accent,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-[#262626] bg-[#171717] transition-[background-color,transform] hover:bg-neutral-800 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 [&_svg]:size-3.5 ${accent ? "text-emerald-500" : "text-neutral-500"}`}
    >
      <Icon name={icon} aria-hidden />
    </button>
  );
}


/** An icon button like the ones in BB's own browser bar: borderless and quiet until hovered. */
function ChromeButton({ icon, label, onClick, active = false }: { icon: IconName; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      onClick={onClick}
      className={`flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:size-4 ${active ? "bg-state-hover text-foreground" : "text-subtle-foreground/75"}`}
    >
      <Icon name={icon} aria-hidden />
    </button>
  );
}
