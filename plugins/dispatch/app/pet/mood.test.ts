import { describe, expect, it } from "vitest";
import { FACE_HOLD_MS, FACE_LINGER_MS, nextFace, OUTCOME_MS, petFace, toolFace, type PetSignals } from "./mood.js";

const base: PetSignals = { state: "live", activity: "idle", work: null, outcome: null, now: 10_000 };

describe("petFace", () => {
  it("sleeps with no call and wakes while connecting", () => {
    expect(petFace({ ...base, state: "idle" })).toBe("sleep");
    expect(petFace({ ...base, state: "connecting" })).toBe("wake");
    expect(petFace(base)).toBe("awake");
  });

  it("follows who is speaking, and the agent beats the user", () => {
    expect(petFace({ ...base, activity: "you" })).toBe("listen");
    expect(petFace({ ...base, activity: "agent" })).toBe("talk");
    expect(petFace({ ...base, state: "muted", activity: "agent" })).toBe("talk");
  });

  it("puts speech above tool work", () => {
    const work = { tool: "read_thread", step: "run" as const, since: 0 };
    expect(petFace({ ...base, work })).toBe("read");
    expect(petFace({ ...base, activity: "agent", work })).toBe("talk");
    expect(petFace({ ...base, activity: "you", work })).toBe("listen");
  });

  it("shows outcomes above speech for 1.5 s", () => {
    const sent = { tool: "send_to_thread", ok: true, at: base.now - 100 };
    expect(petFace({ ...base, outcome: sent })).toBe("happy");
    expect(petFace({ ...base, activity: "agent", outcome: sent })).toBe("happy");
    expect(petFace({ ...base, outcome: { ...sent, ok: false } })).toBe("oops");
    expect(petFace({ ...base, outcome: { ...sent, at: base.now - OUTCOME_MS } })).toBe("awake");
    // A lookup that worked earns no cheer.
    expect(petFace({ ...base, outcome: { tool: "list_threads", ok: true, at: base.now } })).toBe("awake");
    for (const tool of ["start_thread", "rename_thread", "archive_thread"]) {
      expect(petFace({ ...base, outcome: { tool, ok: true, at: base.now } })).toBe("happy");
    }
  });
});

describe("toolFace", () => {
  const face = (tool: string) => toolFace({ tool, step: "run" });

  it("maps each tool family", () => {
    for (const tool of ["focus_thread", "focus_threads", "set_pane", "show_diff", "manage_views"]) expect(face(tool)).toBe("look");
    for (const tool of ["read_thread", "get_context", "get_thread_error", "list_threads"]) expect(face(tool)).toBe("read");
    for (const tool of ["search_threads", "list_projects", "list_machines", "list_providers"]) expect(face(tool)).toBe("research");
    for (const tool of ["set_composer_text", "append_composer_text"]) expect(face(tool)).toBe("type");
    for (const tool of ["start_thread", "stop_thread", "archive_thread", "rename_thread", "something_new"]) expect(face(tool)).toBe("work");
  });

  it("lets on-screen steps override the tool", () => {
    expect(toolFace({ tool: "send_to_thread", step: "switch" })).toBe("look");
    expect(toolFace({ tool: "send_to_thread", step: "type" })).toBe("type");
    expect(toolFace({ tool: "send_to_thread", step: "send" })).toBe("send");
  });
});

describe("nextFace", () => {
  it("keeps every hold and linger inside 250–600 ms", () => {
    for (const ms of [...Object.values(FACE_HOLD_MS), ...Object.values(FACE_LINGER_MS)]) {
      expect(ms).toBeGreaterThanOrEqual(250);
      expect(ms).toBeLessThanOrEqual(600);
    }
  });

  it("holds a quick tool face for its minimum", () => {
    const shown = { face: "read" as const, since: 0, seenAt: 0 };
    const hold = FACE_HOLD_MS.read!;
    expect(nextFace(shown, "awake", hold - 100)).toEqual({ shown, recheckIn: 100 });
    expect(nextFace(shown, "awake", hold).shown.face).toBe("awake");
  });

  it("lets talking linger after the voice stops, but not over a new face", () => {
    const linger = FACE_LINGER_MS.talk!;
    const talking = nextFace({ face: "talk", since: 0, seenAt: 0 }, "talk", 5000).shown;
    expect(nextFace(talking, "awake", 5000 + linger - 50)).toEqual({ shown: talking, recheckIn: 50 });
    expect(nextFace(talking, "awake", 5000 + linger).shown.face).toBe("awake");
    expect(nextFace(talking, "read", 5010).shown.face).toBe("read");
  });

  it("falls asleep at once", () => {
    expect(nextFace({ face: "read", since: 0, seenAt: 0 }, "sleep", 1).shown.face).toBe("sleep");
  });
});
