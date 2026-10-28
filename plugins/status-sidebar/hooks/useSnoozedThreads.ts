import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { SNOOZE_CHANNEL } from "../shared";

export function useSnoozedThreads() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<readonly { threadId: string; untilAt: number }[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [now, setNow] = useState(Date.now);
  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("listSnoozed");
      setRows(result.rows);
      setStatus("ready");
    } catch { setStatus("error"); }
  }, [rpc]);
  useEffect(() => { void refresh(); }, [refresh]);
  useRealtime(SNOOZE_CHANNEL, () => { void refresh(); });
  useEffect(() => {
    const next = Math.min(...rows.filter((row) => row.untilAt > now).map((row) => row.untilAt));
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - now, 0) + 1, 60_000));
    return () => window.clearTimeout(timer);
  }, [rows, now]);
  const untilByThreadId = useMemo(() => new Map(rows.filter((row) => row.untilAt > now).map((row) => [row.threadId, row.untilAt])), [rows, now]);
  const setSnoozed = useCallback(async (threadId: string, untilAt: number | null) => {
    setRows((current) => [...current.filter((row) => row.threadId !== threadId), ...(untilAt ? [{ threadId, untilAt }] : [])]);
    try { await rpc.call("setSnoozed", { threadId, untilAt }); }
    catch { await refresh(); }
  }, [refresh, rpc]);
  return { status, untilByThreadId, setSnoozed };
}
