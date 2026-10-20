// Who is on a call right now, for the console header and the sidebar badge.
// The server's live status gives the starting point. The `presence` channel
// pushes every change after that, and each push refreshes the live status.
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { CHANNELS } from "../../shared/constants.js";
import type { LiveStatus, Presence, RpcContract } from "../../shared/contract.js";
import { useLatest } from "../settings/data.js";

export type CallState = {
  live: boolean;
  muted: boolean;
  /** The id that stop and mute commands aim at. Null when only the server knows of the call. */
  nonce: string | null;
  startedAt: number | null;
  channel: LiveStatus["channel"];
};

const IDLE: CallState = { live: false, muted: false, nonce: null, startedAt: null, channel: null };
const ACTIVE = new Set<Presence["phase"]>(["connecting", "live", "muted"]);

export function useCallState(): CallState {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [owners, setOwners] = useState<ReadonlyMap<string, Presence>>(new Map());
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    rpcRef.current
      .call("liveStatus", {})
      .then((value) => mounted.current && setStatus(value))
      // A failed read leaves the last known state. Presence pushes still correct it.
      .catch(() => undefined);
  }, [rpcRef]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useRealtime(CHANNELS.presence, (payload) => {
    const presence = payload as Presence;
    setOwners((current) => {
      const next = new Map(current);
      if (ACTIVE.has(presence.phase)) next.set(presence.nonce, presence);
      else next.delete(presence.nonce);
      return next;
    });
    refresh();
  });

  const active = [...owners.values()];
  const owner = active.find((item) => item.phase !== "connecting") ?? active[0] ?? null;
  if (!status?.live && !owner) return IDLE;
  return {
    live: true,
    muted: owner?.phase === "muted",
    nonce: owner?.nonce ?? null,
    startedAt: status?.startedAt ?? owner?.startedAt ?? null,
    channel: status?.channel ?? null,
  };
}

export type ConsoleBadge = { text: string; tone?: "warning"; label: string };

/**
 * The sidebar badge for the Dispatch entry: a dot-sized "Live" while a call
 * runs. ConsoleSidebarAccessory renders it, because stable BB (SDK 0.6.49)
 * has no `experimental_useBadge` hook yet.
 */
export const useConsoleBadge = (): ConsoleBadge | null => {
  const state = useCallState();
  if (!state.live) return null;
  return state.muted ? { text: "Muted", tone: "warning", label: "Dispatch call is live and muted" } : { text: "Live", label: "Dispatch call is live" };
};
