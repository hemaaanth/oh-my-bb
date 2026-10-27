import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { ChannelAgent, Room } from "../../server/channels/contract";
import type { rpcContract } from "../../server/contract";
import { sharedReads } from "../shared/shared-read";
import { message } from "../shared/ui";

export type ChannelRoster = {
  agents: ChannelAgent[];
  rooms: Room[];
  activeRoomIds: string[];
};

const emptyRoster: ChannelRoster = { agents: [], rooms: [], activeRoomIds: [] };

export function useRoster(reconcile = false) {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [data, setData] = useState<ChannelRoster>(emptyRoster);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(() => {
    const sequence = ++request.current;
    return sharedReads.read("channel-roster", () => rpc.call("channelsList", null)).then(
      (next) => {
        if (sequence === request.current) {
          setData(next);
          setError(null);
        }
      },
      (cause) => {
        if (sequence === request.current) setError(message(cause));
      },
    );
  }, [rpc]);

  useEffect(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]);

  useRealtime("changed", (event) => {
    sharedReads.invalidate(event && typeof event === "object" && "revision" in event ? event.revision : undefined);
    void load();
  });

  useEffect(() => {
    if (reconcile && connectionState === "connected") void load();
  }, [reconcile, connectionState, load]);

  const hasActiveWork = data.activeRoomIds.length > 0;
  useEffect(() => {
    if (!reconcile) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    const timer = window.setInterval(refresh, hasActiveWork ? 2_500 : 15_000);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reconcile, hasActiveWork, load]);

  return { ...data, error, load };
}
