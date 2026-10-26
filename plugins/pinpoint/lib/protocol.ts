// Picker <-> panel protocol versioning.
//
// The injected picker (PICKER_JS in server.ts) can outlive a plugin update:
// live and parked iframe sessions (lib/session-registry.ts) keep running
// whatever picker code was injected when the page loaded. The picker reports
// this version in its `ready` message; the panel compares it against its own
// copy and reloads a stale session once so both sides speak the same protocol.
//
// Bump this when the message shapes change incompatibly or a parked picker
// must reload to gain new interaction behavior. Purely additive optional
// capture fields do not need a bump when old and new picker behavior remains
// interchangeable.
export const PICKER_PROTOCOL_VERSION = 7;
export const PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups";
export const GUEST_PREVIEW_ISOLATION_VERSION = 1;

export type ProtocolDecision = "ok" | "reload" | "block";

/**
 * What the panel should do when a picker announces itself via `ready`.
 *
 *  - Current (or newer) version: proceed — never reload a matching session.
 *  - Missing/older version, not yet reloaded: reload the session once so it
 *    picks up the freshly injected picker.
 *  - Missing/older version AGAIN after a reload: something is pinning the old
 *    script (cache, frozen sandbox) — block with a notice instead of looping.
 *
 * A newer-than-ours version is tolerated ("ok"): reloading can't downgrade
 * the injected script, and additive fields are optional end-to-end.
 */
export function decideProtocolAction(
  reportedVersion: number | undefined,
  alreadyReloaded: boolean,
): ProtocolDecision {
  if (
    typeof reportedVersion === "number" &&
    reportedVersion >= PICKER_PROTOCOL_VERSION
  )
    return "ok";
  return alreadyReloaded ? "block" : "reload";
}
