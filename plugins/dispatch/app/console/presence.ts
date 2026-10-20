// The console and sidebar share app presence, server phone status, and the
// browser's pending phone attempt. A Twilio dial result is not a live session.
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { CHANNELS } from "../../shared/constants.js";
import type { LiveStatus, Presence, RpcContract, TraceTailPayload } from "../../shared/contract.js";
import { useCall } from "../../voice/call-store.js";
import { createStore, useStore } from "../../voice/store.js";
import { ENDED_STATUS_MS, PHONE_WAIT_MS, phoneAttempt } from "../phone-status.js";
import { useLatest } from "../settings/data.js";
import { formatElapsed } from "./format.js";

export type CallPhase = "idle" | "connecting" | "dialing" | "ringing" | "live" | "muted" | "ended" | "failed" | "unconfirmed";
export type CallState = {
  phase: CallPhase;
  live: boolean;
  muted: boolean;
  nonce: string | null;
  startedAt: number | null;
  channel: LiveStatus["channel"];
  now: number;
};

const IDLE: CallState = { phase: "idle", live: false, muted: false, nonce: null, startedAt: null, channel: null, now: 0 };
export const consoleCallState = createStore<CallState>(IDLE);
export const useConsoleCallState = () => useStore(consoleCallState);

/** Icon components have no plugin SDK context. An invisible plugin slot reads
 * the SDK once and publishes status for the footer icon's ordinary store hook. */
export function ConsoleStatusOverlay() {
  const call = useCallState();
  useEffect(() => {
    consoleCallState.set(call);
  }, [call.phase, call.live, call.muted, call.nonce, call.startedAt, call.channel, call.now]);
  useEffect(() => () => consoleCallState.set(IDLE), []);
  // The host hides decorative icon contents from assistive technology. Expose
  // phase changes outside that wrapper; do not announce the elapsed clock.
  return createElement("span", { role: "status", "aria-label": "Dispatch call status", className: "sr-only" }, call.phase === "idle" ? "" : `Dispatch: ${callStatusText(call)}`);
}

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const ACTIVE = new Set<Presence["phase"]>(["connecting", "live", "muted"]);
const LIFECYCLE = new Set(["call.started", "call.closed", "call.stopped", "call.failed", "call.suspended"]);

