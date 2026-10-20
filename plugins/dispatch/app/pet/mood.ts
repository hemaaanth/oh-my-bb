// The pet's face as one pure function of the call (SPEC §7.2). The pet
// component turns a face into avatar calls and holds each face long enough to
// be seen.

import type { PetMood } from "@/shared/constants.js";
import type { CallSnapshot, ToolWork } from "@/voice/call-store.js";

export type PetFace =
  | "sleep" | "wake" | "awake" | "listen" | "talk"
  | "look" | "read" | "research" | "type" | "send" | "work"
  | "happy" | "oops";

/** How long an outcome face stays after a tool ends. */
export const OUTCOME_MS = 1500;

const READ = new Set(["read_thread", "get_context", "get_thread_error", "list_threads", "list_live_threads"]);
const RESEARCH = new Set(["search_threads", "list_projects", "list_machines", "list_providers"]);
const LOOK = new Set(["focus_thread", "focus_threads", "set_pane", "manage_views", "show_diff"]);
const TYPE = new Set(["set_composer_text", "append_composer_text"]);
/** Tools whose success earns a cheer. Lookups do not. */
const CHEER = new Set(["send_to_thread", "start_thread", "rename_thread", "archive_thread"]);

export function toolFace(work: Pick<ToolWork, "tool" | "step">): PetFace {
  if (work.step === "switch") return "look";
  if (work.step === "type") return "type";
  if (work.step === "send") return "send";
  if (READ.has(work.tool)) return "read";
  if (RESEARCH.has(work.tool)) return "research";
  if (LOOK.has(work.tool)) return "look";
  if (TYPE.has(work.tool)) return "type";
  return "work";
}

export type PetSignals = Pick<CallSnapshot, "state" | "activity" | "work" | "outcome"> & { now: number };

/** Precedence: idle or connecting, then outcome, then speech, then tool work. */
export function petFace({ state, activity, work, outcome, now }: PetSignals): PetFace {
  if (state === "idle") return "sleep";
  if (state === "connecting") return "wake";
  if (outcome && now - outcome.at < OUTCOME_MS) {
    if (!outcome.ok) return "oops";
    if (CHEER.has(outcome.tool)) return "happy";
  }
  if (activity === "agent") return "talk";
  if (activity === "you") return "listen";
  if (work) return toolFace(work);
  return "awake";
}

/**
 * The shortest time a face stays on screen, so a quick tool still shows. SPEC
 * §7.2 bounds these to 250–600 ms. Sleep has no hold: a stopped call sleeps
 * at once. Outcomes also last OUTCOME_MS through `petFace`.
 */
export const FACE_HOLD_MS: Partial<Record<PetFace, number>> = {
  wake: 600,
  read: 600,
  look: 450,
  research: 500,
  type: 400,
  send: 500,
  work: 400,
  happy: 600,
  oops: 600,
};

/**
 * How long listening or talking stays after the voice stops when nothing else
 * replaces it, so short pauses in speech do not flicker the face.
 */
export const FACE_LINGER_MS: Partial<Record<PetFace, number>> = {
  listen: 400,
  talk: 300,
};

/** The word for each face in the hover label ("Juno · listening"). */
export const FACE_LABEL: Record<PetFace, PetMood> = {
  sleep: "asleep",
  wake: "waking",
  awake: "awake",
  listen: "listening",
  talk: "talking",
  look: "looking",
  read: "reading",
  research: "searching",
  type: "typing",
  send: "sending",
  work: "working",
  happy: "done",
  oops: "failed",
};

/** The face on screen: when it appeared, and when the signals last asked for it. */
export interface ShownFace {
  face: PetFace;
  since: number;
  seenAt: number;
}

/**
 * Pick the face to show now. A new face waits until the old one has had its
 * hold. Listening and talking linger after their cause ends while nothing
 * replaces them. Sleep always wins at once. `recheckIn` says when the answer
 * can change with no new signal.
 */
export function nextFace(shown: ShownFace, wanted: PetFace, now: number): { shown: ShownFace; recheckIn: number | null } {
  if (wanted === shown.face) return { shown: { ...shown, seenAt: now }, recheckIn: null };
  if (wanted !== "sleep") {
    const hold = (FACE_HOLD_MS[shown.face] ?? 0) - (now - shown.since);
    if (hold > 0) return { shown, recheckIn: hold };
    const linger = wanted === "awake" ? (FACE_LINGER_MS[shown.face] ?? 0) - (now - shown.seenAt) : 0;
    if (linger > 0) return { shown, recheckIn: linger };
  }
  return { shown: { face: wanted, since: now, seenAt: now }, recheckIn: null };
}
