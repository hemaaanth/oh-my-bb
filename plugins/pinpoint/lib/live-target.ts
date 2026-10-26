// Lease timing for a thread's live Pinpoint target (the URL the open panel
// is showing, read by Session Share's Review links). The mounted panel renews
// the lease on an interval and clears it on unmount; the TTL only matters
// when cleanup never runs (a crashed or force-closed window). The TTL spans
// several heartbeats so a delayed renewal never drops a live panel.
export const LIVE_TARGET_HEARTBEAT_MS = 20_000;
export const LIVE_TARGET_TTL_MS = 60_000;
