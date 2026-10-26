import { z } from "zod";

import {
  annotationIntents,
  annotationKinds,
  annotationSeverities,
  workflowStates,
  type WorkflowState,
} from "./afs-vocabulary";
import { learningTopics } from "./clasi-rules";

export {
  annotationIntents,
  annotationKinds,
  annotationSeverities,
  intentOf,
  isAgentInboxState,
  isUserInboxState,
  severityOf,
  workflowStates,
  type AnnotationIntent,
  type AnnotationSeverity,
  type WorkflowState,
} from "./afs-vocabulary";

export const AFS_VERSION = "1.1" as const;

export const annotationStatuses = [
  "pending",
  "acknowledged",
  "resolved",
  "dismissed",
] as const;
export const reviewStates = [
  "open",
  "ready",
  "waiting-input",
  "approved",
  "dismissed",
] as const;

export const annotationStatusSchema = z.enum(annotationStatuses);
export const reviewStateSchema = z.enum(reviewStates);
export const workflowStateSchema = z.enum(workflowStates);

export type AnnotationStatus = z.infer<typeof annotationStatusSchema>;
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const boundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const threadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["human", "agent"]),
  content: z.string(),
  timestamp: z.number(),
  guest: z.boolean().optional(),
  pendingOwnerDispatch: z.boolean().optional(),
  guestOriginalContent: z.string().optional(),
});

// Scope classification recorded when an item is resolved (R6): how broad the
// fix was (one instance vs a repeated pattern) and what level it touched
// (element vs component vs design token). `declared` distinguishes an agent
// that actually classified its change from the server-side inferred default
// (instance/element) recorded when the agent stayed silent.
export const scopeBreadths = ["instance", "pattern"] as const;
export const scopeTargets = ["element", "component", "token"] as const;
export const resolutionScopeSchema = z.object({
  breadth: z.enum(scopeBreadths),
  target: z.enum(scopeTargets),
  declared: z.boolean(),
});
export type ResolutionScope = z.infer<typeof resolutionScopeSchema>;
export type ScopeBreadth = (typeof scopeBreadths)[number];
export type ScopeTarget = (typeof scopeTargets)[number];

const guestReferenceSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const guestReviewSchema = z.object({
  reviewRef: guestReferenceSchema,
  participantRef: guestReferenceSchema,
  pendingOwnerDispatch: z.boolean(),
}).strict();

export const pinpointContextSchema = z.looseObject({
  selector: z.string().nullable(),
  pathname: z.string().nullable(),
  title: z.string().nullable(),
  authorRole: z.enum(["human", "agent"]).optional(),
  /** Server-assigned guest provenance. References never enter guest projections. */
  guestReview: guestReviewSchema.optional(),
  guestOriginal: z.object({ comment: z.string(), textNew: z.string().nullable() }).strict().optional(),
  /**
   * True when the picker stamped the live element with `data-pp="<id>"` AND
   * that client-generated id was adopted as the row id — i.e. the stamp in
   * the page really identifies this annotation and is worth persisting in
   * source. Absent for legacy rows, agent comments, and collision fallbacks.
   */
  anchored: z.boolean().optional(),
  /** Scope classification recorded at resolve time (declared or inferred). */
  scope: resolutionScopeSchema.optional(),
  /** Agent-asserted diff receipt (capped at RECEIPT_MAX_CHARS on write). */
  receipt: z.string().optional(),
  /**
   * Set when an anchored item's receipt never mentions its data-pp id — the
   * asserted diff may not touch the pinned element. A warning, never a block.
   */
  receiptAnchorWarning: z.boolean().optional(),
  /**
   * ONE proposed generalized learning attached to a ready resolution (R12),
   * validated against the vendored clasi rules at propose time. Stored only
   * when valid; awaiting the user's explicit opt-in on the review card.
   */
  proposedLearning: z
    .object({
      topic: z.enum(learningTopics),
      logicalKey: z.string(),
      text: z.string(),
    })
    .optional(),
  /**
   * Consent event: recorded only when the user approved WITH the explicit
   * learning opt-in. `text` is the verbatim proposal the user saw and
   * approved — the clasi write sends exactly this string.
   */
  learningConsent: z
    .object({
      approvedAt: z.number(), text: z.string(),
      topic: z.enum(learningTopics).optional(),
      logicalKey: z.string().optional(),
    })
    .optional(),
  /**
   * Set when a user reply (reopen) arrived while a dispatch send was in
   * flight (routing "sending"): the routing claim could not be re-staged, so
   * the reply would otherwise never be delivered. dispatch()'s success path
   * checks this flag, clears it, and re-stages + dispatches exactly once.
   */
  pendingFollowUp: z.boolean().optional(),
  /** Click position relative to the pinned element's top-left corner. */
  anchorOffset: z.object({ x: z.number(), y: z.number() }).optional(),
  /** False when the reviewer disabled automatic screenshot capture. */
  screenshotExpected: z.boolean().optional(),
  /**
   * Outcome of the direct clasi write. Only ever written after a consent
   * event; "saved" is only ever written after a successful saveContext call.
   */
  learningWrite: z
    .union([
      z.object({ state: z.literal("saved"), at: z.number() }),
      z.object({ state: z.literal("failed"), error: z.string() }),
    ])
    .optional(),
  xIsPercentage: z.boolean(),
  legacyPosition: z
    .object({ x: z.number().nullable(), y: z.number().nullable() })
    .optional(),
});

