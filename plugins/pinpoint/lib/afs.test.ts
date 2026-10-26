import { describe, expect, it } from "vitest";

import {
  captureSchema,
  createAfsAnnotation,
  guardWorkflowAction,
  intentOf,
  isAgentInboxState,
  isUserInboxState,
  severityOf,
  workflowStateFor,
  workflowStates,
} from "./afs";

describe("Pinpoint workflow state projection", () => {
  it("projects waiting-input straight through, independent of routing", () => {
    expect(workflowStateFor("waiting-input", "staged")).toBe("waiting-input");
    expect(workflowStateFor("waiting-input", "assigned")).toBe("waiting-input");
  });

  it("refines open by routing into open vs dispatched", () => {
    expect(workflowStateFor("open", "staged")).toBe("open");
    expect(workflowStateFor("open", "sending")).toBe("dispatched");
    expect(workflowStateFor("open", "assigned")).toBe("dispatched");
  });
});

describe("Pinpoint workflow transition guards", () => {
  it("allows resolve only from the agent inbox (open, dispatched)", () => {
    expect(guardWorkflowAction("open", "resolve")).toEqual({
      ok: true,
      to: "ready",
    });
    expect(guardWorkflowAction("dispatched", "resolve")).toEqual({
      ok: true,
      to: "ready",
    });
    for (const from of ["ready", "waiting-input", "approved", "dismissed"] as const) {
      expect(guardWorkflowAction(from, "resolve").ok).toBe(false);
    }
  });

  it("moves dispatched to waiting-input on question, but never ready", () => {
    expect(guardWorkflowAction("dispatched", "question")).toEqual({
      ok: true,
      to: "waiting-input",
    });
    expect(guardWorkflowAction("ready", "question").ok).toBe(false);
    expect(guardWorkflowAction("approved", "question").ok).toBe(false);
    expect(guardWorkflowAction("dismissed", "question").ok).toBe(false);
  });

  it("allows approve only from ready", () => {
    expect(guardWorkflowAction("ready", "approve")).toEqual({
      ok: true,
      to: "approved",
    });
    for (const from of ["open", "dispatched", "waiting-input", "approved", "dismissed"] as const) {
      expect(guardWorkflowAction(from, "approve").ok).toBe(false);
    }
  });

  it("never dismisses an already-terminal item", () => {
    expect(guardWorkflowAction("dispatched", "dismiss")).toEqual({
      ok: true,
      to: "dismissed",
    });
    expect(guardWorkflowAction("approved", "dismiss").ok).toBe(false);
    expect(guardWorkflowAction("dismissed", "dismiss").ok).toBe(false);
  });

  it("allows reopen (feedback / reply) from every state, landing open", () => {
    for (const from of workflowStates) {
      expect(guardWorkflowAction(from, "reopen")).toEqual({
        ok: true,
        to: "open",
      });
    }
  });

  it("names the invalid transition in the error", () => {
    const result = guardWorkflowAction("dismissed", "resolve");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('"dismissed"');
  });
});

describe("Pinpoint inbox split", () => {
  it("counts waiting-input in the user inbox, not the agent inbox", () => {
    expect(isUserInboxState("waiting-input")).toBe(true);
    expect(isAgentInboxState("waiting-input")).toBe(false);
  });

  it("keeps open/dispatched with the agent and ready with the user", () => {
    expect(isAgentInboxState("open")).toBe(true);
    expect(isAgentInboxState("dispatched")).toBe(true);
    expect(isUserInboxState("ready")).toBe(true);
    expect(isAgentInboxState("ready")).toBe(false);
    expect(isUserInboxState("approved")).toBe(false);
    expect(isUserInboxState("dismissed")).toBe(false);
  });
});

