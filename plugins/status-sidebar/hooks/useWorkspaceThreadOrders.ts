import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { THREAD_ORDER_CHANNEL } from "../shared";

export const GENERAL_THREAD_ORDER_SCOPE = "__general__";
export const STATUS_ALL_THREAD_ORDER_SCOPE = "__status_all__";

export function useWorkspaceThreadOrders(workspaceIds: readonly string[]) {
  const rpc = useRpc<typeof rpcContract>();
  const [threadIdsByWorkspace, setThreadIdsByWorkspace] = useState<
    ReadonlyMap<string, readonly string[]>
  >(() => new Map());
  const refreshGeneration = useRef(0);
  const mounted = useRef(true);
  const scopeKey = [
    ...workspaceIds,
    GENERAL_THREAD_ORDER_SCOPE,
    STATUS_ALL_THREAD_ORDER_SCOPE,
  ].join("\0");
  const scopes = useMemo(() => scopeKey.split("\0"), [scopeKey]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const rows = await Promise.all(
        scopes.map(async (workspaceId) => ({
          workspaceId,
          threadIds: (await rpc.call("listThreadOrder", { workspaceId }))
            .threadIds,
        })),
      );
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setThreadIdsByWorkspace(
        new Map(rows.map(({ workspaceId, threadIds }) => [workspaceId, threadIds])),
      );
    } catch {
      // Ordering is an enhancement; natural status/recency sorting remains.
    }
  }, [rpc, scopes]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime(THREAD_ORDER_CHANNEL, () => {
    void refresh();
  });

  const indexByWorkspace = useMemo(
    () =>
      new Map(
        [...threadIdsByWorkspace].map(([workspaceId, threadIds]) => [
          workspaceId,
          new Map(threadIds.map((threadId, index) => [threadId, index])),
        ]),
      ),
    [threadIdsByWorkspace],
  );

  const setOrder = useCallback(
    async (workspaceId: string, threadIds: readonly string[]) => {
      setThreadIdsByWorkspace((current) =>
        new Map(current).set(workspaceId, [...threadIds]),
      );
      try {
        await rpc.call("setThreadOrder", {
          workspaceId,
          threadIds: [...threadIds],
        });
      } catch {
        await refresh();
      }
    },
    [refresh, rpc],
  );

  return { indexByWorkspace, setOrder };
}
