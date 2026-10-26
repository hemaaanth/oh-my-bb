import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createAfsAnnotation, type ReviewState } from "./afs";
import {
  RECEIPT_MAX_CHARS,
  RECEIPT_TRUNCATION_MARKER,
  applyResolveOutcome,
  parseLearningFlag,
  parseScopeFlag,
  readReceiptFile,
} from "./resolve";
import { reopenAnnotation } from "./store";
import type { RoutingState } from "./routing";
import { annotationFor, getAnnotationRow, migrations, workflowOf } from "./store";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  return db;
}

let seedCounter = 0;
function seed(
  db: Database.Database,
  opts: {
    reviewState?: ReviewState;
    routingState?: RoutingState;
    anchored?: boolean;
  } = {},
): string {
  const id = `pp_res${(seedCounter += 1)}`;
  const now = Date.now();
  const annotation = createAfsAnnotation(
    id,
    {
      threadId: "thread_1",
      comment: "fix this",
      url: "http://localhost:3000/",
      selector: "#target",
      // A clientId matching the row id is what marks the pick as anchored
      // (the live element carries data-pp="<id>").
      ...(opts.anchored ? { clientId: id } : {}),
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
  ).run(id, opts.routingState ?? "assigned", "thread_child", null, now);
  return id;
}

describe("Pinpoint structured resolve outcomes (shared tool/CLI handler)", () => {
  it("routes outcome ready to the resolve mutation and records an inferred scope by default", () => {
    const db = makeDb();
    const id = seed(db);

    const result = applyResolveOutcome(db, {
      id,
      outcome: "ready",
      summary: "tightened the spacing",
    });

    expect(result.ok).toBe(true);
    const row = getAnnotationRow(db, id)!;
    expect(workflowOf(db, row)).toBe("ready");
    const annotation = annotationFor(row);
    expect(annotation.pinpoint.scope).toEqual({
      breadth: "instance",
      target: "element",
      declared: false,
    });
    expect(annotation.thread.map((m) => m.content)).toContain(
      "tightened the spacing",
    );
  });

  it("records a declared scope when one is supplied", () => {
    const db = makeDb();
    const id = seed(db);

    const result = applyResolveOutcome(db, {
      id,
      outcome: "ready",
      summary: "unified the button variant",
      scope: { breadth: "pattern", target: "component" },
    });

    expect(result.ok).toBe(true);
    expect(annotationFor(getAnnotationRow(db, id)!).pinpoint.scope).toEqual({
      breadth: "pattern",
      target: "component",
      declared: true,
    });
  });

  it("rejects scope/receipt outside ready, and question text outside question", () => {
    const db = makeDb();
    const id = seed(db);

    const withScope = applyResolveOutcome(db, {
      id,
      outcome: "question",
      question: "which one?",
      scope: { breadth: "pattern", target: "token" },
    });
    expect(withScope.ok).toBe(false);
    const withReceipt = applyResolveOutcome(db, {
      id,
      outcome: "reject",
      receipt: "diff --git",
    });
    expect(withReceipt.ok).toBe(false);
    const readyWithQuestion = applyResolveOutcome(db, {
      id,
      outcome: "ready",
      question: "also, which one?",
    });
    expect(readyWithQuestion.ok).toBe(false);
    // Nothing moved.
    expect(workflowOf(db, getAnnotationRow(db, id)!)).toBe("dispatched");
  });

  it("rejects outcome question without question text", () => {
    const db = makeDb();
    const id = seed(db);

    const missing = applyResolveOutcome(db, { id, outcome: "question" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("question");
    const blank = applyResolveOutcome(db, {
      id,
      outcome: "question",
      question: "   ",
    });
    expect(blank.ok).toBe(false);
    expect(workflowOf(db, getAnnotationRow(db, id)!)).toBe("dispatched");
  });

  it("moves dispatched to waiting-input on question and appends it as an agent message", () => {
    const db = makeDb();
    const id = seed(db);

    const result = applyResolveOutcome(db, {
      id,
      outcome: "question",
      question: "Should the header change on mobile too?",
    });

    expect(result.ok).toBe(true);
    const row = getAnnotationRow(db, id)!;
    expect(workflowOf(db, row)).toBe("waiting-input");
    const last = annotationFor(row).thread.at(-1)!;
    expect(last.role).toBe("agent");
    expect(last.content).toBe("Should the header change on mobile too?");
  });

  it("routes outcome reject to dismiss with the reason recorded", () => {
    const db = makeDb();
    const id = seed(db);

    const result = applyResolveOutcome(db, {
      id,
      outcome: "reject",
      summary: "intended behavior per the spec",
    });

    expect(result.ok).toBe(true);
    const row = getAnnotationRow(db, id)!;
    expect(workflowOf(db, row)).toBe("dismissed");
    expect(annotationFor(row).thread.map((m) => m.content)).toContain(
      "intended behavior per the spec",
    );
  });

  it("stores an over-cap receipt truncated with the marker", () => {
    const db = makeDb();
    const id = seed(db);

    const result = applyResolveOutcome(db, {
      id,
      outcome: "ready",
      receipt: "x".repeat(RECEIPT_MAX_CHARS + 500),
    });

    expect(result.ok).toBe(true);
    const receipt = annotationFor(getAnnotationRow(db, id)!).pinpoint.receipt!;
    expect(receipt.length).toBe(
      RECEIPT_MAX_CHARS + RECEIPT_TRUNCATION_MARKER.length,
    );
    expect(receipt.endsWith(RECEIPT_TRUNCATION_MARKER)).toBe(true);
  });

  it("flags receiptAnchorWarning only when an anchored item's receipt omits its data-pp id", () => {
    const db = makeDb();

    const anchoredMiss = seed(db, { anchored: true });
    expect(
      applyResolveOutcome(db, {
        id: anchoredMiss,
        outcome: "ready",
        receipt: "diff --git a/Button.tsx b/Button.tsx",
      }).ok,
    ).toBe(true);
    expect(
      annotationFor(getAnnotationRow(db, anchoredMiss)!).pinpoint
        .receiptAnchorWarning,
    ).toBe(true);

    const anchoredHit = seed(db, { anchored: true });
    expect(
      applyResolveOutcome(db, {
        id: anchoredHit,
        outcome: "ready",
        receipt: `+<button data-pp="${anchoredHit}">Save</button>`,
      }).ok,
    ).toBe(true);
    expect(
      annotationFor(getAnnotationRow(db, anchoredHit)!).pinpoint
        .receiptAnchorWarning,
    ).toBeUndefined();

    const unanchored = seed(db);
    expect(
      applyResolveOutcome(db, {
        id: unanchored,
        outcome: "ready",
        receipt: "diff --git a/Button.tsx b/Button.tsx",
      }).ok,
    ).toBe(true);
    expect(
      annotationFor(getAnnotationRow(db, unanchored)!).pinpoint
        .receiptAnchorWarning,
    ).toBeUndefined();
  });
});

describe("Pinpoint proposed learnings (R12)", () => {
  const validLearning = {
    topic: "design" as const,
    logicalKey: "spacing-scale",
    text: "Use a four pixel spacing scale.",
  };

  it("stores a valid proposal verbatim on the payload", () => {
    const db = makeDb();
    const id = seed(db);

    const result = applyResolveOutcome(db, {
      id,
      outcome: "ready",
      summary: "tightened the spacing",
      proposedLearning: validLearning,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.learningRejected).toBeUndefined();
    const pinpoint = annotationFor(getAnnotationRow(db, id)!).pinpoint;
    expect(pinpoint.proposedLearning).toEqual(validLearning);
    expect(pinpoint.learningConsent).toBeUndefined();
    expect(pinpoint.learningWrite).toBeUndefined();
  });

  it("AE3: a path-bearing proposal is dropped with the reason while the resolution still becomes ready", () => {
    const db = makeDb();
    const id = seed(db);

    const result = applyResolveOutcome(db, {
      id,
      outcome: "ready",
      summary: "tightened the spacing",
      proposedLearning: {
        topic: "design",
        logicalKey: "spacing-scale",
        text: "Fix the spacing in /src/components/Button.tsx",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.learningRejected).toBeDefined();
      expect(result.learningRejected).toContain("path");
    }
    const row = getAnnotationRow(db, id)!;
    // The resolution applied…
    expect(workflowOf(db, row)).toBe("ready");
    // …but no proposal was stored.
    expect(annotationFor(row).pinpoint.proposedLearning).toBeUndefined();
  });

  it("rejects a proposal outside outcome ready without mutating anything", () => {
    const db = makeDb();
    const id = seed(db);

    for (const outcome of ["question", "reject"] as const) {
      const result = applyResolveOutcome(db, {
        id,
        outcome,
        question: outcome === "question" ? "which one?" : undefined,
        proposedLearning: validLearning,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('outcome "ready"');
    }
    expect(workflowOf(db, getAnnotationRow(db, id)!)).toBe("dispatched");
  });

  it("re-resolving starts a fresh proposal cycle (old proposal cleared)", () => {
    const db = makeDb();
    const id = seed(db);

    expect(
      applyResolveOutcome(db, {
        id,
        outcome: "ready",
        proposedLearning: validLearning,
      }).ok,
    ).toBe(true);
    expect(reopenAnnotation(db, id, "not quite").ok).toBe(true);
    expect(applyResolveOutcome(db, { id, outcome: "ready" }).ok).toBe(true);

    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.proposedLearning,
    ).toBeUndefined();
  });

  it("parses --learning topic:key:text (text keeps its own colons) and rejects bad shapes", () => {
    expect(
      parseLearningFlag("design:spacing-scale:Use a four pixel spacing scale."),
    ).toEqual({
      ok: true,
      learning: validLearning,
    });
    const withColons = parseLearningFlag(
      "copy:error-tone:State the fix: what to do next",
    );
    expect(withColons.ok).toBe(true);
    if (withColons.ok)
      expect(withColons.learning.text).toBe("State the fix: what to do next");
    for (const bad of [
      "",
      "design",
      "design:only-key",
      "engineering:key:an engineering learning",
    ]) {
      const result = parseLearningFlag(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.error).toContain("design|copy");
    }
  });
});

describe("Pinpoint CLI flag helpers", () => {
  it("parses breadth:target scope flags and rejects bad values with a usage error", () => {
    expect(parseScopeFlag("pattern:component")).toEqual({
      ok: true,
      scope: { breadth: "pattern", target: "component" },
    });
    expect(parseScopeFlag("instance:token")).toEqual({
      ok: true,
      scope: { breadth: "instance", target: "token" },
    });
    for (const bad of ["huge:thing", "pattern", "pattern component", "element:pattern", ""]) {
      const result = parseScopeFlag(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("instance|pattern");
    }
  });

  it("reads a receipt file whose content is then capped by the shared handler", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-receipt-"));
    const path = join(dir, "receipt.diff");
    writeFileSync(path, "y".repeat(RECEIPT_MAX_CHARS + 123));

    const read = readReceiptFile(path);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text).toBe(readFileSync(path, "utf8"));

    const db = makeDb();
    const id = seed(db);
    expect(
      applyResolveOutcome(db, { id, outcome: "ready", receipt: read.text }).ok,
    ).toBe(true);
    const stored = annotationFor(getAnnotationRow(db, id)!).pinpoint.receipt!;
    expect(stored.length).toBe(
      RECEIPT_MAX_CHARS + RECEIPT_TRUNCATION_MARKER.length,
    );
    expect(stored.endsWith(RECEIPT_TRUNCATION_MARKER)).toBe(true);

    const missing = readReceiptFile(join(dir, "nope.diff"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("receipt");
  });
});

describe("Pinpoint surface parity guards", () => {
  const serverSource = readFileSync(
    new URL("../server.ts", import.meta.url),
    "utf8",
  );

  it("registers exactly the list/resolve/show tools — approve and delete have no tool route", () => {
    const registrations = serverSource.match(/bb\.agents\.registerTool\(/g) ?? [];
    expect(registrations.length).toBe(3);
    expect(serverSource).not.toMatch(/pinpoint_approve|pinpoint_delete/);
  });

  it("keeps the CLI approve/delete human-only thread-context guards", () => {
    const guards =
      serverSource.match(/reserved for the user: it cannot run with a thread context/g) ??
      [];
    expect(guards.length).toBe(2);
  });

  it("routes tool and CLI resolve surfaces through the one shared handler", () => {
    // Both surfaces must call the shared lib handler rather than reaching for
    // store mutations directly — that is what makes them provably identical.
    expect(serverSource).toContain("applyResolveOutcome");
    expect(serverSource).not.toMatch(/\bstoreResolve\(/);
  });
});
