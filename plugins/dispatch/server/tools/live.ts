// Live threads, like BB's live sidebar section (SPEC §11.6 list_live_threads).
// Used by the tool, `get_context` on the phone, and `bb dispatch live`. Owned by P1.
import type { ServerContext } from "../context.js";

type Sdk = ServerContext["bb"]["sdk"];
export type ThreadListRow = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

export const LIVE_THREADS_MAX = 200;
/** Idle or failed threads updated within this window count as recently finished. */
export const RECENT_WINDOW_MS = 30 * 60 * 1000;
/** How many open threads to read before filtering. */
const SCAN_LIMIT = 1000;

export type LiveThreadStatus =
  | "active"
  | "starting"
  | "stopping"
  | "provisioning"
  | "waiting-for-host"
  | "host-reconnecting"
  | "recently-finished";

export type LiveThread = {
  id: string;
  title: string;
  status: LiveThreadStatus;
  projectId: string;
  projectName: string;
  machineName: string;
  /** When the thread last changed. */
  since: number;
  /** Human relative time, for example "4 minutes ago". */
  ago: string;
};

export const threadTitle = (row: { title: string | null; titleFallback: string | null }): string =>
  row.title?.trim() || row.titleFallback?.trim() || "Untitled thread";

/** "just now", "1 minute ago", "3 hours ago", "2 days ago". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}

/** The live status for a row, or null when it is not live. */
export function liveStatusOf(row: ThreadListRow, hostConnected: boolean, now: number): LiveThreadStatus | null {
  const display = row.runtime.displayStatus;
  if (display === "provisioning" || display === "waiting-for-host") return display;
  const status = display === "pending" ? "starting" : display;
  if (status === "active" || status === "starting" || status === "stopping") {
    return hostConnected ? status : "host-reconnecting";
  }
  if ((status === "idle" || status === "error") && now - row.updatedAt <= RECENT_WINDOW_MS) return "recently-finished";
  return null;
}

/** Live threads first, then recently finished; newest change first in each group. */
export async function listLiveThreads(ctx: ServerContext, now: number = Date.now()): Promise<LiveThread[]> {
  const sdk = ctx.bb.sdk;
  const [rows, projects, hosts] = await Promise.all([
    sdk.threads.list({ archived: false, limit: SCAN_LIMIT }),
    sdk.projects.list(),
    sdk.hosts.list(),
  ]);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  const live: LiveThread[] = [];
  for (const row of rows) {
    if (row.visibility === "hidden") continue;
    const host = row.environmentHostId ? hostsById.get(row.environmentHostId) : undefined;
    const status = liveStatusOf(row, host ? host.status === "connected" : true, now);
    if (!status) continue;
    live.push({
      id: row.id,
      title: threadTitle(row),
      status,
      projectId: row.projectId,
      projectName: projectNames.get(row.projectId) ?? "Unknown project",
      machineName: host?.name ?? row.environmentName ?? "Unknown machine",
      since: row.updatedAt,
      ago: relativeTime(row.updatedAt, now),
    });
  }
  const group = (thread: LiveThread) => (thread.status === "recently-finished" ? 1 : 0);
  live.sort((a, b) => group(a) - group(b) || b.since - a.since);
  return live.slice(0, LIVE_THREADS_MAX);
}