describe("Pinpoint capture schema rollout tolerance", () => {
  it("accepts an old-picker payload carrying only the required core fields", () => {
    // Old pickers (previous protocol) send none of the newer optional fields —
    // they must keep capturing during a rollout.
    const result = captureSchema.safeParse({
      threadId: "th_1",
      url: "https://sandbox.example.test/page",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.comment).toBe("");
  });

  it("tolerates unknown extra fields instead of failing the whole capture", () => {
    // A newer picker may report fields this server version doesn't know yet.
    const result = captureSchema.safeParse({
      threadId: "th_1",
      comment: "check this",
      url: "https://sandbox.example.test/page",
      someFutureField: { nested: true },
      anotherNewThing: "value",
    });
    expect(result.success).toBe(true);
  });

  it("still rejects payloads missing required core fields", () => {
    expect(captureSchema.safeParse({ threadId: "th_1" }).success).toBe(false);
    expect(
      captureSchema.safeParse({ url: "https://x.test/" }).success,
    ).toBe(false);
  });
});

describe("Pinpoint capture enrichment mapping", () => {
  const base = {
    threadId: "th_1",
    comment: "tweak this",
    url: "https://app.example.test/page",
  };

  it("maps enriched capture fields through to the annotation", () => {
    const annotation = createAfsAnnotation(
      "pp_abc123",
      captureSchema.parse({
        ...base,
        clientId: "pp_abc123",
        computedStyles: "display:flex; color:rgb(10, 20, 30)",
        accessibility: 'role=button name="Save" aria-expanded=false',
        nearbyElements: 'div.header "Title" | main',
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
        intent: "question",
        severity: "important",
      }),
      1000,
    );
    expect(annotation.computedStyles).toBe(
      "display:flex; color:rgb(10, 20, 30)",
    );
    expect(annotation.accessibility).toBe(
      'role=button name="Save" aria-expanded=false',
    );
    expect(annotation.nearbyElements).toBe('div.header "Title" | main');
    expect(annotation.boundingBox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(annotation.intent).toBe("question");
    expect(annotation.severity).toBe("important");
    // The client id was adopted as the row id → the page stamp is durable.
    expect(annotation.pinpoint.anchored).toBe(true);
  });

  it("maps text-edit kind and old/new text through to the annotation, capped at 500 chars", () => {
    const annotation = createAfsAnnotation(
      "pp_ted1",
      captureSchema.parse({
        ...base,
        clientId: "pp_ted1",
        kind: "text-edit",
        textOld: "Welcome to the beta",
        textNew: "Welcome to the workspace",
        intent: "change",
      }),
      1000,
    );
    expect(annotation.kind).toBe("text-edit");
    expect(annotation.textOld).toBe("Welcome to the beta");
    expect(annotation.textNew).toBe("Welcome to the workspace");
    expect(annotation.intent).toBe("change");

    const long = "x".repeat(900);
    const capped = createAfsAnnotation(
      "pp_ted2",
      captureSchema.parse({
        ...base,
        kind: "text-edit",
        textOld: long,
        textNew: long,
      }),
      1000,
    );
    expect(capped.textOld).toHaveLength(500);
    expect(capped.textNew).toHaveLength(500);
  });

  it("defaults kind to feedback and leaves textOld/textNew unset for ordinary picks", () => {
    const annotation = createAfsAnnotation(
      "pp_plain1",
      captureSchema.parse(base),
      1000,
    );
    expect(annotation.kind).toBe("feedback");
    expect(annotation.textOld).toBeUndefined();
    expect(annotation.textNew).toBeUndefined();
  });

  it("leaves intent/severity unset in storage and defaults them at read time", () => {
    const annotation = createAfsAnnotation(
      "pp_srv1",
      captureSchema.parse(base),
      1000,
    );
    expect(annotation.intent).toBeUndefined();
    expect(annotation.severity).toBeUndefined();
    expect(intentOf(annotation)).toBe("fix");
    expect(intentOf({ intent: "change" })).toBe("fix");
    expect(severityOf(annotation)).toBe("suggestion");
    expect(intentOf({ intent: "approve" })).toBe("approve");
    expect(severityOf({ severity: "blocking" })).toBe("blocking");
  });

  it("marks anchored only when the client id was adopted as the row id", () => {
    const noClient = createAfsAnnotation(
      "pp_srv2",
      captureSchema.parse(base),
      1000,
    );
    expect(noClient.pinpoint.anchored ?? false).toBe(false);

    // Collision fallback: the server generated its own id, so the client-side
    // data-pp stamp doesn't match the row and must not be advertised.
    const collided = createAfsAnnotation(
      "pp_srv3",
      captureSchema.parse({ ...base, clientId: "pp_other7" }),
      1000,
    );
    expect(collided.pinpoint.anchored ?? false).toBe(false);
  });

  it("preserves the click offset and screenshot preference for marker placement", () => {
    const annotation = createAfsAnnotation(
      "pp_position1",
      captureSchema.parse({
        threadId: "thr_1",
        comment: "Pin this exact word",
        url: "https://example.com",
        x: 320,
        y: 240,
        anchorOffsetX: 85,
        anchorOffsetY: 31,
        screenshotExpected: false,
      }),
      1,
    );

    expect(annotation.pinpoint.anchorOffset).toEqual({ x: 85, y: 31 });
    expect(annotation.pinpoint.screenshotExpected).toBe(false);
  });
});
