// The always-mounted overlay of each realm. It draws nothing of its own but the
// toasts. It feeds preferences, registers the fallback bindings, installs the
// call engine, and passes the realtime channels to the call controller.

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
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  useFeedPreferences();
  useRegisterBindings("fallback", useScreenContext(), null);

  useEffect(() => {
    setSettingsFallback(() => navigate.toPluginPanel(NAV_PANEL.path));
    return () => setSettingsFallback(null);
  }, [navigate]);

  useEffect(() => {
    const dispose = installCallEngine(rpc);
    // Ask owners elsewhere to publish, so a call that is already running shows here.
    rpc.call("pollPresence", {}).catch(() => undefined);
    return dispose;
    // The rpc client is stable for the plugin's life.
  }, []);

  useRealtime(CHANNELS.presence, (payload) => callEngine()?.onPresence(payload as Presence));
  useRealtime(CHANNELS.presencePing, () => callEngine()?.onPresencePing());
  useRealtime(CHANNELS.agentCommand, (payload) => callEngine()?.onAgentCommand(payload as AgentCommandPayload));
  useRealtime(CHANNELS.threadNotice, (payload) => callEngine()?.onThreadNotice(payload as ThreadNoticePayload));
  useRealtime(CHANNELS.callControl, (payload) => callEngine()?.onCallControl(payload as CallControlPayload));

  return <Toaster />;
}
