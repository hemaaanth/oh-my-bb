import type DatabaseNamespace from "better-sqlite3";
import { z } from "zod";

export const routingStates = ["staged", "sending", "assigned"] as const;
export const routingStateSchema = z.enum(routingStates);
export type RoutingState = z.infer<typeof routingStateSchema>;

type Database = DatabaseNamespace.Database;

export const routingMigrations = [
  `CREATE TABLE IF NOT EXISTS annotation_routing (
    annotation_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    assigned_thread_id TEXT,
    dispatch_id TEXT,
    last_error TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(annotation_id) REFERENCES annotations(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pinpoint_routing_state ON annotation_routing(state, updated_at)`,
] as const;

export interface AnnotationRouting {
  annotationId: string;
  state: RoutingState;
  assignedThreadId: string | null;
  dispatchId: string | null;
  lastError: string | null;
  updatedAt: number;
}

type RoutingRow = {
  annotation_id: string;
  state: string;
  assigned_thread_id: string | null;
  dispatch_id: string | null;
  last_error: string | null;
  updated_at: number;
};

function toRouting(row: RoutingRow): AnnotationRouting {
  return {
    annotationId: row.annotation_id,
    state: routingStateSchema.parse(row.state),
    assignedThreadId: row.assigned_thread_id,
    dispatchId: row.dispatch_id,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function ensureRoutingRows(db: Database, now = Date.now()): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO annotation_routing
       (annotation_id,state,assigned_thread_id,dispatch_id,last_error,updated_at)
       SELECT id,
         CASE WHEN review_state='open' AND status='pending' THEN 'staged' ELSE 'assigned' END,
         NULL,NULL,NULL,?
       FROM annotations`,
    )
    .run(now);
  return result.changes;
}

/** Return interrupted claims to staging after a plugin/server restart. */
export function recoverInterruptedDispatches(db: Database, now = Date.now()): number {
  const result = db
    .prepare(
      `UPDATE annotation_routing
       SET state='staged', dispatch_id=NULL,
           last_error='delivery interrupted before completion', updated_at=?
       WHERE state='sending'`,
    )
    .run(now);
  return result.changes;
}

export function getRouting(
  db: Database,
  annotationId: string,
): AnnotationRouting | null {
  const row = db
    .prepare(`SELECT * FROM annotation_routing WHERE annotation_id=?`)
    .get(annotationId) as RoutingRow | undefined;
  return row ? toRouting(row) : null;
}

export function stageRouting(
  db: Database,
  annotationId: string,
  now = Date.now(),
): AnnotationRouting {
  db.prepare(
    `INSERT INTO annotation_routing
     (annotation_id,state,assigned_thread_id,dispatch_id,last_error,updated_at)
     VALUES (?,'staged',NULL,NULL,NULL,?)
     ON CONFLICT(annotation_id) DO UPDATE SET
       state='staged', dispatch_id=NULL, last_error=NULL, updated_at=excluded.updated_at`,
  ).run(annotationId, now);
  return getRouting(db, annotationId)!;
}

export type ClaimRoutingResult =
  | { outcome: "claimed"; routing: AnnotationRouting }
  | { outcome: "busy" | "not-staged" | "missing" };

export function claimRouting(
  db: Database,
  input: { annotationId: string; targetThreadId: string; now?: number },
): ClaimRoutingResult {
  return db.transaction(() => {
    const existing = getRouting(db, input.annotationId);
    if (!existing) return { outcome: "missing" as const };
    if (existing.state === "sending") return { outcome: "busy" as const };
    if (existing.state !== "staged") return { outcome: "not-staged" as const };

    const now = input.now ?? Date.now();
    const dispatchId = `dispatch_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const result = db
      .prepare(
        `UPDATE annotation_routing
         SET state='sending', assigned_thread_id=?, dispatch_id=?, last_error=NULL, updated_at=?
         WHERE annotation_id=? AND state='staged'`,
      )
      .run(input.targetThreadId, dispatchId, now, input.annotationId);
    if (result.changes !== 1) return { outcome: "busy" as const };
    return {
      outcome: "claimed" as const,
      routing: getRouting(db, input.annotationId)!,
    };
  })();
}

export function completeRouting(
  db: Database,
  annotationId: string,
  dispatchId: string,
  now = Date.now(),
): boolean {
  const result = db
    .prepare(
      `UPDATE annotation_routing
       SET state='assigned', dispatch_id=NULL, last_error=NULL, updated_at=?
       WHERE annotation_id=? AND state='sending' AND dispatch_id=?`,
    )
    .run(now, annotationId, dispatchId);
  return result.changes === 1;
}

export function failRouting(
  db: Database,
  annotationId: string,
  dispatchId: string,
  error: string,
  now = Date.now(),
): boolean {
  const result = db
    .prepare(
      `UPDATE annotation_routing
       SET state='staged', dispatch_id=NULL, last_error=?, updated_at=?
       WHERE annotation_id=? AND state='sending' AND dispatch_id=?`,
    )
    .run(error, now, annotationId, dispatchId);
  return result.changes === 1;
}

/**
 * Give up on the thread this item was assigned to and put it back in the
 * staging queue. Unlike `stageRouting` this also clears `assigned_thread_id`,
 * which is the point: the assigned thread accepted the send and then failed to
 * act on it, so `chooseDispatchTarget` must NOT prefer it again. Only an
 * already-delivered ("assigned") item can be abandoned — an in-flight send owns
 * its claim and settles through completeRouting/failRouting.
 */
export function abandonRouting(
  db: Database,
  annotationId: string,
  error: string,
  now = Date.now(),
): boolean {
  const result = db
    .prepare(
      `UPDATE annotation_routing
       SET state='staged', assigned_thread_id=NULL, dispatch_id=NULL,
           last_error=?, updated_at=?
       WHERE annotation_id=? AND state='assigned'`,
    )
    .run(error, now, annotationId);
  return result.changes === 1;
}

export function deleteRouting(db: Database, annotationId: string): void {
  db.prepare(`DELETE FROM annotation_routing WHERE annotation_id=?`).run(annotationId);
}

/**
 * Pick where a (re)dispatch should go: prefer the thread this annotation was
 * already assigned to (so replies land in the ongoing conversation), and fall
 * back to a full re-dispatch target only when that thread no longer exists —
 * the conversation history is embedded in the message, so nothing is lost.
 */
export async function chooseDispatchTarget(options: {
  routing: Pick<AnnotationRouting, "assignedThreadId"> | null;
  threadExists: (threadId: string) => Promise<boolean>;
  fallback: () => Promise<string>;
}): Promise<{ target: string; reusedAssigned: boolean }> {
  const assigned = options.routing?.assignedThreadId;
  if (assigned) {
    let alive = false;
    try {
      alive = await options.threadExists(assigned);
    } catch {
      alive = false;
    }
    if (alive) return { target: assigned, reusedAssigned: true };
  }
  return { target: await options.fallback(), reusedAssigned: false };
}
