import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { SandboxThreadStatus } from "../shared";

const STATUS_POLL_INTERVAL_MS = 30_000;
const MAX_THREADS_PER_CALL = 500;

export interface SandboxStatusCandidate {
  threadId: string;
  hostId: string | null;
}

export function useSandboxStatuses(
  candidates: readonly SandboxStatusCandidate[],
  refreshKey: string,
): ReadonlyMap<string, SandboxThreadStatus> {
  const rpc = useRpc<typeof rpcContract>();
  // Sorted, so activity reordering the thread list does not re-key the poll.
  const candidatesKey = JSON.stringify(
    [...candidates].sort((left, right) =>
      left.threadId.localeCompare(right.threadId) ||
      (left.hostId ?? "").localeCompare(right.hostId ?? ""),
    ),
  );
  const [statuses, setStatuses] = useState<readonly SandboxThreadStatus[]>([]);

  const loadStatuses = useCallback(async () => {
    const threads = (
      JSON.parse(candidatesKey) as SandboxStatusCandidate[]
    ).slice(0, MAX_THREADS_PER_CALL);
    if (threads.length === 0) return [];
    return (await rpc.call("listSandboxStatuses", { threads })).statuses;
  }, [rpc, candidatesKey]);

  useEffect(() => {
    let disposed = false;
    const load = () => {
      void loadStatuses()
        .then((next) => {
          // An unchanged poll keeps the old array, so the sidebar does not
          // re-render every row on each tick.
          if (!disposed) {
            setStatuses((current) =>
              JSON.stringify(current) === JSON.stringify(next) ? current : next,
            );
          }
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, STATUS_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadStatuses, refreshKey]);

  return useMemo(
    () => new Map(statuses.map((status) => [status.threadId, status])),
    [statuses],
  );
}
