import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createAfsAnnotation, type ReviewState } from "./afs";
import {
  chooseDispatchTarget,
  claimRouting,
  getRouting,
  type RoutingState,
} from "./routing";
import {
  annotationFor,
  getAnnotationRow,
  getScreenshot,
  migrations,
  removeAnnotation,
  reopenAnnotation,
  resolveAnnotation,
  questionAnnotation,
  screenshotKindsForMany,
  screenshotsFor,
  SCREENSHOT_MAX_BASE64_CHARS,
  SCREENSHOT_UPLOAD_WINDOW_MS,
  storeScreenshot,
  workflowOf,
} from "./store";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  return db;
}

const SEED_URL = "http://localhost:3000/";

let seedCounter = 0;
function seed(
  db: Database.Database,
  opts: {
    reviewState?: ReviewState;
    routingState?: RoutingState;
    assignedThreadId?: string | null;
    /** Picker-anchored capture (client id adopted as the row id). */
    anchored?: boolean;
    createdAt?: number;
    kind?: "text-edit";
    intent?: "question";
  } = {},
): string {
  const id = `pp_test${(seedCounter += 1)}`;
  const now = opts.createdAt ?? Date.now();
  const annotation = createAfsAnnotation(
    id,
    {
      threadId: "thread_1",
      comment: "fix this",
      url: SEED_URL,
      ...(opts.anchored ? { clientId: id } : {}),
      ...(opts.kind
        ? { kind: opts.kind, textOld: "Old copy", textNew: "New copy" }
        : {}),
      ...(opts.intent ? { intent: opts.intent } : {}),
    },
    now,
  );
  db.prepare(
    `INSERT INTO annotations
     (id,project_id,thread_id,status,review_state,comment,url,payload,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "project_1",
    "thread_1",
    annotation.status,
    opts.reviewState ?? "open",
    annotation.comment,
    annotation.url,
    JSON.stringify(annotation),
    now,
    now,
  );
  db.prepare(
    `INSERT INTO annotation_routing
     (annotation_id,state,assigned_thread_id,dispatch_id,last_error,updated_at)
     VALUES (?,?,?,?,NULL,?)`,
  ).run(
    id,
    opts.routingState ?? "staged",
    opts.assignedThreadId ?? null,
    opts.routingState === "sending" ? "dispatch_test" : null,
    now,
  );
  return id;
}

describe("Pinpoint annotation store transitions", () => {
  it("rejects resolve (markReady) on a dismissed annotation and leaves state unchanged", () => {
    const db = makeDb();
    const id = seed(db, { reviewState: "dismissed", routingState: "assigned" });

    const result = resolveAnnotation(db, id, "did the thing");

    expect(result.ok).toBe(false);
    expect(getAnnotationRow(db, id)!.review_state).toBe("dismissed");
  });

  it("moves a dispatched annotation to waiting-input on an agent question", () => {
    const db = makeDb();
    const id = seed(db, {
      reviewState: "open",
      routingState: "assigned",
      assignedThreadId: "thread_child",
    });
    expect(workflowOf(db, getAnnotationRow(db, id)!)).toBe("dispatched");

    const result = questionAnnotation(db, id, "Which shade of blue?");

    expect(result.ok).toBe(true);
    expect(workflowOf(db, getAnnotationRow(db, id)!)).toBe("waiting-input");
  });

  it("re-dispatches a waiting-input reply to the recorded assigned thread", async () => {
    const db = makeDb();
    const id = seed(db, {
      reviewState: "waiting-input",
      routingState: "assigned",
      assignedThreadId: "thread_child",
      intent: "question",
    });

    const reopened = reopenAnnotation(db, id, "Use the darker one");
    expect(reopened.ok).toBe(true);
    expect(reopened.staged).toBe(true);

    // The reply is in the conversation and the assignment survived re-staging.
    const row = getAnnotationRow(db, id)!;
    expect(row.review_state).toBe("open");
    expect(
      annotationFor(row).thread.map((m) => m.content),
    ).toContain("Use the darker one");
    expect(annotationFor(row).intent).toBe("fix");
    const routing = getRouting(db, id)!;
    expect(routing.state).toBe("staged");
    expect(routing.assignedThreadId).toBe("thread_child");

    // Dispatch targets the recorded thread while it exists…
    await expect(
      chooseDispatchTarget({
        routing,
        threadExists: async () => true,
        fallback: async () => "thread_fresh",
      }),
    ).resolves.toEqual({ target: "thread_child", reusedAssigned: true });
    // …and falls back to a full re-dispatch once it is gone (the conversation
    // is embedded in the dispatch message, so nothing is lost).
    await expect(
      chooseDispatchTarget({
        routing,
        threadExists: async () => false,
        fallback: async () => "thread_fresh",
      }),
    ).resolves.toEqual({ target: "thread_fresh", reusedAssigned: false });
  });

  it("keeps a reply made while a send is in flight instead of dropping it", () => {
    const db = makeDb();
    const id = seed(db, { reviewState: "open", routingState: "sending" });

    const reopened = reopenAnnotation(db, id, "Also fix the padding");
    expect(reopened.ok).toBe(true);
    // The in-flight claim must not be clobbered…
    expect(reopened.staged).toBe(false);
    const routing = getRouting(db, id)!;
    expect(routing.state).toBe("sending");
    expect(routing.dispatchId).toBe("dispatch_test");
    // …so a redispatch attempt reports busy (surfaced to the user)…
    expect(
      claimRouting(db, { annotationId: id, targetThreadId: "t" }).outcome,
    ).toBe("busy");
    // …while the note is saved on the item for the next send, flagged so
    // dispatch()'s success path re-stages + re-dispatches it exactly once.
    const annotation = annotationFor(getAnnotationRow(db, id)!);
    expect(annotation.thread.map((m) => m.content)).toContain(
      "Also fix the padding",
    );
    expect(annotation.pinpoint.pendingFollowUp).toBe(true);
  });

  it("does not flag a pending follow-up on a normal (staged) reopen", () => {
    const db = makeDb();
    const id = seed(db, { reviewState: "ready", routingState: "assigned" });

    const reopened = reopenAnnotation(db, id, "One more tweak");
    expect(reopened.ok).toBe(true);
    expect(reopened.staged).toBe(true);
    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.pendingFollowUp,
    ).toBeUndefined();
  });

  it("clears a stale receipt (and its anchor warning) on a re-resolve without one", () => {
    const db = makeDb();
    const id = seed(db, { reviewState: "open", routingState: "assigned" });

    const first = resolveAnnotation(db, id, "did it", {
      receipt: "diff --git a/App.tsx b/App.tsx",
    });
    expect(first.ok).toBe(true);
    expect(annotationFor(getAnnotationRow(db, id)!).pinpoint.receipt).toContain(
      "diff --git",
    );

    // Follow-up feedback reopens the item; the agent re-resolves WITHOUT a
    // receipt — the old receipt must not survive into the new resolution.
    expect(reopenAnnotation(db, id, "still off by 2px").ok).toBe(true);
    const second = resolveAnnotation(db, id, "nudged it");
    expect(second.ok).toBe(true);
    const pinpoint = annotationFor(getAnnotationRow(db, id)!).pinpoint;
    expect(pinpoint.receipt).toBeUndefined();
    expect(pinpoint.receiptAnchorWarning).toBeUndefined();
  });

  it("deletes the routing row with the annotation and reports the assigned thread", () => {
    const db = makeDb();
    const id = seed(db, {
      reviewState: "open",
      routingState: "assigned",
      assignedThreadId: "thread_child",
    });

    const result = removeAnnotation(db, id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Pre-delete routing is returned so the caller can send a cancellation
      // note to the thread that was working the item.
      expect(result.routing?.assignedThreadId).toBe("thread_child");
    }
    expect(getAnnotationRow(db, id)).toBeNull();
    expect(getRouting(db, id)).toBeNull();
  });

  it("rejects deleting an id that does not exist", () => {
    const db = makeDb();
    expect(removeAnnotation(db, "pp_missing").ok).toBe(false);
  });
});

describe("Pinpoint screenshot store", () => {
  const shot = (
    annotationId: string,
    kind: "element" | "viewport",
    pageUrl = SEED_URL,
  ) => ({
    annotationId,
    kind,
    mime: "image/webp",
    data: "dGVzdA==",
    pageUrl,
  });

  it("stores one screenshot per kind, write-once (second store of same kind rejected 409)", () => {
    const db = makeDb();
    const id = seed(db, { anchored: true });

    expect(storeScreenshot(db, shot(id, "element")).ok).toBe(true);
    const dup = storeScreenshot(db, shot(id, "element"));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.status).toBe(409);

    // A different kind for the same annotation is still allowed.
    expect(storeScreenshot(db, shot(id, "viewport")).ok).toBe(true);
    expect(screenshotsFor(db, id).map((s) => s.kind).sort()).toEqual([
      "element",
      "viewport",
    ]);
    expect(getScreenshot(db, id, "element")?.mime).toBe("image/webp");
    expect(getScreenshot(db, id, "element")?.data).toBe("dGVzdA==");
  });
  it("rejects screenshots for text-edit annotations with 409", () => {
    const db = makeDb();
    const id = seed(db, { anchored: true, kind: "text-edit" });
    const result = storeScreenshot(db, shot(id, "element"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
    expect(screenshotsFor(db, id)).toEqual([]);
  });
  it("removes previously stored text-edit screenshots during migration", () => {
    const db = new Database(":memory:");
    for (const statement of migrations.slice(0, -1)) db.exec(statement);
    const id = seed(db, { anchored: true, kind: "text-edit" });
    db.prepare(
      `INSERT INTO screenshots (id,annotation_id,kind,mime,data,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run("shot_legacy", id, "element", "image/webp", "dGVzdA==", Date.now());
    expect(screenshotsFor(db, id)).toHaveLength(1);

    db.exec(migrations.at(-1)!);

    expect(screenshotsFor(db, id)).toEqual([]);
  });



  it("rejects a screenshot for a nonexistent annotation with 404", () => {
    const db = makeDb();
    const result = storeScreenshot(db, shot("pp_missing", "element"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("rejects an oversized payload with 413", () => {
    const db = makeDb();
    const id = seed(db, { anchored: true });
    const result = storeScreenshot(db, {
      annotationId: id,
      kind: "element",
      mime: "image/webp",
      data: "a".repeat(SCREENSHOT_MAX_BASE64_CHARS + 1),
      pageUrl: SEED_URL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
    expect(screenshotsFor(db, id)).toEqual([]);
  });

  it("rejects an upload whose page url does not match the capture with 403", () => {
    const db = makeDb();
    const id = seed(db, { anchored: true });
    // A hostile proxied page shares the proxy origin but not the capture's
    // target page: its posted url must not fill the slot.
    const result = storeScreenshot(
      db,
      shot(id, "element", "http://localhost:3000/other-page"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(screenshotsFor(db, id)).toEqual([]);
  });

  it("rejects an upload outside the expects-screenshot window with 403", () => {
    const db = makeDb();
    const createdAt = Date.now() - SCREENSHOT_UPLOAD_WINDOW_MS - 1000;
    const id = seed(db, { anchored: true, createdAt });
    const result = storeScreenshot(db, shot(id, "element"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(screenshotsFor(db, id)).toEqual([]);
  });

  it("rejects an upload for a non-anchored annotation with 403", () => {
    const db = makeDb();
    // Agent-comment / CLI-created rows never expect screenshot uploads.
    const id = seed(db);
    const result = storeScreenshot(db, shot(id, "element"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("accepts a matching-page upload where only the hash/query differs (same origin+path)", () => {
    const db = makeDb();
    const id = seed(db, { anchored: true });
    expect(
      storeScreenshot(db, shot(id, "element", `${SEED_URL}#section`)).ok,
    ).toBe(true);
  });

  it("batches kinds for many annotations in one lookup (no entry when none stored)", () => {
    const db = makeDb();
    const both = seed(db, { anchored: true });
    const elementOnly = seed(db, { anchored: true });
    const none = seed(db, { anchored: true });
    expect(storeScreenshot(db, shot(both, "element")).ok).toBe(true);
    expect(storeScreenshot(db, shot(both, "viewport")).ok).toBe(true);
    expect(storeScreenshot(db, shot(elementOnly, "element")).ok).toBe(true);

    const kinds = screenshotKindsForMany(db, [both, elementOnly, none]);
    expect(kinds.get(both)).toEqual(["element", "viewport"]);
    expect(kinds.get(elementOnly)).toEqual(["element"]);
    expect(kinds.has(none)).toBe(false);
    expect(screenshotKindsForMany(db, []).size).toBe(0);
  });

  it("deletes screenshot rows in the same transaction as the annotation", () => {
    const db = makeDb();
    const id = seed(db, { anchored: true });
    expect(storeScreenshot(db, shot(id, "element")).ok).toBe(true);
    expect(storeScreenshot(db, shot(id, "viewport")).ok).toBe(true);

    expect(removeAnnotation(db, id).ok).toBe(true);

    expect(screenshotsFor(db, id)).toEqual([]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM screenshots`).get(),
    ).toEqual({ n: 0 });
  });
});