export function useCallState(): CallState {
  const rpc = useRpc<RpcContract>();
  const rpcRef = useLatest(rpc);
  const local = useCall();
  const pending = useStore(phoneAttempt);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [owners, setOwners] = useState<ReadonlyMap<string, { presence: Presence; seenAt: number }>>(new Map());
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const wasLive = useRef(false);
  const phoneStarts = useRef(new Map<string, number>());
  const now = useNow(Boolean(status?.live || owners.size || local.state !== "idle" || pending || endedAt));

  const refresh = useCallback(() => {
    const id = ++request.current;
    rpcRef.current.call("liveStatus", {}).then((value) => {
      if (mounted.current && request.current === id) setStatus(value);
    }).catch(() => undefined);
  }, [rpcRef]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  useRealtime(CHANNELS.presence, (payload) => {
    const presence = payload as Presence;
    setOwners((current) => {
      const next = new Map([...current].filter(([, item]) => Date.now() - item.seenAt < 15_000));
      if (ACTIVE.has(presence.phase)) next.set(presence.nonce, { presence, seenAt: Date.now() });
      else next.delete(presence.nonce);
      return next;
    });
    refresh();
  });
  useRealtime(CHANNELS.traceTail, (payload) => {
    const tail = payload as TraceTailPayload;
    if (!tail.events?.some((event) => LIFECYCLE.has(event.kind))) return;
    const attempt = phoneAttempt.get();
    for (const event of tail.events) {
      if (event.kind === "call.started" && event.payload?.channel === "phone") phoneStarts.current.set(tail.callId, event.at);
      const startedAt = phoneStarts.current.get(tail.callId);
      if (event.kind !== "call.started" && LIFECYCLE.has(event.kind) && startedAt !== undefined) {
        phoneStarts.current.delete(tail.callId);
        // A short phone session can start and end before liveStatus replies.
        if (attempt && startedAt >= attempt.at) phoneAttempt.set(null);
        setEndedAt(Date.now());
        setStatus((current) => current?.channel === "phone" && (current.startedAt ?? 0) <= startedAt ? { live: false, channel: null, startedAt: null, device: null } : current);
      }
    }
    if (attempt && tail.events.some((event) => event.kind === "call.failed" && event.at >= attempt.at)) {
      phoneAttempt.set({ phase: "failed", at: Date.now() });
    }
    refresh();
  });

  const owner = [...owners.values()].filter((item) => now - item.seenAt < 15_000).at(-1)?.presence;
  const app = local.state !== "idle" ? { phase: local.state, nonce: local.nonce, startedAt: local.startedAt } : owner;
  const phoneLive = status?.live === true && status.channel === "phone";
  const live = phoneLive || (app ? app.phase === "live" || app.phase === "muted" : status?.live === true);
  const muted = !phoneLive && app?.phase === "muted";
  const waiting = pending?.phase === "dialing" || pending?.phase === "ringing";

  // Trace pushes are immediate. Poll only during a phone attempt/session to
  // recover missed pushes, including a phone that ends without browser presence.
  useEffect(() => {
    if (!waiting && !phoneLive) return;
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [waiting, phoneLive, refresh]);
  useEffect(() => {
    if (phoneLive && pending) phoneAttempt.set(null);
  }, [phoneLive, pending]);
  useEffect(() => {
    if (live) wasLive.current = true;
    else if (wasLive.current) {
      wasLive.current = false;
      setEndedAt(Date.now());
    }
  }, [live]);
  useEffect(() => {
    if ([...owners.values()].some((item) => now - item.seenAt >= 15_000)) {
      setOwners(new Map([...owners].filter(([, item]) => now - item.seenAt < 15_000)));
    }
    if (endedAt && now - endedAt >= ENDED_STATUS_MS) setEndedAt(null);
    if (pending && waiting && now - pending.at >= PHONE_WAIT_MS) phoneAttempt.set({ phase: "unconfirmed", at: Date.now() });
    else if (pending && !waiting && now - pending.at >= ENDED_STATUS_MS) phoneAttempt.set(null);
  }, [now, endedAt, pending, waiting, owners]);

  const phase: CallPhase = live ? (muted ? "muted" : "live") : app?.phase === "connecting" ? "connecting" : pending?.phase ?? (endedAt ? "ended" : "idle");
  return {
    phase, live, muted, now,
    nonce: phoneLive ? null : app?.nonce ?? null,
    startedAt: phoneLive ? status.startedAt : app?.startedAt ?? status?.startedAt ?? null,
    channel: phoneLive || pending ? "phone" : app ? "app" : status?.channel ?? null,
  };
}

export const callStatusText = (state: CallState): string => ({
  idle: "No active call", connecting: "Connecting…", dialing: "Calling your phone…", ringing: "Waiting for you to answer…",
  live: state.channel === "phone" ? "Phone call live" : "Live", muted: "Muted", ended: "Call ended", failed: "Call failed", unconfirmed: "No connection confirmed",
})[state.phase];

export type ConsoleBadge = { text: string; phase: CallPhase; tone?: "warning"; label: string };

/** Stable SDK 0.6.49 uses the nav panel's sidebar accessory, not a badge hook. */
export function useConsoleBadge(): ConsoleBadge | null {
  const state = useConsoleCallState();
  if (state.phase === "idle") return null;
  const text = state.live && state.startedAt !== null ? formatElapsed((state.now - state.startedAt) / 1000)
    : ({ dialing: "Calling", ringing: "Calling", connecting: "Connecting", ended: "Ended", failed: "Failed", unconfirmed: "Not connected" } as Partial<Record<CallPhase, string>>)[state.phase] ?? "Live";
  return { text, phase: state.phase, ...(state.muted ? { tone: "warning" as const } : {}), label: `Dispatch · ${callStatusText(state)}${state.live ? ` · ${text}` : ""}` };
}
