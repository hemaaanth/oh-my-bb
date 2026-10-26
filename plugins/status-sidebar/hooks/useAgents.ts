import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { AGENTS_CHANGED_CHANNEL, type AgentSidebarSnapshot } from "../shared";

export function useAgents() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<AgentSidebarSnapshot | null>(null);
  const request = useRef(0);
  const load = useCallback(async (fresh = false) => {
    const sequence = ++request.current;
    try {
      const next = await rpc.call("listAgents", { fresh });
      if (sequence === request.current) setSnapshot(next);
    } catch {
      if (sequence === request.current) setSnapshot(null);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]);
  useRealtime(AGENTS_CHANGED_CHANNEL, (payload) => {
    if (!payload || typeof payload !== "object" || !("agents" in payload)
      || !("excludedThreadIds" in payload)
      || !Array.isArray(payload.agents) || !Array.isArray(payload.excludedThreadIds)) {
      void load(true);
      return;
    }
    request.current += 1;
    setSnapshot(payload as AgentSidebarSnapshot);
  });
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (connection === "connected" && previous === "reconnecting") void load(true);
  }, [connection, load]);
  return snapshot;
}
