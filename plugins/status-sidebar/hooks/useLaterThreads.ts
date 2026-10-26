import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { LATER_CHANNEL } from "../shared";

export function useLaterThreads() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<readonly { threadId: string; placedAt: number }[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("listLater");
      setRows(result.rows);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime(LATER_CHANNEL, () => {
    void refresh();
  });

  const placedAtByThreadId = useMemo(
    () => new Map(rows.map((row) => [row.threadId, row.placedAt])),
    [rows],
  );

  const setLater = useCallback(
    async (threadId: string, later: boolean) => {
      setRows((current) => {
        const withoutThread = current.filter((row) => row.threadId !== threadId);
        return later
          ? [{ threadId, placedAt: Date.now() }, ...withoutThread]
          : withoutThread;
      });
      try {
        await rpc.call("setLater", { threadId, later });
      } catch {
        await refresh();
      }
    },
    [refresh, rpc],
  );

  return { status, placedAtByThreadId, setLater };
}
