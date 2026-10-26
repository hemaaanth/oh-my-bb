// Pinpoint annotation store: the persisted lifecycle of one piece of pinned
// feedback. Pure db-in/db-out so the transition rules are unit-testable; all
// bb-specific side effects (realtime publish, thread sends) stay in server.ts.
import type DatabaseNamespace from "better-sqlite3";

import {
  afsAnnotationSchema,
  appendThreadMessage,
  guardWorkflowAction,
  parseAnnotationPayload,
  reviewStateSchema,
  workflowStateFor,
  type AfsAnnotation,
  type LegacyAnnotationRow,
  type ResolutionScope,
  type ReviewState,
  type WorkflowAction,
  type WorkflowState,
} from "./afs";
import type { ProposedLearning } from "./clasi-rules";
import {
  deleteRouting,
  getRouting,
  routingMigrations,
  stageRouting,
  type AnnotationRouting,
} from "./routing";

type Database = DatabaseNamespace.Database;

export type AnnotationRow = LegacyAnnotationRow & {
  project_id: string;
  thread_id: string;
  review_state: string;
  payload: string | null;
  updated_at: number;
};

// APPEND-ONLY: never edit or reorder existing statements — bb.storage.migrate
// tracks what already ran. New ALTER/UPDATE statements go at the end.
export const migrations = [
  `CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      pathname TEXT,
      title TEXT,
      selector TEXT,
      element_path TEXT,
      tag TEXT,
      css_classes TEXT NOT NULL DEFAULT '[]',
      component_name TEXT,
      nearby_text TEXT,
      rect TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_ann_project ON annotations(project_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_ann_thread ON annotations(thread_id, status)`,
  `ALTER TABLE annotations ADD COLUMN x REAL`,
  `ALTER TABLE annotations ADD COLUMN y REAL`,
  `ALTER TABLE annotations ADD COLUMN selected_text TEXT`,
  `ALTER TABLE annotations ADD COLUMN payload TEXT`,
  `ALTER TABLE annotations ADD COLUMN review_state TEXT NOT NULL DEFAULT 'open'`,
  `UPDATE annotations SET review_state = CASE status
       WHEN 'ready' THEN 'ready'
       WHEN 'approved' THEN 'approved'
       WHEN 'dismissed' THEN 'dismissed'
       ELSE 'open'
     END`,
  `UPDATE annotations SET status = CASE status
       WHEN 'open' THEN 'pending'
       WHEN 'dispatched' THEN 'acknowledged'
       WHEN 'ready' THEN 'acknowledged'
       WHEN 'approved' THEN 'resolved'
       ELSE status
     END`,
  `CREATE INDEX IF NOT EXISTS idx_pinpoint_review ON annotations(project_id, review_state, updated_at)`,
  ...routingMigrations,
  `UPDATE annotations
       SET payload = json_set(
         payload,
         '$.pinpoint.authorRole',
         CASE
           WHEN json_extract(payload, '$.thread[0].role') = 'agent'
            AND json_extract(payload, '$.thread[0].content') = json_extract(payload, '$.comment')
           THEN 'agent'
           ELSE 'human'
         END
       )
     WHERE json_valid(payload)
       AND json_extract(payload, '$.pinpoint.authorRole') IS NULL`,
  `CREATE TABLE IF NOT EXISTS screenshots (
      id TEXT PRIMARY KEY,
      annotation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_shot_annotation_kind
      ON screenshots(annotation_id, kind)`,
  `DELETE FROM screenshots
     WHERE annotation_id IN (
       SELECT id FROM annotations
       WHERE json_valid(payload)
         AND json_extract(payload, '$.kind') = 'text-edit'
     )`,
] as const;

// ---------------------------------------------------------------------------
// Screenshots: one element crop + one viewport crop per annotation, captured
// after trusted confirmation. Each image kind is write-once. Owner uploads use
// authenticated thread/page-scoped RPC; guest uploads require a short-lived,
// capture-bound receipt. The reviewed document gets neither owner credentials
// nor a general HTTP mutation route.
// ---------------------------------------------------------------------------
export const screenshotKinds = ["element", "viewport"] as const;
export type ScreenshotKind = (typeof screenshotKinds)[number];

/** ~2 MB of base64 per image; anything larger is rejected with 413. */
export const SCREENSHOT_MAX_BASE64_CHARS = 2 * 1024 * 1024;

/**
 * Expects-screenshot window: uploads are only accepted this long after the
 * capture created the row, so a stale (or merely known) annotation id cannot
 * have its write-once slot squatted later.
 */
export const SCREENSHOT_UPLOAD_WINDOW_MS = 60_000;

export interface StoredScreenshot {
  kind: ScreenshotKind;
  mime: string;
  data: string;
}

