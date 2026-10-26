import { describe, expect, it } from "vitest";

import { classifyDelivery, type DeliveryEvent } from "./delivery-check";

function item(type: string, text?: string): DeliveryEvent {
  return { type: "item/completed", data: { item: { type, ...(text ? { text } : {}) } } };
}

const TURN_STARTED: DeliveryEvent = { type: "turn/started" };
const TURN_COMPLETED: DeliveryEvent = { type: "turn/completed" };

describe("classifyDelivery", () => {
  it("reads a rate-limited turn as stalled and keeps the provider's words", () => {
    // The exact shape a Codex-backed child emits when its account is out of
    // quota: a full turn, marked completed, that changed nothing.
    const verdict = classifyDelivery([
      TURN_STARTED,
      { type: "turn/input/accepted" },
      item("agentMessage", ""),
      {
        type: "item/agentMessage/delta",
        data: { item: null },
      },
      item(
        "agentMessage",
        "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
      ),
      TURN_COMPLETED,
    ]);
    expect(verdict.kind).toBe("stalled");
    expect(verdict.kind === "stalled" && verdict.detail).toContain(
      "usage limit has been reached",
    );
  });

  it("reads a turn that touched the repo as acted", () => {
    expect(
      classifyDelivery([
        TURN_STARTED,
        item("reasoning"),
        item("search"),
        item("fileChange"),
        item("agentMessage", "Done."),
        TURN_COMPLETED,
      ]),
    ).toEqual({ kind: "acted" });
  });

  it("treats an item type it has never seen as work", () => {
    // Deliberate fail-open: a false stall would pull an item away from an
    // agent that is mid-edit.
    expect(
      classifyDelivery([TURN_STARTED, item("someFutureToolKind")]),
    ).toEqual({ kind: "acted" });
  });

  it("reads talking and thinking alone as stalled", () => {
    const verdict = classifyDelivery([
      TURN_STARTED,
      item("reasoning"),
      item("agentMessage", "I'll take a look at that shortly."),
      TURN_COMPLETED,
    ]);
    expect(verdict.kind).toBe("stalled");
  });

  it("reports a thread that never ran at all", () => {
    const verdict = classifyDelivery([]);
    expect(verdict).toEqual({
      kind: "stalled",
      detail: "the thread never started a turn on this item",
    });
  });

  it("flattens and truncates a long stall message", () => {
    const verdict = classifyDelivery([
      TURN_STARTED,
      item("agentMessage", `line one\n\n  ${"x".repeat(600)}`),
    ]);
    expect(verdict.kind === "stalled" && verdict.detail).toContain("line one x");
    expect(verdict.kind === "stalled" && verdict.detail.length).toBeLessThan(
      460,
    );
  });
});
