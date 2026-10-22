// The one call controller of this realm, wired to the real browser. The
// bindings overlay installs it once. The pet, the shortcuts, the palette
// commands and the console's "Wake" button all reach it through here.

import { podcastEngine } from "./podcast/controller.js";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "@/shared/contract.js";
import { registerStartCall } from "@/app/console/index.js";
import { dialPhone } from "@/app/phone-dial.js";
import { pointerGhost } from "@/app/pointer-ghost/model.js";
import { readAudioChoice } from "./audio-devices.js";
import { currentBindings } from "./bindings.js";
import { CallController } from "./call-controller.js";
import { callStore, updateCall } from "./call-store.js";
import { playHangUpChime, playReadyChime } from "./chimes.js";
import { deviceProfile } from "./device-profile.js";
import { drawerViews } from "./drawer-views.js";
import { clientId, pointerGhostEnabled, REALM_ID } from "./local.js";
import { agentName, prefsStore, setupStore } from "./preferences.js";
import { createAudioSink } from "./peer.js";
import { openDispatchSettings } from "./settings-opener.js";
import { showToast } from "./toasts.js";
import { ToolDispatcher } from "./tool-dispatcher.js";

let engine: CallController | null = null;
let engineRpcClient: PluginRpcClient<RpcContract> | null = null;

export const callEngine = () => engine;

/** The RPC client, for surfaces that run outside the plugin's React tree (footer icon, palette). */
export const engineRpc = () => engineRpcClient;

export const toggleCall = () => podcastEngine()?.active ? podcastEngine()!.stop() : engine?.toggle() ?? Promise.resolve();

export const toggleMute = () => podcastEngine()?.active ? Promise.resolve(podcastEngine()!.toggleMute()) : engine?.toggleMute() ?? Promise.resolve();

/** Stop the call this realm shows, its own or a mirrored one. Never starts one. */
export const stopCall = () => podcastEngine()?.active ? podcastEngine()!.stop() : (engine && callStore.get().state !== "idle" ? engine.toggle() : Promise.resolve());

/** "Call my phone" from the pet menu or the palette. P3's helper shows the result. */
export function callMyPhone() {
  const rpc = engineRpcClient;
  if (!rpc) return Promise.resolve(null);
  return dialPhone(rpc, { agentName: agentName(), onNotReady: openDispatchSettings });
}

/** Create the controller and hook it to the page. Returns the disposer. */
export function installCallEngine(rpc: PluginRpcClient<RpcContract>): () => void {
  if (engine) return () => undefined;
  const profile = deviceProfile();
  let controller: CallController | null = null;
  const dispatcher = new ToolDispatcher({
    rpc,
    bindings: currentBindings,
    profile,
    ghost: () => (pointerGhostEnabled() ? pointerGhost : null),
    drawer: drawerViews,
    prefs: () => prefsStore.get(),
    trace: (kind, payload) => controller?.record(kind, payload),
    setWork: (work) => updateCall({ work }),
    setOutcome: (outcome) => updateCall({ outcome }),
  });
  controller = new CallController({
    rpc,
    createPeer: () => new RTCPeerConnection(),
    media: () => (typeof navigator === "undefined" ? undefined : navigator.mediaDevices),
    createAudio: () => createAudioSink(),
    outputDeviceId: () => readAudioChoice().outputDeviceId,
    visible: () => document.visibilityState === "visible",
    profile,
    screen: () => currentBindings()?.context() ?? { threadId: null, projectId: null, onNewThreadScreen: false },
    prefs: () => prefsStore.get(),
    setup: () => setupStore.get(),
    agentName,
    runTool: (call) => dispatcher.run(call),
    toast: showToast,
    openSettings: openDispatchSettings,
    chimes: { ready: playReadyChime, hangUp: playHangUpChime },
    clientId: clientId(),
    realmId: REALM_ID,
  });
  const installed = controller;
  engine = installed;
  engineRpcClient = rpc;

  const onVisibility = () => installed.onVisibility();
  const onPageHide = () => void installed.stop("pagehide");
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  const unregisterStart = registerStartCall(() => podcastEngine()?.active ? Promise.resolve() : installed.wake());

  return () => {
    unregisterStart();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    installed.dispose("unmount");
    if (engine === installed) {
      engine = null;
      engineRpcClient = null;
    }
  };
}