export type ScreenshotStoreResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409 | 413; error: string };

/** Page-ownership check: exact url match, or same origin + pathname. */
export function sameCapturePage(
  stored: string | null | undefined,
  posted: string,
): boolean {
  if (!stored) return false;
  if (stored === posted) return true;
  try {
    const a = new URL(stored);
    const b = new URL(posted);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

export function storeScreenshot(
  db: Database,
  input: {
    annotationId: string;
    kind: ScreenshotKind;
    mime: string;
    data: string;
    /** The posting page's target url (the picker's targetLoc().href). */
    pageUrl: string;
  },
  now = Date.now(),
): ScreenshotStoreResult {
  if (input.data.length > SCREENSHOT_MAX_BASE64_CHARS) {
    return {
      ok: false,
      status: 413,
      error: `screenshot too large (${input.data.length} > ${SCREENSHOT_MAX_BASE64_CHARS} base64 chars)`,
    };
  }
  // Authorization: the annotation row must already exist (the capture RPC
  // creates it before the picker posts the screenshot)…
  const row = getAnnotationRow(db, input.annotationId);
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: `no such annotation: ${input.annotationId}`,
    };
  }
  // Native screenshots need a durable picker anchor. Guest captures instead
  // carry server-owned provenance and a short-lived upload receipt.
  const annotation = annotationFor(row);
  if (annotation.kind === "text-edit") {
    return {
      ok: false,
      status: 409,
      error: `${input.annotationId} does not accept screenshots for text edits`,
    };
  }
  if (annotation.pinpoint.anchored !== true && annotation.pinpoint.guestReview === undefined) {
    return {
      ok: false,
      status: 403,
      error: `${input.annotationId} does not accept screenshot uploads`,
    };
  }
  // …still be inside the expects-screenshot window…
  if (now - row.created_at > SCREENSHOT_UPLOAD_WINDOW_MS) {
    return {
      ok: false,
      status: 403,
      error: `screenshot upload window for ${input.annotationId} has expired`,
    };
  }
  // …and the posting page must be the page the capture was made on.
  if (!sameCapturePage(annotation.url ?? row.url, input.pageUrl)) {
    return {
      ok: false,
      status: 403,
      error: `page url does not match the capture for ${input.annotationId}`,
    };
  }
  try {
    db.prepare(
      `INSERT INTO screenshots (id,annotation_id,kind,mime,data,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      `shot_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      input.annotationId,
      input.kind,
      input.mime,
      input.data,
      now,
    );
  } catch {
    // UNIQUE(annotation_id, kind): the slot is already filled (write-once).
    return {
      ok: false,
      status: 409,
      error: `screenshot "${input.kind}" for ${input.annotationId} already stored`,
    };
  }
  return { ok: true };
}

export function getScreenshot(
  db: Database,
  annotationId: string,
  kind: ScreenshotKind,
): StoredScreenshot | null {
  return (
    (db
      .prepare(
        `SELECT kind, mime, data FROM screenshots WHERE annotation_id=? AND kind=?`,
      )
      .get(annotationId, kind) as StoredScreenshot | undefined) ?? null
  );
}

export function screenshotsFor(
  db: Database,
  annotationId: string,
): StoredScreenshot[] {
  return db
    .prepare(
      `SELECT kind, mime, data FROM screenshots WHERE annotation_id=? ORDER BY kind`,
    )
    .all(annotationId) as StoredScreenshot[];
}

/** Kinds only (presence, not pixels) — for list surfaces and the CLI. */
export function screenshotKindsFor(
  db: Database,
  annotationId: string,
): ScreenshotKind[] {
  return (
    db
      .prepare(
        `SELECT kind FROM screenshots WHERE annotation_id=? ORDER BY kind`,
      )
      .all(annotationId) as { kind: ScreenshotKind }[]
  ).map((r) => r.kind);
}

/** Batched `screenshotKindsFor` — one IN (...) query for a whole list. Ids
 *  with no screenshots simply have no entry in the returned map. */
export function screenshotKindsForMany(
  db: Database,
  annotationIds: string[],
): Map<string, ScreenshotKind[]> {
  const kinds = new Map<string, ScreenshotKind[]>();
  if (annotationIds.length === 0) return kinds;
  const rows = db
    .prepare(
      `SELECT annotation_id, kind FROM screenshots
        WHERE annotation_id IN (${annotationIds.map(() => "?").join(",")})
        ORDER BY kind`,
    )
    .all(...annotationIds) as { annotation_id: string; kind: ScreenshotKind }[];
  for (const row of rows) {
    const list = kinds.get(row.annotation_id);
    if (list) list.push(row.kind);
    else kinds.set(row.annotation_id, [row.kind]);
  }
  return kinds;
}

