// The always-mounted overlay of each realm. It draws nothing of its own but the
// toasts. It feeds preferences, registers the fallback bindings, installs the
// call engine, and passes the realtime channels to the call controller.

import { installPodcast, podcastEngine } from "./podcast/controller.js";
import { PODCAST_SPEECH_CHANNEL, type PodcastSpeech } from "@/shared/podcast.js";
import type { PodcastContract } from "@/shared/podcast.js";
import { useEffect } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { AgentCommandPayload, CallControlPayload, Presence, RpcContract, ThreadNoticePayload } from "@/shared/contract.js";
import { CHANNELS } from "@/shared/constants.js";
import { NAV_PANEL } from "@/app/ids.js";
import { useRegisterBindings, useScreenContext } from "./bindings.js";
import { callEngine, installCallEngine } from "./engine.js";
import { useFeedPreferences } from "./preferences.js";
import { setSettingsFallback } from "./settings-opener.js";
import { Toaster } from "./toaster.js";

export function BindingsOverlay() {
  const rpc = useRpc<RpcContract & PodcastContract>();
  const navigate = useBbNavigate();
  useFeedPreferences();
  useRegisterBindings("fallback", useScreenContext(), null);

  useEffect(() => {
    setSettingsFallback(() => navigate.toPluginPanel(NAV_PANEL.path));
    return () => setSettingsFallback(null);
  }, [navigate]);

  useEffect(() => {
    const dispose = installCallEngine(rpc);
    const disposePodcast = installPodcast(rpc);
    // Ask owners elsewhere to publish, so a call that is already running shows here.
    rpc.call("pollPresence", {}).catch(() => undefined);
    return () => { disposePodcast(); dispose(); };
    // The rpc client is stable for the plugin's life.
  }, []);

  useRealtime(CHANNELS.presence, (payload) => { if (!podcastEngine()?.active) callEngine()?.onPresence(payload as Presence); });
  useRealtime(CHANNELS.presencePing, () => { if (podcastEngine()?.active) podcastEngine()?.presence(); else callEngine()?.onPresencePing(); });
  useRealtime(CHANNELS.agentCommand, (payload) => { podcastEngine()?.onCommand(payload as AgentCommandPayload); callEngine()?.onAgentCommand(payload as AgentCommandPayload); });
  useRealtime(CHANNELS.threadNotice, (payload) => callEngine()?.onThreadNotice(payload as ThreadNoticePayload));
  useRealtime(CHANNELS.callControl, (payload) => { podcastEngine()?.onControl(payload as CallControlPayload); callEngine()?.onCallControl(payload as CallControlPayload); });

  useRealtime(PODCAST_SPEECH_CHANNEL, payload => podcastEngine()?.onSpeech(payload as { callId: string; requestId: string; speech: PodcastSpeech }));

  return <Toaster />;
}
