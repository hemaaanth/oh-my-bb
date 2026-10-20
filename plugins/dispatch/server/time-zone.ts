// Time zones for the caller. The app sends its zone with the device profile.
// Phone calls send none, so they use the homeTimeZone preference, and an
// empty preference means the server's zone.
import type { DeviceProfile } from "../shared/contract.js";

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** True for a zone Intl knows. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The homeTimeZone preference, or the server's zone. */
export const homeZone = (homeTimeZone: string): string => (isTimeZone(homeTimeZone) ? homeTimeZone : serverTimeZone());

/** The caller's zone: the device's own, else the home zone. */
export function callerTimeZone(device: Pick<DeviceProfile, "timeZone"> | null | undefined, homeTimeZone: string): string {
  return isTimeZone(device?.timeZone) ? device.timeZone : homeZone(homeTimeZone);
}

/** "Tuesday, October 20, 2026 at 3:05 PM" in `timeZone`. */
export function formatWhen(ms: number | Date, timeZone: string): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "3:05 PM" in `timeZone`. */
export const formatClock = (ms: number, timeZone: string): string =>
  new Date(ms).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
