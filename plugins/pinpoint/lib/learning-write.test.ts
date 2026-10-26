import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createAfsAnnotation } from "./afs";
import { CLASI_SCOPE_FIXTURES } from "./clasi-scope";
import {
  LEARNING_PRIORITY,
  performLearningWrite,
  recordLearningConsent,
  type LearningWriteDeps,
} from "./learning-write";
import { applyResolveOutcome } from "./resolve";
import { annotationFor, getAnnotationRow, migrations, patchPinpoint } from "./store";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  return db;
}

let seedCounter = 0;
function seed(db: Database.Database): string {
  const id = `pp_lw${(seedCounter += 1)}`;
  const now = Date.now();
  const annotation = createAfsAnnotation(
    id,
    {
      threadId: "thread_1",
      comment: "make the buttons consistent",
      url: "http://localhost:3000/",
      selector: "#target",
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
    "open",
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
  ).run(id, "assigned", "thread_child", null, now);
  return id;
}

const LEARNING = {
  topic: "design" as const,
  logicalKey: "button-consistency",
  text: "Use one shared button component per variant.",
};

/** Resolve ready with the standard proposal attached. */
function seedWithProposal(db: Database.Database): string {
  const id = seed(db);
  const resolved = applyResolveOutcome(db, {
    id,
    outcome: "ready",
    summary: "unified the buttons",
    proposedLearning: LEARNING,
  });
  expect(resolved.ok).toBe(true);
  db.prepare("UPDATE annotations SET review_state='approved' WHERE id=?").run(id);
  return id;
}

const REMOTE_FIXTURE = CLASI_SCOPE_FIXTURES.scopeRemotes[0]!;
const EXPECTED_REPO_SCOPE_ID = `repo_${createHash("sha256")
  .update(REMOTE_FIXTURE.canonical)
  .digest("hex")
  .slice(0, 32)}`;

function fakeDeps(overrides: Partial<LearningWriteDeps> = {}): {
  deps: LearningWriteDeps;
  callRpc: ReturnType<typeof vi.fn>;
} {
  const callRpc = vi.fn().mockResolvedValue({ id: "ctx-1" });
  return {
    deps: {
      callRpc,
      isEnabled: async () => true,
      getProject: async (projectId) => ({
        id: projectId,
        gitRemoteUrl: REMOTE_FIXTURE.remote,
      }),
      ...overrides,
    },
    callRpc,
  };
}

describe("learning consent event", () => {
  it("records approvedAt plus the verbatim proposal text", () => {
    const db = makeDb();
    const id = seedWithProposal(db);

    const result = recordLearningConsent(db, id, LEARNING, 1700000000000);
    expect(result.ok).toBe(true);
    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.learningConsent,
    ).toEqual({ approvedAt: 1700000000000, ...LEARNING });
  });

  it("refuses consent for a row without a proposal (AE4 gate)", () => {
    const db = makeDb();
    const id = seed(db);
    applyResolveOutcome(db, { id, outcome: "ready", summary: "done" });

    const result = recordLearningConsent(db, id, LEARNING);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no proposed learning");
    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.learningConsent,
    ).toBeUndefined();
  });
});

