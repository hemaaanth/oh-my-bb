import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  abandonRouting,
  chooseDispatchTarget,
  claimRouting,
  completeRouting,
  getRouting,
  recoverInterruptedDispatches,
  stageRouting,
} from "./routing";
import { migrations } from "./store";

// The routing table declares a foreign key on annotations, so build the full
// schema (store migrations include the routing ones, in order).
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  return db;
}

function seedAnnotation(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO annotations
     (id,project_id,thread_id,status,review_state,comment,url,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, "project_1", "thread_1", "pending", "open", "", "http://x/", 0, 0);
}

describe("Pinpoint dispatch routing", () => {
  it("re-stages an interrupted (sending) dispatch exactly once on restart", () => {
    const db = makeDb();
    seedAnnotation(db, "pp_1");
    stageRouting(db, "pp_1");
    const claim = claimRouting(db, {
      annotationId: "pp_1",
      targetThreadId: "thread_child",
    });
    expect(claim.outcome).toBe("claimed");
    expect(getRouting(db, "pp_1")!.state).toBe("sending");

    // Restart while the send was in flight.
    expect(recoverInterruptedDispatches(db)).toBe(1);
    const recovered = getRouting(db, "pp_1")!;
    expect(recovered.state).toBe("staged");
    expect(recovered.lastError).toContain("interrupted");

    // Running recovery again must not touch anything (no double re-stage).
    expect(recoverInterruptedDispatches(db)).toBe(0);

    // The recovered item can be claimed exactly once, not twice.
    expect(
      claimRouting(db, { annotationId: "pp_1", targetThreadId: "t" }).outcome,
    ).toBe("claimed");
    expect(
      claimRouting(db, { annotationId: "pp_1", targetThreadId: "t" }).outcome,
    ).toBe("busy");
  });

  it("clears the assigned thread when a delivered item is abandoned", () => {
    // A child that accepted the pin and then did nothing must not be chosen
    // again, so abandoning has to drop assigned_thread_id — re-staging alone
    // would leave chooseDispatchTarget preferring the dead child forever.
    const db = makeDb();
    seedAnnotation(db, "pp_3");
    stageRouting(db, "pp_3");
    const claim = claimRouting(db, {
      annotationId: "pp_3",
      targetThreadId: "thread_child",
    });
    expect(claim.outcome).toBe("claimed");
    const dispatchId = claim.outcome === "claimed" ? claim.routing.dispatchId! : "";
    expect(completeRouting(db, "pp_3", dispatchId)).toBe(true);
    expect(getRouting(db, "pp_3")!.assignedThreadId).toBe("thread_child");

    expect(abandonRouting(db, "pp_3", "child did nothing")).toBe(true);
    const abandoned = getRouting(db, "pp_3")!;
    expect(abandoned.state).toBe("staged");
    expect(abandoned.assignedThreadId).toBeNull();
    expect(abandoned.lastError).toBe("child did nothing");
  });

  it("refuses to abandon an item that is not currently delivered", () => {
    const db = makeDb();
    seedAnnotation(db, "pp_4");
    stageRouting(db, "pp_4");
    expect(abandonRouting(db, "pp_4", "stale verdict")).toBe(false);
    claimRouting(db, { annotationId: "pp_4", targetThreadId: "thread_child" });
    // An in-flight send owns its claim; the watchdog must not steal it.
    expect(abandonRouting(db, "pp_4", "stale verdict")).toBe(false);
    expect(getRouting(db, "pp_4")!.state).toBe("sending");
  });

  it("reports busy while a send is in flight instead of double-claiming", () => {
    const db = makeDb();
    seedAnnotation(db, "pp_2");
    stageRouting(db, "pp_2");
    claimRouting(db, { annotationId: "pp_2", targetThreadId: "thread_child" });
    expect(
      claimRouting(db, { annotationId: "pp_2", targetThreadId: "other" })
        .outcome,
    ).toBe("busy");
  });
});

describe("Pinpoint dispatch target choice", () => {
  const routingWith = (assignedThreadId: string | null) => ({
    assignedThreadId,
  });

  it("prefers the recorded assigned thread when it still exists", async () => {
    const chosen = await chooseDispatchTarget({
      routing: routingWith("thread_assigned"),
      threadExists: async () => true,
      fallback: async () => {
        throw new Error("must not resolve a fresh target");
      },
    });
    expect(chosen).toEqual({ target: "thread_assigned", reusedAssigned: true });
  });

  it("falls back to a full re-dispatch when the assigned thread is gone", async () => {
    const chosen = await chooseDispatchTarget({
      routing: routingWith("thread_deleted"),
      threadExists: async () => {
        throw new Error("no such thread");
      },
      fallback: async () => "thread_fresh",
    });
    expect(chosen).toEqual({ target: "thread_fresh", reusedAssigned: false });
  });

  it("resolves a fresh target when nothing was ever assigned", async () => {
    const chosen = await chooseDispatchTarget({
      routing: null,
      threadExists: async () => true,
      fallback: async () => "thread_fresh",
    });
    expect(chosen).toEqual({ target: "thread_fresh", reusedAssigned: false });
  });
});
