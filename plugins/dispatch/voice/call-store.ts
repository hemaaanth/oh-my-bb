// What every surface knows about the one Dispatch call (SPEC §5.1). The call
// controller writes it; the pet, the call controls, the nav badge and the
// palette commands read it. A mirrored call (owned by another realm) shows
// here too, with `owner: "mirror"`.

import { createStore, useStore } from "./store.js";

export type CallState = "idle" | "connecting" | "live" | "muted";
/** Who is speaking, from transcript events. */
export type Activity = "you" | "agent" | "idle";
/** `run` is a plain tool call. The other steps belong to an on-screen send. */
export type WorkStep = "run" | "switch" | "type" | "send";

export interface ToolWork {
  tool: string;
  step: WorkStep;
  since: number;
}

export interface ToolOutcome {
  tool: string;
  ok: boolean;
  at: number;
}

export interface CallSnapshot {
  state: CallState;
  /** `self` when this realm runs the call, `mirror` when another realm does. */
  owner: "self" | "mirror" | null;
  nonce: string | null;
  callId: string | null;
  /** When the call went live, for elapsed time. */
  startedAt: number | null;
  activity: Activity;
  /** The operating system paused the microphone (SPEC §5.6). */
  micSuspended: boolean;
  work: ToolWork | null;
  outcome: ToolOutcome | null;
}

export const IDLE_CALL: CallSnapshot = {
  state: "idle",
  owner: null,
  nonce: null,
  callId: null,
  startedAt: null,
  activity: "idle",
  micSuspended: false,
  work: null,
  outcome: null,
};

export const callStore = createStore<CallSnapshot>(IDLE_CALL);

export function updateCall(patch: Partial<CallSnapshot>) {
  callStore.set((current) => ({ ...current, ...patch }));
}

export const useCall = () => useStore(callStore);

/** Live or muted, own or mirrored: the call controls and mute command apply. */
export const isCallActive = (call: Pick<CallSnapshot, "state">) => call.state === "live" || call.state === "muted";