export function getAnnotationRow(db: Database, id: string): AnnotationRow | null {
  return (
    (db.prepare(`SELECT * FROM annotations WHERE id=?`).get(id) as
      | AnnotationRow
      | undefined) ?? null
  );
}

export function annotationFor(row: AnnotationRow): AfsAnnotation {
  return parseAnnotationPayload(row.payload, row);
}

export function routingFor(db: Database, id: string): AnnotationRouting {
  return getRouting(db, id) ?? stageRouting(db, id);
}

export function workflowOf(db: Database, row: AnnotationRow): WorkflowState {
  const reviewState = reviewStateSchema.parse(row.review_state);
  return workflowStateFor(reviewState, routingFor(db, row.id).state);
}

export function writeAnnotation(
  db: Database,
  row: AnnotationRow,
  annotation: AfsAnnotation,
  reviewState: ReviewState,
  summary: string | null,
  now = Date.now(),
): AnnotationRow {
  db.prepare(
    `UPDATE annotations
     SET status=?, review_state=?, summary=?, payload=?, updated_at=?
     WHERE id=?`,
  ).run(
    annotation.status,
    reviewState,
    summary,
    JSON.stringify(annotation),
    now,
    row.id,
  );
  return getAnnotationRow(db, row.id)!;
}

/**
 * Rewrite only the pinpoint context of a row's payload. Shared by the
 * learning consent/write flow and dispatch-time payload patches
 * (screenshotAttachment, pendingFollowUp).
 */
export function patchPinpoint(
  db: Database,
  row: AnnotationRow,
  patch: Partial<AfsAnnotation["pinpoint"]>,
): AnnotationRow {
  const annotation = annotationFor(row);
  db.prepare(`UPDATE annotations SET payload=? WHERE id=?`).run(
    JSON.stringify(
      afsAnnotationSchema.parse({
        ...annotation,
        pinpoint: { ...annotation.pinpoint, ...patch },
      }),
    ),
    row.id,
  );
  return getAnnotationRow(db, row.id)!;
}

export type StoreResult =
  | { ok: true; row: AnnotationRow }
  | { ok: false; error: string };

/** Load the row and check the transition table; error on invalid moves. */
function guarded(
  db: Database,
  id: string,
  action: WorkflowAction,
): StoreResult {
  const row = getAnnotationRow(db, id);
  if (!row) return { ok: false, error: `no such annotation: ${id}` };
  const guard = guardWorkflowAction(workflowOf(db, row), action);
  if (!guard.ok) return { ok: false, error: `${id}: ${guard.error}` };
  return { ok: true, row };
}

/** Resolve-time pinpoint-context additions (scope/receipt live in payload). */
export interface ResolvePinpointExtras {
  scope?: ResolutionScope;
  receipt?: string;
  receiptAnchorWarning?: boolean;
  /** Already validated by the caller (lib/resolve.ts) against clasi rules. */
  proposedLearning?: ProposedLearning;
}

/** Agent finished the work: mark the item ready for the user's review. */
export function resolveAnnotation(
  db: Database,
  id: string,
  summary?: string,
  extras?: ResolvePinpointExtras,
  now = Date.now(),
): StoreResult {
  const checked = guarded(db, id, "resolve");
  if (!checked.ok) return checked;
  const row = checked.row;
  const current = annotationFor(row);
  let annotation = afsAnnotationSchema.parse({
    ...current,
    status: "acknowledged",
    resolution: summary ?? null,
    pinpoint: {
      ...current.pinpoint,
      ...(extras?.scope ? { scope: extras.scope } : {}),
      // Fresh receipt cycle per resolve (matching proposedLearning/consent/
      // write below): a receipt asserted for a PREVIOUS resolution must never
      // stick to a re-resolution that supplied none. (undefined keys are
      // dropped by JSON.stringify.)
      receipt: extras?.receipt,
      // Recompute per resolve, and only meaningful when a receipt is present:
      // a warning from a previous resolve must not stick to a receipt that
      // now mentions the anchor (and vice versa).
      receiptAnchorWarning:
        extras?.receipt !== undefined && extras?.receiptAnchorWarning
          ? true
          : undefined,
      // Each resolve starts a FRESH learning proposal cycle: a prior
      // proposal, consent event, or write outcome must never stick to a
      // re-resolution it wasn't proposed/approved for. (undefined keys are
      // dropped by JSON.stringify.)
      proposedLearning: extras?.proposedLearning,
      learningConsent: undefined,
      learningWrite: undefined,
    },
  });
  if (summary) {
    annotation = appendThreadMessage(annotation, "agent", summary, now);
  }
  return {
    ok: true,
    row: writeAnnotation(db, row, annotation, "ready", summary ?? null, now),
  };
}

