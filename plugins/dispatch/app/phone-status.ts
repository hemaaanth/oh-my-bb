// A phone attempt belongs to this browser realm. Server live status takes over
// when the SIP session is accepted. Nothing here stores a number or provider id.
import { createStore } from "../voice/store.js";

export const PHONE_WAIT_MS = 120_000;
export const ENDED_STATUS_MS = 8_000;
export type PhoneAttempt = { phase: "dialing" | "ringing" | "failed" | "unconfirmed"; at: number };
export const phoneAttempt = createStore<PhoneAttempt | null>(null);

/** Provider error bodies can contain the destination number or a Twilio SID. */
export function privateCallText(text: string): string {
  return text.replace(/\b(?:CA|AC|PN|CF|RE)[a-f0-9]{32}\b/gi, "[call reference]")
    .replace(/\+\d(?:[ ().-]*\d){7,14}\b/g, (number) => `•••${number.replace(/\D/g, "").slice(-4)}`);
}
