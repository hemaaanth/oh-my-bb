import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  CHANNELS_CHANGED_CHANNEL,
  type ChannelSummary,
  type ChannelsChangedSignal,
} from "../shared";

function signalChannels(
  payload: unknown,
): { channels: ChannelSummary[] | null } | null {
  if (!payload || typeof payload !== "object" || !("channels" in payload)) {
    return null;
  }
  const { channels } = payload as ChannelsChangedSignal;
  if (channels === null) return { channels: null };
  return Array.isArray(channels) ? { channels: [...channels] } : null;
}

/**
 * Channel rows load once on mount, then arrive in the server's change signal,
 * so a channel update costs no RPC per window. A signal without rows (an older
 * server) or a reconnect, which may have dropped signals, triggers one reload.
 */
export function useChannels() {
  const rpc = useRpc<typeof rpcContract>();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const request = useRef(0);
  const inFlight = useRef(false);
  const reloadQueued = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) {
      reloadQueued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        reloadQueued.current = false;
        const sequence = ++request.current;
        try {
          const next = await rpc.call("listChannels", null);
          if (sequence === request.current) setChannels(next);
        } catch {
          if (sequence === request.current) setChannels(null);
        }
      } while (reloadQueued.current);
    } finally {
      inFlight.current = false;
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
      reloadQueued.current = false;
    };
  }, [load]);

  useRealtime(CHANNELS_CHANGED_CHANNEL, (payload) => {
    const signal = signalChannels(payload);
    if (!signal) {
      void load();
      return;
    }
    // Rows pushed now supersede a reload still in flight.
    request.current += 1;
    reloadQueued.current = false;
    setChannels(signal.channels);
  });

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (connection === "connected" && previous === "reconnecting") void load();
  }, [connection, load]);

  return channels;
}