/** AFS 1.1 plus a namespaced Pinpoint context extension. */
export const afsAnnotationSchema = z.looseObject({
  id: z.string().min(1),
  comment: z.string(),
  elementPath: z.string(),
  timestamp: z.number(),
  x: z.number(),
  y: z.number(),
  element: z.string(),
  url: z.string().optional(),
  boundingBox: boundingBoxSchema.optional(),
  reactComponents: z.string().optional(),
  cssClasses: z.string().optional(),
  computedStyles: z.string().optional(),
  accessibility: z.string().optional(),
  nearbyText: z.string().optional(),
  nearbyElements: z.string().optional(),
  selectedText: z.string().optional(),
  sourceFile: z.string().optional(),
  fullPath: z.string().optional(),
  isFixed: z.boolean().optional(),
  isMultiSelect: z.boolean().optional(),
  intent: z.enum(annotationIntents).optional(),
  severity: z.enum(annotationSeverities).optional(),
  kind: z.enum(annotationKinds).default("feedback"),
  /** Direct text edit (kind "text-edit"): the rendered text before/after the
   *  reviewer's inline edit, each capped at TEXT_EDIT_MAX_CHARS on write. */
  textOld: z.string().optional(),
  textNew: z.string().optional(),
  status: annotationStatusSchema.default("pending"),
  resolvedAt: z.string().optional(),
  resolvedBy: z.enum(["human", "agent"]).optional(),
  thread: z.array(threadMessageSchema).default([]),
  pinpoint: pinpointContextSchema,
});

export type AfsAnnotation = z.infer<typeof afsAnnotationSchema>;
export type ThreadMessage = z.infer<typeof threadMessageSchema>;
// Loose on purpose (rollout tolerance): a newer picker may send fields this
// server version doesn't know yet, and an older picker omits newer optional
// fields — neither may fail the capture. Only the core fields are required.
export const captureSchema = z.looseObject({
  threadId: z.string(),
  comment: z.string().default(""),
  url: z.string(),
  pathname: z.string().nullish(),
  title: z.string().nullish(),
  selector: z.string().nullish(),
  elementPath: z.string().nullish(),
  fullPath: z.string().nullish(),
  element: z.string().nullish(),
  cssClasses: z.string().nullish(),
  reactComponents: z.string().nullish(),
  computedStyles: z.string().nullish(),
  accessibility: z.string().nullish(),
  nearbyText: z.string().nullish(),
  nearbyElements: z.string().nullish(),
  selectedText: z.string().nullish(),
  sourceFile: z.string().nullish(),
  isFixed: z.boolean().nullish(),
  isMultiSelect: z.boolean().nullish(),
  x: z.number().nullish(),
  y: z.number().nullish(),
  anchorOffsetX: z.number().nullish(),
  anchorOffsetY: z.number().nullish(),
  screenshotExpected: z.boolean().nullish(),
  boundingBox: boundingBoxSchema.nullish(),
  // Client-generated durable-anchor id (the picker stamps the element with
  // data-pp=<clientId>); the server adopts it as the row id when valid.
  clientId: z.string().nullish(),
  intent: z.enum(annotationIntents).nullish(),
  severity: z.enum(annotationSeverities).nullish(),
  // Direct text edit (R4). `.catch` so an unknown future kind degrades to a
  // plain feedback capture instead of failing the whole pick.
  kind: z.enum(annotationKinds).nullish().catch(null),
  textOld: z.string().nullish(),
  textNew: z.string().nullish(),
});

