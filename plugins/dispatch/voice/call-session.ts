// The shapes of one in-app call (SPEC §5): the timing knobs, what the
// controller gets from the browser, and the state of the session it owns.
// call-controller.ts holds the behaviour.

import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { DeviceProfile, Preferences, RpcContract, SetupStatus } from "@/shared/contract.js";
import type { ScreenContext } from "./bindings.js";
import type { Activity, CallSnapshot } from "./call-store.js";
import { acquireMic, MIC_TIMEOUT_MS } from "./mic.js";
import { NOTICE_WINDOW_MS } from "./notices.js";
import { ICE_TIMEOUT_MS, type AudioSink } from "./peer.js";
import { STALE_MS } from "./presence-mirror.js";
import type { Store } from "./store.js";
import type { ToastOptions } from "./toasts.js";
import type { FunctionCall } from "./tool-dispatcher.js";

export interface Timing {
  micTimeoutMs: number;
  iceTimeoutMs: number;
  heartbeatMs: number;
  staleMs: number;
  /** A second stop on a mirrored call within this window ends it on the server. */
  doubleStopMs: number;
  noticeWindowMs: number;
  traceDelayMs: number;
}

export const DEFAULT_TIMING: Timing = {
  micTimeoutMs: MIC_TIMEOUT_MS,
  iceTimeoutMs: ICE_TIMEOUT_MS,
  heartbeatMs: 5000,
  staleMs: STALE_MS,
  doubleStopMs: 4000,
  noticeWindowMs: NOTICE_WINDOW_MS,
  traceDelayMs: 500,
};

type MediaDevicesLike = Parameters<typeof acquireMic>[0];

export interface ControllerDeps {
  rpc: Pick<PluginRpcClient<RpcContract>, "call">;
  createPeer: () => RTCPeerConnection;
  media: () => MediaDevicesLike;
  createAudio: () => AudioSink;
  outputDeviceId: () => string | null;
  visible: () => boolean;
  profile: DeviceProfile;
  screen: () => ScreenContext;
  prefs: () => Preferences;
  /** Null until the first setup read returns. */
  setup: () => SetupStatus | null;
  agentName: () => string;
  runTool: (call: FunctionCall) => Promise<string>;
  toast: (message: string, options?: ToastOptions) => void;
  openSettings: () => void;
  chimes: { ready: () => void; hangUp: () => void };
  clientId: string;
  realmId: string;
  store?: Store<CallSnapshot>;
  timing?: Partial<Timing>;
}

export type OwnState = "connecting" | "live" | "muted";

export interface Session {
  nonce: string;
  callId: string | null;
  state: OwnState;
  muted: boolean;
  startedAt: number | null;
  activity: Activity;
  micSuspended: boolean;
  pc: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  stream: MediaStream | null;
  track: MediaStreamTrack | null;
  sender: RTCRtpSender | null;
  audio: AudioSink | null;
  detachTrack: (() => void) | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** Function calls without an output yet. */
  pending: Set<string>;
  /** Outputs sent since the last continue. */
  answered: number;
  responseActive: boolean;
  queuedNotice: string | null;
  recovering: boolean;
  ending: boolean;
  ended: boolean;
}

export interface Teardown {
  reason: string;
  /** Ask the server to end the call first. */
  server: boolean;
  /** The trace kind that ends the call in the ledger. */
  record: "call.stopped" | "call.closed" | "call.suspended";
  extra?: Record<string, unknown>;
}