describe("consented clasi write (injected callRpc)", () => {
  it("rechecks disabling while repository scope is loading", async () => {
    const db = makeDb();
    const id = seedWithProposal(db);
    recordLearningConsent(db, id, LEARNING);
    let enabled = true;
    const { deps, callRpc } = fakeDeps({
      isEnabled: async () => enabled,
      getProject: async (projectId) => { enabled = false; return { id: projectId, gitRemoteUrl: null }; },
    });
    const result = await performLearningWrite(db, id, deps);
    expect(result.ok).toBe(false);
    expect(callRpc).not.toHaveBeenCalled();
  });

  it("does not save or overwrite an item reopened during scope lookup", async () => {
    const db = makeDb();
    const id = seedWithProposal(db);
    recordLearningConsent(db, id, LEARNING);
    const { deps, callRpc } = fakeDeps({
      getProject: async (projectId) => {
        db.prepare("UPDATE annotations SET review_state='open', comment='New feedback' WHERE id=?").run(id);
        return { id: projectId, gitRemoteUrl: null };
      },
    });
    expect((await performLearningWrite(db, id, deps)).ok).toBe(false);
    expect(callRpc).not.toHaveBeenCalled();
    expect(getAnnotationRow(db, id)?.review_state).toBe("open");
    expect(getAnnotationRow(db, id)?.comment).toBe("New feedback");
    expect(annotationFor(getAnnotationRow(db, id)!).pinpoint.learningWrite).toBeUndefined();
  });

  it("retains legacy consent without broadening it into a new write", async () => {
    const db = makeDb();
    const id = seedWithProposal(db);
    patchPinpoint(db, getAnnotationRow(db, id)!, { learningConsent: { approvedAt: 1, text: LEARNING.text } });
    const { deps, callRpc } = fakeDeps();
    const result = await performLearningWrite(db, id, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("older consent");
    expect(callRpc).not.toHaveBeenCalled();
    expect(annotationFor(getAnnotationRow(db, id)!).pinpoint.learningConsent).toEqual({ approvedAt: 1, text: LEARNING.text });
  });

  it("preserves newer state when a save completes after the item reopens", async () => {
    const db = makeDb();
    const id = seedWithProposal(db);
    recordLearningConsent(db, id, LEARNING);
    const { deps } = fakeDeps({
      callRpc: async () => {
        db.prepare("UPDATE annotations SET review_state='open', summary='Newer review' WHERE id=?").run(id);
        return { id: "ctx-1" };
      },
    });
    expect((await performLearningWrite(db, id, deps)).ok).toBe(false);
    expect(getAnnotationRow(db, id)?.summary).toBe("Newer review");
    expect(getAnnotationRow(db, id)?.review_state).toBe("open");
    expect(annotationFor(getAnnotationRow(db, id)!).pinpoint.learningWrite).toBeUndefined();
  });

  it("sends the exact saveContext payload and marks learningWrite saved", async () => {
    const db = makeDb();
    const id = seedWithProposal(db);
    expect(recordLearningConsent(db, id, LEARNING).ok).toBe(true);
    const { deps, callRpc } = fakeDeps();

    const result = await performLearningWrite(db, id, deps, 1700000001000);

    expect(result.ok).toBe(true);
    expect(callRpc).toHaveBeenCalledTimes(1);
    const args = callRpc.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.pluginId).toBe("clasi");
    expect(args.method).toBe("saveContext");
    expect(args.outputSchema).toBeDefined();
    expect(args.input).toEqual({
      scope: { type: "project", id: EXPECTED_REPO_SCOPE_ID },
      logicalKey: LEARNING.logicalKey,
      kind: "preference",
      value: LEARNING.text, // verbatim approved text
      priority: LEARNING_PRIORITY,
      topic: "design",
      provenance: "thread_1",
      consentRef: `pinpoint:${id}`,
    });
    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.learningWrite,
    ).toEqual({ state: "saved", at: 1700000001000 });
  });

  it("falls back to the raw project id as scope when the project has no remote", async () => {
    const db = makeDb();
    const id = seedWithProposal(db);
    recordLearningConsent(db, id, LEARNING);
    const { deps, callRpc } = fakeDeps({
      getProject: async (projectId) => ({ id: projectId, gitRemoteUrl: null }),
    });

    expect((await performLearningWrite(db, id, deps)).ok).toBe(true);
    const input = callRpc.mock.calls[0]![0].input as { scope: unknown };
    expect(input.scope).toEqual({ type: "project", id: "project_1" });
  });

  it("marks failed with the error when callRpc throws, and retry re-attempts to saved", async () => {
    const db = makeDb();
    const id = seedWithProposal(db);
    recordLearningConsent(db, id, LEARNING);
    const callRpc = vi
      .fn()
      .mockRejectedValueOnce(new Error("plugin clasi is not installed"))
      .mockResolvedValueOnce({ id: "ctx-2" });
    const deps: LearningWriteDeps = {
      callRpc,
      isEnabled: async () => true,
      getProject: async (projectId) => ({ id: projectId, gitRemoteUrl: null }),
    };

    const failed = await performLearningWrite(db, id, deps);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toBe("plugin clasi is not installed");
    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.learningWrite,
    ).toEqual({ state: "failed", error: "plugin clasi is not installed" });

    // retry-learning re-runs the same write.
    const retried = await performLearningWrite(db, id, deps, 1700000002000);
    expect(retried.ok).toBe(true);
    expect(callRpc).toHaveBeenCalledTimes(2);
    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.learningWrite,
    ).toEqual({ state: "saved", at: 1700000002000 });
  });

  it("marks failed (never saved) when the project lookup itself fails, without calling clasi", async () => {
    const db = makeDb();
    const id = seedWithProposal(db);
    recordLearningConsent(db, id, LEARNING);
    const { deps, callRpc } = fakeDeps({
      getProject: async () => {
        throw new Error("project service unavailable");
      },
    });

    const result = await performLearningWrite(db, id, deps);
    expect(result.ok).toBe(false);
    expect(callRpc).not.toHaveBeenCalled();
    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.learningWrite,
    ).toEqual({ state: "failed", error: "project service unavailable" });
  });

  it("never writes without a consent event — no callRpc, no learningWrite mark", async () => {
    const db = makeDb();
    const id = seedWithProposal(db); // proposal, but the user never opted in
    const { deps, callRpc } = fakeDeps();

    const result = await performLearningWrite(db, id, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no consented learning");
    expect(callRpc).not.toHaveBeenCalled();
    expect(
      annotationFor(getAnnotationRow(db, id)!).pinpoint.learningWrite,
    ).toBeUndefined();
  });
});