export type CaptureInput = z.infer<typeof captureSchema>;

export interface LegacyAnnotationRow {
  id: string;
  status: string;
  comment: string;
  url: string;
  pathname: string | null;
  title: string | null;
  selector: string | null;
  element_path: string | null;
  tag: string | null;
  css_classes: string;
  component_name: string | null;
  nearby_text: string | null;
  selected_text: string | null;
  rect: string | null;
  x: number | null;
  y: number | null;
  summary: string | null;
  created_at: number;
}

function defined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function usableSourceFile(sourceFile: string | null | undefined): string | undefined {
  if (!sourceFile || /^[a-z]+:\/\//i.test(sourceFile)) return undefined;
  if (/(^|\/)(api|assets)\//.test(sourceFile)) return undefined;
  return sourceFile;
}

/** Cap for textOld/textNew on a text-edit capture (applied on write). */
export const TEXT_EDIT_MAX_CHARS = 500;

function cappedText(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value.slice(0, TEXT_EDIT_MAX_CHARS);
}

export function createAfsAnnotation(
  id: string,
  input: CaptureInput,
  timestamp: number,
): AfsAnnotation {
  const elementPath = input.selector ?? input.elementPath ?? "body";
  return afsAnnotationSchema.parse({
    id,
    comment: input.comment,
    elementPath,
    timestamp,
    x: input.x ?? 0,
    y: input.y ?? 0,
    element: input.element ?? "unknown",
    url: input.url,
    boundingBox: defined(input.boundingBox),
    reactComponents: defined(input.reactComponents),
    cssClasses: defined(input.cssClasses),
    computedStyles: defined(input.computedStyles),
    accessibility: defined(input.accessibility),
    nearbyText: defined(input.nearbyText),
    nearbyElements: defined(input.nearbyElements),
    selectedText: defined(input.selectedText),
    sourceFile: usableSourceFile(input.sourceFile),
    fullPath: defined(input.fullPath ?? input.elementPath),
    isFixed: defined(input.isFixed),
    isMultiSelect: defined(input.isMultiSelect),
    intent: defined(input.intent),
    severity: defined(input.severity),
    kind: input.kind ?? "feedback",
    textOld: cappedText(input.textOld),
    textNew: cappedText(input.textNew),
    status: "pending",
    thread: [],
    pinpoint: {
      selector: input.selector ?? null,
      pathname: input.pathname ?? null,
      title: input.title ?? null,
      authorRole: "human",
      // Only a client id that was actually adopted as the row id makes the
      // in-page data-pp stamp a durable anchor for THIS annotation.
      anchored: input.clientId != null && input.clientId === id ? true : undefined,
      anchorOffset:
        input.anchorOffsetX != null && input.anchorOffsetY != null
          ? { x: input.anchorOffsetX, y: input.anchorOffsetY }
          : undefined,
      screenshotExpected: input.screenshotExpected ?? undefined,
      xIsPercentage: true,
    },
  });
}

export function annotationFromLegacy(row: LegacyAnnotationRow): AfsAnnotation {
  const classes = parseLegacyClasses(row.css_classes);
  const rect = parseLegacyRect(row.rect);
  const status = annotationStatusSchema.catch("pending").parse(row.status);
  return afsAnnotationSchema.parse({
    id: row.id,
    comment: row.comment,
    elementPath: row.selector ?? row.element_path ?? "body",
    timestamp: row.created_at,
    x: row.x ?? 0,
    y: row.y ?? 0,
    element: row.tag ?? "unknown",
    url: row.url,
    boundingBox: rect,
    reactComponents: defined(row.component_name),
    cssClasses: classes.length > 0 ? classes.join(" ") : undefined,
    nearbyText: defined(row.nearby_text),
    selectedText: defined(row.selected_text),
    fullPath: defined(row.element_path),
    kind: "feedback",
    status,
    thread: [],
    pinpoint: {
      selector: row.selector,
      pathname: row.pathname,
      title: row.title,
      authorRole: "human",
      xIsPercentage: false,
      legacyPosition: { x: row.x, y: row.y },
    },
  });
}

export function appendThreadMessage(
  annotation: AfsAnnotation,
  role: ThreadMessage["role"],
  content: string,
  timestamp: number,
  guest = false,
): AfsAnnotation {
  const message: ThreadMessage = {
    id: `msg_${timestamp.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    role,
    content,
    timestamp,
    ...(guest ? { guest: true, pendingOwnerDispatch: true } : {}),
  };
  return afsAnnotationSchema.parse({
    ...annotation,
    thread: [...annotation.thread, message],
  });
}

export function workflowStateFor(
  reviewState: ReviewState,
  routingState: "staged" | "sending" | "assigned",
): WorkflowState {
  // Non-open review states (ready, waiting-input, approved, dismissed) are
  // authoritative; only "open" is refined by routing into open vs dispatched.
  if (reviewState !== "open") return reviewState;
  return routingState === "staged" ? "open" : "dispatched";
}

/**
 * The workflow transition table, keyed by the action being attempted. Each
 * action maps the states it is valid FROM to the state it lands IN; anything
 * absent is an invalid transition and must be rejected, not clobbered.
 *
 *   open → dispatched            (claim + send; handled by routing, not here)
 *   open|dispatched → ready      (resolve — "open" kept valid so the CLI flow
 *                                 with autoDispatch off still works: the agent
 *                                 inbox is open + dispatched)
 *   open|dispatched → waiting-input  (agent question; same open rationale)
 *   open|dispatched|ready|waiting-input → dismissed  (reject / user dismiss)
 *   ready → approved             (user approval)
 *   waiting-input → dispatched   (user reply: reopen re-stages, dispatch claims)
 *   any → open                   (reopen / feedback / follow-up note)
 *
 * Invalid by omission: resolve on ready/waiting-input/approved/dismissed,
 * question on ready/approved/dismissed, approve on anything but ready, dismiss
 * on approved/dismissed.
 */
export type WorkflowAction =
  | "resolve"
  | "question"
  | "approve"
  | "dismiss"
  | "reopen";

const workflowActionTable: Record<
  WorkflowAction,
  Partial<Record<WorkflowState, WorkflowState>>
> = {
  resolve: { open: "ready", dispatched: "ready" },
  question: { open: "waiting-input", dispatched: "waiting-input" },
  approve: { ready: "approved" },
  dismiss: {
    open: "dismissed",
    dispatched: "dismissed",
    ready: "dismissed",
    "waiting-input": "dismissed",
  },
  reopen: {
    open: "open",
    dispatched: "open",
    "waiting-input": "open",
    ready: "open",
    approved: "open",
    dismissed: "open",
  },
};

export type WorkflowGuardResult =
  | { ok: true; to: WorkflowState }
  | { ok: false; error: string };

export function guardWorkflowAction(
  current: WorkflowState,
  action: WorkflowAction,
): WorkflowGuardResult {
  const to = workflowActionTable[action][current];
  if (!to) {
    return {
      ok: false,
      error: `cannot ${action} an annotation in state "${current}"`,
    };
  }
  return { ok: true, to };
}

export function parseAnnotationPayload(
  raw: string | null,
  fallback: LegacyAnnotationRow,
): AfsAnnotation {
  if (raw) {
    try {
      const parsed = afsAnnotationSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* malformed payload — fall back to legacy columns */
    }
  }
  return annotationFromLegacy(fallback);
}

function parseLegacyClasses(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string"
        ? value.split(/\s+/).filter(Boolean)
        : [];
  } catch {
    return raw.split(/\s+/).filter(Boolean);
  }
}

function parseLegacyRect(
  raw: string | null,
): z.infer<typeof boundingBoxSchema> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const width = typeof value.width === "number" ? value.width : value.w;
    const height = typeof value.height === "number" ? value.height : value.h;
    if (
      typeof value.x === "number" &&
      typeof value.y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return { x: value.x, y: value.y, width, height };
    }
  } catch {
    // A malformed legacy rectangle is non-essential context.
  }
  return undefined;
}