/** Agent needs an answer from the user before it can continue. */
export function questionAnnotation(
  db: Database,
  id: string,
  question?: string,
  now = Date.now(),
): StoreResult {
  const checked = guarded(db, id, "question");
  if (!checked.ok) return checked;
  const row = checked.row;
  let annotation = afsAnnotationSchema.parse({
    ...annotationFor(row),
    status: "acknowledged",
  });
  if (question) {
    annotation = appendThreadMessage(annotation, "agent", question, now);
  }
  return {
    ok: true,
    row: writeAnnotation(
      db,
      row,
      annotation,
      "waiting-input",
      question ?? row.summary,
      now,
    ),
  };
}

/** User accepts the work. */
export function approveAnnotation(
  db: Database,
  id: string,
  now = Date.now(),
): StoreResult {
  const checked = guarded(db, id, "approve");
  if (!checked.ok) return checked;
  const row = checked.row;
  const annotation = afsAnnotationSchema.parse({
    ...annotationFor(row),
    status: "resolved",
    resolvedAt: new Date(now).toISOString(),
    resolvedBy: "human",
  });
  return {
    ok: true,
    row: writeAnnotation(db, row, annotation, "approved", row.summary, now),
  };
}

/** The item is rejected / won't be acted on. */
export function dismissAnnotation(
  db: Database,
  id: string,
  reason?: string,
  now = Date.now(),
): StoreResult {
  const checked = guarded(db, id, "dismiss");
  if (!checked.ok) return checked;
  const row = checked.row;
  let annotation = afsAnnotationSchema.parse({
    ...annotationFor(row),
    status: "dismissed",
    resolvedAt: new Date(now).toISOString(),
    resolvedBy: "human",
    resolution: reason ?? row.summary,
  });
  if (reason) {
    annotation = appendThreadMessage(annotation, "agent", reason, now);
  }
  return {
    ok: true,
    row: writeAnnotation(
      db,
      row,
      annotation,
      "dismissed",
      reason ?? row.summary,
      now,
    ),
  };
}

/**
 * User replies / gives feedback / reopens: back to review state "open" with
 * the note appended, re-staged for dispatch. If a dispatch is in flight
 * (routing "sending") the routing row is left alone so the in-flight claim
 * isn't clobbered — the note stays in the conversation payload and rides the
 * next (re)dispatch; `staged: false` tells the caller to surface that.
 */
export function reopenAnnotation(
  db: Database,
  id: string,
  note?: string,
  now = Date.now(),
): StoreResult & { staged?: boolean } {
  const checked = guarded(db, id, "reopen");
  if (!checked.ok) return checked;
  const row = checked.row;
  const current = annotationFor(row);
  const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...open } = current;
  let annotation = afsAnnotationSchema.parse({
    ...open,
    status: "pending",
    resolution: null,
    intent: note && current.intent === "question" ? "fix" : current.intent,
  });
  if (note) {
    annotation = appendThreadMessage(annotation, "human", note, now);
  }
  let staged = false;
  const updated = db.transaction(() => {
    const routing = routingFor(db, id);
    const sending = routing.state === "sending";
    // A reply that lands while a send is in flight cannot be re-staged (the
    // claim must not be clobbered), so flag it: dispatch()'s success path
    // clears the flag and re-stages + dispatches it exactly once. A normal
    // reopen clears any stale flag — the reply is being staged right now.
    const flagged = afsAnnotationSchema.parse({
      ...annotation,
      pinpoint: {
        ...annotation.pinpoint,
        pendingFollowUp: sending ? true : undefined,
      },
    });
    const saved = writeAnnotation(db, row, flagged, "open", null, now);
    if (!sending) {
      stageRouting(db, id, now);
      staged = true;
    }
    return saved;
  })();
  return { ok: true, row: updated, staged };
}

/**
 * Delete the annotation and its routing row atomically. Returns the pre-delete
 * row + routing so the caller can notify an assigned thread.
 */
export function removeAnnotation(
  db: Database,
  id: string,
):
  | { ok: true; row: AnnotationRow; routing: AnnotationRouting | null }
  | { ok: false; error: string } {
  const row = getAnnotationRow(db, id);
  if (!row) return { ok: false, error: `no such annotation: ${id}` };
  const routing = getRouting(db, id);
  db.transaction(() => {
    deleteRouting(db, id);
    db.prepare(`DELETE FROM screenshots WHERE annotation_id=?`).run(id);
    db.prepare(`DELETE FROM annotations WHERE id=?`).run(id);
  })();
  return { ok: true, row, routing };
}
