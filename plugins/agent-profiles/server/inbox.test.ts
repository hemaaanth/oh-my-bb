import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createAgentInbox, INBOX_SHOWN } from "./inbox";

function inbox() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE agent_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL,
    source TEXT NOT NULL, thread_id TEXT NOT NULL, place TEXT NOT NULL, request TEXT NOT NULL,
    reply TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER)`);
  let clock = Date.UTC(2026, 9, 18, 12, 0);
  return { db, inbox: createAgentInbox(db, () => clock++) };
}

const report = { profileId: "a", source: "channel" as const, threadId: "thr_room", place: "launch",
  request: "Ana: what shipped?", reply: "The pricing page shipped." };

it("delivers reports to the DM's next turn and marks them read only when it finishes", () => {
  const { inbox: box } = inbox();
  box.record(report);
  box.record({ ...report, source: "task", threadId: "thr_task", place: "Fix slide two", request: "Fix slide two.", reply: "Fixed." });
  const text = box.take("a", "dm")!;
  expect(text).toContain("In the #launch channel (@thread:thr_room)");
  expect(text).toContain("> The pricing page shipped.");
  expect(text).toContain('In your task "Fix slide two" (@thread:thr_task)');
  expect(text.indexOf("#launch")).toBeLessThan(text.indexOf("Fix slide two"));
  // A failed turn keeps them for the next try.
  box.release("dm");
  expect(box.take("a", "dm")).toBe(text);
  box.settle("dm");
  expect(box.take("a", "dm")).toBeNull();
  expect(box.take("b", "dm_b")).toBeNull();
});

it("keeps reports that arrive during the DM turn for the turn after", () => {
  const { inbox: box } = inbox();
  box.record(report);
  box.take("a", "dm");
  box.record({ ...report, reply: "Docs shipped too." });
  box.settle("dm");
  expect(box.take("a", "dm")).toContain("Docs shipped too.");
});

it("skips empty and replayed replies", () => {
  const { db, inbox: box } = inbox();
  box.record({ ...report, reply: "  " });
  box.record(report);
  box.record(report);
  expect(db.prepare("SELECT count(*) AS n FROM agent_inbox").get()).toEqual({ n: 1 });
});

it("shows the newest reports and counts the older ones", () => {
  const { inbox: box } = inbox();
  for (let index = 0; index < INBOX_SHOWN + 3; index += 1)
    box.record({ ...report, reply: `reply ${index}` });
  const text = box.take("a", "dm")!;
  expect(text).toContain("(3 older reports not shown.)");
  expect(text).not.toContain("reply 2\n");
  expect(text).toContain(`reply ${INBOX_SHOWN + 2}`);
  box.settle("dm");
  expect(box.take("a", "dm")).toBeNull();
});
