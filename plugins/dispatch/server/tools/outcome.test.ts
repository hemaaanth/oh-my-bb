import { describe, expect, it } from "vitest";
import { OUTCOME_DETAIL_MAX, clipDetail, summariseEvents, type ThreadEventRow } from "./outcome.js";

const event = (type: string, data: Record<string, unknown>) => ({ type, data }) as unknown as ThreadEventRow;

describe("outcome summariser", () => {
  it("summarises a provider error and a system error", () => {
    expect(summariseEvents([event("provider/error", { message: "Rate limited\nretry later", detail: "429" })])).toEqual({
      kind: "error",
      summary: "Rate limited",
      detail: "Rate limited\nretry later\n429",
    });
    expect(summariseEvents([event("system/error", {})])?.summary).toBe("The thread hit an error.");
  });

  it("summarises a rejected turn", () => {
    expect(summariseEvents([event("client/turn/rejected", { reason: "busy", message: "A turn is already running" })])).toMatchObject({
      kind: "rejected",
      summary: "The message was not accepted: A turn is already running.",
    });
  });

  it("summarises provisioning with the failed stage", () => {
    const outcome = summariseEvents([
      event("system/thread-provisioning", {
        status: "failed",
        entries: [
          { status: "completed", text: "Cloning" },
          { status: "failed", text: "npm install failed" },
        ],
      }),
    ]);
    expect(outcome).toMatchObject({ kind: "provisioning", summary: "The thread's environment setup failed (npm install failed)." });
  });

  it("summarises an interruption by its reason and cause", () => {
    expect(summariseEvents([event("system/thread/interrupted", { reason: "manual-stop" })])?.summary).toBe("Someone stopped the thread.");
    expect(summariseEvents([event("system/thread/interrupted", { cause: "host-connection-lost" })])?.summary).toMatch(/connection to the machine/);
  });

  it("summarises turn completion, and skips a plain completion for errors only", () => {
    expect(summariseEvents([event("turn/completed", { status: "completed" })])).toMatchObject({ kind: "completed", summary: "finished without a message" });
    expect(summariseEvents([event("turn/completed", { status: "failed", error: { message: "Out of context" } })])).toMatchObject({
      kind: "error",
      summary: "Out of context",
    });
    expect(summariseEvents([event("turn/completed", { status: "interrupted" })])?.kind).toBe("interrupted");
    const events = [event("turn/completed", { status: "completed" }), event("provider/error", { message: "Old failure" })];
    expect(summariseEvents(events, { errorsOnly: true })?.summary).toBe("Old failure");
    expect(summariseEvents([event("system/thread-provisioning", { status: "active" })], { errorsOnly: true })).toBeNull();
  });

  it("uses the newest relevant event and ignores others", () => {
    const events = [event("item/started", {}), event("provider/error", { message: "New" }), event("provider/error", { message: "Old" })];
    expect(summariseEvents(events)?.summary).toBe("New");
    expect(summariseEvents([event("item/started", {})])).toBeNull();
  });

  it("drops stack traces at each marker", () => {
    expect(clipDetail("TypeError: x is undefined\n    at run (a.js:1:1)\n    at main")).toBe("TypeError: x is undefined");
    expect(clipDetail("Failed.\nTraceback (most recent call last):\n  File x")).toBe("Failed.");
    expect(clipDetail("Crash. Stack trace: frame 1")).toBe("Crash.");
  });

  it("caps detail at 2000 characters with an ellipsis", () => {
    const clipped = clipDetail("y".repeat(5000));
    expect(clipped).toHaveLength(OUTCOME_DETAIL_MAX);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipDetail("short")).toBe("short");
  });
});
