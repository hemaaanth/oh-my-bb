import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import { sharedReads } from "../shared/shared-read";
import {
  extendTranscript,
  TRANSCRIPT_PAGE_SIZE,
} from "../shared/transcript-window";
import { message } from "../shared/ui";
import { channelPresence, MISSING_CHANNEL_ERROR } from "./channel-presence";

type RoomResult = PluginRpcResult<(typeof rpcContract)["room"]>;
export type ChannelData = Exclude<RoomResult, { missing: string }>;

/**
 * Refresh a channel side panel on realtime changes and reconnects, but only
 * after the channel's own room read confirms it still exists. A deleted
 * channel is never refetched.
 */
export function useChannelRefresh(id: string, refresh: () => void) {
  const latest = useRef(refresh);
  latest.current = refresh;
  const realtimeConnectionState = useRealtimeConnectionState();
  const previousRealtimeConnectionState = useRef(realtimeConnectionState);
  const refreshIfPresent = useCallback(() => {
    void channelPresence.stillExists(id).then((exists) => {
      if (exists) latest.current();
    });
  }, [id]);
  useRealtime("changed", refreshIfPresent);
  useEffect(() => {
    const previous = previousRealtimeConnectionState.current;
    previousRealtimeConnectionState.current = realtimeConnectionState;
    if (realtimeConnectionState === "connected" && previous !== "connected") refreshIfPresent();
  }, [realtimeConnectionState, refreshIfPresent]);
}

export function useChannel(id: string | null, poll = true) {
  const rpc = useRpc<typeof rpcContract>();
  const request = useRef(0);
  const realtimeConnectionState = useRealtimeConnectionState();
  const previousRealtimeConnectionState = useRef(realtimeConnectionState);
  const [loadingPage, setLoadingPage] = useState(false);
  const pageRequest = useRef<symbol | null>(null);
  const followingLatest = useRef(true);
  const currentData = useRef<ChannelData | null>(null);
  const [data, setData] = useState<ChannelData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showMissing = useCallback(() => {
    currentData.current = null;
    setData(null);
    setError(MISSING_CHANNEL_ERROR);
  }, []);

  const load = useCallback((): Promise<void> => {
    if (!id) {
      setData(null);
      return Promise.resolve();
    }
    // The server already said this channel is gone; don't ask again.
    if (channelPresence.isMissing(id)) {
      showMissing();
      return Promise.resolve();
    }
    if (pageRequest.current) return Promise.resolve();
    const sequence = ++request.current;
    const previous = currentData.current?.room.id === id ? currentData.current : null;
    const options = {
      id,
      ...(previous?.messages.length && !followingLatest.current ? { start: previous.messages[0]!.id } : {}),
      limit: Math.max(TRANSCRIPT_PAGE_SIZE, previous?.messages.length ?? 0),
    };
    const read = sharedReads.read(`channel:${JSON.stringify(options)}`, () => rpc.call("room", options)).then(
      (next) => {
        if ("missing" in next) channelPresence.markMissing(id);
        return next;
      },
    );
    channelPresence.track(id, read);
    return read.then(
      (next) => {
        if (sequence !== request.current) return;
        if ("missing" in next) {
          showMissing();
          return;
        }
        currentData.current = next;
        setData(next);
        setError(null);
      },
      (cause) => {
        if (sequence === request.current) {
          const detail = message(cause);
          setError(detail);
          if (detail.includes(MISSING_CHANNEL_ERROR)) setData(null);
        }
      },
    );
  }, [id, rpc, showMissing]);

  useEffect(() => {
    currentData.current = null;
    followingLatest.current = true;
    pageRequest.current = null;
    setLoadingPage(false);
    setData(null);
    void load();
    return () => { request.current += 1; };
  }, [load]);

  useRealtime("changed", (event) => {
    sharedReads.invalidate(event && typeof event === "object" && "revision" in event ? event.revision : undefined);
    void load();
  });

  useEffect(() => {
    const previous = previousRealtimeConnectionState.current;
    previousRealtimeConnectionState.current = realtimeConnectionState;
    if (realtimeConnectionState === "connected" && previous !== "connected") void load();
  }, [load, realtimeConnectionState]);

  const hasActiveWork = !!data && (
    data.jobs.some((job) => ["queued", "dispatching", "running"].includes(job.status)) ||
    data.runs.some((run) => ["queued", "running"].includes(run.status))
  );
  const missing = !data && error === MISSING_CHANNEL_ERROR;
  useEffect(() => {
    if (!poll || !id || missing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (disposed) return;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(refresh, 30_000);
        return;
      }
      const schedule = () => {
        if (!disposed) timer = setTimeout(refresh, hasActiveWork ? 2_500 : 15_000);
      };
      void load().then(schedule, schedule);
    };
    timer = setTimeout(refresh, hasActiveWork ? 2_500 : 15_000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [hasActiveWork, id, load, missing, poll]);

  const loadPage = useCallback(async (direction: "older" | "newer" | "around", target?: string) => {
    const previous = currentData.current;
    if (!id || previous?.room.id !== id || pageRequest.current) return;
    if ((direction === "older" && !previous.hasOlder) || (direction === "newer" && !previous.hasNewer)) return;
    const token = Symbol();
    pageRequest.current = token;
    const sequence = ++request.current;
    followingLatest.current = false;
    setLoadingPage(true);
    try {
      const page = await rpc.call("transcript", {
        id,
        ...(direction === "older" ? { before: previous.messages[0]!.id } : {}),
        ...(direction === "newer" ? { after: previous.messages.at(-1)!.id } : {}),
        ...(direction === "around" && target ? { around: target } : {}),
      });
      if (sequence !== request.current) return;
      if ("missing" in page) {
        if (page.missing === "message") throw new Error("Message not found in this channel.");
        channelPresence.markMissing(id);
        showMissing();
        return;
      }
      const next = {
        ...previous,
        ...(direction === "older" || direction === "newer" ? extendTranscript(previous, page, direction) : page),
      };
      currentData.current = next;
      setData(next);
    } finally {
      if (pageRequest.current === token) {
        pageRequest.current = null;
        setLoadingPage(false);
      }
    }
  }, [id, rpc, showMissing]);

  const loadLatest = useCallback(() => {
    request.current += 1;
    pageRequest.current = null;
    setLoadingPage(false);
    followingLatest.current = true;
    return load();
  }, [load]);

  return {
    data: data?.room.id === id ? data : null,
    error,
    load,
    loadOlder: () => loadPage("older"),
    loadNewer: () => loadPage("newer"),
    loadAround: (target: string) => loadPage("around", target),
    loadLatest,
    followingLatest,
    loadingPage,
  };
}
